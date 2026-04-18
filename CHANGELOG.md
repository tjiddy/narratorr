# Changelog

All notable changes to Narratorr are documented in this file.

## [1.0.0] — Unreleased

Initial public release. Full audiobook acquisition and organization pipeline.

### Breaking Changes
- **Flatten-on-download removed.** Auto-import no longer runs audio processing (ffmpeg merge/convert) on downloaded books. Imports now complete in seconds instead of minutes. Users who relied on `processing.enabled` for automatic transcoding should configure `postProcessingScript` in Settings → Post Processing → Custom Script as the replacement path.

### Core Pipeline
- Search indexers (Torznab, Newznab, MyAnonamouse) for audiobooks
- Grab releases to download clients (qBittorrent, Transmission, Deluge, SABnzbd, NZBGet, Blackhole)
- Monitor download progress with real-time SSE updates
- Quality gate: auto-accept upgrades, hold for review, auto-reject downgrades
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
- RSS feed monitoring with quality-aware upgrades
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
- Configurable event triggers (grab, import, failure, upgrade, health)

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
- React 18, Vite, TanStack Query, Tailwind CSS
- TypeScript strict mode throughout
- 5,700+ automated tests across 312 test files
