import { generateKeyPairSync, sign, createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  Key,
  Metadata,
  MetaFile,
  Root,
  Signature,
  Snapshot,
  TargetFile,
  Targets,
  Timestamp,
} from '@tufjs/models';
import { canonicalize } from '@tufjs/canonical-json';

const digest = (bytes: Uint8Array) =>
  createHash('sha256').update(bytes).digest('hex');
const fields = {
  version: 1,
  specVersion: '1.0.31',
  expires: '2035-01-01T00:00:00Z',
};

function signer() {
  const pair = generateKeyPairSync('ed25519');
  const publicKey = pair.publicKey
    .export({ format: 'der', type: 'spki' })
    .subarray(-32)
    .toString('hex');
  const keyObject = {
    keytype: 'ed25519',
    scheme: 'ed25519',
    keyval: { public: publicKey },
  };
  const keyID = digest(Buffer.from(canonicalize(keyObject)));
  const key = new Key({
    keyID,
    keyType: 'ed25519',
    scheme: 'ed25519',
    keyVal: { public: publicKey },
  });
  return {
    key,
    sign: (data: Buffer) =>
      new Signature({
        keyID: key.keyID,
        sig: sign(null, data, pair.privateKey).toString('hex'),
      }),
  };
}

/** Throwaway Ed25519 keys and payload bytes are used only by local tests. */
export async function repository(
  directory: string,
  options: {
    expires?: string;
    metadataFields?: Partial<
      Record<
        'root' | 'rotatedRoot' | 'timestamp' | 'snapshot' | 'targets',
        { expires?: string; version?: number }
      >
    >;
    rotate?: boolean;
    badRotation?: boolean;
    badTargetsSignature?: boolean;
  } = {}
) {
  await mkdir(join(directory, 'metadata'), { recursive: true });
  const keys = {
    root: signer(),
    targets: signer(),
    snapshot: signer(),
    timestamp: signer(),
  };
  const root = new Root({
    ...fields,
    ...options.metadataFields?.root,
    consistentSnapshot: true,
  });
  for (const role of ['root', 'targets', 'snapshot', 'timestamp'] as const)
    root.addKey(keys[role].key, role);
  const rootMetadata = new Metadata(root);
  rootMetadata.sign(keys.root.sign);
  const rootPath = join(directory, 'trusted-root.json');
  await writeFile(rootPath, JSON.stringify(rootMetadata.toJSON()));
  if (options.rotate) {
    const nextKey = signer();
    const next = new Root({
      ...fields,
      version: 2,
      ...options.metadataFields?.rotatedRoot,
      consistentSnapshot: true,
    });
    next.addKey(nextKey.key, 'root');
    for (const role of ['targets', 'snapshot', 'timestamp'] as const)
      next.addKey(keys[role].key, role);
    const rotated = new Metadata(next);
    if (!options.badRotation) rotated.sign(keys.root.sign);
    rotated.sign(nextKey.sign);
    await writeFile(
      join(directory, 'metadata/2.root.json'),
      JSON.stringify(rotated.toJSON())
    );
  }
  const image = Buffer.from('observer test payload');
  const target = 'observer-fixture.txt';
  const targets = new Metadata(
    new Targets({
      ...fields,
      ...options.metadataFields?.targets,
      targets: {
        [target]: new TargetFile({
          path: target,
          length: image.length,
          hashes: { sha256: digest(image) },
        }),
      },
    })
  );
  targets.sign(options.badTargetsSignature ? signer().sign : keys.targets.sign);
  const targetsBytes = Buffer.from(JSON.stringify(targets.toJSON()));
  const snapshot = new Metadata(
    new Snapshot({
      ...fields,
      ...options.metadataFields?.snapshot,
      meta: {
        'targets.json': new MetaFile({
          version: 1,
          length: targetsBytes.length,
          hashes: { sha256: digest(targetsBytes) },
        }),
      },
    })
  );
  snapshot.sign(keys.snapshot.sign);
  const snapshotBytes = Buffer.from(JSON.stringify(snapshot.toJSON()));
  const timestamp = new Metadata(
    new Timestamp({
      ...fields,
      expires: options.expires ?? fields.expires,
      ...options.metadataFields?.timestamp,
      snapshotMeta: new MetaFile({
        version: 1,
        length: snapshotBytes.length,
        hashes: { sha256: digest(snapshotBytes) },
      }),
    })
  );
  timestamp.sign(keys.timestamp.sign);
  await writeFile(
    join(directory, 'metadata/timestamp.json'),
    JSON.stringify(timestamp.toJSON())
  );
  await writeFile(join(directory, 'metadata/1.snapshot.json'), snapshotBytes);
  await writeFile(join(directory, 'metadata/1.targets.json'), targetsBytes);
  return { rootPath };
}
