# Companion EPUB Support for Narratorr

**Revision:** v4 · 2026-07-25 · supersedes v3 (same day), v2 (same day), v1 (2026-07-20)
**Status:** Issue-ready. **No open decisions.** Targeted at **1.0**.
**Archives:** v1 at `.scratch/archive/companion-ebook-support-v1-2026-07-20.md`. v2 and v3 were
overwritten in place; their content is reconstructable from `.scratch/PLAN-REVIEW-v2.md`, which quotes
every section of v2 under review.
**Reviews folded in:** `.scratch/PLAN-REVIEW.md` (v1, 12 lenses) and `.scratch/PLAN-REVIEW-v2.md`
(v2, 12 lenses cross-model: 6 Claude + 6 Codex `gpt-5.6-sol` @ xhigh — 20 must-resolve,
28 should-consider, 8 optional). Findings cited as **[R2-n]**.

Every `file:line` was verified against the working tree on 2026-07-25. Four claims were established by
**running code**, not reading it, and are marked **[reproduced]**.

---

## What v4 changed, and why

v3 cleared all 20 review blockers but was over-built. A design pass — mocking the UI into the running
app, and asking what each mechanism actually buys — cut roughly a third of it. Nothing here was found
by the review; the review was checking whether mechanisms matched the claims the plan made, never
whether the claims were warranted.

**1. Security posture is now proportionate.** v3 specified `lstat` → no-follow open → `fstat` →
dev/ino equality → realpath containment → stored-fingerprint match → close ceremony on every read. The
762 MB audiobook in the same folder gets `access()` once every six hours and **nothing** at serve time.
Cut to two checks — reject non-regular files, verify containment — which happen to be the only two
that stand between an attacker and `/config`. §5. **[R2-6, R2-18 dissolved]**

**2. The archive reader is just `unzipper.Open.file()`.** The hand-rolled `FileHandle` adapter existed
only to bind reads to one descriptor for TOCTOU. With that requirement gone, so is the adapter — and
so is the empirical bug it carried, where `Open.custom()` over `createReadStream` dies after one entry.
An entire issue disappears. §4. **[R2-1 dissolved] [reproduced]**

**3. The table went from sixteen columns to nine.** The stream validates the live file, so the row is
a display cache, not an authority — which makes a batch counter, a failure counter, two scan
timestamps, and a path snapshot unnecessary. Cutting `exposure_generation` dissolves the review's
joint-strongest finding (12/12 lenses said it had nowhere valid to live). §2. **[R2-15 dissolved]**

**4. The staleness ceiling is cut — but not for the reason v4 first gave.** v4 argued redundancy: an
unreachable mount flips the book to `missing`, so the predicate's status term kills exposure first.
**#1955 deliberately stopped that flip** — a transient errno now performs no `books` write at all — so
the redundancy argument does not hold. #1958 shipped the cut anyway on better grounds, pinned in a
test: the stale window is **accepted**, because the failure is a clean `404
companion_epub_unavailable` at click time, it self-heals on the next reconcile, and during such an
outage the audiobook is unreachable too, so a stale ebook badge is not a distinct harm.
**[R2-14 accepted, not subsumed]**

**5. The panel is five states, headed "Ebook".** Down from eight rendered cards. `ineligible` was
three unreachable reasons plus a misconfiguration plus one the import scanner cannot produce;
`stale` and `degraded` were modifiers wearing state costumes; a path block duplicated the `LOCATION`
card beside it. `ambiguous` became a picker rather than a refusal. §7. **[R2-112]**

**6. The source breadcrumb is cut** — ten findings with it. §9. **[R2-2, R2-16, R2-19, R2-26, R2-33,
R2-36, R2-109, R2-110, R2-113]**

**7. Two things a real EPUB taught us**, once one book was imported. `META-INF/encryption.xml` with
Adobe font obfuscation is routine and readable — rejecting on its presence would have marked the first
book in the library `invalid`, so `drm_protected` is now a distinct status classified by *what* is
encrypted. And cheerio's `xmlMode` resolves no entities at all, verified against XXE and
billion-laughs payloads, so the parser choice *is* the defence. §4. **[reproduced]**

**8. The consumer ruled on the one bilateral question** — search-result-only; the top-level DTO field
ships as pinned-but-dormant substrate. Todd's veto remains open. §Decisions. **[R2-3]**

Net: **nine issues** (one Phase-0 prerequisite plus eight), no open decisions.

---

## Decision

Build this, holding a hard product boundary: **Narratorr supports a companion EPUB attached to an
existing imported audiobook; it does not acquire ebooks.** Narratorr Requests remains the
family-facing application. There is no third app and no ebook-only record.

The audiobook record already owns the identity, final library folder, cover, metadata, and
media-server refresh lifecycle; Requests already owns family authentication and delivery. A sidecar
ebook application would duplicate both.

**"Companion EPUB" is internal vocabulary.** It names the product boundary — subordinate to an
audiobook, EPUB-only — and it is the right term in this document, in issue bodies, and in the
`companionEbook` API field, which is a pinned cross-repo contract. It appears **nowhere in the user
interface**: the panel is headed *Ebook*, the settings section is *Ebooks*, and the format is named
only when something is wrong. The feature defaults off and ships in two phases: Narratorr first
(feature off), Requests second.

---

## Product invariant

Every companion EPUB is subordinate to one existing Narratorr audiobook record.

- No ebook-only books, monitoring, metadata matching, search queue, download jobs, or
  wanted/missing lifecycle.
- Narratorr never searches for, selects, grabs, converts, or independently imports an EPUB.
- **Automatic and manual audiobook imports remain audio-only.** Narratorr observes and serves one
  valid EPUB already present at the top level of the final audiobook folder.
- The EPUB is a foreign, user-owned file. Narratorr does not rename its basename, modify its
  contents, replace it, or delete it.
- Whole-folder operations carry foreign files when the directory is reorganized — existing container
  behavior, not ebook management.
- Deletion, wrong-release handling, reimport cleanup, and managed-file cleanup preserve EPUBs.
- EPUB only. MOBI, AZW, PDF, conversion, DRM removal, Calibre, and a browser reader are out of scope.

### The honest note about supply — corrected [R2-9]

v2 got this wrong in four particulars, all in the direction of making the gap look smaller. The
corrected picture:

- `deleteAfterImport` **does** cause a filesystem delete. `src/core/download-clients/types.ts:57` is
  `removeDownload(id, deleteFiles?)` and `src/server/services/torrent-removal.helpers.ts:74` passes
  **`true`** — the client deletes the data, EPUB included.
- Narratorr also deletes it **itself**: `torrent-removal.helpers.ts:143` runs
  `rm(outputPath, { recursive: true, force: true })` inside the Narratorr process. This does **not**
  route through the managed-file classifier.
- The maintenance cron is `*/5 * * * *` (`src/server/jobs/index.ts:100`) — five minutes, not the
  sixty seconds v2 claimed. That figure came from a stale doc comment at `import.service.ts:327`
  *(file it as a drive-by)*.
- Usenet is **never** seed-gated: `src/server/utils/seed-helpers.ts:27` returns `false` for
  non-torrent, so removal is immediate rather than deferred.
- Worse for ordering: `import.service.ts:221-223` awaits `handleTorrentRemoval` **inside**
  `importDownload()`, before it returns, and `auto.ts:40` awaits that. So for a usenet auto-import
  with the setting on, **the source is already gone before any post-import hook runs.** [R2-2b]

What genuinely survives from v2's analysis: `deleteAfterImport` **defaults to `false`**
(`src/shared/schemas/settings/import.ts:4`), so on a default configuration nothing above fires and
the source persists indefinitely. And the *import-time* `move` cleanup at
`import-orchestration.helpers.ts:347-353` really does preserve a co-located `.epub` — that is a
different code path from torrent removal, and v2 conflated the two.

**Net:** the owner's only supply route is placing the file themselves, nothing tells them the
release contained one, and with `deleteAfterImport` on it is destroyed within minutes. The breadcrumb
that was supposed to mitigate this is **cut** (§9) — it was weakest precisely in the case that
motivated it. What remains is honest `unavailable` copy plus an `info` log line at import when a
co-located `.epub` is dropped. State the limitation plainly rather than implying coverage.

---

## Architecture

- **Narratorr** discovers, validates, records, and securely streams a companion EPUB beside an
  imported audiobook, and shows the owner its state.
- **Narratorr Requests** annotates its existing search results with companion availability, proxies
  the EPUB stream same-origin, stores each user's Kindle address, and sends via a designated SMTP
  notifier.
- **Audiobookshelf** stays downstream and is *not* the ebook backend. No companion→connector refresh
  ships: `ConnectorReason` (`src/core/connectors/types.ts:59`) is a closed union with no fitting
  member and nothing in the delivery path routes through ABS.

The browser never receives a Narratorr API key or a filesystem path.

---

# Phase 1 — Narratorr

## 1. Feature setting

One owner-controlled value: `companionEpub.enabled: boolean`, default `false`.

A settings **registry category** (`src/shared/schemas/settings/registry.ts:19-96` — `defineCategory`
derives the schema map, defaults, form schema, and `SETTINGS_CATEGORIES` from one entry), **rendered
as its own section inside the General settings tab**, alongside Library, Naming, Import, Network,
Discovery and Appearance (`src/client/pages/settings/GeneralSettings.tsx`). A top-level tab for one
checkbox isn't warranted.

*Corrected after #1958 shipped: there is no "Library settings tab". `GeneralSettings.tsx` is the
General tab and Library is one section within it. The implementation read the intent correctly and
mounted Ebooks as a peer section at `GeneralSettings.tsx:41`, between Discovery and Appearance.*

Adding a category trips two existing tests — `registry.test.ts:65` hard-codes the category list and
asserts set equality, and `create-mock-settings.fixtures.test.ts` iterates `SETTINGS_CATEGORIES`.
Both must be updated in the same issue. [R2-38]

When disabled: discovery and validation are no-ops; owner panels are hidden; the public capability
reports `false`; public companion fields are `null`; the stream returns `409
companion_epub_disabled`; files and observation rows are untouched.

Enabling bumps the **exposure generation** (§2) in the same transaction as the flag write and
enqueues one coalesced full reconciliation. **Precision v2 got wrong:** existing observations may
render in the *owner panel* while that runs, but **public exposure stays dark until reconciled** —
these are different rules and v2 stated one for both. [R2-15]

## 2. Data model

A one-to-one `companion_ebooks` table keyed by `book_id`, cascading FK to `books.id`.

The separate table remains right (v1 **D-1**, 11/12 then, unchallenged by all twelve lenses now):
`books` is written by five paths doing partial-column updates; `book-list.service.ts:151-158` selects
via `getTableColumns(books)` and `getSlimBookColumns()` exists *because* the team already had to shed
columns from list projections; and the payload is a five-state observation with provenance and two
distinct timestamps. *[Corrected 2026-07-29, #1966: this sentence predated the `drm_protected`
split and said "four-state"; the §2 column table and Decision 7's five-value list were always the
authority and win over any prose count.]*

| Column | Notes |
|---|---|
| `book_id` | PK, FK to `books.id` ON DELETE CASCADE |
| `status` | `available \| none \| ambiguous \| invalid \| drm_protected` |
| `filename` | nullable; a top-level basename only, never a path |
| `size_bytes` · `mtime_ms` · `ctime_ms` | nullable; the fingerprint |
| `validation_code` | nullable; drives the "not readable" sentence |
| `candidate_count` | integer; drives the "N found" pill |
| `selected_filename` | nullable; the owner's pick when more than one candidate exists |
| `created_at` / `updated_at` | standard |

Nine columns. v3 had sixteen. What went, and why:

- **`exposure_generation`** — a batch number bumped on feature re-enable so every old row is ignored
  until rescanned. But the stream opens and validates the live file, so a stale row cannot serve wrong
  bytes; all the generation ever prevented was a briefly-wrong badge in the minutes before a rescan
  finishes, on a feature that ships off by default. Cutting it also dissolves the review's
  joint-strongest finding — twelve of twelve lenses said it had no valid storage home. The cleanest
  fix for a mechanism with nowhere to live is to not need it. [R2-15]
- **`consecutive_failure_count` + the staleness ceiling** — restored in v3 from v1's D-8 to stop a
  dead observation advertising forever, then cut. **Note the original justification was wrong:** it
  claimed redundancy because an unreachable mount flips the book to `missing`, but #1955 exists
  precisely to stop that flip, so the status term does not cover the case. The cut still stands on the
  ground #1958 shipped and pinned in a test — the stale window is *accepted*: a clean
  `404 companion_epub_unavailable` at click time, self-healing on the next reconcile, and during the
  outage the audiobook is unreachable too. [R2-14 accepted]
- **`last_scan_attempt_at`** — its only consumer was the degraded indicator, which the design pass
  deleted. A column nothing reads.
- **`last_successful_scan_at`** — diagnostic only, and `updated_at` already answers "when did we last
  write this?"
- **`book_path_snapshot`** — caught a moved book folder, which the fingerprint already catches: a
  different file at the new path means size/mtime/ctime disagree, so it 404s and the next scan
  repairs.
- **`format`** — a single-value enum carries no information. The public DTO still emits the `"epub"`
  literal because Requests pinned the object shape.
- **`source_hint_*`** — the breadcrumb, cut (see the decision log).

**The fingerprint is the one thing worth defending.** Without `size`/`mtime`/`ctime`, every six-hourly
rescan re-opens and re-parses every EPUB in the library. Three integers buys the short-circuit.
`ctime_ms` specifically matters because a same-path replacement preserving size *and* mtime —
`cp -p`, `rsync --times`, an edit inside one mtime tick — would otherwise never be revalidated, and
unvalidated bytes would inherit an `available` observation. [R2-13]

**No `source`/`provider`/`download_id`/`managed` column.** The seam for a future stager is a service
call, not a column.

**`ctime_ms` is load-bearing, not decoration.** Without it, a same-path replacement preserving size
and mtime — `cp -p`, `rsync --times`, an in-place edit inside one mtime tick, or a deliberate swap —
satisfies both the short-circuit and the resolver and is **never structurally revalidated**.
Unvalidated bytes would then inherit an `available` observation and stream to a Kindle. An in-place
overwrite still bumps ctime; an atomic rename changes it too. `dev`/`ino` are deliberately **not**
persisted — they belong to the within-request race check (§5), which stores nothing, and their
behavior on a Docker bind mount is unanalyzed. [R2-13]

**No `format` column** — a single-value enum carries no information. The public DTO still emits the
`"epub"` literal because Requests pinned the object shape.

**No `source` / `provider` / `download_id` / `managed` column.** The seam for a future stager is a
service call, not a column.

CHECK constraints enforce per-status field combinations, **written in never-NULL boolean form** —
SQLite treats a `NULL` CHECK predicate as satisfied, so the naive form lets half-set rows through
(`narratorr-requests/src/db/schema.ts:62-70` already learned this).

`ineligible` is **not** stored and has **no user-facing surface** (§7) — the eligibility guard lives
in code only, and the panel is absent when the feature does not apply. **Reachability
must be fixed:** §1 hides the panel when disabled and §7 shows it only on imported, folder-backed
books, which makes four of five reasons unrenderable. Resolve by showing the panel on **every** book
detail whenever the feature is enabled — keeping `book_not_imported`, `no_path`, and `file_backed`
reachable — and dropping `feature_disabled` from the vocabulary. [R2-112]

**Migration mechanics.** `src/db/schema.ts` uses `check()` zero times today, and Drizzle emits no
DB-level CHECK, so this needs `pnpm exec drizzle-kit generate --custom` with
`--> statement-breakpoint` separators. **`git add drizzle/` in full** — SQL + `_journal.json` +
`<N>_snapshot.json` — or CI skips the migration while local tests pass. Relevant learnings:
`drizzle-sqlite-text-enum-no-db-check`, `drizzle-migration-prompt-hang`. [R2-28]

**FK cascade — rationale corrected.** v2 claimed the cascade is inherited-by-assumption because
`src/db/client.ts` sets no `PRAGMA foreign_keys`. The curated learning
`libsql-foreign-keys-on-by-default` (files: `src/db/client.ts`) says the opposite and was verified
empirically, and `AUTOINCREMENT` (`drizzle/0000_baseline.sql:70`) guarantees rowids are never reused.
Keep the test; restate the rationale as **orphan-row accumulation and regression protection against a
client change**, and list that learning. Left as written, `/elaborate` would inject a learning that
contradicts the spec body and `$review-spec` would correctly bounce it. [R2-16]

## 3. Eligibility and discovery

Eligible when: the feature is enabled; `book.status === 'imported'`; `book.path` resolves to a
**directory**; and that directory is contained by the library root.

Stated as **file-vs-directory, not pointer-vs-copy** — pointer/adopt imports persist the source path
verbatim, so "was this copied?" is unanswerable from the row, and a pointer can point at a directory.

For an eligible directory: inspect **only** top-level entries; match `.epub` case-insensitively;
ignore dotfiles and temp names; reject symlinks and non-regular files (`lstat`, no follow); zero →
`unavailable`; more than one → `ambiguous`, **never guessing**; exactly one → structurally validate,
then `available` or `invalid` with a code.

## 4. Validation, limits, and the archive read primitive

### Reading the archive — use the library normally

`unzipper.Open.file(path)`. That is the library's own supported entry point and it works because it
opens a fresh stream per entry.

**Do not hand-roll a `FileHandle` adapter.** v3 mandated `Open.custom()` over an already-open handle
to bind every read to one file descriptor for TOCTOU reasons. That requirement is gone (§5), and the
adapter it forced was empirically broken anyway — `Open.custom()` over
`filehandle.createReadStream` reads exactly one entry and then the descriptor is dead (`fh.fd = -1`,
`EBADF`), because unzipper's `PullStream` destroys every bounded range stream it creates. Reproduced
against the pinned `unzipper@0.12.3`; script kept at `.scratch/unzip-repro.mjs` as a cautionary note.
A positional-read adapter *does* work, and was verified against the real 2.06 MiB EPUB in the library
(71 entries, four reads, one handle) — but with the TOCTOU requirement dropped there is no reason to
carry it. [R2-1] [reproduced]

**Bound the file, not the archive internals.** `unzipper` materialises the entire central directory
before `Open` resolves — it reads `numberOfRecords` from the EOCD (attacker-authored) and parses every
declared record — so an entry-count cap applied *after* `Open` has no "after" to run in. Rather than
build an EOCD preflight to close that, **cap the file size with one `stat` before opening**. A 256 MiB
ceiling bounds the worst case to a background job burning CPU on one book, which per-book isolation
already contains. This is an availability concern, not an exfiltration one. [R2-12, proportionality]

### Structural validation

Confirm the EPUB media type; require `META-INF/container.xml`, a resolvable package document, a
non-empty manifest, and a non-empty **linear** spine. Normalize archive paths; reject absolute paths,
`..` traversal, duplicate normalized names, and anything outside the archive namespace. Parse XML with
**`cheerio` in `xmlMode`**, and treat that choice as the security control.

**Verified empirically, not assumed:** cheerio's backend (htmlparser2) is a non-validating parser with
**no DTD or entity resolution whatsoever**. Tested against three payloads — a `SYSTEM` file entity
pointing at a local secret, a parameter entity, and a billion-laughs bomb. All three came back as
literal, unexpanded text (`&xxe;`, `&lol4;`), nothing read from disk, 11 bytes and 1 ms on the bomb.
So XXE and entity-expansion DoS are not defended against here — they are **structurally unavailable**,
and there is nothing to configure.

**This makes the dependency choice load-bearing.** Swapping in a real XML parser
(`fast-xml-parser`, `libxmljs`, `xmldom`) would silently reintroduce a file-read primitive into a
process whose config directory holds `secret.key`. Any such change requires re-running the XXE
fixtures. Keep those fixtures as regression guards even though they currently pass trivially — they
exist to fail loudly if the parser is ever replaced. [R2-19]

**Every byte and ratio bound is enforced by a counting transform on the actual inflated stream,
aborting at limit+1.** Declared central-directory sizes are advisory only — a cheap pre-reject, never
the enforcement point. Include a hostile fixture whose declared size disagrees with its real inflate.
[R2-25]

### `META-INF/encryption.xml` is not a rejection — classify by *what* is encrypted

**Verified against the first real EPUB in the library** (`A Court of Thorns and Roses`, 2.06 MiB, 71
entries, probed in the prod container 2026-07-25). It contains `META-INF/encryption.xml` with
algorithm `http://ns.adobe.com/pdf/enc#RC` — but all four encrypted resources are `OEBPS/Fonts/*.ttf`,
and all **55** XHTML content documents are unencrypted. Manifest 67 items, spine 55 itemrefs. It is a
completely readable, Kindle-sendable book.

That is **Adobe font obfuscation**, which is routine in commercial EPUBs — not DRM. A validator that
treats the mere presence of `encryption.xml` as encrypted-and-unsupported would mark the very first
book in this library `invalid`. The twelve review lenses did not catch this because none of them had
a real EPUB to read.

The rule:

- Presence of `encryption.xml` alone → **no effect**. Parse it.
- Every encrypted URI resolves to a font (`.ttf`/`.otf`/`.woff`/`.woff2`), whether Adobe
  `ns.adobe.com/pdf/enc#RC` or IDPF `embedding` obfuscation → the publication is fully readable →
  **`available`**. Fonts are decorative; nothing we do needs them.
- **Any encrypted spine or content document** → real DRM → a **distinct** status code
  `drm_protected`, never the generic `invalid`. The owner-facing message is a different message —
  *"this file is DRM-protected; Narratorr will not remove DRM"* rather than *"this file is
  malformed"* — and the Kindle path differs too: an obfuscated-font EPUB converts fine, a DRM'd one
  never will.
- An unparseable `encryption.xml` → `malformed_xml`, subject to the same bounded XML limits.

Malformed structure is a **definitive** `invalid`. `EACCES` / `EIO` / an unavailable library root are
**transient**: log a redacted diagnostic and **retain the last successful observation** rather than
clobbering it. There is no failure counter and no staleness ceiling. Be precise about why: the
predicate's `books.status === 'imported'` term does **not** cover an unreachable mount, because #1955
stops the `missing` flip on a transient errno. The stale window is instead **accepted** — the live
open fails closed, so the worst outcome is a clean `404 companion_epub_unavailable` at click time on a
book whose audio is equally unreachable. `src/shared/companion-ebook-exposure.ts` documents this and a
test pins it so it cannot be mistaken for an oversight.

Validation promises nothing about Kindle conversion compatibility and does not remove DRM.

### Module split [R2-114]

`core/epub/` is pre-sliced against `max-lines` 400 / `max-lines-per-function` 150 / `complexity` 15:
`limits.ts` (constants), `zip-source.ts` (the positional adapter + preflight), `paths.ts` (archive
path normalization), `xml.ts` (bounded parsing), `validate.ts` (orchestration only), `extract.ts`
(cover / OPF metadata / TOC).

## 5. Opening a companion file — proportionate, not hardened

v3 specified a two-layer resolver: `lstat` → no-follow open → `fstat` → dev/ino equality → realpath
containment → stored-fingerprint match → explicit close ceremony, on every read. **That was
disproportionate and is cut.**

The comparison that settles it: the 762 MB audiobook in the same folder gets
`await access(row.path)` once every six hours (`library-scan.service.ts:203-208`) and **nothing** at
serve time — no `lstat`, no `realpath`, no `O_NOFOLLOW` anywhere on the audio path. Applying a
hardened-file-server posture to the 2 MB EPUB beside it, placed there by the same person, cannot be
justified. The v2 review validated that the *mechanism matched the claim the plan made*; it was never
asked whether the claim was warranted. It wasn't. CLAUDE.md's settled decisions are explicit:
filesystem access is unrestricted because the authenticated user is the operator.

**What we do keep, and why.** The catastrophic case is an attacker obtaining
`<configPath>/narratorr.db` together with `<configPath>/secret.key` — and per
`secret-codec.ts:361-378` the key falls back to *that same directory* and auto-generates there when
`NARRATORR_SECRET_KEY` is unset, which is the common Docker deployment. One arbitrary-file-read
primitive aimed at `/config` yields indexer credentials, download-client passwords, SMTP credentials,
the v1 API key, and password hashes.

This feature adds exactly one path toward that: a symlink named `book.epub` pointing at
`/config/secret.key`, streamed to anyone holding the API key. Two cheap checks close it completely:

1. **`lstat` and reject** anything that is not a regular file — symlinks especially.
2. **Containment** — the resolved path must sit inside the library root.

Then: `open`, `fstat` for `Content-Length`, stream, close. One syscall more than the audio path.

**What we dropped and what it cost.** The dev/ino binding defends a microsecond-wide swap race that
requires an attacker who already has write access to the media share — who can equally replace the
audiobooks, which nothing checks. It does not stand between anyone and `/config`. Also gone: the
two-layer split, serve-time fingerprint matching, and the close-on-abort ceremony (closing handles
correctly is just correct code, and stays).

**Still true:** the file is opened and streamed live, so a stale database row can never cause the
wrong bytes to be served — the worst it does is render a briefly-wrong badge. That property is what
lets the observation row be a display cache rather than an authority, and it is why most of v3's
freshness machinery was unnecessary.

## 6. Reconciliation: triggers, concurrency, convergence

### Use the primitives that already exist [R2-27]

Do **not** invent a keyed mutex, a semaphore, or a coalescing runner. All three exist and none was
cited in v2:

- `src/server/services/book-admission.ts:24` — `withBookAdmissionLock`, a per-`bookId` mutex
  documented as *the* shared process-local primitive for book-scoped work. **It is NON-REENTRANT** —
  put that warning in the issue body, because the trigger seams call service methods that may want
  the same lock.
- `src/server/utils/semaphore.ts:4` — counting, FIFO, already used by `match-job.service.ts`.
- `src/server/services/connector-refresh-queue.ts` — a working debounced coalescing single-flight
  with batch caps and a shutdown drain.

`TaskRegistry` genuinely does not queue (`task-registry.ts:84-93` silently returns when running), so
the coalescing requirement stands.

### Trigger seams — corrected

| Trigger | Seam | Correction |
|---|---|---|
| Per-book **Refresh & Scan** | at the **route**, `finally`-shaped | not inside `refreshScanBook`, which throws first |
| Library **Refresh** / 6h cron | **not a hook** — see below | v2's `:158` row is deleted |
| Import completion (**all** adapters: auto, manual copy/move, and pointer/adopt) | `import-queue-worker.ts:390`, after the completion UPDATE persists, behind `fireAndForget` | see the two corrections below |
| Rename | the three **callers**, not `renameBook` | see below |
| Wrong release / rejection | `book-rejection.service.ts:60-77` | **redundant for exposure, keep for hygiene** — it nulls `path` and sets `wanted`, so derived exposure already fails closed |

**The `:158` row is deleted.** v2 simultaneously required a hook at `library-scan.service.ts:158`
*and* "bounded-concurrency reconciliation outside the scan lock." Those are mutually exclusive:
`:127` sets `this.scanning = true`, the row loop is `:155-165`, and `finally { this.scanning = false }`
is `:180-182`; `:124-126` throws `ScanInProgressError` to concurrent callers, and both the manual
route (409 on overlap) and the cron call the same method. An implementer follows the line number over
the prose bullet and puts per-book filesystem work inside the section that 409s Refresh Library.
Instead: **one wrapper used by both the route and the cron** runs `rescanLibrary()`, lets its
`finally` release `scanning`, then calls `CompanionEbookService.reconcileAll()` fire-and-forget
through the companion service's own coalescing runner, which selects its own eligible rows (the
`fireAndForget` precedent is already in that file at `:169-173`). **AC:** no `lstat`/`readdir`/ZIP
read happens while `scanning` is true, and a Refresh Library issued during a companion sweep returns
200, not 409. Coalescing applies to *companion* passes; the existing Refresh 409 behavior is
unchanged. [R2-4] — **12/12, the joint-strongest finding in the panel.**

**The import seam needs an extraction first, for two independent reasons.**
(a) `import-queue-worker.ts` measures **exactly 400/400** ESLint-counted lines
(`npx eslint … --rule '{"max-lines":["error",{"max":1,…}]}'` → "File has too many lines (400)";
`eslint.config.js:189` sets the cap at 400). Adding *one line* fails `pnpm verify`, the only gate on
`develop`. [R2-7]
(b) `processJob` wraps `await adapter.process(job, ctx)` **and** the whole success tail — phase close,
the `importJobs` completion UPDATE (`:399-406`), and the `import_complete` emit — in **one `try`**
whose `catch` calls `markJobFailed`. Anything awaited at `:390` that throws converts a successfully
imported audiobook into a **failed import job**, with a user-visible SSE failure event. [R2-20]
So: extract the success tail into a helper module, then invoke the companion scheduler **after the
completion UPDATE has persisted**, behind `fireAndForget`. **AC:** a companion reconcile that rejects
leaves the job `completed` and emits `import_complete` normally.

**The "Adopt confirm" row is deleted.** Adopt *is* the manual adapter with `mode === undefined`
(`import-adapters/manual.ts:101`, `:133`, `:204`) and reaches `:390` like every other job. A separate
row means adopt either reconciles twice — failing the exactly-once AC — or an implementer hunts for a
seam that doesn't exist. Note that adopt's `book.path` is the adopted source directory, so eligibility
turns on the file-vs-directory rule. [R2-11]

**Rename: hook the callers, not `renameBook`.** `renameBook(bookId)` takes no options and has no
suppression channel, and `bulk-operation.service.ts:281-283` loops over it — so anything hooked inside
fans out N-wide during a whole-library rename, which is exactly what SC-11 exists to prevent. There is
also a **third caller v2 missed**: `src/server/routes/books-fix-match.ts:78`, gated on
`body.renameFiles`. Hook `books.ts:380`, `books-fix-match.ts:78`, and once after the bulk loop.
`rename.service.ts:206`'s "Already organized" early return must **not** reconcile — nothing moved.
[R2-10]

**Apply the `finally`-shaped rule uniformly.** `rename.service.ts:181-190` writes `books.path`
immediately after the folder move (with an explicit comment that it must stay in sync even if the
later file rename fails), then `renameFilesWithTemplate` at `:193-203` can throw. `manual.ts:148-153`
has the same shape. Any trigger sited after a `books.path` write runs on **both** success and error
paths, or exposure stays dark until the next 6h sweep for a book whose EPUB actually travelled. [R2-34]

### Concurrency and convergence

- **Conditional writes keyed on `(bookId, books.path, books.status, fingerprint)`.** Name **which**
  fingerprint is expected —
  v2's "only lands if those still match" never distinguished the pre-scan fingerprint from the newly
  computed one, making it unimplementable in either reading. Write it as SQL-shaped pseudocode in the
  issue. [R2-15]
- **Per-book serialization** via `withBookAdmissionLock`.
- **`reconcileAll()`** single-flight + coalescing, selecting its own eligible rows, outside the scan
  lock.
- **Fingerprint short-circuit** on unchanged `size`/`mtime`/**`ctime`**/path. A mismatch forces full
  revalidation on the next pass, bypassing the short-circuit.
- **Exposure is derived from the frozen predicate**, and the live open is the final authority — a
  stale row can render a wrong badge but can never serve wrong bytes.
- **Staleness ceiling — restored from v1's D-8, which v2 dropped while claiming the review was folded
  in.** After N consecutive failures **or** `last_successful_scan_at` older than a fixed age, derive
  stop public exposure: `companionEbook` projects `null`. **This is invisible to the owner** — the
  panel keeps rendering the last stored observation (see §7), because whether the file was deleted or
  the mount is briefly down the owner can do nothing differently, and a click surfaces the real
  error. Without the ceiling there is **no upper bound** on how
  long a dead observation advertises itself to the family — every click 404s. One column, one
  comparison. [R2-14]

**"Exposure stops immediately" — decide, don't assert.** v2 kept MR-9's word and dropped its
mechanism: §5 has no re-enumeration, §8 gates on DB state, and there is no watcher, so after a second
EPUB lands the first keeps streaming for up to six hours. Either add **bounded re-enumeration** as a
resolver step (one `readdir` of a directory with a handful of entries, trivial next to the transfer)
or replace "immediately" with "at the next reconciliation or the next stream authorization, whichever
comes first" in both §6 and the test plan. **Recommended: add the re-enumeration** — it is what makes
"exactly one" true at serve time. Either way, **any resolver mismatch enqueues a reconcile for that
book before returning the error** — the only self-healing path a watcherless design has. [R2-17]

**A library-root change must bump the generation.** The root is an ordinary mutable setting and
`src/server/routes/settings.ts:76-108` applies it with no rescan and no invalidation (it special-cases
*network* settings only). `books.path` values are absolute and unchanged by a root edit, so the
snapshot equality still holds and badges keep advertising EPUBs validated under the old root. [R2-111]

## 7. Owner UI

One section on book details, headed **Ebook**. Not "Companion EPUB" — that is our vocabulary for the
product boundary, not the owner's. They are on an audiobook page, so "companion" is implied by
context, and the format only matters when something is wrong (the not-readable and DRM copy name it).
**No "companion EPUB" anywhere in the UI, settings included.** The settings section is **Ebooks**
with a toggle reading **Enable ebook support**. An earlier draft kept the longer name there on the
theory that a bare "Ebooks" might read like acquisition — but the copy answers that, and a jargon
label answers nothing.

**The description splits across the existing `InfoTip`** (`src/client/components/settings/InfoTip.tsx`),
whose docstring sets the rule: *"Only for SUPPLEMENTARY detail — anything required to fill the field
correctly belongs in the always-visible description."*

- **Visible row:** *"Show ebooks stored alongside your audiobooks, ready to download from the book
  page."* Leads with what the owner gets locally, which is true whether or not they run Requests.
- **Behind the tip:** *"Ebooks need to already be in the book's folder. Narratorr doesn't search
  for or download them. Enabling this also exposes them over the API, which is how
  [Narratorr Requests](https://docs.narratorr.dev/narratorr-requests/) offers Download and Send to
  Kindle to your family."*

  The link target is the docs page, not the GitHub repo — verified live, and its sections ("How it
  fits with narratorr", "The request flow") are exactly what a reader who has never heard of Requests
  needs. `InfoTip` takes `ReactNode`, and there is precedent for rich content in one
  (`ProcessingSettingsSection.tsx:159-162`). Match the one existing external-link idiom in settings:
  `target="_blank" rel="noopener noreferrer"` with the `HealthDashboard.tsx:76-83` classes.

  **Copy style for every user-facing string in this feature:** no em-dashes. Use a period, a comma,
  or a colon. Applies to the panel states too — *"This isn't a valid EPUB: it has no reading order"*,
  *"Drop a single `.epub` into this book's folder, shown under Location below, then rescan."* And no
  verbs that frame Narratorr as watching the filesystem: it *uses* or *shows* files the owner placed,
  it does not *notice* them.

  **Known limitation, accepted:** the popover sits `bottom-full mb-2`, so crossing the 8 px gap with
  the pointer leaves both trigger and popover and closes it. The link is reachable via the
  **click-to-pin** path the component already supports, not via pure hover. Bridging the gap would
  mean changing the shared component and every tip that uses it — not worth it for one link.

Two things this fixes. The earlier copy named **Narratorr Requests** in the always-visible line, which
assumes knowledge of a separate application most people installing Narratorr have never heard of —
the tip explains it instead of presuming it. And it stops the description overselling: for an owner
who never runs Requests the feature is real but modest (a download button when you are away from the
machine holding the file), and default-off means that costs them nothing.

*Open to revisit:* the "never downloads" boundary sits in the tip on the grounds that the visible line
already implies the file must exist. If a skim-reader enabling this expecting acquisition is judged a
real risk, that sentence moves back onto the row and the tip keeps only the Requests paragraph.

Structure follows `src/client/components/AudioInfo.tsx` exactly: an uppercase muted `h2` over a
`glass-card rounded-2xl p-4 space-y-2`, `text-sm` rows, parts joined with `·`, a status pill in the
first row. Verified by injecting the mock into the live app.

**Five states. No modifiers, no derived reason vocabulary, no `ineligible` surface.**

| State | Pill | Literal copy (ship this text) |
|---|---|---|
| `available` | `Available` | size · chapter count, then **Download EPUB** |
| `unavailable` | `None` | "Drop a single `.epub` into this book's folder, shown under Location below, then rescan." |
| `ambiguous` | `N found` | "Which one belongs to this book?" + radio list of basenames + **Use this one** |
| `invalid` | `Not readable` | the filename, then "This isn't a valid EPUB: it has no reading order. If it's still copying, wait and rescan." |
| `drm_protected` | `DRM-protected` | size, then "Its chapters are encrypted. Narratorr won't remove DRM, so this can't be sent to Kindle." |

*[Shipped divergences from this table, 2026-07-29 — Todd's calls during the first live UAT, made
interactively (UI work stays out of the pipeline). The shipped panel is the authority; this table
is kept as the original design record:*
- *The **filename renders** on `available` and `drm_protected` as the card's identity line
  (truncated, full name in the tooltip). The original design showed it only on `invalid`; once a
  selection exists the filename is the only disambiguator for which file won.*
- ***Download EPUB** is no longer an in-card text link — it is a header ICON in the Series-card
  idiom. It renders as a real link on `available` and, since #2038, on `drm_protected` too; the
  other three states render no download control at all. (It briefly rendered DISABLED on
  `drm_protected` with tooltip "DRM-protected: download unavailable", which was correct only
  while the server ran one `available`-only gate for advertisement and owner readability.)*
- *A **re-check arrow** (#2034, not in this design) sits beside it in every state, wired to
  `POST /companion-epub/refresh` with a bounded post-202 poll window and a minimum visible spin.*
- *`size · chapter count` remains size-only — the count is #2022, parked: `/metadata` cannot yet
  bind its response to the `/state` row rendered beside it.*
- *The `Available` pill is CUT (badge only when something needs saying): once the filename, size,
  and live download icon are visible, the pill was a fourth voice repeating three others. `None`,
  `N found`, `Not readable`, and `DRM-protected` keep theirs — those carry signal.]*

Settings row: section **Ebooks**, toggle **Enable ebook support**, visible description "Show ebooks
stored alongside your audiobooks, ready to download from the book page.", with the `InfoTip` carrying
"Ebooks need to already be in the book's folder. Narratorr doesn't search for or download them." plus
the linked Requests paragraph.

**These strings are the deliverable, not a paraphrase.** They went through several rounds; an
implementer should copy them verbatim rather than re-derive. Style rules that produced them: no
em-dashes, and no verbs that frame Narratorr as watching the filesystem.

**The filename renders only where it is actionable** — `invalid` (they must find the file) and
`ambiguous` (they must choose). Real filenames in this library run ~96 characters and consume three
lines in the sidebar; in `available` the owner already knows which book they are on.

**`ambiguous` is a picker, not a refusal.** v2 told the owner to go delete a file. Instead: list the
candidates, persist the choice in `selected_filename`, carry on. Discovery is one-to-many;
**selection stays one-to-one, so the bilaterally-pinned singular `companionEbook` contract never
changes** and the consumer needs no picker. The mutation is owner-session only and takes a
server-issued candidate index — never a filename or path from the client.

**No `ineligible` state, and no exception.** Of v2's four reason codes, `book_not_imported` and
`no_path` cannot occur when the panel renders only on imported books, and `outside_library_root` is a
misconfiguration. The fourth, `file_backed`, was investigated and is **effectively unreachable**:
`scanDirectory` (`library-scan.service.ts:278-328` — `discoverBooks(rootPath)` at `:281`,
`folder.folderParts` at `:328`; the walk itself is `book-discovery.ts:60-68,89-96,105-139`) only
ever offers **folders** as candidates. *[Citation refreshed 2026-07-29, #2018: the original
`:232-235` range now documents path reconciliation; the folder-only claim itself is unchanged and
was re-verified against the tree.]* A
file-valued `books.path` would require a hand-crafted API call. The **eligibility guard stays in
code** — `books.path` is nullable, legacy rows exist, and the resolver must fail closed — but it gets
no user-facing state. When the feature does not apply, the section is simply absent. [R2-112]

**No transient-unreachability surface.** The card renders the last stored observation; a click then
fails with a real error. Less code than detecting unverifiability and hiding, and it avoids an ebook
appearing to vanish. See §What changed 5b.

**No metadata-disagreement warning.** Detecting "this EPUB is a different book" requires fuzzy title
matching, and this repo's existing fuzzy-title machinery is an active source of false positives. A
warning that fires on a legitimate ebook whose subtitle or edition naming differs is worse than the
narrow case it guards — which needs delete-with-files followed by re-importing a *different work*
into the same computed folder. Accepted gap; see Deferred.

**No EPUB HTML is rendered anywhere** (v1 **D-3**). The cover is a bounded raster: magic-byte checked,
**SVG rejected**, byte-capped. **The dimension cap needs a mechanism or it goes** — `package.json`
contains **zero** image libraries (`sharp`, `image-size`, `probe-image-size`, `jimp`, `canvas` all
absent). Either hand-write a header reader over the first N bytes for exactly the magic-byte set
accepted (PNG/JPEG/WebP/GIF), living in `core/epub/`, **or** drop the dimension bound and keep the
byte cap plus magic-byte sniffing, which still closes the bomb case. Do not add an unbudgeted
production dependency into the process holding `NARRATORR_SECRET_KEY` and fed attacker-authored
archives. [R2-19]

Owner routes — registered in their **own route module**, not `routes/books.ts` (measured 360/400):

- `GET /api/books/:id/companion-epub` — download · **#1974**
- `GET /api/books/:id/companion-epub/state` — the owner observation read and, for `ambiguous`
  only, the candidate list that issues the selection indices · **#1974**
- `GET /api/books/:id/companion-epub/metadata` — OPF metadata + TOC (feeds the chapter
  count) · **#1976**
- `GET /api/books/:id/companion-epub/cover` — validated embedded cover · **#1976**
- `PUT /api/books/:id/companion-epub/selection` — the `ambiguous` picker; body carries a
  server-issued candidate index, range-checked, never a path · **#1976**, together with the
  revalidate-and-persist work behind it

Every route that opens a companion file goes through the §5 resolver: download, metadata,
cover, and selection. `/state` is the exception: it reads the stored observation and, for
`ambiguous` only, enumerates candidate basenames with `readdir` + `lstat`. It opens no
companion file, so the resolver does not apply to it.

## 8. Public v1 API

### `GET /api/v1/capabilities`

```json
{ "companionEpub": { "enabled": true } }
```

`/api/v1/system` is untouched (v1 **D-2**, 12/12). A `404` from an older Narratorr is the consumer's
"unsupported" signal and is the **default** state against every deployed Narratorr today, so it must
be the well-tested path. The `/api/v1/docs` tree is deliberately key-free, so the route's *shape*
appears there; the `enabled` **value** never does.

### `companionEbook` on two producers

```ts
companionEbook: { format: "epub", sizeBytes: number } | null
```

**1. Nested in the metadata-search `library` annotation** — `src/server/routes/v1/metadata.ts:40`
(`result.library = match`, batch-loaded via `findLibraryStatusByAsins` at `:37`). This is the
load-bearing surface: it feeds the consumer's search cards.

**The batch-load as v2 described it is impossible.** `book.service.ts:179-194` selected only
`{ bookId: books.publicId, status, asin }` — no numeric `books.id`, which is the companion FK. So
`findLibraryStatusByAsins` had to additionally select `books.id`, or LEFT JOIN `companion_ebooks`,
with the predicate applied in the mapper. Assert no-N+1 on **both** producers. [R2-17]

*[Corrected: this passage previously also required `books.path` "(needed by the exposure
predicate)". That has been false since #1961 shipped — NEITHER predicate takes a path term. Both
take exactly `{ enabled, bookStatus, observationStatus }`, and the producer deliberately projects
the numeric `books.id` only (`src/server/services/book.service.ts` says so at its select). A future
implementer following the old text would add the very path term the predicates forbid.]*

Reach limit worth stating: the annotation is **ASIN-keyed** and `book.service.ts:191` skips null-ASIN
rows, while `idx_books_asin_unique` is UNIQUE on `upper(asin)` where non-null — so the keep-both
edition fence necessarily produces a second row with a different or NULL ASIN, invisible to consumer
search. This library has editions. [R2-37]

**Accepted for 1.0, bilaterally.** A companion sitting on a non-primary-ASIN edition is invisible to
consumer search, so a multi-edition book can show a false "no ebook" on their card. There is nothing
the consumer can do about it — they only see what we annotate — and it is rare. Recorded here so a
later reviewer does not file the false negative as a Requests bug.

### Consumer-pinned AC precision (2026-07-25)

Three wordings the consumer verified against their rendering code. Write the ACs this way, not the
intuitive way:

1. **`missing` → Request, not "no ebook."** Our §3 eligibility forces `companionEbook: null` for any
   non-`imported` book, so it is tempting to write "a `missing` book annotates as in-library with no
   ebook." That is not what renders: `requests:book-card-state.ts:36` excludes `missing`/`failed`
   from the "On the way" branch, so the card falls through to a **Request** button — behavior that
   predates companion entirely. Across a mount flake the card shows *In library + Download → Request
   → In library + Download*, and the companion `null` is invisible because the card already left the
   in-library state for an unrelated reason.
2. **Companion → `null` degrades silently. No third state.** The only companion-specific flip is a
   book that stays `imported` while companion goes null — either the EPUB was genuinely removed
   ("no ebook" is correct) or the file became unreachable, which is narrow (a whole-mount outage
   flips the book to `missing` instead) and self-healing on the next good scan. A third state is
   contract plus UI surface for a rare self-correcting case. The live open already makes the stream
   the click-time source of truth, so a briefly-stale Download returns a clean
   `404 companion_epub_unavailable` — it fails gracefully, not corruptly. Revisit only if UAT shows
   the flip-flop confuses owners.
3. **Consumed via the search annotation only** — see the dormancy note below.

*Consumer's one non-blocking preference, recorded but not adopted:* for the narrow staleness-ceiling
case they would mildly rather transient scan-failure **retain last-good presence** (consistent with
our own "retain the last successful observation on transient I/O" principle) and let the stream
explain at click, rather than the ceiling projecting `null`. The self-heal makes either acceptable;
this is not worth reopening the frozen predicate over, but it is worth revisiting if [R2-14]'s
ceiling proves noisy in practice.

**2. Top-level on the v1 book DTO** — `toBookV1`. There are **four** touchpoints, not three:
`v1/books.ts:172` (list), `:190` (single), `:317` (POST create), **and `fetchByPublicId`'s projector
signature**. `routes/v1/_helpers.ts:40-52` declares `project: (row: TRow) => TDto` — synchronous,
one-argument, invoked as `return project(row)`, shared by five v1 routes. And `:172` is
`data.map(toBookV1)` — a bare reference to `Array.map`, so a naive second parameter receives **the
array index**. Prescribe closures rather than a signature change:
`data.map(row => toBookV1(row, map.get(row.id) ?? null))`; resolve and load the single row before
projection; pass explicit `null` on POST-create. `toBookV1` stays synchronous and server-import-free —
the companion map is passed **in**, never looked up. Test that the single-book GET emits a
**non-null** `companionEbook`, not merely that the key exists. [R2-5]

**This field is contract-pinned but dormant.** v2 claimed it "feeds the My Requests row"; that is
false and the consumer confirmed it against their own code (decision A, resolved → search-only).
Requests polls Narratorr books **only** for `acquiring` requests, at which point the book is not yet
`imported`, so §3's eligibility rule forces `null` on every poll that happens; the one call where it
could be non-null is the `acquiring → available` transition, whose payload `applyBook()`
(`requests:request.service.ts:525-545`) discards apart from `{ status, narratorrBookId }`. Build it —
it is additive, contract-stable substrate — but **1.4's ACs must state that its only Phase-1
consumer is a test.** The live surface is the nested annotation above. [R2-3]

*[Evidence pinned 2026-07-29, #1977: this record originally cited only unversioned coordinates. The
claim was re-verified against narratorr-requests `main` AFTER its companion-ebook slate shipped
(PRs #179/#182/#186/#191, all merged 2026-07-29 — the Get-eBook affordances, Send-to-Kindle
service/sheet, and the cross-app integration suite): `applyBook` still persists only
`{ status, narratorrBookId }` and nothing under `src/server/` reads `companionEbook` — the readers
are the client's `EbookSheet`/`BookCard`, i.e. the nested SEARCH annotation exactly as this record
predicted. The dormancy held through the consumer actually shipping.]*

### `GET /api/v1/books/:publicId/companion-epub`

API-key hook; never accepts or returns a path; requires the frozen ADVERTISEMENT predicate
(`isCompanionEbookExposed` — never the owner-readable one, see Frozen contracts); resolves
through the §5 resolver; `Content-Type: application/epub+zip`, sanitized attachment filename,
`private, no-store`; `409 companion_epub_disabled` when disabled, `404 companion_epub_unavailable`
otherwise; abort propagation and backpressure.

**`Content-Length` comes from `fstat.size` on the resolver's handle — never from `size_bytes`.**
Sourced from the observation, a grown file truncates silently (a corrupt EPUB delivered to a Kindle
under a 200) and a shrunk one hangs until timeout. Precedent: `audio-preview-stream.ts:107`. Test a
divergence in both directions. [R2-21]

**The mid-stream error path needs a guard.** `routes/v1/_helpers.ts:70-87` — the handler every v1
plugin installs — ends with an unconditional `reply.status(500).send({ error: … })` with no
`reply.sent`/`headersSent` check, so a mid-stream failure yields a truncated body under a 200 or a
throw inside the error path. Add a leading
`if (reply.sent || reply.raw.headersSent) { log; reply.raw.destroy(); return reply }` branch, with a
test forcing an error after the first chunk and a regression assertion on an existing v1 404. [R2-18*]

**Bound concurrent streams.** The reframe deleted `/api/library`, `search` forwarding, and the cover
route — but not this, the most bandwidth-expensive route in the system. `@fastify/rate-limit` is
registered `global: false` and only `auth.ts`/`filesystem.ts` opt in; `v1/common.ts:45-47` documents
v1 rate limiting as out of scope on a *single-user* threat model — the premise Phase 2 changes by
putting N family browsers behind one key. Add a small fixed semaphore (reuse
`src/server/utils/semaphore.ts`) returning a stable 503 when saturated and closing the handle on
abort. Combined with the resolver's close steps, this is also the EMFILE guard. One sentence noting
the threat-model shift so a future reviewer doesn't file the asymmetry as an unrelated bug. [R2-24]

## 9. ~~The source breadcrumb~~ — CUT

**Decision B resolved 2026-07-25 → cut.** Both simplifier lenses, independently and cross-engine,
recommended deferring it; the owner agreed after seeing it rendered. It is gone entirely, not
reduced: no source_hint_* columns, no Clear route, no write-once/four-clear-event/never-resurrect
lifecycle, no issue 1.7.

That removes ten review findings at a stroke — [R2-2] (the write site that does not exist),
[R2-16] (the unenforceable never-resurrect invariant), [R2-19] (the errno bug it reintroduced on the
one path Phase 0a cannot cover), [R2-26] (UI scheduled before the panel existed), [R2-32]
(container-internal paths), [R2-33] (dismissal not durable against re-import), [R2-40] (the
duplicated test paragraph), [R2-109], [R2-110], and [R2-113] — along with roughly a third of the test
plan.

**What replaces it is what SC-13 originally asked for and v2 inflated:** honest static copy in the
unavailable panel, plus the info log line at import when a co-located .epub is dropped.
The log line costs nothing and leaves a trail for anyone diagnosing a missing companion; it is not a
user-facing feature and carries no state.

Recorded so it is not re-derived: the breadcrumb was *most* wanted for the short-lived-source case,
and per the corrected supply note it is precisely that case — usenet auto-import with
deleteAfterImport on — where the source is deleted inside importDownload() before any
post-import hook could ever have written one. It was weakest exactly where it was needed most.

## Frozen contracts

**The exposure predicates — TWO named literals sharing terms 1-2, differing only in the status-set
term.** [R2-8, R2-41] Split in #2038: advertisement and owner-readability are different questions
asked at different trust boundaries, and one gate answering both is what silently blocked the owner
from downloading their own `drm_protected` file.

```
exposed(book, obs) :=                        # ADVERTISEMENT — isCompanionEbookExposed
      settings.companionEpub.enabled
  AND book.status === 'imported'
  AND obs.status === 'available'
  AND the live term succeeds (caller-owned)

ownerReadable(book, obs) :=                  # OWNER FILE ROUTES — isCompanionEbookOwnerReadable
      settings.companionEpub.enabled
  AND book.status === 'imported'
  AND obs.status IN ('available', 'drm_protected')
  AND the live term succeeds (caller-owned)
```

**Callers, and why the sets differ.** `exposed` is evaluated by both public producers (the
metadata-search `library` annotation and the top-level book DTO) and the public v1 stream: a
`drm_protected` EPUB genuinely fails Amazon's Kindle converter, so advertising one promises a
conversion that cannot happen. `ownerReadable` is evaluated by the three owner file routes —
download, metadata, and cover — at one shared call site: the file is already on the owner's disk,
serving its bytes removes no DRM, and the classifier has been wrong about a real book, so the block
only ever converted a misclassification into denied access. The owner panel reads neither: it
issues `GET /companion-epub/state`, which gates on eligibility.

**Term 4 is caller-owned for both**, and is the authority in both cases: the live open (`lstat`
regular-file + containment) for the download and the stream, the live `inspectEpub` for metadata
and cover. That is what makes the widened status set safe — a genuinely encrypted file still fails
the live term on the two read routes, so widening the STORED-status gate cannot expose encrypted
content.

`books.status === 'imported'` is required in both and is doing more work than it looks.
`library-scan.service.ts:210-216` flips `imported` to `missing` without touching `books.path`, so
without this term a book on an unreachable mount keeps advertising `companionEbook: { sizeBytes }`
while every family click 404s. With it, the mount-down case is covered here rather than needing a
separate staleness mechanism.

**Statuses:** `available | none | ambiguous | invalid | drm_protected`. Nothing derived, nothing
stored beyond these. `drm_protected` is separate from `invalid` because the owner message and the
Kindle outcome both differ — see the `encryption.xml` rule in §4.

**Validation codes:** `not_a_zip`, `bad_mimetype`, `missing_container`, `unresolvable_package`,
`empty_manifest`, `empty_spine`, `unsafe_entry_path`, `duplicate_entry`, `malformed_xml`,
`limit_exceeded`, `truncated`.

**Eligibility guard (code-level, no UI):** enabled · `book.status === 'imported'` · `book.path`
resolves to a directory · contained by the library root. No `ineligible` reason vocabulary — v3's five
codes were three unreachable, one a misconfiguration, and one (`file_backed`) the manual-import
scanner cannot produce, because `discoverBooks` only ever yields folders. The guard must still fail
closed for legacy or API-crafted rows. [R2-112]

**v1 error codes:** `companion_epub_disabled` (409), `companion_epub_unavailable` (404), in the
canonical `{ error: { code, message } }` envelope (`src/shared/schemas/v1/common.ts`,
`v1ErrorEnvelopeSchema`, `.strict()`).

**Limits:** archive file size ≤ 256 MiB, checked with one `stat` **before** opening — this is the real
bound, because `unzipper` materialises the whole central directory before `Open` resolves. Inspection
reads ≤ 16 MiB total, enforced by a counting transform on the **actual inflated stream**; declared
central-directory sizes are attacker-authored and advisory only. XML ≤ 4 MiB inflated-before-parse.
Cover ≤ 8 MiB. TOC entries ≤ 2,000. Boundary-test each at its exact value. [R2-25]

**The XML parser choice is a security control.** `cheerio` in `xmlMode` (htmlparser2) performs no DTD
or entity resolution — verified empirically against XXE and billion-laughs payloads, all of which came
back as literal unexpanded text. Replacing it with a validating parser silently reintroduces a
file-read primitive into a process whose config directory holds `secret.key`. The XXE fixtures stay as
regression guards.

**`Content-Length`** is `fstat.size` from the open handle, never `size_bytes`. From the observation, a
grown file truncates silently under a 200 and a shrunk one hangs. Precedent:
`audio-preview-stream.ts:107`. [R2-21]

**The `ambiguous` selection contract:** a server-issued candidate index, never a filename or path from
the client; `selected_filename` persisted; cleared automatically when the selected basename no longer
appears among the candidates.

## Decisions — all resolved

**A — top-level `companionEbook` consumer.** Resolved 2026-07-25 to **(b) search-result-only**. The
consumer verified against their own code that the field reaches nothing today: Requests polls books
only for `acquiring` requests, at which point the book is not `imported`, so our own eligibility rule
forces `null`; the one call where it could be non-null is the `acquiring → available` transition,
whose payload `applyBook()` discards. The field still ships as contract-pinned substrate, but 1.4's
AC states its only Phase-1 consumer is a test. Their words on the cost: *"the ebook of a book I
already requested" becomes one search instead of a zero-click My-Requests grab.*
**Todd's veto remains available** — overturning means persisted companion columns on the request row
plus a bounded refresh sweep. [R2-3]

**B — source breadcrumb.** Resolved to **cut**. See §9.

**C — `exposure_generation`.** Resolved to **cut**. Superseded by the data-model simplification: with
the stream validating the live file, the observation row is a display cache, and a batch counter only
ever prevented a briefly-wrong badge. This also dissolves [R2-15], the review's joint-strongest
finding.

**D — security proportionality** *(not a review finding; raised by Todd)*. Resolved: keep the `lstat`
symlink rejection and the containment check, drop the dev/ino binding, the two-layer resolver, the
serve-time fingerprint match, and the hand-rolled archive adapter. Rationale in §5. The deciding
observation was that the audiobook in the same folder gets one `access()` every six hours and nothing
at serve time, and that only the two cheap checks stand between an attacker and `/config`.

## Test plan

**Archive primitive** — three-plus entries read from one handle; an early-`destroy()` case; the
handle survives each. Preflight rejects a ZIP64 `numberOfRecords` that exceeds the cap or fails
arithmetic against the real file size. A hostile fixture whose declared size disagrees with its real
inflate is rejected by the counting transform, not the declared value.

**Validation** — valid EPUB 2 and 3; renamed ZIP; missing container/package/spine; traversal and
absolute entry paths; duplicate normalized entries; malformed XML; entity expansion; each limit at
its exact boundary; truncated copy.

**Resolver** — symlink rejection asserted via the **`not_regular_file` outcome** (never "the open
throws", and never a dev/ino comparison — §5 declines that binding, and this line was a v3 leftover
that contradicted it); a **parent-directory** swap, not only a final-component one; ENOENT-safe
containment does not pass on a vanished path; close on success, abort, and error.

**Exposure** — the frozen predicate, one test per term. A book transitioned `imported → missing` with
path and companion row untouched emits `companionEbook: null` on **both** producers on the very next
request. A book whose mount is unreachable stops advertising via the status term, while the panel shows
`unknown`. A library-root change darkens exposure until reconciled. A restart alone does **not**
invalidate observations.

**Concurrency** — a conditional write is rejected when the path/status/fingerprint it was computed
from has changed; `withBookAdmissionLock` serializes two
triggers; `reconcileAll` coalesces rather than stacking; the short-circuit skips revalidation only
when size **and** mtime **and** ctime match; a same-path/same-size/restored-mtime replacement is
still revalidated; a second candidate makes a prior `available` row `ambiguous`.

**Triggers** — per-book scan, full scan, cron, import (per adapter, including pointer/adopt), the
three rename callers, bulk rename (one post-bulk sweep, not N inline), wrong release — each
reconciles exactly once. **No `lstat`/`readdir`/ZIP read occurs while `scanning` is true**, and a
Refresh Library during a companion sweep returns 200. **A companion reconcile that rejects leaves the
import job `completed`** and emits `import_complete`. A failing audio probe still refreshes the
companion observation. A rename whose file-rename step throws still reconciles.

**Selection (`ambiguous`)** — two candidates produce `ambiguous` and no exposure; the owner's pick
persists to `selected_filename` and flips the row to `available`; the selection survives a subsequent
Refresh & Scan; removing the selected file clears the selection rather than silently promoting
another candidate; the mutation rejects an out-of-range index and never accepts a path.

**Encryption classification** — an EPUB whose `encryption.xml` encrypts only fonts validates as
`available` (regression against the real library fixture: Adobe `#RC`, four `.ttf`, 55 plaintext
XHTML); an EPUB with any encrypted spine document is `drm_protected`, not `invalid`; an unparseable
`encryption.xml` is `malformed_xml`.

**Foreign-file preservation** — imports with a bundled EPUB still transfer audio only; delete,
delete-with-files, wrong release, reimport cleanup, and old-path cleanup preserve EPUBs; rename
carries the EPUB unchanged; `planFileRenames` never touches its basename.

**Public contract** — producer schemas stay `.strict()`; the capability route's 404-on-old-version
path; `companionEbook` batch-loaded on both producers with **no N+1**; all four `toBookV1` touchpoints
including the `.map`-index trap and POST-create → `null`; the single-book GET emits a **non-null**
companion for an `available` book.

**Streams** — stale snapshot; generation mismatch; symlink swapped between check and open;
`Content-Length` divergence in both directions; mid-stream error after headers (plus a regression
assertion on an existing v1 404); semaphore saturation returns 503 and closes handles.

**Cross-cutting** — path assertions normalize separators; written on Windows, gated on Linux.

---

## Delivery order

Ten issues, not six. Each carries a `## Relevant Learnings` line — `/elaborate` needs a non-empty
section or `$review-spec` soft-warns. [R2-38]

### Phase 0

| # | Issue | Blocks |
|---|---|---|
| 0a | **Transient filesystem-error classification.** The AC must target the real seam: the bare `catch { }` at `library-scan.service.ts:206-208` that discards the errno from `access(row.path)`. **Not** "root-accessibility as the discriminator" — `:137-141` already checks the root and throws before any row is visited, so as written the AC is satisfiable by a no-op that still converts every per-book errno to `missing`. Regression test per errno class; an `EACCES` book stays `imported`. [R2-15*] | 1.3, and the retention AC in 1.2c |

### Phase 1

| # | Issue | Contents |
|---|---|---|
| 1.1 | **EPUB limits + validator** | `core/epub/`: `limits.ts`, `validate.ts` via `unzipper.Open.file()`, `paths.ts` (archive path normalisation), `xml.ts` (cheerio `xmlMode` + the XXE regression fixtures), `extract.ts` (cover / OPF / TOC). Size cap by `stat` before open; counting transform on inflated bytes. The `encryption.xml` font-vs-DRM classifier, with the real library EPUB as a fixture. [R2-12, R2-19, R2-25] |
| 1.2a | **Migration** | `companion_ebooks` (nine columns) via `drizzle-kit generate --custom`, never-NULL CHECKs, FK-cascade test, full `git add drizzle/`. [R2-16, R2-28] |
| 1.2b | **Setting + repository + projections** | Registry category rendered as a peer section in General settings, the two test-file updates, repository, the exposure predicate as one shared function. No reconciler, no UI, no routes. [R2-38, R2-112] |
| 1.2c | **Reconciler** | `withBookAdmissionLock` per book, coalescing `reconcileAll()`, fingerprint short-circuit incl. `ctime`. Conditional writes keyed on `(bookId, path, status, fingerprint)`. [R2-13, R2-27] |
| 1.3 | **Trigger wiring** | The `processJob` success-tail extraction **first** (lint budget + failure isolation), the scan-lock wrapper, the three rename callers, wrong release, `finally`-shaping. Foreign-file regressions. [R2-4, R2-7, R2-10, R2-11, R2-20, R2-34] |
| 1.4 | **Public v1 contract** | `/api/v1/capabilities`; `companionEbook` on both producers; `findLibraryStatusByAsins` gains the numeric `books.id` only (NOT `books.path` — neither exposure predicate takes a path term); all four `toBookV1` touchpoints; batch-load; OpenAPI fixtures. **AC:** the nested annotation is the live surface; the top-level field is pinned but dormant. [R2-3, R2-5, R2-17, R2-37] |
| 1.5 | **Companion read routes** — split three ways, own route module | **#1974**: the shared open-and-verify helper (`lstat` + regular-file + containment, `Content-Length` from `fstat`), the shared candidate-discovery function, the owner download, and the owner `/state` read. **#1975**: the public stream, its `headersSent` guard in `routes/v1/_helpers.ts`, and the stream semaphore. **#1976**: owner metadata, owner cover, and the `ambiguous` selection `PUT` — route *and* the revalidate-and-persist write behind it, which needs the validator's verdict because `ck_companion_ebooks_selection` refuses a `selected_filename` on an `ambiguous` row. [R2-18*, R2-21, R2-23, R2-24] |
| 1.6 | **Owner panel** (presentational only) | Five states plus the `ambiguous` picker. No `ineligible` surface, no stale/degraded states. Depends on 1.4 and 1.5. [R2-26, R2-112] |

**Phase 1 exit:** an owner places one EPUB, runs Refresh & Scan, sees its state and metadata,
downloads it, and retrieves it through the authenticated public API.

### Phase 2 — Requests

Their repo, their issues. **Scope confirmed by the consumer 2026-07-25: search-result-only.** The
three consumer-side defects below are *their* Phase-2 work, not ours; they are recorded here only so
the cross-app contract has one written home.

**Carry forward verbatim** — the consumer explicitly asked for this rather than a separate review
pass on their side, and will settle them when specing 2.4–2.6. From v1 **D-6**: (1) user-visible
error copy for each limit; (2) whether an admin can clear a capped user; (3) the replay-window
duration; (4) the `started`-lease timeout; (5) the audit retention horizon; (6) the audit row's FK
behavior on user deletion. From **D-5**: 25 MiB is the **raw-file** limit, the byte counter is
authoritative and the preflight advisory — and it stays a fixed constant, not admin configuration
(7/12). [R2-108]

**Their three defects — latent today, armed by this feature.** The consumer's framing, and it is the
right one: none is a current bug, because nothing acts on `bookId` yet. They arm the moment Download
and Send-to-Kindle proxy by it.

- **The 60-second search cache snapshots the annotation.** `requests:search.service.ts:59-68` caches
  the entire upstream result including the mutable `library` object, keyed on the normalized query.
  Its own header comment at `:31-39` names *this plan's field* as the revisit trigger. A newly placed
  EPUB stays invisible, and a removed one leaves buttons live, for up to a minute — the first thing
  an owner tests after copying a file in. Split static from live, or accept and **test** the bounded
  window with pinned copy. [R2-103]
- **Partition that cache by connection generation.** `NarratorrClientHolder` carries none, and
  `requests:routes/settings.ts:101-106` swaps the client live without touching `SearchService` — a
  cached result can supply the old server's `bookId` while the proxy targets the new one. [R2-104]
- **Move `.catch()` down a level — in both vendored schemas.**
  `requests:src/shared/schemas/v1/metadata.ts:43-47` puts `.catch(undefined)` on the **entire**
  `library` object, so a malformed nested `companionEbook` erases `bookId` *and* `status` and the
  card falls through to offering **Request** for a book already in the library. **And `books.ts` is
  the more dangerous of the two** (the consumer's correction to us): it is non-strict, so an
  *unmodeled* companion key is ignored today — but vendoring the field there **without** a per-field
  `.catch(null)` makes a malformed value fail the whole poll parse → `CONTRACT_MISMATCH` → the
  request never transitions, because `status` is load-bearing on that path. Per-field catch in both;
  non-optional in `books.ts`. [R2-105]

Phase 0 prerequisites (jsdom + RTL harness) remain independent of us.

**Sequencing:** Narratorr ships first, feature off. Nothing on the consumer side is blocked on us —
they build against their MSW fixture — but their half stays dark until a Narratorr with Phase 1
deploys, so filing in step beats building ahead.

---

## Security invariants

- Family access is authenticated in Requests; Narratorr's public routes are **API-key authenticated,
  subject to the existing LAN-bypass posture** (`src/server/plugins/auth.ts:44-57`, `:228-233` — with
  `localBypass` on and a private source IP, any `/api/*` path authenticates with no key;
  pre-existing, deliberate, settled — but do not build on a "server-to-server only" guarantee that
  isn't there).
- No endpoint accepts a filesystem path or an archive member path from the client.
- No raw EPUB HTML executes in any origin — none is rendered at all in Phase 1.
- Symlinks, traversal, archive bombs, entity expansion, unbounded parsing, and stale path
  associations fail closed.
- Streaming revalidates the live file through one handle; DB discovery is never authorization.
- Logs above `debug` carry public book IDs and stable error codes — never paths, API keys, or
  EPUB content. `debug` records may carry a library path, matching the treatment
  `classifyProbeFailure` and `isCompanionEbookEligible` already use. Key material, API keys, and
  EPUB content never appear at any level.
- **Foreign-file preservation** — managed is an allowlist of **three** classes, not two: audio at any
  depth, the root cover sidecar (`delete-managed-files.ts:55-58`), **and a provenance-confirmed root
  `metadata.opf`** (`classifyRootOpf` at `:60-81`, dispatched at `:122-126`, which reads the file and
  deletes it as managed only when it carries the Narratorr marker). v2 described two and passed it as
  verified — correct the description; **EPUB remains foreign and preserved in every mode**, which is
  the property this feature depends on. [R2-106]

### The guardrail to paste into every issue

`src/server/services/search-pipeline.ts:76-80` — `EBOOK_FORMAT_RE` **rejects** ebook-only releases
from audiobook search. Existing, correct, unchanged behavior. Do not let anyone "helpfully" relax it
as part of this work: that is the acquisition door opening by accident, and the single most likely way
this boundary gets breached.

---

## Explicitly deferred

- **Sandboxed body preview** — needs a named sanitizer strategy with a priced dependency, a
  built-container smoke test (no DOM runtime on the server today), per-frame CSP + `srcdoc`, and a
  full XSS fixture suite. (v1 **D-3**, 12/12 that it must not block Phase 2.)
- **Companion → connector refresh** — no consumer routes through ABS.
- **Family library browse channel** — withdrawn by the consumer. If it returns, that is when a
  filtered list endpoint, a cover-by-id route, and edition disambiguation get designed.
- **Admin-configurable attachment limit** — unless a real EPUB trips 25 MiB.
- **Re-import into a folder holding a previous edition's EPUB.** `import-orchestration.helpers.ts:301`
  gates the collision fence on **audio** size only, so a folder holding nothing but a stale EPUB reads
  as empty; reconciliation then marks the previous edition's EPUB `available` for the new book —
  structurally valid, indistinguishable from correct, offered as Send-to-Kindle for the wrong book.
  Cheap boundary-respecting answer when it is addressed: when the import trigger creates or re-paths a
  book and reconciliation finds a candidate whose `mtime` predates the import timestamp, record
  `unavailable` with a distinct owner note until the owner confirms. **Decide it rather than writing
  "assert the behavior, whatever it is" in a test plan.** [R2-35]

### The bundled-EPUB copy cluster — 1.1

Copying a co-located `.epub` into the library at import time. Deferred not on boundary grounds — the
app already protects that exact file by name at `import-orchestration.helpers.ts:347-353`, and
`#1602`'s audio-only choice was a *consistency* fix between two diverging import paths, not a product
stance — but because it is a cluster of decisions, each one Narratorr choosing for the owner:

1. Target folder already holds an EPUB — overwrite, skip, or `ambiguous`? Overwrite collides with the
   invariant that Narratorr never replaces the owner's file.
2. Source holds two EPUBs — which one, on what basis? Any answer is a guess.
3. A PDF rides along — does the door open once it's open to EPUB?
4. A suspiciously-named non-EPUB (`book.epub.pdf`) — validate before or after copying?
5. Wrong-release residue — the bad release's EPUB survives cleanup, the right release brings its own,
   and the folder lands in `ambiguous` with no explanation.
6. Unvetted content — the copied EPUB may be DRM'd, an advertisement, or a different book. Structural
   validation catches garbage, not wrong-book.

Revisit as a unit with its own design pass.

---

## Non-normative: the acquisition door

The design does not close it. A future stager could validate an EPUB, atomically place it in the
audiobook folder, and call `CompanionEbookService.reconcile(bookId)` — the same service every trigger
uses. Narratorr could then be an integrator or an implementor without changing today's family
contract.

**This paragraph is architecture prose. It must not appear in any GitHub issue body or acceptance
criterion, and it must never be cited to justify a `source`/`provider`/`download_id`/`managed` column
now.**
