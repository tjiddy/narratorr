import { readFile, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import { OPF_FILENAME, NARRATORR_OPF_MARKER, hasNarratorrMarker } from '../../core/utils/opf-regex.js';
import { AUDIO_EXTENSIONS } from '../../core/utils/audio-constants.js';
import type { BookService, BookWithAuthor } from '../services/book.service.js';
import { serializeError } from './serialize-error.js';

/**
 * XML-1.0-invalid control characters: everything in C0 except tab (`\x09`), LF (`\x0A`) and CR
 * (`\x0D`), which XML 1.0 §2.2 permits. External provider text (Audnexus/Hardcover/Audible) and user
 * edits can carry a stray control byte; left in, it produces a well-escaped-but-malformed OPF that
 * ABS's `parseOpfMetadata` rejects wholesale. Mirrors the `\x00-\x1f` strip in
 * `naming.ts`'s `sanitizePath` (filesystem safety) — here it is XML-well-formedness safety.
 */
// eslint-disable-next-line no-control-regex
const XML_INVALID_CONTROL_CHARS = /[\x00-\x08\x0B\x0C\x0E-\x1F]/g;

/**
 * Escape a string for safe inclusion in XML text or attribute values.
 *
 * `&` MUST be replaced first — it is the entity-introducer, so escaping it after the others would
 * double-escape the `&` in `&lt;`/`&quot;` etc. There is no XML-escape helper elsewhere in the
 * codebase (no `xmlbuilder`/`entities` dependency), so the writer escapes itself; an unescaped `&`
 * in a title makes the whole OPF malformed.
 */
function escapeXml(value: string): string {
  return value
    // Strip XML-invalid control chars FIRST (additive — leaves the entity escaping below
    // byte-for-byte unchanged); `&` stays the first entity replaced so it is never double-escaped.
    .replace(XML_INVALID_CONTROL_CHARS, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Generate an Audiobookshelf-compatible `metadata.opf` (OPF 2.0) from a resolved book record.
 *
 * Element/attribute shapes are fixed to exactly what ABS's `parseOpfMetadata.js` reads:
 * - `dc:title`
 * - one `dc:creator opf:role="aut"` per author and one `opf:role="nrt"` per narrator, in
 *   `BookWithAuthor` source order (ABS reads ALL matching creators into arrays).
 * - `dc:identifier opf:scheme="ASIN"` / `opf:scheme="ISBN"`
 * - series as the adjacent `<meta name="calibre:series">` then `<meta name="calibre:series_index">`
 * - `dc:subtitle`, `dc:description`, `dc:publisher`, `dc:date`, one `dc:subject` per genre.
 *
 * No `dc:language` (the books table has no language column — out of scope this phase) and no cover
 * reference (ABS does not read a cover from OPF). Optional fields that are null/empty are omitted
 * cleanly. `seriesPosition` is guarded with `!= null` so a legitimate position of `0` is emitted.
 */
export function generateOpf(book: BookWithAuthor): string {
  const lines: string[] = [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<package version="2.0" xmlns="http://www.idpf.org/2007/opf" unique-identifier="bookid">',
    '  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">',
    // Inert provenance marker — proves narratorr authored this OPF so the cleanup sweep may delete it
    // and the writer may overwrite it, without clobbering a foreign ABS/Calibre `metadata.opf`.
    `    ${NARRATORR_OPF_MARKER}`,
    `    <dc:title>${escapeXml(book.title)}</dc:title>`,
  ];

  if (book.subtitle) lines.push(`    <dc:subtitle>${escapeXml(book.subtitle)}</dc:subtitle>`);

  for (const author of book.authors) {
    lines.push(`    <dc:creator opf:role="aut">${escapeXml(author.name)}</dc:creator>`);
  }
  for (const narrator of book.narrators) {
    lines.push(`    <dc:creator opf:role="nrt">${escapeXml(narrator.name)}</dc:creator>`);
  }

  if (book.description) lines.push(`    <dc:description>${escapeXml(book.description)}</dc:description>`);
  if (book.publisher) lines.push(`    <dc:publisher>${escapeXml(book.publisher)}</dc:publisher>`);
  if (book.publishedDate) lines.push(`    <dc:date>${escapeXml(book.publishedDate)}</dc:date>`);

  if (book.asin) lines.push(`    <dc:identifier opf:scheme="ASIN">${escapeXml(book.asin)}</dc:identifier>`);
  if (book.isbn) lines.push(`    <dc:identifier opf:scheme="ISBN">${escapeXml(book.isbn)}</dc:identifier>`);

  if (book.seriesName) {
    lines.push(`    <meta name="calibre:series" content="${escapeXml(book.seriesName)}"/>`);
    // `!= null` (not truthy): a legitimate series position of 0 must still be emitted.
    if (book.seriesPosition != null) {
      lines.push(`    <meta name="calibre:series_index" content="${escapeXml(String(book.seriesPosition))}"/>`);
    }
  }

  for (const genre of book.genres ?? []) {
    lines.push(`    <dc:subject>${escapeXml(genre)}</dc:subject>`);
  }

  lines.push('  </metadata>', '</package>', '');
  return lines.join('\n');
}

export interface WriteOpfForImportArgs {
  /** Gate — the `tagging.writeOpf` setting. When false the helper is a no-op (no fresh load, no write). */
  enabled: boolean;
  bookService: BookService;
  bookId: number;
  /** The book folder the OPF is written into (`result.targetPath` auto / `finalPath` manual). */
  bookFolder: string;
  log: FastifyBaseLogger;
}

/**
 * Decide whether `writeOpfForImport` may write to `opfPath`. narratorr only owns an OPF it wrote, so:
 * absent (ENOENT) → write freely; present-and-marked → overwrite our own file; present-and-unmarked
 * → a foreign ABS/Calibre file, do NOT clobber it. A read failure (EACCES/EISDIR/…) fails safe: we
 * could not confirm ownership, so we skip rather than risk overwriting a user file.
 */
async function mayWriteOpf(opfPath: string, log: FastifyBaseLogger): Promise<boolean> {
  let existing: string;
  try {
    existing = await readFile(opfPath, 'utf-8');
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true; // no file yet → write
    log.warn({ opfPath, error: serializeError(error) }, 'Could not read existing metadata.opf — skipping OPF write to avoid clobbering a foreign file');
    return false;
  }
  if (hasNarratorrMarker(existing)) return true; // our own previous OPF → overwrite
  log.warn({ opfPath }, 'Existing metadata.opf is foreign (no narratorr marker) — skipping OPF write to preserve it');
  return false;
}

/** Outcome of an OPF sidecar write attempt — lets bulk callers account for per-book failures. */
export type OpfWriteOutcome = 'written' | 'skipped' | 'failed';

/**
 * Shared OPF generate + write core, invoked from BOTH import surfaces (auto orchestrator and
 * manual/adopt), the per-book edit triggers, and the library-reconcile bulk job. Loads a FRESH
 * `BookWithAuthor` by id at write time — never a pre-import snapshot — so a narrator (or other
 * field) filled by import enrichment is present in the written file. The OPF is a canonical on-disk
 * artifact, so this is an awaited inline write (NOT the droppable connector queue).
 *
 * Returns an outcome rather than throwing: `'written'` on a successful write, `'skipped'` when the
 * gate is off / the path is a single-file pointer / the book is missing / the target is a foreign
 * OPF, and `'failed'` when the load or `writeFile` rejects. The reconcile bulk job uses this result
 * to count failures; {@link writeOpfForImport} wraps it to preserve the legacy nonfatal `void`
 * contract for the import and per-book edit callers.
 *
 * Never overwrites a foreign `metadata.opf` (an ABS/Calibre sidecar narratorr did not author): the
 * target is pre-read and the write is skipped unless the file is absent or carries the narratorr
 * provenance marker. See {@link mayWriteOpf}.
 */
export async function writeOpfSidecar(args: WriteOpfForImportArgs): Promise<OpfWriteOutcome> {
  const { enabled, bookService, bookId, bookFolder, log } = args;
  if (!enabled) return 'skipped';

  // Pointer single-file imports persist a *file* path (e.g. `/audiobooks/Doctor Sleep.m4b`), not a
  // book directory. `join(<file>, OPF_FILENAME)` would target a path beneath a file (ENOTDIR), and
  // the parent dir can't be assumed to be a one-book folder (a loose file commonly sits in a shared
  // library root), so a sidecar there would be wrong/clobbering. Skip with a warning — never write.
  if (AUDIO_EXTENSIONS.has(extname(bookFolder).toLowerCase())) {
    log.warn({ bookId, bookFolder }, 'OPF write skipped — pointer single-file import has no dedicated book folder');
    return 'skipped';
  }

  try {
    const book = await bookService.getById(bookId);
    if (!book) {
      log.warn({ bookId }, 'OPF write skipped — book not found');
      return 'skipped';
    }
    const opfPath = join(bookFolder, OPF_FILENAME);
    if (!(await mayWriteOpf(opfPath, log))) return 'skipped';
    await writeFile(opfPath, generateOpf(book), 'utf-8');
    log.info({ bookId, opfPath }, 'Wrote metadata.opf sidecar');
    return 'written';
  } catch (error: unknown) {
    log.warn({ error: serializeError(error), bookId }, 'Failed to write metadata.opf — continuing');
    return 'failed';
  }
}

/**
 * Thin nonfatal `void` wrapper over {@link writeOpfSidecar}, preserving the original import/per-book
 * contract: errors are swallowed (already logged inside the core), so the caller's import or edit
 * flow continues regardless of outcome.
 */
export async function writeOpfForImport(args: WriteOpfForImportArgs): Promise<void> {
  await writeOpfSidecar(args);
}
