# Changelog

All notable changes to Narratorr are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- **BREAKING (native v1 API):** `POST /api/v1/books/:publicId/grab` now derives its `409` conflict `code` from the single consolidated grab-blocker classifier (#1861). Two reachable behavior changes: a `checking`/`pending_review` active download now returns `409 PIPELINE_ACTIVE` (was `ACTIVE_DOWNLOAD_EXISTS`), and a quality-gate-eligible completed download now returns `409 PIPELINE_ACTIVE` (was admitted with `200`, a duplicate-admission window). The `PIPELINE_ACTIVE` message is now blocker-neutral ("Book already has a download in the import pipeline"). See the API Versioning Policy exception in `SECURITY.md`.

## [1.0.0] — Unreleased

Initial public release.
