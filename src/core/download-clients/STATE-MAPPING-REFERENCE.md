# Download Client State Mapping Reference

Last updated: 2026-04-06

## Client Source Repos

When Radarr/Sonarr mappings seem suspect, check the actual client source:

- **qBittorrent**: https://github.com/qbittorrent/qBittorrent
- **Deluge**: https://github.com/deluge-torrent/deluge
- **SABnzbd**: https://github.com/sabnzbd/sabnzbd
- **Transmission**: https://github.com/transmission/transmission
- **NZBGet**: https://github.com/nzbgetcom/nzbget

This document captures the research behind our download client state mappings — what each client reports, how Radarr/Sonarr/Mylar handle it, and why we made specific choices. When future-you asks "why the fuck did we do it that way," start here.

## The Problem

Download clients report `progress: 100%` before files are actually ready for import. Two confirmed failure modes:

1. **SABnzbd post-processing**: History items report 100% progress during Extracting/Verifying/Repairing. Files don't exist at the output path yet.
2. **qBittorrent file moves**: When using separate incomplete/complete directories, qBT briefly enters `completed` state with `content_path` still pointing to the incomplete dir, then transitions to `moving`, then back to `completed` with the correct path.

The monitor (`monitor.ts`) was using `progress >= 1` alone to determine completion, ignoring the adapter's status. This fired the quality gate before files were ready.

## qBittorrent

### API: `/api/v2/torrents/info?hashes=<hash>`

### State machine (observed in live API testing, 2026-04-06)

The exact transient sequence below was observed empirically — qBT does not document this ordering.
**Important:** The `completed` label below is what we observed in the raw API `state` field, but
`completed` is NOT listed in qBT's official WebUI API state table. It may be an internal/transient
state, or it may have been our interpretation of the torrent being 100% with no `*DL`/`*UP` suffix.
The practical impact is the same — `content_path` was wrong during this phase.

```
downloading (content_path: /incomplete/file.m4b)
  → brief transient state, progress 1.0 (content_path: /incomplete/file.m4b)  ← DANGER: wrong path
  → moving    (content_path: /incomplete/file.m4b)   ← progress 1.0, wrong path
  → stalledUP/uploading (content_path: /complete/file.m4b) ← seeding, safe
```

Users without separate incomplete/complete dirs skip the moving phase entirely.

### States (from qBT API docs)

| State | Description | Our mapping |
|-------|-------------|-------------|
| `error` | Error occurred | `'error'` |
| `missingFiles` | Data files missing | `'error'` |
| `uploading` | Seeding, data transferring | `'seeding'` |
| `pausedUP` | Paused, finished downloading (qBT <5) | `'seeding'` |
| `stoppedUP` | Stopped, finished downloading (qBT 5+) | `'seeding'` |
| `queuedUP` | Queued for upload | `'seeding'` |
| `stalledUP` | Seeding, no connections | `'seeding'` |
| `forcedUP` | Force-seeding | `'seeding'` |
| `checkingUP` | Finished, being rechecked | `'downloading'` |
| `allocating` | Allocating disk space | `'downloading'` |
| `downloading` | Actively downloading | `'downloading'` |
| `metaDL` | Fetching metadata | `'downloading'` |
| `forcedMetaDL` | Force-fetching metadata | `'downloading'` |
| `pausedDL` | Paused, not finished (qBT <5) | `'paused'` |
| `stoppedDL` | Stopped, not finished (qBT 5+) | `'paused'` |
| `queuedDL` | Queued for download | `'downloading'` |
| `stalledDL` | Downloading, no connections | `'downloading'` |
| `checkingDL` | Being checked, not finished | `'downloading'` |
| `forcedDL` | Force-downloading | `'downloading'` |
| `checkingResumeData` | Checking resume data on startup | `'downloading'` |
| `moving` | Moving to another location | `'downloading'` |
| `unknown` | Unknown | `'error'` |

### Path validation (our heuristic)

Even when state is a `*UP` (seeding) state, validate `content_path` starts with `save_path`. If it doesn't, the move hasn't completed — return `'downloading'`.

Radarr/Sonarr do `contentPath !== savePath` as a sanity check (if they're equal, something's wrong — `savePath` is the directory, `contentPath` should include the filename). We use `content_path.startsWith(save_path)` to catch the incomplete→complete move case. **Note:** This prefix check is our design choice — the upstream API documents both fields but does not define containment semantics or endorse any specific comparison algorithm.

**Implementation note:** The `startsWith` check must use normalized paths (trailing slashes, consistent separators) to avoid false negatives. Also beware sibling-path false positives (e.g., `/complete-old` starts with `/complete` as a raw string). Use `path.resolve()` and ensure a path separator follows the prefix.

### Radarr/Sonarr differences from us

- They have `Warning` and `Queued` statuses we don't. We use `'downloading'` for both.
- They map `stalledDL` to `Warning` (no peers). We map to `'downloading'` — functionally safe.
- They map `checkingUP` to `Queued`. We map to `'downloading'` — both prevent premature completion.

### `content_path` history

[qBittorrent PR #13625](https://github.com/qbittorrent/qBittorrent/pull/13625) added `content_path` to the WebUI API in v2.6.1 (merged Oct 2020, released in 4.3.1). During review, maintainers noted the `actual` parameter (real save path from libtorrent) "should not be used as it's intended for incomplete torrents using temporary folders" — confirming the field was designed with the incomplete/complete distinction in mind.

### `stoppedUP` / `stoppedDL` documentation gap

qBT 5 renamed `pausedUP` → `stoppedUP` and `pausedDL` → `stoppedDL`. The official wiki state table hasn't been updated to include these, but the qBT issue tracker confirms the change. Our mappings are based on issue-tracker evidence, not the current wiki.

### References
- [Radarr qBT adapter](https://github.com/Radarr/Radarr/blob/develop/src/NzbDrone.Core/Download/Clients/QBittorrent/QBittorrent.cs)
- [Sonarr qBT adapter](https://github.com/Sonarr/Sonarr/blob/v5-develop/src/NzbDrone.Core/Download/Clients/QBittorrent/QBittorrent.cs)

---

## SABnzbd

### API: Queue (`/api?mode=queue`) and History (`/api?mode=history`)

### Post-processing states

History items can have these statuses while still processing:
- `Queued`, `QuickCheck`, `Fetching`, `Moving`, `Extracting`, `Verifying`, `Repairing`, `Running`

These are observed to report `progress: 100` because the download transfer is complete — it's post-processing that's ongoing. SABnzbd's docs confirm these are valid history statuses, though the "progress stays at 100 during post-processing" behavior is observed, not explicitly documented upstream.

### Our mapping

- `Completed` → `'completed'`
- `Failed` → `'error'`
- Everything else → `'downloading'`

### Radarr/Sonarr approach (identical to ours)

```csharp
if (status == Failed) → Failed (with special Warning case for disk-full unpack)
else if (status == Completed) → Completed
else → Downloading  // "Verifying/Moving etc"
```

### Mylar approach

Mylar explicitly lists the post-processing states and implements adaptive waiting:
```python
if status in ['Queued', 'Moving', 'Extracting', 'QuickCheck', 'Repairing', 'Verifying']:
    delay = bytes / 25MB + 2  # add retries proportional to file size
```

We don't need adaptive delay since we poll every 30s, but this confirms the states are real.

### References
- [Radarr SABnzbd adapter](https://github.com/Radarr/Radarr/blob/develop/src/NzbDrone.Core/Download/Clients/Sabnzbd/Sabnzbd.cs)
- [Sonarr SABnzbd adapter](https://github.com/Sonarr/Sonarr/blob/v5-develop/src/NzbDrone.Core/Download/Clients/Sabnzbd/Sabnzbd.cs)
- [Mylar3 SABnzbd](https://github.com/mylar3/mylar3/blob/master/mylar/sabnzbd.py)

---

## NZBGet

### API: JSON-RPC (`listgroups` for queue, `history` for completed)

### History status model

NZBGet uses a degradation model — multiple post-processing fields that each indicate pass/fail:

| Field | Success values | Failure meaning |
|-------|---------------|-----------------|
| `Status` | `SUCCESS/*` | `FAILURE/*` or `DELETED/*` |
| `ParStatus` | `SUCCESS`, `NONE` | Par repair failed |
| `UnpackStatus` | `SUCCESS`, `NONE` | Unpack failed (`SPACE` = disk full) |
| `MoveStatus` | `SUCCESS`, `NONE` | File move incomplete |
| `ScriptStatus` | `SUCCESS`, `NONE` | Post-processing script failed |
| `DeleteStatus` | (empty) | `HEALTH`, `DUPE`, `SCAN`, `COPY`, `BAD` = failed; others = warning |

### Our mapping (needs fixing)

Current code defaults unknown history status to `'completed'` (line 259) — same bug as old SABnzbd. Should default to `'downloading'`.

Should also check `ParStatus`, `UnpackStatus`, `MoveStatus` for degradation.

### Radarr/Sonarr approach

Start as completed, degrade through each check:
```
ParStatus not success → Failed
UnpackStatus == SPACE → Warning
UnpackStatus not success → Failed
MoveStatus not success → Warning
ScriptStatus not success → Failed
DeleteStatus not success → Failed or Warning depending on value
```

**Note:** The degradation field names (`ParStatus`, `UnpackStatus`, `MoveStatus`, `ScriptStatus`, `DeleteStatus`) and their allowed values are derived from Radarr/Sonarr implementations and NZBGet changelogs. NZBGet does not publish a single clean reference table for all fields — treat this as implementation research, not an upstream-certified spec.

### References
- [Radarr NZBGet adapter](https://github.com/Radarr/Radarr/blob/develop/src/NzbDrone.Core/Download/Clients/Nzbget/Nzbget.cs)
- [Sonarr NZBGet adapter](https://github.com/Sonarr/Sonarr/blob/v5-develop/src/NzbDrone.Core/Download/Clients/Nzbget/Nzbget.cs)

---

## Deluge

### API: JSON-RPC (`web.get_torrent_status`)

### Completion model

Radarr/Sonarr/Mylar all use the `is_finished` boolean from Deluge's API, NOT the state string:

```
Error → error
IsFinished && state !== Checking → completed
Queued → downloading
Paused → paused
Everything else → downloading
```

### Moving state

Deluge **does** have a `Moving` state — contrary to earlier assumptions. From [deluge/core/torrent.py](https://github.com/deluge-torrent/deluge/blob/develop/deluge/core/torrent.py):

```python
elif status.moving_storage:
    self.state = 'Moving'
```

This is triggered during `move_storage()` operations (e.g., move-on-complete). The `is_finished` flag remains true during moves, so Radarr/Sonarr's `IsFinished && state !== Checking` check would still report completed during a move. This means our adapter should also check for the `Moving` state explicitly and return `'downloading'` — same as we do for qBT's `moving`.

Full state list from Deluge source:
- `Checking` (queued_for_checking, checking_files, checking_resume_data)
- `Downloading` (downloading_metadata, downloading)
- `Seeding` (finished, seeding)
- `Allocating`
- `Queued` (paused + auto_managed)
- `Paused`
- `Error` (forced_error or libtorrent error)
- `Moving` (moving_storage)

### References
- [Radarr Deluge adapter](https://github.com/Radarr/Radarr/blob/develop/src/NzbDrone.Core/Download/Clients/Deluge/Deluge.cs)
- [Sonarr Deluge adapter](https://github.com/Sonarr/Sonarr/blob/v5-develop/src/NzbDrone.Core/Download/Clients/Deluge/Deluge.cs)
- [Mylar3 Deluge adapter](https://github.com/mylar3/mylar3/blob/master/mylar/torrent/clients/deluge.py)
- [Deluge torrent.py source](https://github.com/deluge-torrent/deluge/blob/develop/deluge/core/torrent.py)

---

## Transmission

### API: RPC (`torrent-get`)

### Status codes

| Code | Name | Description |
|------|------|-------------|
| 0 | `Stopped` | Torrent stopped |
| 1 | `CheckWait` | Waiting to check files |
| 2 | `Check` | Checking files |
| 3 | `DownloadWait` | Queued for download |
| 4 | `Download` | Downloading |
| 5 | `SeedWait` | Queued for seeding |
| 6 | `Seed` | Seeding |

### Completion model (Radarr/Sonarr)

```
errorString not empty → error
totalSize == 0 → downloading (no metadata yet)
leftUntilDone == 0 AND (Stopped OR Seeding OR SeedWait) → completed/seeding
isFinished AND NOT (Check OR CheckWait) → completed
Queued → downloading
Everything else → downloading
```

### Key insight

Radarr/Sonarr check `leftUntilDone` (remaining bytes), not just progress percentage. This is more reliable — progress can round to 100% before the last piece is written.

Transmission does not have a qBT-style `moving` state. However, it **does** support separate incomplete/complete directories via `incomplete-dir-enabled` and `incomplete-dir` session settings (since Transmission 1.80). When enabled, files download to the incomplete dir and are moved to the final location on completion. Unlike qBT, there's no documented transient state during this move — the torrent transitions directly between download and seed states.

### `isFinished` semantics

[Transmission Issue #6268](https://github.com/transmission/transmission/issues/6268): `isFinished` does **not** mean "download complete." A maintainer closed the issue as invalid, indicating the behavior is by design. The field appears to track whether seeding goals (ratio/idle limits) have been met, not whether bytes have been downloaded. Torrents with `leftUntilDone: 0` (fully downloaded) can have `isFinished: false`. **Takeaway:** Don't use `isFinished` as the sole completion check — `leftUntilDone === 0` is the reliable signal for download completion.

### References
- [Radarr Transmission adapter](https://github.com/Radarr/Radarr/blob/develop/src/NzbDrone.Core/Download/Clients/Transmission/TransmissionBase.cs)
- [Sonarr Transmission adapter](https://github.com/Sonarr/Sonarr/blob/v5-develop/src/NzbDrone.Core/Download/Clients/Transmission/TransmissionBase.cs)
