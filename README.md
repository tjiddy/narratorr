# Narratorr

> "arr for audiobooks"

Narratorr is a self-hosted audiobook management and automation application. It allows you to search for audiobooks, add them to a wanted list, automatically search indexers, send downloads to a torrent client, and import completed downloads into a folder structure compatible with Audiobookshelf.

**[Read the documentation](https://docs.narratorr.dev)** for installation guides, configuration reference, and troubleshooting.

## Features

- **Search** - Search AudioBookBay (and future indexers) for audiobooks
- **Download Management** - Integrates with qBittorrent to manage downloads
- **Progress Monitoring** - Real-time download progress tracking
- **Library Organization** - Imports completed downloads to your audiobook library
- **Modern UI** - Clean React-based interface with dark mode support

## Screenshots

The UI includes:
- **Search Page** - Find audiobooks across configured indexers
- **Activity Page** - Monitor active downloads and view history
- **Settings** - Configure indexers, download clients, and library settings

## Quick Start

### Prerequisites

- Node.js 24+
- pnpm 9+
- qBittorrent with WebUI enabled

### Installation

```bash
# Clone the repository
git clone https://git.tjiddy.com/todd/narratorr.git
cd narratorr

# Install dependencies
pnpm install

# Generate database migrations
pnpm db:generate

# Start development server
pnpm dev
```

The server will start on http://localhost:3000 (API) and http://localhost:5173 (Vite dev server).

### Docker

Published to `ghcr.io/todd/narratorr` as multi-arch images (amd64/arm64). Built on [linuxserver.io](https://www.linuxserver.io/) base image with s6-overlay for process supervision, matching the conventions used by other *arr applications.

```bash
# Pull and run with Docker Compose
docker compose pull
docker compose up -d
```

Edit `docker-compose.yml` to set your volume paths and user:

```yaml
environment:
  - PUID=1000                           # Container process UID (default: 911)
  - PGID=1000                           # Container process GID (default: 911)
volumes:
  - ./config:/config                    # Database and config
  - /path/to/audiobooks:/audiobooks     # Your audiobook library
  - /path/to/downloads:/downloads       # Download client save path
```

**Image tags:**

| Tag | Description |
|-----|-------------|
| `latest` | Most recent release |
| `0.9.0` | Specific version |
| `0.9` | Latest patch for a major.minor series |

**Building from source:** To build locally instead of pulling from the registry, uncomment the `build: .` line in `docker-compose.yml` (and comment out the `image:` line), then run `docker compose up -d --build`.

#### CI/CD — Docker Publish Pipeline

Images are built and published automatically when a version tag (e.g., `v0.9.0`) is pushed. The pipeline runs quality gates (lint, test, typecheck, build) before building multi-arch images via `docker buildx` with QEMU emulation.

**Required Gitea Actions secrets:**

| Secret | Description |
|--------|-------------|
| `REGISTRY_USER` | GHCR username (e.g., `todd`) |
| `REGISTRY_PASSWORD` | GHCR personal access token with `write:packages` scope |

**Setup:** In your Gitea repository, go to **Settings > Actions > Secrets** and add both `REGISTRY_USER` and `REGISTRY_PASSWORD`. The workflow validates these are present before attempting to push — if either is missing, the job fails with a clear error message. Once configured, push a version tag (e.g., `git tag v0.9.0 && git push origin v0.9.0`) to trigger a build.

## Configuration

### 1. Add a Download Client

Go to **Settings > Download Clients** and add your qBittorrent instance:

- **Host**: Your qBittorrent IP/hostname (e.g., `localhost`)
- **Port**: WebUI port (default: `8080`)
- **Username/Password**: Your qBittorrent credentials

Click **Test** to verify the connection.

### 2. Add an Indexer

Go to **Settings > Indexers** and add AudioBookBay:

- **Name**: AudioBookBay
- **Hostname**: `audiobookbay.lu` (or current domain)
- **Page Limit**: Number of search result pages to scrape (default: 2)

### 3. Configure Library Settings

Go to **Settings > General**:

- **Library Path**: Where imported audiobooks will be stored (e.g., `/audiobooks`)
- **Folder Format**: How to organize files (e.g., `{author}/{title}`)

## Usage

1. **Search** - Enter a book title or author name in the search box
2. **Grab** - Click the "Grab" button on a search result to start downloading
3. **Monitor** - Watch progress on the Activity page
4. **Import** - Completed downloads are automatically imported to your library

## Tech Stack

| Layer | Technology |
|-------|------------|
| Package Manager | pnpm |
| Backend | Node.js 24, Fastify |
| Database | SQLite (libSQL) + Drizzle ORM |
| Frontend | React 18 + Vite |
| Data Fetching | TanStack Query |
| Styling | Tailwind CSS |
| Deployment | Docker |

## Project Structure

```
narratorr/
├── src/
│   ├── server/              # Fastify backend
│   │   ├── routes/          # API endpoints
│   │   ├── services/        # Business logic
│   │   └── jobs/            # Background tasks
│   ├── client/              # React frontend
│   │   ├── pages/           # Page components
│   │   ├── components/      # Shared components
│   │   └── lib/             # Utilities
│   ├── shared/              # Zod schemas, registries
│   ├── core/                # Indexers, download clients, metadata
│   │   ├── indexers/        # AudioBookBay, Torznab, Newznab
│   │   ├── download-clients/  # qBittorrent, SABnzbd, etc.
│   │   ├── metadata/        # Metadata providers
│   │   └── utils/           # Magnet links, parsing
│   └── db/                  # Drizzle ORM schema
├── scripts/
│   └── gitea.ts             # Gitea API client (TypeScript CLI)
├── Dockerfile
└── docker-compose.yml
```

## API Reference

### Search

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/search?q=query` | Search indexers |
| POST | `/api/search/grab` | Grab a search result |

### Activity

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/activity` | List all downloads |
| DELETE | `/api/activity/:id` | Cancel download |
| POST | `/api/activity/:id/retry` | Retry failed download |

### Indexers

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/indexers` | List indexers |
| POST | `/api/indexers` | Add indexer |
| DELETE | `/api/indexers/:id` | Remove indexer |
| POST | `/api/indexers/:id/test` | Test connection |

### Download Clients

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/download-clients` | List clients |
| POST | `/api/download-clients` | Add client |
| DELETE | `/api/download-clients/:id` | Remove client |
| POST | `/api/download-clients/:id/test` | Test connection |

### Settings

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/settings` | Get all settings |
| PUT | `/api/settings` | Update settings |

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Server port |
| `NODE_ENV` | `development` | Environment |
| `CONFIG_PATH` | `./config` | Config directory |
| `LIBRARY_PATH` | `./audiobooks` | Audiobook library path |
| `DATABASE_URL` | `file:./config/narratorr.db` | SQLite database path |

### Gitea (Development Only)

For contributors using the `scripts/gitea.ts` client, create a `.env` file in the project root:

```bash
GITEA_TOKEN=your_token_here    # Generate at https://git.tjiddy.com/user/settings/applications
GITEA_URL=https://git.tjiddy.com
GITEA_OWNER=todd
GITEA_REPO=narratorr
```

This file is gitignored. The client provides quick access to issues and project management:

```bash
pnpm gitea issues          # List open issues
pnpm gitea issue <id>      # Read issue details
pnpm gitea prs             # List open pull requests
```

## Development

```bash
pnpm dev            # Dev servers (API :3000, Vite :5173)
pnpm build          # Build for production
pnpm db:generate    # Generate new database migration
pnpm typecheck      # Type check
pnpm test           # Run tests
pnpm lint           # Lint
```

## License

GPL-3.0 — see [LICENSE](LICENSE) for details.

## Acknowledgments

- Inspired by [Sonarr](https://sonarr.tv/), [Radarr](https://radarr.video/), and [Readarr](https://readarr.com/)
- AudioBookBay scraping approach inspired by [audiobookbay-automated](https://github.com/JamesRy96/audiobookbay-automated)
