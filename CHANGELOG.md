# Changelog

All notable changes to Narratorr are documented in this file.

## [1.0.0] — Unreleased

Initial public release. Full audiobook acquisition and organization pipeline.

### Breaking Changes
- **Automatic audiobook upgrade system removed (#1103).** Imported audiobooks are no longer automatically replaced with higher-quality releases. The scheduled `upgrade-search` job is gone, RSS now only considers `wanted` books, the `monitor_for_upgrades` book flag has been dropped, `quality.monitorForUpgrades` is no longer a setting, and the `'upgraded'` event type plus `on_upgrade` notification event have been retired. Manual `Search Releases` on an imported book still works, but the grab is always held for explicit review (`imported_book_replacement` hold reason) — no auto-import on replacement. `POST /api/activity/:id/retry` now returns 409 (`IMPORTED_BOOK_NO_RETRY`) when the linked book has been imported. Existing `monitor_for_upgrades` values and historical `'upgraded'` event rows are dropped/remapped to `'imported'` by a single migration; `on_upgrade` subscriptions are scrubbed and notifier rows with no remaining events are disabled.
- **Flatten-on-download removed.** Auto-import no longer runs audio processing (ffmpeg merge/convert) on downloaded books. Imports now complete in seconds instead of minutes. Users who relied on `processing.enabled` for automatic transcoding should configure `postProcessingScript` in Settings → Post Processing → Custom Script as the replacement path.
- **Unused `authors` columns dropped.** Migration `0002_dizzy_captain_cross.sql` removes `image_url`, `bio`, `monitored`, and `last_checked_at` from the `authors` table — none were ever read or written by production code. Author image and biography continue to be sourced live from audnexus on the author detail page; no UI regression.
- **Vestigial REST endpoints retired (Wave 11.2, #755).** Endpoints with no UI consumer have been removed; integrations should migrate to the active surfaces listed below. `POST /api/system/tasks/search` is preserved for external API compatibility (see `SECURITY.md` → "Public-compatibility API surfaces"). Removed routes:
    - `GET /api/search` — superseded by SSE `GET /api/search/stream` (`POST /api/search/grab` continues to be active).
    - `POST /api/library/import/scan-single` and `POST /api/library/import/single` — single-book scan/import flows had no production caller.
    - `GET /api/discover/stats` and `POST /api/discover/suggestions/:id/snooze` — service-layer snooze/resurfacing logic remains active; only the unused HTTP wrappers were removed.
    - `GET /api/books/bulk/convert/count` — Bulk Operations UI never consumed this count; the start-convert and active-job endpoints continue to be active.

### Core Pipeline
- Search indexers (Torznab, Newznab, MyAnonamouse) for audiobooks
- Grab releases to download clients (qBittorrent, Transmission, Deluge, SABnzbd, NZBGet, Blackhole)
- Monitor download progress with real-time SSE updates
- Quality gate: auto-import the first release for a wanted book; hold questionable releases for review
- Import completed downloads to organized library folder structure
- Configurable file naming with author/title/series/narrator tokens
- Audio enrichment: extract metadata from audio file tags
- Retry and blacklist system for failed downloads

### Library Management
- Grid and list views with filtering by status, author, series, narrator, genre
- Full-text search across library
- Bulk actions: search, delete, retag
- Book detail pages with metadata, download history, event timeline
- Author pages with series grouping
- Library rescan to detect missing/restored files
- Recycling bin with configurable retention

### Metadata
- Metadata providers with region support
- Author and series enrichment
- Cover art display and embedding
- Series and narrator tracking

### Discovery Engine
- AI-powered book suggestions based on library analysis
- Signal types: author affinity, series completion, genre, narrator, diversity
- Dismissal tracking with automatic weight tuning
- Snooze and expiry for suggestion lifecycle
- Series completion intelligence (gap detection)

### Search & Monitoring
- Scheduled automatic search for wanted books
- RSS feed polling for wanted books
- Prowlarr integration for indexer sync
- Quality filtering: grab floor, min seeders, protocol preference, reject/required words

### Import Lists
- AudiobookShelf library sync
- NYT Bestsellers
- Hardcover lists

### Audio Processing
- FFmpeg-based audio conversion and merging
- ID3 tag embedding (populate missing or overwrite)
- Cover art embedding
- Post-processing script support with configurable timeout

### Notifications
- Discord, Slack, Telegram, Pushover, Gotify, Ntfy, Email, Webhook
- Configurable event triggers (grab, download complete, import, failure, health)

### Settings & Configuration
- Web-based configuration for all features
- Download client connection testing with category fetch
- Indexer connection testing
- Proxy support (HTTP/HTTPS/SOCKS5)
- Remote path mappings for Docker environments
- Backup and restore with configurable retention

### Security
- Forms-based authentication with session cookies (HMAC-SHA256 signed)
- HTTP Basic authentication option
- API key authentication (header or query parameter)
- Rate limiting on login endpoints (5 attempts / 15 min)
- AES-256-GCM encryption at rest for all stored credentials
- CSP with nonce-based script execution via @fastify/helmet
- scrypt password hashing with timing-safe comparison

### System
- Docker support with linuxserver.io base image (amd64/arm64)
- s6-overlay process supervision
- Health checks for Docker and monitoring
- Background job system: search, RSS, import, enrichment, housekeeping, backup
- Real-time UI updates via Server-Sent Events
- URL_BASE support for reverse proxy subpath deployments

### Tech Stack
- Node.js 24, Fastify 5, Drizzle ORM + libSQL
- React 19, Vite 8, TanStack Query, Tailwind CSS
- TypeScript 6 strict mode, ESLint 10, pnpm 10
- 5,700+ automated tests across 312 test files
