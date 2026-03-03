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

- Node.js 20+
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

```bash
# Build and run with Docker Compose
docker-compose up -d
```

Edit `docker-compose.yml` to set your volume paths:

```yaml
volumes:
  - ./config:/config                    # Database and config
  - /path/to/audiobooks:/audiobooks     # Your audiobook library
  - /path/to/downloads:/downloads       # qBittorrent download directory
```

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
| Monorepo | Turborepo + pnpm |
| Backend | Node.js 20, Fastify |
| Database | SQLite (libSQL) + Drizzle ORM |
| Frontend | React 18 + Vite |
| Data Fetching | TanStack Query |
| Styling | Tailwind CSS |
| Deployment | Docker |

## Project Structure

```
narratorr/
├── apps/
│   └── narratorr/              # Main application
│       ├── src/
│       │   ├── server/         # Fastify backend
│       │   │   ├── routes/     # API endpoints
│       │   │   ├── services/   # Business logic
│       │   │   └── jobs/       # Background tasks
│       │   └── client/         # React frontend
│       │       ├── pages/      # Page components
│       │       ├── components/ # Shared components
│       │       └── lib/        # Utilities
│       └── Dockerfile
├── packages/
│   ├── core/                   # Indexers, download clients, metadata
│   │   ├── indexers/           # AudioBookBay, etc.
│   │   ├── download-clients/   # qBittorrent, etc.
│   │   ├── metadata/           # Audnexus, etc.
│   │   └── utils/              # Magnet links, parsing
│   ├── db/                     # Database schema
│   └── ui/                     # Shared UI utilities
├── scripts/
│   └── gitea.ts                # Gitea API client (TypeScript CLI)
├── docker-compose.yml
└── turbo.json
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
pnpm gitea milestones      # List milestones
pnpm gitea prs             # List open pull requests
```

## Development

```bash
# Run all packages in dev mode
pnpm dev

# Build all packages
pnpm build

# Run only the main app
pnpm dev --filter=narratorr

# Generate new database migration
pnpm db:generate

# Type check
pnpm typecheck
```

## Roadmap

Tracked via [Gitea milestones and issues](https://git.tjiddy.com/todd/narratorr/issues):

- **v0.1 - MVP Foundation** -- Complete (search, grab, activity, settings)
- **v0.2 - Metadata & Library** -- Audnexus integration, library management, author/book pages
- **v0.3 - Automation** -- Scheduled search, auto-grab, blacklist
- **v0.4 - Polish** -- File import, Audiobookshelf integration, author monitoring

## License

MIT

## Acknowledgments

- Inspired by [Sonarr](https://sonarr.tv/), [Radarr](https://radarr.video/), and [Readarr](https://readarr.com/)
- AudioBookBay scraping approach inspired by [audiobookbay-automated](https://github.com/JamesRy96/audiobookbay-automated)
