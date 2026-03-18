# Product Philosophy

## What Narratorr Is

Narratorr is an **audiobook acquisition and organization pipeline** — the Sonarr/Radarr for audiobooks. It finds audiobooks, downloads them, renames and organizes the files, and puts them in the right folder. That's it.

The workflow:

```
Search for a book → Add to library as "wanted"
  → Search indexers for releases → Grab a release
  → Download client handles the transfer
  → Narratorr renames and moves files to the library folder
  → Downstream media server picks them up → User listens
```

## What Narratorr Is Not

- **Not a media server.** Narratorr does not play audiobooks. Audiobookshelf, Plex, Jellyfin, or whatever the user prefers handles playback.
- **Not a library browser.** The library view exists to manage acquisition status (wanted, downloading, imported), not to be a rich browsing experience. The media server does that better.
- **Not an audiobook database.** Metadata is fetched from external providers to support search, matching, and file organization. Narratorr is not trying to be a metadata catalog.

## Where It Fits in the Stack

Narratorr occupies the same role as Sonarr/Radarr in a typical self-hosted media setup:

```
TV/Movies:   Sonarr  → qBit/SABnzbd → Sonarr renames/moves → Plex     → User watches
Audiobooks:  Narratorr → qBit/SABnzbd → Narratorr renames/moves → ABS/Plex → User listens
```

The app works end-to-end without a downstream media server. Some users will treat it as a managed downloader — add a book, let it download and organize, then delete the entry. That's a valid use case.

## Design Principles

### Platform-agnostic

Narratorr must not be coupled to any specific media server. The user could be running Audiobookshelf, Plex, Jellyfin, or nothing at all. Integration with downstream services happens through:

- **The library folder** — the shared contract. Narratorr writes files to a configured path; the media server watches that path.
- **Notifications / Connect** — generic webhooks, Discord, custom scripts. If a user wants Narratorr to trigger an ABS library scan after import, they configure a webhook notifier. Narratorr doesn't need to know it's ABS.
- **Configurable naming templates** — the folder structure is user-defined (`{author}/{title}`, `{author}/{series}/{title}`, etc.), not hardcoded to any platform's conventions.

### Follow *arr conventions

Users coming from Sonarr/Radarr/Lidarr have expectations about how an *arr app works. Narratorr should feel familiar:

- Indexers and download clients configured in Settings
- Search → grab → download → import pipeline
- Activity page showing download status
- Notification/Connect system for external integrations
- Library import via directory scan (point at a folder, import what's there)
- Quality awareness (size/hour, audio bitrate) for informed grabbing

Where *arr conventions exist, follow them. Don't reinvent patterns that users already understand.

### Proportional investment

Not every feature deserves the same depth. Narratorr is a download pipeline first. Features should be prioritized by how much they contribute to the core loop:

1. **Core loop** (search → grab → download → organize): This must be rock-solid.
2. **Library management** (status tracking, metadata, filtering): Important for avoiding duplicates and knowing what you have.
3. **Automation** (scheduled search, quality profiles, retry): What makes an *arr app an *arr app — set it and forget it.
4. **Polish** (notifications, directory import, documentation): Improves the experience but the app works without them.

### Data quality over data volume

Metadata from providers is noisy (see: genre normalization). The principle is: clean data in, clean data stored, context-appropriate display. Don't show the user 10 messy genres when 3 clean ones tell the story better. Don't throw away data that might be useful for filtering — just show the right amount in the right context.

### Extensibility through adapters

Indexers, download clients, metadata providers, and notifiers all follow the adapter pattern. Each type has an interface; implementations are pluggable. Adding a new indexer (Torznab), download client (Transmission), or notifier (Discord) means writing one adapter class that implements the interface. The rest of the system doesn't change.

This keeps the core thin and the integration surface wide.

