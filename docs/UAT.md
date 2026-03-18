# UAT Test Plan — Narratorr v1.0

Track progress by checking boxes. File bugs as you go — don't stop to fix mid-UAT.

**Legend:**
- `[P0]` — Release blocker. Must pass.
- `[P1]` — Important. Should pass, but workaround acceptable.
- `[P2]` — Nice to have. Won't block release.

---

## 1. Authentication & Authorization

### 1.1 First-Time Setup
- [ ] `[P0]` Fresh install (no users) → redirects to setup page
- [ ] `[P0]` Create first user with username/password → redirected to login
- [ ] `[P0]` Login with created credentials → lands on Library page
- [ ] `[P1]` Setup page not accessible after first user exists → returns error

### 1.2 Login / Logout
- [ ] `[P0]` Valid credentials → authenticated, redirected to Library
- [ ] `[P0]` Invalid credentials → error message, stays on login page
- [ ] `[P0]` Logout → redirected to login, can't access protected pages
- [ ] `[P1]` Rate limiting: 6th failed login within 15 min → 429 response
- [ ] `[P1]` Rate limit recovery: wait for window to expire → can login again
- [ ] `[P2]` Login with URL_BASE configured → redirect respects base path

### 1.3 Password Management
- [ ] `[P1]` Change password with correct current password → success
- [ ] `[P1]` Change password with wrong current password → error
- [ ] `[P1]` Login with old password after change → fails
- [ ] `[P1]` Login with new password after change → succeeds

### 1.4 API Key
- [ ] `[P1]` Regenerate API key → new key returned
- [ ] `[P1]` Old API key no longer works for API requests
- [ ] `[P1]` New API key works for API requests (X-Api-Key header)
- [ ] `[P2]` API key works as query parameter (?apikey=...)

### 1.5 Auth Modes
- [ ] `[P1]` Disable auth → all pages accessible without login
- [ ] `[P1]` Re-enable auth → redirected to login
- [ ] `[P0]` Health endpoint accessible without auth (`/api/health`)
- [ ] `[P0]` Status endpoint accessible without auth (`/api/auth/status`)

---

## 2. Settings & Configuration

### 2.1 Library Settings
- [ ] `[P0]` Set library path to valid directory → saves successfully
- [ ] `[P0]` Set library path to nonexistent directory → error message
- [ ] `[P1]` Folder format with all tokens ({author}/{title}) → preview shows expected path
- [ ] `[P1]` File format with tokens → preview shows expected filename
- [ ] `[P2]` Folder format with series tokens on non-series book → tokens omitted gracefully

### 2.2 Indexers
- [ ] `[P0]` Add Torznab indexer with valid URL + API key → saves, appears in list
- [ ] `[P0]` Test indexer connection → success message
- [ ] `[P0]` Test indexer with bad URL → failure message with details
- [ ] `[P1]` Add Newznab indexer → saves, appears in list
- [ ] `[P1]` Edit indexer URL → saves, re-test works
- [ ] `[P1]` Delete indexer → removed from list, no longer searched
- [ ] `[P1]` Disable indexer (toggle enabled) → not searched but still in list
- [ ] `[P1]` Add MAM indexer with API key → test passes
- [ ] `[P2]` Prowlarr sync: configure URL + key → indexers imported
- [ ] `[P2]` Prowlarr re-sync: new indexers added, removed ones deleted

### 2.3 Download Clients
- [ ] `[P0]` Add qBittorrent with valid host/port/credentials → saves
- [ ] `[P0]` Test download client connection → success message
- [ ] `[P0]` Test with wrong credentials → failure message
- [ ] `[P1]` Add SABnzbd with API key → saves, test passes
- [ ] `[P1]` Add Transmission with username/password → saves, test passes
- [ ] `[P1]` Fetch categories from client → dropdown populated
- [ ] `[P1]` Edit client settings → saves, re-test works
- [ ] `[P1]` Delete client → removed from list
- [ ] `[P2]` Add Deluge client → saves, test passes
- [ ] `[P2]` Add NZBGet client → saves, test passes
- [ ] `[P2]` Add Blackhole client with watch folder → saves

### 2.4 Notifications
- [ ] `[P1]` Add Discord webhook → saves, test sends message
- [ ] `[P1]` Add Slack webhook → saves, test sends message
- [ ] `[P1]` Configure notification events (on_grab, on_import, on_failure) → only selected events fire
- [ ] `[P1]` Edit notifier → saves
- [ ] `[P1]` Delete notifier → removed
- [ ] `[P2]` Add Pushover notifier → test sends push
- [ ] `[P2]` Add Gotify notifier → test sends message
- [ ] `[P2]` Add email notifier → test sends email
- [ ] `[P2]` Add generic webhook → test hits URL with correct payload

### 2.5 Import Lists
- [ ] `[P1]` Add AudiobookShelf import list → saves
- [ ] `[P1]` Preview import list items → shows books from source
- [ ] `[P1]` Import list sync adds wanted books to library
- [ ] `[P2]` Add NYT bestseller list → shows current bestsellers
- [ ] `[P2]` Add Hardcover list → shows items

### 2.6 Remote Path Mappings
- [ ] `[P1]` Add mapping (remote path → local path) for a download client
- [ ] `[P1]` Mapping applied during import (verify file found at local path)
- [ ] `[P1]` Edit mapping → new paths used
- [ ] `[P1]` Delete mapping → no longer applied

### 2.7 Quality Settings
- [ ] `[P1]` Set grab floor → search results below floor are filtered out
- [ ] `[P1]` Set min seeders → torrent results below threshold filtered
- [ ] `[P1]` Set protocol preference (usenet) → usenet results ranked higher
- [ ] `[P1]` Set reject words → matching results excluded from search
- [ ] `[P1]` Set required words → only matching results included
- [ ] `[P2]` Grab floor = 0 → no quality filtering applied

### 2.8 Search Settings
- [ ] `[P1]` Toggle search enabled → scheduled search starts/stops
- [ ] `[P1]` Change interval → next search runs at new interval
- [ ] `[P2]` Change blacklist TTL → expired entries cleaned up on next housekeeping

### 2.9 Processing Settings
- [ ] `[P1]` Enable processing with valid FFmpeg path → saves
- [ ] `[P1]` Enable processing with invalid FFmpeg path → validation error
- [ ] `[P2]` Set merge behavior → multi-file books merged on import
- [ ] `[P2]` Set output format → files converted on import
- [ ] `[P2]` Configure post-processing script → runs after import

### 2.10 Tagging Settings
- [ ] `[P1]` Enable tagging → imported books get metadata embedded
- [ ] `[P1]` Disable tagging → no tag changes on import
- [ ] `[P2]` Mode: populate_missing → only fills empty tag fields
- [ ] `[P2]` Mode: overwrite → replaces all tag fields
- [ ] `[P2]` Embed cover art toggle → cover art embedded/not embedded

### 2.11 Network Settings
- [ ] `[P2]` Configure HTTP proxy → indexer requests go through proxy
- [ ] `[P2]` Test proxy → success/failure message
- [ ] `[P2]` Invalid proxy URL → validation error

### 2.12 RSS Settings
- [ ] `[P1]` Enable RSS → periodic polling starts
- [ ] `[P1]` Disable RSS → polling stops
- [ ] `[P2]` Change interval → next poll at new interval

### 2.13 General Settings
- [ ] `[P1]` Change log level → takes effect immediately (no restart)
- [ ] `[P1]` Set recycle retention days → old entries purged after period
- [ ] `[P2]` Set recycle retention to 0 → deleted books permanently removed immediately

### 2.14 Discovery Settings
- [ ] `[P1]` Enable discovery → suggestions generated on next refresh
- [ ] `[P1]` Disable discovery → discover page hidden from nav
- [ ] `[P2]` Adjust weight multipliers → scoring changes reflected in suggestions

---

## 3. Search & Grab Pipeline

### 3.1 Manual Search (from Book Detail page)
- [ ] `[P0]` Click "Search" on a wanted book → results appear ranked by quality
- [ ] `[P0]` Results show: title, indexer, size, quality score, seeders (torrent), protocol icon
- [ ] `[P0]` Click "Grab" on a result → download starts, book status → downloading
- [ ] `[P0]` Grab shows in Activity page immediately
- [ ] `[P1]` Search for imported book → results shown, can grab upgrade
- [ ] `[P1]` Search returns no results → "No results found" message
- [ ] `[P1]` Search with all indexers disabled → appropriate error
- [ ] `[P1]` Reject words filter applied → matching results not shown
- [ ] `[P1]` Required words filter applied → only matching results shown
- [ ] `[P2]` Results sorted by quality score descending by default

### 3.2 Manual Search (from Search page — metadata search)
- [ ] `[P0]` Search by title → Audible results shown (cover, author, narrator, duration)
- [ ] `[P0]` Click "Add" on result → book created with status "wanted"
- [ ] `[P1]` Search by author name → author results shown
- [ ] `[P1]` Search by series name → series results shown
- [ ] `[P1]` Add book that already exists in library → error or duplicate warning
- [ ] `[P1]` Add book with "Search Immediately" enabled → search triggered after add
- [ ] `[P2]` Add book with "Monitor for Upgrades" enabled → flag set in DB

### 3.3 Scheduled Search (automatic)
- [ ] `[P0]` Enable search + set interval → search runs automatically at interval
- [ ] `[P0]` Scheduled search finds results for wanted books → grabs best match
- [ ] `[P1]` Scheduled search skips imported books (only searches wanted)
- [ ] `[P1]` Scheduled search skips books with active downloads
- [ ] `[P1]` Scheduled search logs activity (searchable in event history)
- [ ] `[P1]` Disable search → scheduled search stops running

### 3.4 RSS Feed Monitoring
- [ ] `[P1]` Enable RSS → polls indexer RSS feeds at configured interval
- [ ] `[P1]` RSS matches wanted book → auto-grabs
- [ ] `[P1]` RSS matches monitored book with better quality → grabs upgrade
- [ ] `[P1]` RSS matches monitored book with same/worse quality → skips
- [ ] `[P2]` Multi-part Usenet posts filtered out automatically
- [ ] `[P2]` RSS skips blacklisted releases

### 3.5 Quality Filtering & Ranking
- [ ] `[P1]` Grab floor filters results below threshold
- [ ] `[P1]` Min seeders filters torrents below threshold
- [ ] `[P1]` Protocol preference ranks preferred protocol higher
- [ ] `[P1]` Results with better title match ranked higher
- [ ] `[P2]` Tied results broken by MB/hr → seeders → protocol

### 3.6 Blacklist Behavior
- [ ] `[P1]` Failed download → release blacklisted automatically
- [ ] `[P1]` Blacklisted release not grabbed again on re-search
- [ ] `[P1]` Manual blacklist entry → blocks specific release
- [ ] `[P1]` Delete blacklist entry → release eligible again
- [ ] `[P2]` Toggle blacklist entry temporary/permanent → behavior changes
- [ ] `[P2]` Expired temporary blacklist entries cleaned up by housekeeping

---

## 4. Download Pipeline

### 4.1 Torrent Downloads
- [ ] `[P0]` Grab torrent → sent to torrent client, appears in client UI
- [ ] `[P0]` Download progress updates in Activity page (percentage, speed)
- [ ] `[P0]` Download completes → status changes to "completed"
- [ ] `[P1]` Magnet link grabs work correctly
- [ ] `[P1]` .torrent file (data: URI) grabs work correctly
- [ ] `[P1]` Download with category → placed in correct category in client
- [ ] `[P2]` Seed time enforced: torrent not removed until min seed time elapsed

### 4.2 Usenet Downloads
- [ ] `[P0]` Grab NZB → sent to usenet client, appears in client UI
- [ ] `[P0]` Download progress updates in Activity page
- [ ] `[P0]` Download completes → status changes to "completed"
- [ ] `[P1]` Download with category → placed in correct category in client

### 4.3 Blackhole Downloads
- [ ] `[P2]` Grab with blackhole client → file placed in watch folder
- [ ] `[P2]` Status immediately set to "completed" (handoff mode)
- [ ] `[P2]` Import triggered on next cycle

### 4.4 Download Monitoring
- [ ] `[P0]` Active downloads show real-time progress via SSE
- [ ] `[P0]` Nav badge shows count of active downloads
- [ ] `[P1]` Download stalls → status reflects stalled state
- [ ] `[P1]` Download client goes offline → appropriate error logged

### 4.5 Download Actions
- [ ] `[P0]` Cancel active download → removed from client, status → failed, book → wanted
- [ ] `[P1]` Retry failed download → new search triggered, new download started
- [ ] `[P1]` Delete download record → removed from activity list

### 4.6 Download Failure Scenarios
- [ ] `[P1]` Download client unreachable → grab fails with clear error message
- [ ] `[P1]` No download client configured → grab fails with "No download client" message
- [ ] `[P1]` Duplicate grab attempt → blocked with "already has active download"
- [ ] `[P2]` Download client auth failure → appropriate error (not generic 500)

---

## 5. Import Pipeline

### 5.1 Automatic Import (happy path)
- [ ] `[P0]` Download completes → quality gate runs → import starts automatically
- [ ] `[P0]` Files copied/moved to library path with correct folder structure
- [ ] `[P0]` Book status → "imported", download status → "imported"
- [ ] `[P0]` Book appears in Library page with correct metadata
- [ ] `[P0]` Cover art displayed on book card
- [ ] `[P1]` Event history records import event
- [ ] `[P1]` Notification sent (if configured for on_import)

### 5.2 Quality Gate
- [ ] `[P1]` New download, no existing book quality → auto-imports
- [ ] `[P1]` Upgrade download, better quality → auto-imports, replaces old files
- [ ] `[P1]` Upgrade download, same/worse quality → auto-rejected, blacklisted
- [ ] `[P1]` Quality unclear (narrator mismatch) → held for review
- [ ] `[P1]` Quality unclear (duration delta > 15%) → held for review
- [ ] `[P1]` Quality unclear (probe failure) → held for review
- [ ] `[P1]` Approve pending review → import proceeds
- [ ] `[P1]` Reject pending review → files deleted, release blacklisted

### 5.3 Import with Processing
- [ ] `[P1]` Processing enabled → audio files converted after import
- [ ] `[P1]` Merge enabled (multi-file) → files merged into single output
- [ ] `[P2]` Post-processing script runs after import
- [ ] `[P2]` Post-processing script timeout → script killed, import still succeeds
- [ ] `[P2]` Processing fails → error logged, original files preserved

### 5.4 Import with Tagging
- [ ] `[P1]` Tagging enabled → metadata embedded in audio files
- [ ] `[P1]` Cover art embedded (if embedCover enabled)
- [ ] `[P2]` populate_missing mode → existing tags preserved, only empty filled
- [ ] `[P2]` overwrite mode → all tags replaced with current metadata

### 5.5 Import Failure Scenarios
- [ ] `[P1]` Disk full → import fails with clear error, download marked failed
- [ ] `[P1]` Source files missing (deleted from client) → import fails with error
- [ ] `[P1]` Library path not writable → import fails with permission error
- [ ] `[P1]` Import failure → book status reverted to previous state
- [ ] `[P2]` Partial copy interrupted → cleanup removes partial files

### 5.6 Remote Path Mapping
- [ ] `[P1]` Download client in Docker, files at container path → mapping translates to host path
- [ ] `[P1]` SABnzbd full-path quirk → correctly split into savePath + name
- [ ] `[P2]` Missing mapping → import fails with "file not found" (not silent failure)

### 5.7 File Naming
- [ ] `[P1]` Folder format applied: files in `{author}/{title}/` structure
- [ ] `[P1]` File format applied: audio files renamed per template
- [ ] `[P1]` Series book: series/position tokens populated correctly
- [ ] `[P1]` Non-series book: series tokens omitted (no empty folders)
- [ ] `[P2]` Special characters in author/title → sanitized in path (no illegal chars)
- [ ] `[P2]` Very long title → truncated to safe path length

### 5.8 Delete After Import
- [ ] `[P1]` deleteAfterImport enabled → torrent/NZB removed from client after import
- [ ] `[P1]` deleteAfterImport disabled → torrent/NZB remains in client
- [ ] `[P1]` Torrent with minSeedTime > 0 → not removed until seed time elapsed

---

## 6. Library Management

### 6.1 Library Page — Display & Navigation
- [ ] `[P0]` Library page loads with all imported books
- [ ] `[P0]` Books display cover art, title, author, status badge
- [ ] `[P0]` Click book → navigates to book detail page
- [ ] `[P1]` Empty library → helpful empty state message
- [ ] `[P1]` Loading state → spinner shown while fetching

### 6.2 Filtering
- [ ] `[P0]` Filter by status: Wanted → only wanted books shown
- [ ] `[P0]` Filter by status: Imported → only imported books shown
- [ ] `[P1]` Filter by status: Downloading → only downloading books shown
- [ ] `[P1]` Filter by status: Missing → only missing books shown
- [ ] `[P1]` Filter by status: Failed → only failed books shown
- [ ] `[P1]` Filter by author → only that author's books shown
- [ ] `[P1]` Filter by series → only that series shown
- [ ] `[P1]` Filter by narrator → only that narrator's books shown
- [ ] `[P1]` Filter by genre → only that genre's books shown
- [ ] `[P1]` Combined filters → intersection applied (author + status)
- [ ] `[P1]` Filter dropdown options deduplicated case-insensitively
- [ ] `[P2]` Clear filters → all books shown again

### 6.3 Search & Sort
- [ ] `[P1]` Search by title → matching books shown
- [ ] `[P1]` Search by author → matching books shown
- [ ] `[P1]` Sort by title → alphabetical order
- [ ] `[P1]` Sort by date added → newest first
- [ ] `[P1]` Sort by author → alphabetical
- [ ] `[P2]` Sort direction toggle (asc/desc)

### 6.4 Pagination
- [ ] `[P1]` Large library (100+ books) → pagination controls shown
- [ ] `[P1]` Navigate pages → correct books displayed
- [ ] `[P1]` Filters + pagination → filtered results paginated correctly

### 6.5 Bulk Actions
- [ ] `[P1]` Select multiple books → bulk action bar appears
- [ ] `[P1]` Bulk delete → confirmation modal, books deleted
- [ ] `[P1]` Bulk search → search triggered for all selected wanted books
- [ ] `[P2]` Bulk retag → tagging triggered for all selected
- [ ] `[P2]` Select all → selects current page

### 6.6 Book Detail Page
- [ ] `[P0]` Shows: cover, title, author, narrator, duration, series, genres, description
- [ ] `[P0]` Shows: status badge, quality info (bitrate, format, channels)
- [ ] `[P0]` Shows: file path on disk (for imported books)
- [ ] `[P1]` Shows: download history (recent attempts)
- [ ] `[P1]` Shows: event history (all state transitions)
- [ ] `[P1]` Edit metadata → saves, page refreshes with new data
- [ ] `[P1]` Trigger search → search results modal opens
- [ ] `[P1]` Delete book → confirmation, removed from library
- [ ] `[P2]` Rename files → files renamed on disk per template
- [ ] `[P2]` Author name links to author detail page

### 6.7 Author Detail Page
- [ ] `[P1]` Shows: author name, description, image
- [ ] `[P1]` Shows: all books by this author in library
- [ ] `[P1]` Shows: series grouping (books organized by series)
- [ ] `[P2]` Series shows position numbers and gaps

### 6.8 Book Status Transitions
- [ ] `[P0]` New book added → status: wanted
- [ ] `[P0]` Download started → status: downloading
- [ ] `[P0]` Import complete → status: imported
- [ ] `[P1]` Download failed → status: failed (can retry)
- [ ] `[P1]` Imported book files deleted externally → rescan sets status: missing
- [ ] `[P1]` Missing book files restored → rescan sets status: imported
- [ ] `[P1]` Delete imported book → moves to recycling bin

---

## 7. Manual Import (Directory Import)

### 7.1 Scan Phase
- [ ] `[P1]` Browse filesystem → directory tree shown
- [ ] `[P1]` Select directory → scan discovers audio files
- [ ] `[P1]` Scan results show: folder path, file count, total size, detected author/title
- [ ] `[P1]` Empty directory → "No audio files found" message
- [ ] `[P2]` Nested directories → each subfolder treated as potential book

### 7.2 Match Phase
- [ ] `[P1]` Detected books matched against Audible metadata
- [ ] `[P1]` Match results show confidence level (high/medium/low/none)
- [ ] `[P1]` User can edit matched metadata before import
- [ ] `[P1]` User can change match (re-search with different query)
- [ ] `[P2]` Unmatched books can be imported with manual metadata entry

### 7.3 Import Phase
- [ ] `[P1]` Confirm import → files copied to library
- [ ] `[P1]` Progress indicator during import
- [ ] `[P1]` Import complete → books appear in Library page
- [ ] `[P1]` Duplicate detection: book already in library → warning shown
- [ ] `[P2]` Cancel import mid-process → partial imports cleaned up

---

## 8. Activity & Event History

### 8.1 Activity Page — Downloads Tab
- [ ] `[P0]` Active downloads show: title, progress bar, speed, ETA
- [ ] `[P0]` Progress updates in real-time (SSE)
- [ ] `[P0]` Completed downloads show: title, status, completion time
- [ ] `[P1]` Failed downloads show: title, error message, retry button
- [ ] `[P1]` Pending review downloads show: approve/reject buttons
- [ ] `[P1]` Cancel button on active downloads → cancels in client

### 8.2 Activity Page — History Tab
- [ ] `[P1]` Event history shows: timestamp, event type, book title, details
- [ ] `[P1]` Filter by event type (grab, import, search, failure)
- [ ] `[P1]` Search events by book title
- [ ] `[P1]` Pagination for large history
- [ ] `[P2]` Delete individual events
- [ ] `[P2]` Bulk delete events by type

### 8.3 Real-Time Updates (SSE)
- [ ] `[P0]` Download progress updates without page refresh
- [ ] `[P0]` Download completion reflected immediately in UI
- [ ] `[P1]` Book status changes reflected in Library without refresh
- [ ] `[P1]` Import progress shown in real-time
- [ ] `[P1]` SSE reconnects after network interruption
- [ ] `[P2]` Multiple browser tabs → all receive SSE updates

---

## 9. Discovery Engine

### 9.1 Suggestion Generation
- [ ] `[P1]` Discovery enabled + library has books → suggestions generated
- [ ] `[P1]` Suggestions based on: author affinity, series gaps, genre, narrator, diversity
- [ ] `[P1]` Suggestions show: cover, title, author, reason, confidence score
- [ ] `[P1]` No duplicate suggestions (already owned books excluded)
- [ ] `[P2]` Empty library → no suggestions (graceful empty state)

### 9.2 Suggestion Actions
- [ ] `[P1]` Accept suggestion → book added to library as "wanted"
- [ ] `[P1]` Dismiss suggestion → removed from list, affects future scoring
- [ ] `[P1]` Snooze suggestion → hidden for configured duration, reappears later
- [ ] `[P2]` Accepted book auto-searches if searchImmediately enabled

### 9.3 Suggestion Filtering
- [ ] `[P1]` Filter by reason (author/series/genre/narrator/diversity)
- [ ] `[P1]` Filter by author name
- [ ] `[P2]` Filters persist across page navigation

### 9.4 Refresh & Expiry
- [ ] `[P1]` Manual refresh → new suggestions generated
- [ ] `[P1]` Auto-refresh at configured interval
- [ ] `[P2]` Old suggestions (past expiry) automatically removed
- [ ] `[P2]` Snoozed suggestions reappear after snooze period

### 9.5 Series Completion
- [ ] `[P1]` Library has books 1,3,5 of series → suggests books 2,4
- [ ] `[P1]` Series gap suggestions scored highest
- [ ] `[P2]` Fractional series positions handled (1.5, 2.5)

### 9.6 Weight Tuning
- [ ] `[P2]` High dismissal rate for a reason → that reason's weight lowered
- [ ] `[P2]` Weight multipliers visible in discovery settings
- [ ] `[P2]` Manual weight adjustment → reflected in next refresh

---

## 10. System & Maintenance

### 10.1 Backups
- [ ] `[P0]` Manual backup → backup file created
- [ ] `[P0]` Download backup → valid file downloaded
- [ ] `[P0]` Restore from backup → database restored, app restarts cleanly
- [ ] `[P1]` Automatic backup at configured interval → backup files accumulate
- [ ] `[P1]` Backup retention → old backups pruned (keeps N most recent)
- [ ] `[P1]` Restore confirmation step (pending restore → confirm)

### 10.2 Health Checks
- [ ] `[P1]` Health page shows: indexer connectivity, download client connectivity
- [ ] `[P1]` Health page shows: library path accessible, disk space
- [ ] `[P1]` Failing health check → red indicator in nav
- [ ] `[P1]` Manual health check trigger → runs immediately
- [ ] `[P2]` Health endpoint returns correct status for Docker HEALTHCHECK

### 10.3 System Info
- [ ] `[P1]` Shows: app version, Node.js version, OS, DB size, disk free space
- [ ] `[P1]` Library path shown with free space
- [ ] `[P2]` Update available → notification shown (dismissible)

### 10.4 Recycling Bin
- [ ] `[P1]` Deleted books appear in recycling bin
- [ ] `[P1]` Restore book → files moved back, book re-created in library
- [ ] `[P1]` Restore blocked if original path occupied → error message
- [ ] `[P1]` Permanent delete from bin → files permanently removed
- [ ] `[P1]` Empty bin → all entries permanently deleted
- [ ] `[P2]` Auto-purge after retention period

### 10.5 Background Jobs
- [ ] `[P1]` System page shows all jobs with status (running/idle/last run time)
- [ ] `[P1]` Manually trigger any job → runs immediately
- [ ] `[P1]` Job already running → trigger blocked with message
- [ ] `[P2]` Job failure → error logged, next scheduled run unaffected

### 10.6 Library Rescan
- [ ] `[P1]` Trigger rescan → all book paths verified on disk
- [ ] `[P1]` Missing files detected → book status set to "missing"
- [ ] `[P1]` Files restored to original path → rescan sets status back to "imported"
- [ ] `[P2]` Rescan with large library → completes without timeout

---

## 11. Notifications

### 11.1 Event Coverage
- [ ] `[P1]` on_grab → notification sent when download grabbed
- [ ] `[P1]` on_import → notification sent when import completes
- [ ] `[P1]` on_failure → notification sent when download/import fails
- [ ] `[P2]` on_upgrade → notification sent when quality upgrade imported
- [ ] `[P2]` on_held_for_review → notification sent when download held

### 11.2 Notification Delivery
- [ ] `[P1]` Discord: message appears in configured channel
- [ ] `[P1]` Notification includes: book title, author, event type
- [ ] `[P2]` Multiple notifiers configured → all receive events
- [ ] `[P2]` One notifier fails → others still send (independent)

---

## 12. Docker & Deployment

### 12.1 Docker Compose
- [ ] `[P0]` `docker compose up` → app starts and is accessible on port 3000
- [ ] `[P0]` `/config` volume persists database across restarts
- [ ] `[P0]` `/audiobooks` volume maps to library path
- [ ] `[P0]` `/downloads` volume accessible for imports
- [ ] `[P1]` Container restarts cleanly after crash/kill
- [ ] `[P1]` Environment variables (CONFIG_PATH, DATABASE_URL) respected
- [ ] `[P2]` URL_BASE env var → app served at subpath

### 12.2 Health & Monitoring
- [ ] `[P0]` Docker HEALTHCHECK passes when app is running
- [ ] `[P1]` HEALTHCHECK fails when app is unresponsive → Docker marks unhealthy
- [ ] `[P2]` Graceful shutdown on SIGTERM (in-flight imports complete)

---

## 13. Edge Cases & Error Handling

### 13.1 Network Failures
- [ ] `[P1]` Indexer unreachable during search → error logged, other indexers still queried
- [ ] `[P1]` Download client unreachable during grab → clear error message to user
- [ ] `[P1]` Metadata API unreachable → graceful degradation (cached data used if available)
- [ ] `[P1]` SSE connection drops → client auto-reconnects
- [ ] `[P2]` Proxy misconfigured → requests fail with proxy error (not generic timeout)

### 13.2 Data Edge Cases
- [ ] `[P1]` Book with no cover art → placeholder/fallback image shown
- [ ] `[P1]` Book with very long title → truncated in UI, full title in detail
- [ ] `[P1]` Author with special characters (accents, unicode) → displayed correctly
- [ ] `[P1]` Series with fractional positions (1.5) → displayed and sorted correctly
- [ ] `[P2]` Book with no duration → quality calculations gracefully skip
- [ ] `[P2]` Multiple books by same author → author page aggregates correctly

### 13.3 Concurrent Operations
- [ ] `[P1]` Two searches for same book simultaneously → only one grab
- [ ] `[P1]` Import running + manual search → both work independently
- [ ] `[P1]` Multiple browser tabs → all show consistent state
- [ ] `[P2]` Delete book while it's being imported → handled gracefully

### 13.4 Disk & Storage
- [ ] `[P1]` Library disk full → import fails with clear error, no corrupt files left
- [ ] `[P1]` Download disk full → download client handles (not narratorr's concern)
- [ ] `[P2]` Very large library (1000+ books) → UI responsive, pagination works

### 13.5 Browser Compatibility
- [ ] `[P1]` Chrome (latest) → full functionality
- [ ] `[P1]` Firefox (latest) → full functionality
- [ ] `[P2]` Safari (latest) → full functionality
- [ ] `[P2]` Mobile browser → usable (responsive layout)

---

## 14. Upgrade & Migration

### 14.1 Fresh Install
- [ ] `[P0]` New install → setup wizard, database created, migrations run
- [ ] `[P0]` All settings have sensible defaults
- [ ] `[P0]` App usable after just: set library path + add indexer + add download client

### 14.2 Database Migrations
- [ ] `[P1]` Migrations run automatically on startup
- [ ] `[P1]` Failed migration → app fails to start with clear error (not silent corruption)

---

## Progress Tracking

| Section | P0 | P1 | P2 | Total | Done |
|---------|----|----|-------|-------|------|
| 1. Auth | 6 | 5 | 1 | 12 | |
| 2. Settings | 3 | 37 | 21 | 61 | |
| 3. Search & Grab | 5 | 17 | 6 | 28 | |
| 4. Downloads | 6 | 7 | 4 | 17 | |
| 5. Import | 5 | 19 | 6 | 30 | |
| 6. Library | 11 | 23 | 8 | 42 | |
| 7. Manual Import | 0 | 10 | 2 | 12 | |
| 8. Activity | 4 | 8 | 3 | 15 | |
| 9. Discovery | 0 | 11 | 8 | 19 | |
| 10. System | 2 | 14 | 5 | 21 | |
| 11. Notifications | 0 | 3 | 3 | 6 | |
| 12. Docker | 4 | 3 | 2 | 9 | |
| 13. Edge Cases | 0 | 10 | 5 | 15 | |
| 14. Upgrade | 1 | 2 | 0 | 3 | |
| 15. Bare Metal | 13 | 13 | 2 | 28 | |
| **TOTAL** | **60** | **182** | **76** | **318** | |

**Suggested UAT order (primary environment: Docker compose stack):**
1. Section 14 (Fresh Install) — start clean
2. Section 1 (Auth) — get logged in
3. Section 2 (Settings) — configure the app
4. Section 12 (Docker) — verify container behavior
5. Section 3 (Search & Grab) — core pipeline start
6. Section 4 (Downloads) — core pipeline middle
7. Section 5 (Import) — core pipeline end
8. Section 6 (Library) — verify results
9. Section 8 (Activity) — verify tracking
10. Section 7 (Manual Import) — alternate path
11. Section 9 (Discovery) — feature verification
12. Section 10 (System) — maintenance features
13. Section 11 (Notifications) — if configured
14. Section 13 (Edge Cases) — stress testing
15. **Section 15 (Bare Metal Cross-Check)** — verify non-Docker works

---

## 15. Bare Metal Cross-Check

Run the full UAT in Docker (your compose stack with qBittorrent, Prowlarr, NZBGet, etc.).
Then run ONLY these scenarios bare metal (`pnpm dev`) to confirm it works outside a container.
These cover the areas where Docker vs bare metal actually differ.

### 15.1 Startup & Database
- [ ] `[P0]` `pnpm dev` starts without errors
- [ ] `[P0]` Database created at default location (or CONFIG_PATH if set)
- [ ] `[P0]` Migrations run automatically on startup
- [ ] `[P0]` App accessible at `localhost:3000` (or configured port)
- [ ] `[P1]` App accessible at `localhost:5173` (Vite dev server, proxies API)

### 15.2 Filesystem Access
- [ ] `[P0]` Library path resolves correctly (no Docker volume translation needed)
- [ ] `[P0]` Filesystem browser (`/api/filesystem/browse`) shows host directories
- [ ] `[P0]` Import writes files to library path on host filesystem
- [ ] `[P1]` Permissions: app can read download client output directory
- [ ] `[P1]` Permissions: app can write to library directory
- [ ] `[P1]` Permissions: app can create/delete in recycle bin directory

### 15.3 Network & Service Connectivity
- [ ] `[P0]` Can reach indexers (Prowlarr/direct) from host network
- [ ] `[P0]` Can reach download clients from host network
- [ ] `[P1]` Metadata API (Audible/Audnexus) reachable from host
- [ ] `[P1]` No port conflicts with other local services

### 15.4 Core Pipeline Smoke Test
- [ ] `[P0]` Add a book via metadata search → status: wanted
- [ ] `[P0]` Search for the book → results appear
- [ ] `[P0]` Grab a result → download starts in client
- [ ] `[P0]` Download completes → import runs → book status: imported
- [ ] `[P0]` Imported files exist at expected library path on host
- [ ] `[P1]` SSE updates work (progress bar updates in browser)
- [ ] `[P1]` Notifications fire (if configured)

### 15.5 Path Handling (the big Docker vs bare metal difference)
- [ ] `[P0]` Download client paths are HOST paths (no remote path mapping needed)
- [ ] `[P0]` Import finds files at path reported by download client
- [ ] `[P1]` If download client is also bare metal → paths match directly
- [ ] `[P1]` If download client is in Docker but narratorr is bare metal → remote path mapping needed and works
- [ ] `[P1]` Library path uses native OS separators (backslash on Windows if applicable)

### 15.6 Environment Variables
- [ ] `[P1]` `CONFIG_PATH` → database and config stored at custom location
- [ ] `[P1]` `DATABASE_URL` → custom database path respected
- [ ] `[P2]` `URL_BASE` → app served at subpath
- [ ] `[P2]` `LOG_LEVEL` → log verbosity matches setting

### 15.7 Process Lifecycle
- [ ] `[P1]` Ctrl+C → graceful shutdown (no orphan processes)
- [ ] `[P1]` Restart after clean shutdown → picks up where it left off
- [ ] `[P1]` In-flight import during shutdown → handled gracefully on restart

### Bare Metal Cross-Check Summary

| Priority | Count |
|----------|-------|
| P0 | 13 |
| P1 | 13 |
| P2 | 2 |
| **Total** | **28** |

This brings the full UAT to **318 scenarios** (290 Docker + 28 bare metal cross-check).
