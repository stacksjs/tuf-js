import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { Updater, type UpdaterOptions } from '../src/index';
import * as Tuf from '../src/index';
import { repository } from './fixtures/observer-repository';

const roots: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

async function setup(
  options: Parameters<typeof repository>[1] = { rotate: true },
  missing?: string
) {
  const root = await mkdtemp(join(tmpdir(), 'drone-sdk-test-'));
  roots.push(root);
  const repo = join(root, 'repo'),
    cache = join(root, 'cache'),
    requests: string[] = [];
  const fixture = await repository(repo, options);
  await mkdir(cache, { mode: 0o700 });
  await copyFile(fixture.rootPath, join(cache, 'root.json'));
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    requests.push(path);
    const filePath = join(repo, 'metadata', basename(path));
    if (
      !/^\/metadata\/(?:[0-9]+\.)?(?:root|timestamp|snapshot|targets)\.json$/.test(
        path
      ) ||
      basename(path) === missing ||
      !existsSync(filePath)
    ) {
      response.writeHead(404).end();
      return;
    }
    response.end(readFileSync(filePath));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Fixture server did not bind TCP');
  const input = {
    metadataDir: cache,
    metadataBaseUrl: `http://127.0.0.1:${address.port}/metadata`,
    config: { fetchRetries: 0, fetchTimeout: 1000 },
  } satisfies UpdaterOptions;
  return { root, repo, cache, fixture, requests, input };
}

async function failureOf(pending: Promise<unknown>): Promise<Error> {
  try {
    await pending;
  } catch (error) {
    assert(error instanceof Error);
    return error;
  }
  throw new Error('Expected refresh to reject');
}

function rootVersion(bytes: string): number {
  const metadata: unknown = JSON.parse(bytes);
  assert(metadata && typeof metadata === 'object' && 'signed' in metadata);
  const signed = metadata.signed;
  assert(signed && typeof signed === 'object' && 'version' in signed);
  assert(typeof signed.version === 'number');
  return signed.version;
}

const roles = ['root', 'timestamp', 'snapshot', 'targets'] as const;

test('the maintained SDK observer receives exact verified bytes before each cache write', async () => {
  const item = await setup(),
    seen: string[] = [];
  const updater = new Updater({
    ...item.input,
    async onVerifiedMetadata(role, bytes) {
      seen.push(role);
      if (role === 'root')
        expect(
          rootVersion(await readFile(join(item.cache, 'root.json'), 'utf8'))
        ).toBe(1);
      else expect(existsSync(join(item.cache, `${role}.json`))).toBe(false);
      const file =
        role === 'root'
          ? '2.root.json'
          : role === 'timestamp'
            ? 'timestamp.json'
            : `1.${role}.json`;
      expect(bytes).toEqual(await readFile(join(item.repo, 'metadata', file)));
    },
  });
  await updater.refresh();
  expect(seen).toEqual([...roles]);
  expect((await readdir(item.cache)).sort()).toEqual([
    'root.json',
    'snapshot.json',
    'targets.json',
    'timestamp.json',
  ]);
});

test('a pending observer prevents the cache write and the next metadata request', async () => {
  const item = await setup();
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const seen = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const pending = new Updater({
    ...item.input,
    async onVerifiedMetadata(role) {
      if (role === 'root') {
        entered();
        await gate;
      }
    },
  }).refresh();
  try {
    await seen;
    expect(
      rootVersion(await readFile(join(item.cache, 'root.json'), 'utf8'))
    ).toBe(1);
    expect(item.requests).toEqual(['/metadata/2.root.json']);
  } finally {
    release();
    await pending;
  }
});

for (const failedRole of roles) {
  test(`an observer rejection for ${failedRole} aborts before that cache or a later role advances`, async () => {
    const item = await setup(),
      seen: string[] = [],
      cause = new Error('protected persistence rejected');
    const updater = new Updater({
      ...item.input,
      async onVerifiedMetadata(role) {
        await Promise.resolve();
        seen.push(role);
        if (role === failedRole) throw cause;
      },
    });
    const failure = await failureOf(updater.refresh());
    const persistence =
      failedRole === 'snapshot' || failedRole === 'targets'
        ? failure.cause
        : failure;
    expect(persistence).toBeInstanceOf(Tuf.PersistError);
    assert(persistence instanceof Tuf.PersistError);
    expect(persistence.message).toBe(
      `Failed to persist metadata ${failedRole}`
    );
    expect(persistence.cause).toBe(cause);
    expect(seen).toEqual(roles.slice(0, roles.indexOf(failedRole) + 1));
    if (failedRole === 'root')
      expect(
        rootVersion(await readFile(join(item.cache, 'root.json'), 'utf8'))
      ).toBe(1);
    else expect(existsSync(join(item.cache, `${failedRole}.json`))).toBe(false);
  });
}

test('a genuine SDK HTTP404 thrown by the observer cannot be mistaken for the end of root rotation', async () => {
  const source = await setup({ rotate: false }, 'timestamp.json');
  const downloadFailure = await failureOf(new Updater(source.input).refresh());
  assert(downloadFailure instanceof Tuf.DownloadHTTPError);
  expect(downloadFailure.statusCode).toBe(404);
  const item = await setup(),
    seen: string[] = [];
  await expect(
    new Updater({
      ...item.input,
      onVerifiedMetadata(role) {
        seen.push(role);
        throw downloadFailure;
      },
    }).refresh()
  ).rejects.toThrow('Failed to persist metadata root');
  expect(seen).toEqual(['root']);
  expect(
    rootVersion(await readFile(join(item.cache, 'root.json'), 'utf8'))
  ).toBe(1);
});

test('the observer owns a byte copy and cannot mutate SDK verification or cache bytes', async () => {
  const item = await setup(),
    observed: Record<string, Buffer> = {};
  await new Updater({
    ...item.input,
    onVerifiedMetadata(role, bytes) {
      observed[role] = Buffer.from(bytes);
      bytes.fill(0);
    },
  }).refresh();
  for (const role of roles)
    expect(
      (await readFile(join(item.cache, `${role}.json`))).equals(observed[role])
    ).toBe(true);
});

test('an unauthorized root never reaches the observer and leaves the initial cache intact', async () => {
  const item = await setup({ rotate: true, badRotation: true }),
    seen: string[] = [];
  await expect(
    new Updater({
      ...item.input,
      onVerifiedMetadata(role) {
        seen.push(role);
      },
    }).refresh()
  ).rejects.toThrow();
  expect(seen).toEqual([]);
  expect(
    rootVersion(await readFile(join(item.cache, 'root.json'), 'utf8'))
  ).toBe(1);
});

test('a later invalid target signature preserves only the earlier verified metadata observations', async () => {
  const item = await setup({ rotate: true, badTargetsSignature: true }),
    seen: string[] = [];
  await expect(
    new Updater({
      ...item.input,
      onVerifiedMetadata(role) {
        seen.push(role);
      },
    }).refresh()
  ).rejects.toThrow();
  expect(seen).toEqual(['root', 'timestamp', 'snapshot']);
  expect(existsSync(join(item.cache, 'targets.json'))).toBe(false);
});

test('snapshot-bound tampering is rejected before it reaches the observer', async () => {
  const item = await setup(),
    seen: string[] = [];
  await writeFile(join(item.repo, 'metadata/1.targets.json'), '{}');
  await expect(
    new Updater({
      ...item.input,
      onVerifiedMetadata(role) {
        seen.push(role);
      },
    }).refresh()
  ).rejects.toThrow();
  expect(seen).toEqual(['root', 'timestamp', 'snapshot']);
});

test('the supplied fixed start time is owned before callers can mutate it', async () => {
  const item = await setup(),
    time = new Date('2030-01-01T00:00:00Z');
  const updater = new Updater({ ...item.input, referenceTime: time });
  time.setUTCFullYear(2040);
  await updater.refresh();
  expect(
    rootVersion(await readFile(join(item.cache, 'root.json'), 'utf8'))
  ).toBe(2);
});

test('fixed-time recovery replay is distinct from current-time authorization', async () => {
  const past = await setup({ expires: '2025-01-01T00:00:00Z' });
  await new Updater({
    ...past.input,
    referenceTime: new Date('2024-01-01T00:00:00Z'),
  }).refresh();
  const current = await setup({ expires: '2025-01-01T00:00:00Z' });
  const failure = await failureOf(new Updater(current.input).refresh());
  expect(failure).toBeInstanceOf(Tuf.MetadataVerificationError);
  assert(failure instanceof Tuf.MetadataVerificationError);
  expect(failure.role).toBe('timestamp');
  expect(failure.cause).toBeInstanceOf(Error);
  assert(failure.cause instanceof Error);
  expect(failure.cause.message).toContain('expired');
});

test('invalid fixed time is rejected before loading even a missing bootstrap root', () => {
  expect(
    () =>
      new Updater({
        metadataDir: '/missing-drone-sdk-bootstrap',
        metadataBaseUrl: 'http://127.0.0.1:1',
        referenceTime: new Date(Number.NaN),
      })
  ).toThrow('Invalid fixed update reference time');
});

test('a fully cached trusted refresh does not emit observations for cache bytes', async () => {
  const item = await setup();
  await new Updater(item.input).refresh();
  const seen: string[] = [];
  await new Updater({
    ...item.input,
    onVerifiedMetadata(role) {
      seen.push(role);
    },
  }).refresh();
  expect(seen).toEqual([]);
});

test('an authenticated intermediate root is observed before final-root expiry rejects the refresh', async () => {
  const item = await setup({
      rotate: true,
      metadataFields: { rotatedRoot: { expires: '2020-01-01T00:00:00Z' } },
    }),
    seen: string[] = [];
  const failure = await failureOf(
    new Updater({
      ...item.input,
      onVerifiedMetadata(role) {
        seen.push(role);
      },
    }).refresh()
  );
  expect(failure).toBeInstanceOf(Tuf.MetadataVerificationError);
  assert(failure instanceof Tuf.MetadataVerificationError);
  expect(failure.role).toBe('timestamp');
  expect(failure.cause).toBeInstanceOf(Error);
  assert(failure.cause instanceof Error);
  expect(failure.cause.message).toContain('expired');
  expect(seen).toEqual(['root']);
  expect(
    rootVersion(await readFile(join(item.cache, 'root.json'), 'utf8'))
  ).toBe(2);
});

test('forceCache cannot swallow a rejected remote timestamp observer when its local cache is missing', async () => {
  const item = await setup({ rotate: false }),
    seen: string[] = [];
  await expect(
    new Updater({
      ...item.input,
      forceCache: true,
      onVerifiedMetadata(role) {
        seen.push(role);
        if (role === 'timestamp')
          throw new Error('protected timestamp persistence rejected');
      },
    }).refresh()
  ).rejects.toThrow('Failed to persist metadata timestamp');
  expect(seen).toEqual(['timestamp']);
  expect(item.requests).toEqual(['/metadata/timestamp.json']);
  expect((await readdir(item.cache)).sort()).toEqual(['root.json']);
});

test('a signed metadata rejection retains its original typed cause through the SDK wrapper', async () => {
  const item = await setup({ badTargetsSignature: true });
  const failure = await failureOf(new Updater(item.input).refresh());
  expect(failure).toBeInstanceOf(Error);
  expect(failure.cause).toBeInstanceOf(Error);
});

test('recovery can identify a remote metadata rejection through a public typed cause', async () => {
  const item = await setup({ badTargetsSignature: true });
  const failure = await failureOf(new Updater(item.input).refresh());
  expect(Tuf.MetadataVerificationError).toEqual(expect.any(Function));
  expect(failure.cause).toBeInstanceOf(Tuf.MetadataVerificationError);
  assert(failure.cause instanceof Tuf.MetadataVerificationError);
  expect(failure.cause.role).toBe('targets');
});

for (const role of roles) {
  test(`remote ${role} verification failure has a typed role and original cause`, async () => {
    const options: Parameters<typeof repository>[1] =
      role === 'root'
        ? { rotate: true, badRotation: true }
        : { metadataFields: { [role]: { expires: '2020-01-01T00:00:00Z' } } };
    const item = await setup(options);
    const failure = await failureOf(new Updater(item.input).refresh());
    const verification =
      failure instanceof Tuf.MetadataVerificationError
        ? failure
        : failure.cause;
    expect(verification).toBeInstanceOf(Tuf.MetadataVerificationError);
    assert(verification instanceof Tuf.MetadataVerificationError);
    expect(verification.role).toBe(role);
    expect(verification.cause).toBeInstanceOf(Error);
  });
}

test('observer failure stays a persistence failure and preserves its exact cause', async () => {
  const item = await setup(),
    cause = new Error('protected storage failure');
  const failure = await failureOf(
    new Updater({
      ...item.input,
      onVerifiedMetadata() {
        throw cause;
      },
    }).refresh()
  );
  expect(failure).toBeInstanceOf(Tuf.PersistError);
  expect(failure).not.toBeInstanceOf(Tuf.MetadataVerificationError);
  expect(failure.cause).toBe(cause);
  expect(item.requests).toEqual(['/metadata/2.root.json']);
});

test('an observer-supplied verification error is still classified as failed persistence first', async () => {
  const item = await setup({ rotate: false }),
    cause = new Tuf.MetadataVerificationError(
      'timestamp',
      'caller error, not an SDK verification verdict'
    );
  const failure = await failureOf(
    new Updater({
      ...item.input,
      forceCache: true,
      onVerifiedMetadata() {
        throw cause;
      },
    }).refresh()
  );
  expect(failure).toBeInstanceOf(Tuf.PersistError);
  expect(failure.cause).toBe(cause);
  expect(item.requests).toEqual(['/metadata/timestamp.json']);
});

test('the public HTTP failure class matches actual missing-metadata failures', async () => {
  const item = await setup({ rotate: false }, 'timestamp.json');
  const failure = await failureOf(new Updater(item.input).refresh());
  expect(failure).toBeInstanceOf(Tuf.DownloadHTTPError);
  assert(failure instanceof Tuf.DownloadHTTPError);
  expect(failure).toBeInstanceOf(Tuf.DownloadError);
  expect(failure.statusCode).toBe(404);
  expect(failure).not.toBeInstanceOf(Tuf.MetadataVerificationError);
});

test('a Symbol observer rejection remains a persistence failure under forceCache', async () => {
  const item = await setup({ rotate: false }),
    seen: string[] = [],
    cause = Symbol('opaque storage failure');
  const failure = await failureOf(
    new Updater({
      ...item.input,
      forceCache: true,
      onVerifiedMetadata(role) {
        seen.push(role);
        if (role === 'timestamp') {
          // Deliberately exercise a legal opaque observer rejection.
          // eslint-disable-next-line @typescript-eslint/only-throw-error
          throw cause;
        }
      },
    }).refresh()
  );
  expect(failure).toBeInstanceOf(Tuf.PersistError);
  expect(failure.cause).toBe(cause);
  expect(seen).toEqual(['timestamp']);
  expect(item.requests).toEqual(['/metadata/timestamp.json']);
  expect((await readdir(item.cache)).sort()).toEqual(['root.json']);
});

test('observer failures are never coerced while wrapping any metadata role', async () => {
  for (const failedRole of roles) {
    const item = await setup(),
      seen: string[] = [];
    let coercions = 0;
    const cause = {
      toString() {
        coercions++;
        throw new Error('Cause coercion must not run');
      },
    };
    const failure = await failureOf(
      new Updater({
        ...item.input,
        onVerifiedMetadata(role) {
          seen.push(role);
          if (role === failedRole) {
            // Deliberately reject with an object whose coercion must never run.
            // eslint-disable-next-line @typescript-eslint/only-throw-error
            throw cause;
          }
        },
      }).refresh()
    );
    const persistence =
      failedRole === 'snapshot' || failedRole === 'targets'
        ? failure.cause
        : failure;
    expect(persistence).toBeInstanceOf(Tuf.PersistError);
    assert(persistence instanceof Tuf.PersistError);
    expect(persistence.cause).toBe(cause);
    expect(coercions).toBe(0);
    expect(seen).toEqual(roles.slice(0, roles.indexOf(failedRole) + 1));
    if (failedRole === 'root')
      expect(
        rootVersion(await readFile(join(item.cache, 'root.json'), 'utf8'))
      ).toBe(1);
    else expect(existsSync(join(item.cache, `${failedRole}.json`))).toBe(false);
  }
});
