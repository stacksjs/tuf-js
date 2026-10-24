# tuf-js

JavaScript TUF client implementation.

## Verified metadata observation

This source branch adds optional `UpdaterOptions.onVerifiedMetadata(role, bytes)`.
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
unmodified upstream 6.0.0 package. Release and qualify this source before removing
an application's legacy distribution patch.
