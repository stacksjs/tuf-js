# @stacksjs/tuf-js

JavaScript TUF client implementation.

## Verified metadata observation

This maintained source adds optional `UpdaterOptions.onVerifiedMetadata(role, bytes)`.
The updater awaits the observer after metadata verification and before its cache
write or the next metadata request. Each call receives an owned byte copy. A
rejection becomes `PersistError` with its exact original cause and aborts the
refresh. Persistence failures are never interpreted as a missing root or a
cache miss, including with `forceCache`.

`UpdaterOptions.referenceTime` accepts a finite `Date` and copies its value at
construction. Omitting it preserves the normal fixed update-start time. This
option supports recovery replay; it does not establish a trusted clock or
permit accepting expired metadata at the actual trusted time.

Remote verification failures expose `MetadataVerificationError.role` and retain
the original failure in `cause`. Download failures and equal-version timestamp
handling preserve their existing paths. Classify persistence failures before
examining an observer's nested cause. An observer can reject with any value,
including another verification error.

Discard an updater after a failed refresh. Observer ordering does not roll back
its in-memory trust set, make cache writes transactional, or provide a protected
trust store. Applications must implement those boundaries independently.

These extensions are maintained source changes, not options present in the
unmodified upstream 6.0.0 package. Consume a qualified, versioned source release before removing an application's
legacy distribution patch.

## Maintained distribution

This client is maintained in [stacksjs/tuf-js](https://github.com/stacksjs/tuf-js),
a fork of [theupdateframework/tuf-js](https://github.com/theupdateframework/tuf-js).
The original MIT attribution is retained in `LICENSE`. This package is distinct
from the upstream npm package named `tuf-js`.

Versioned SDK releases use tags of the form `sdk-v6.0.1` and publish the package
archive, `SHA512SUMS` and `source.json` on GitHub. The release workflow rebuilds
and packs the exact tagged source, then tests it before publication. No npm registry
publication or upstream endorsement is implied.

Applications may retain the import name `tuf-js` by using that dependency key
with the exact GitHub release archive URL. Commit the package manager's frozen
lockfile and verify its archive integrity. Do not depend on a moving branch,
edit installed package files, or apply distribution patches.

To prepare a patch release, commit a Changeset naming only the maintained
client with a `patch` bump, then run `bun run release:patch`. Review the generated
client/CLI versions, changelogs, lockfile and package archive. Commit as the
maintainer, qualify that exact commit, fast-forward main and push the matching
`sdk-v<client-version>` tag. The tag workflow publishes only the maintained
client, not the other upstream workspace packages.
