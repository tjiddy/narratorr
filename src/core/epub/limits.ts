/**
 * Frozen limits for the companion-EPUB read path (#1986, design §4).
 *
 * Every bound in `src/core/epub/` is spelled once, here. No module outside this
 * folder reads them — they bound archive internals, not anything the server or
 * the client can observe.
 */

/**
 * Maximum on-disk size of a companion `.epub`, checked with one `stat` before
 * the archive is opened. `unzipper` materialises the entire central directory
 * before `Open` resolves, so a post-open byte cap has no "after" to run in.
 */
export const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;

/**
 * Maximum number of archive members, applied **once** by 1.1c — pre-open,
 * against the validated EOCD/ZIP64 *declared* record count, mapping to
 * `limit_exceeded`. That is the check that bounds the reader's allocation, and
 * via `zip-source.ts`'s validated replay the count it validated is the count the
 * reader consumes.
 *
 * `CentralDirectory.files.length` is **not** a second, independent measurement
 * against this limit — it is a defensive equality assertion only. The reader
 * builds `vars.files` from `Bluebird.mapSeries(Array(vars.numberOfRecords), …)`
 * (`unzipper@0.12.3/lib/Open/directory.js:185-239`), so `files.length` *is* the
 * declared count by construction and a post-open ceiling branch is unreachable.
 *
 * Source: **#1988 Decision 1**, which overrides §4's prose (`docs/plans/
 * companion-ebook-support.md:293-313`) and its frozen-limits paragraph
 * (`:839-843`), neither of which lists an entry cap. The measured reason: a
 * 213-byte forged ZIP64 archive OOM-kills the process after ~31 s under a 1 GiB
 * heap cap, because `unzipper@0.12.3/lib/Open/directory.js:185` maps over
 * `Array(vars.numberOfRecords)` and `numberOfRecords` is an unchecked 8-byte
 * field on the ZIP64 path. The 256 MiB file-size ceiling does not bound it.
 */
export const MAX_ARCHIVE_ENTRIES = 10000;

/**
 * Total inflated bytes an inspection may read across all its member reads,
 * enforced by the counting transform on the actual inflated stream. Declared
 * central-directory sizes are attacker-authored and advisory only.
 */
export const MAX_INSPECTION_BYTES = 16 * 1024 * 1024;

/** Maximum inflated bytes of a single XML document (container, package, nav, NCX) before parsing. */
export const MAX_XML_BYTES = 4 * 1024 * 1024;

/**
 * Maximum inflated bytes of a cover image extracted *from inside* an EPUB.
 *
 * Deliberately distinct from `MAX_COVER_SIZE` (`src/shared/constants.ts`), which
 * caps an outbound HTTP download of audiobook cover art. Different subjects,
 * different failure modes, independent drift — do not unify or alias them.
 */
export const MAX_EPUB_COVER_BYTES = 8 * 1024 * 1024;

/** Maximum TOC entries retained from a nav document or NCX. */
export const MAX_TOC_ENTRIES = 2000;
