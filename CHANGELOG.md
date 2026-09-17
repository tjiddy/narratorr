# Changelog

All notable changes to Narratorr are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- A merge whose m4b is already in place no longer reports `merge_failed` because the hidden `.merge-tmp` staging folder could not be removed. On an unraid NFS export the just-deleted staged copies linger as `.fuse_hidden*` for as long as another client holds them open, far past the removal helper's 600 ms of retries, and that cleanup failure was thrown as the merge's failure, which also skipped the post-merge retag and audio enrichment. Cleanup after the commit is now a warning on the merge's completion message and in the log; the next merge of the same book resets the folder.
- The recurring production `SIGSEGV` (7+/day by September) is gone at its source (#2615): `@libsql/client` is bumped to 0.18.0, whose sqlite3 backend pools connections instead of abandoning one to garbage collection on every transaction. libsql 0.5.29 segfaults when a statement is finalized before the connection it was prepared on, and 0.17.x's per-transaction detach handed that ordering to V8 thousands of times a day. Reproduced with a plain transaction loop on the production binary and confirmed fixed by the same loop at 0.18.0; the native binding is unchanged. Details, repro and the finalizer-order table: `docs/crash-forensics.md` §8.

### Changed

- **BREAKING (native v1 API):** `POST /api/v1/books/:publicId/grab` now derives its `409` conflict `code` from the single consolidated grab-blocker classifier (#1861). Two reachable behavior changes: a `checking`/`pending_review` active download now returns `409 PIPELINE_ACTIVE` (was `ACTIVE_DOWNLOAD_EXISTS`), and a quality-gate-eligible completed download now returns `409 PIPELINE_ACTIVE` (was admitted with `200`, a duplicate-admission window). The `PIPELINE_ACTIVE` message is now blocker-neutral ("Book already has a download in the import pipeline"). See the API Versioning Policy exception in `SECURITY.md`.

## [1.0.0] — Unreleased

Initial public release.
