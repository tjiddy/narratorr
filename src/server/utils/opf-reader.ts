import { readFile, stat } from 'node:fs/promises';
import { extname, join } from 'node:path';
import * as cheerio from 'cheerio';
import type { Cheerio, CheerioAPI } from 'cheerio';
import type { FastifyBaseLogger } from 'fastify';
import { OPF_FILENAME } from '@core/utils/opf-regex.js';
import { AUDIO_EXTENSIONS } from '@core/utils/audio-constants.js';
import { serializeError } from './serialize-error.js';

/**
 * Read side of the `metadata.opf` sidecar (#2158) — the twin of `opf-writer.ts`.
 *
 * **The parser choice is the security control.** `cheerio.load(xml, { xmlMode: true })` runs on
 * htmlparser2, which performs no DTD or entity resolution whatsoever, so XXE and entity-expansion
 * DoS are not *defended against* here — they are *structurally unavailable*, and there is nothing to
 * configure. Swapping in a real XML parser (`fast-xml-parser`, `xml2js`, `@xmldom/xmldom`, `sax`)
 * would silently reintroduce a file-read primitive into a process whose config directory holds
 * `secret.key`. The XXE fixtures in `opf-reader.test.ts` are kept permanently for exactly that
 * reason, even though they pass trivially today. (Same rationale as `core/epub/xml.ts`; the shapes
 * below are deliberately *copied* rather than imported — `src/core/epub/*` is an internal-only
 * surface, #2030.)
 *
 * **`null` means "no usable document", not "not well-formed".** htmlparser2 never throws on
 * malformed input — it silently repairs unclosed and mismatched tags — so a well-formedness verdict
 * is simply not available to us. The contract is narrowed to what the mechanism can decide:
 * {@link parseOpf} returns `null` for binary garbage, an HTML page, a non-`package` root, AND for a
 * structurally valid document that yields no usable field. An all-null `OpfMetadata` is therefore
 * not a reachable return value: both cases mean "the OPF contributed nothing".
 *
 * **Foreign sidecars are read.** The narratorr provenance marker gates the *writer* (never clobber a
 * user's ABS/Calibre file); reading is the opposite polarity — an ABS/Calibre `metadata.opf` is
 * exactly the curated input this feature honors. Because foreign files are admitted, the reader
 * cannot assume the writer's single-valued output, which is what the selection rules below are for.
 */

// ── Bounds ───────────────────────────────────────────────────────────────
//
// This path bypasses `stagedBookMetadataSchema` entirely (the overlay runs after the staged
// finalize), so the reader enforces its own bounds, taken from `import-staging/schemas.ts:88-92`.
// An over-long identifier is DROPPED rather than truncated: a truncated ASIN is a *wrong identity*
// that would feed dedupe and create, whereas an absent one is merely no signal.

const ID_MAX = 64;
const SHORT_TEXT_MAX = 512;
const DESCRIPTION_MAX = 8_000;
const GENRE_ELEMENT_MAX = 128;
const ARRAY_MAX = 64;

/**
 * Largest `metadata.opf` the reader will parse, checked against `stat` before the file is read.
 * Mirrors `core/epub/limits.ts`'s `MAX_XML_BYTES` without importing it (#2030 — that module is an
 * internal EPUB surface, and the two limits must be free to drift independently).
 */
export const MAX_OPF_BYTES = 4 * 1024 * 1024;

// ── Types ────────────────────────────────────────────────────────────────

/** Everything the reader can recover from a sidecar. Absent scalars are `null`, never `undefined`. */
export interface OpfMetadata {
  title: string | null;
  subtitle: string | null;
  authors: string[];
  narrators: string[];
  description: string | null;
  publisher: string | null;
  publishedDate: string | null;
  asin: string | null;
  isbn: string | null;
  seriesName: string | null;
  seriesPosition: number | null;
  genres: string[];
}

/**
 * One normalization event. Deliberately tiny and carrying **no field values** — an 8 000-char
 * description echoed into a log line is the failure this shape exists to prevent.
 */
export interface OpfDiagnostic {
  field: string;
  kind: 'truncated' | 'capped' | 'dropped-over-bound';
}

export interface OpfParseOutcome {
  metadata: OpfMetadata | null;
  diagnostics: OpfDiagnostic[];
}

/**
 * The element type cheerio hands back, derived from cheerio's own API rather than imported from
 * `domhandler` — that package is a transitive dependency only and is unresolvable under pnpm's
 * strict layout (see the `epub-stack-type-declaration-gaps` learning).
 */
type RootChildren = ReturnType<ReturnType<CheerioAPI['root']>['children']>;
type OpfElement = RootChildren extends Cheerio<infer T> ? T : never;

// ── Name matching ────────────────────────────────────────────────────────

/** The local part of a qualified XML name — everything after the last colon, prefix ignored. */
function localName(qualifiedName: string): string {
  const colon = qualifiedName.lastIndexOf(':');
  return colon === -1 ? qualifiedName : qualifiedName.slice(colon + 1);
}

/**
 * Whether an element's local name matches `expected`, so `opf:package`, `dc:title` and a foreign
 * prefix all resolve. **Case-sensitive**, and that is load-bearing: `xmlMode` leaves `lowerCaseTags`
 * off, so `<DC:TITLE>` arrives with its case intact and must not match `title`.
 */
function hasLocalName(element: OpfElement, expected: string): boolean {
  return localName(element.name) === expected;
}

/** An attribute value looked up by local name — exact spelling first, then the first prefixed match. */
function attrByLocalName(element: OpfElement, expected: string): string | undefined {
  const attribs = element.attribs;
  const exact = attribs[expected];
  if (exact !== undefined) return exact;
  for (const [name, value] of Object.entries(attribs)) {
    if (localName(name) === expected) return value;
  }
  return undefined;
}

/**
 * An attribute value, trimmed. htmlparser2 performs **no** XML attribute-value normalisation (XML
 * 1.0 §3.3.3 says a processor must fold tab/LF/CR to spaces; this one stores the raw source text),
 * so raw separators survive into `attribs` and the trim has to be explicit. See the
 * `htmlparser2-no-attribute-normalisation` learning.
 */
function trimmedAttr(element: OpfElement, expected: string): string {
  return attrByLocalName(element, expected)?.trim() ?? '';
}

// ── Bounding pipeline ────────────────────────────────────────────────────

/** Truncate to `max`, recording one diagnostic when it bites. */
function bound(value: string, max: number, field: string, diagnostics: OpfDiagnostic[]): string {
  if (value.length <= max) return value;
  diagnostics.push({ field, kind: 'truncated' });
  return value.slice(0, max);
}

/**
 * The array pipeline, per element then per array: **trim → drop if empty → truncate the element →
 * deduplicate first-seen → cap at 64.** Both orderings are load-bearing:
 *
 * - **Truncate before deduplicate** — two creators differing only after char 512 collapse to one
 *   entry; deduplicating first would emit two byte-identical strings, a visible duplicate in the UI
 *   and in the written-back OPF.
 * - **Deduplicate before cap** — 64 repetitions of one genre followed by a unique 65th yields TWO
 *   genres; capping first would keep 64 duplicates, collapse them to one, and silently discard the
 *   only other real value.
 *
 * Deduplication is exact string equality after truncation, case-sensitive, first-seen order —
 * matching the `new Set` semantics ABS uses (`abs-opf-parser.fixture.ts:73-75`).
 */
function normalizeArray(raw: string[], max: number, field: string, diagnostics: OpfDiagnostic[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const candidate of raw) {
    const trimmed = candidate.trim();
    if (!trimmed) continue;
    const truncated = bound(trimmed, max, field, diagnostics);
    if (seen.has(truncated)) continue;
    seen.add(truncated);
    out.push(truncated);
  }
  if (out.length <= ARRAY_MAX) return out;
  diagnostics.push({ field, kind: 'capped' });
  return out.slice(0, ARRAY_MAX);
}

// ── Field selection ──────────────────────────────────────────────────────

/**
 * The **first usable** value in document order, then truncated.
 *
 * Bounds do NOT participate in the usability test here — an over-long scalar is still a usable
 * value, it is merely shortened — so a 600-char first `dc:title` wins over a later short one and is
 * stored truncated. The identifier pipeline is deliberately the other way round; see
 * {@link collectIdentifiers}.
 */
function firstScalar(
  $: CheerioAPI,
  children: OpfElement[],
  element: string,
  field: string,
  max: number,
  diagnostics: OpfDiagnostic[],
): string | null {
  for (const child of children) {
    if (!hasLocalName(child, element)) continue;
    const value = $(child).text().trim();
    if (!value) continue;
    return bound(value, max, field, diagnostics);
  }
  return null;
}

/**
 * `dc:creator` bucketed by `role` (`aut` → authors, `nrt` → narrators) and every `dc:subject` into
 * genres, all in document order.
 *
 * A role-less creator is an **author** — the Calibre convention. A creator with an unrecognised role
 * (`edt`, `ill`, …) is ignored entirely. Role *values* are compared case-insensitively after trim,
 * so `opf:role="NRT"` and `xyz:role="nrt"` both land.
 */
function collectArrays($: CheerioAPI, children: OpfElement[], diagnostics: OpfDiagnostic[]) {
  const authors: string[] = [];
  const narrators: string[] = [];
  const genres: string[] = [];
  for (const child of children) {
    if (hasLocalName(child, 'creator')) {
      const role = trimmedAttr(child, 'role').toLowerCase();
      if (role === '' || role === 'aut') authors.push($(child).text());
      else if (role === 'nrt') narrators.push($(child).text());
      continue;
    }
    if (hasLocalName(child, 'subject')) genres.push($(child).text());
  }
  return {
    authors: normalizeArray(authors, SHORT_TEXT_MAX, 'authors', diagnostics),
    narrators: normalizeArray(narrators, SHORT_TEXT_MAX, 'narrators', diagnostics),
    genres: normalizeArray(genres, GENRE_ELEMENT_MAX, 'genres', diagnostics),
  };
}

/**
 * The first usable `dc:identifier` **per scheme**, in document order; later identifiers of an
 * already-filled scheme are ignored.
 *
 * "Usable" here also excludes over-64-char values, precisely because the over-bound behavior is
 * *drop*, not truncate: a 65-char value is not a shortened identifier, it is not an identifier at
 * all. So a junk over-bound ASIN followed by a valid 10-char one yields the **valid second value**
 * rather than consuming the slot and returning `null`. That asymmetry with {@link firstScalar} is
 * deliberate.
 */
function collectIdentifiers($: CheerioAPI, children: OpfElement[], diagnostics: OpfDiagnostic[]) {
  const found: { asin: string | null; isbn: string | null } = { asin: null, isbn: null };
  for (const child of children) {
    if (!hasLocalName(child, 'identifier')) continue;
    const scheme = trimmedAttr(child, 'scheme').toUpperCase();
    const field = scheme === 'ASIN' ? 'asin' : scheme === 'ISBN' ? 'isbn' : null;
    if (field === null || found[field] !== null) continue;
    const value = $(child).text().trim();
    if (!value) continue;
    if (value.length > ID_MAX) {
      diagnostics.push({ field, kind: 'dropped-over-bound' });
      continue;
    }
    found[field] = value;
  }
  return found;
}

/** The `content` of a `<meta name="…">` in scope, or `''` when the name does not match. */
function metaContent(element: OpfElement, name: string): string {
  if (!hasLocalName(element, 'meta') || trimmedAttr(element, 'name') !== name) return '';
  return trimmedAttr(element, 'content');
}

const SERIES_NAME_META = 'calibre:series';
const SERIES_INDEX_META = 'calibre:series_index';

/**
 * Series name + position from the calibre `<meta>` pair.
 *
 * The position is the `calibre:series_index` **immediately following** the chosen `calibre:series`
 * in document order — the adjacency `generateOpf` emits, and the only pairing that stays correct
 * when a foreign document carries two series blocks. With no adjacent index, fall back to the first
 * usable index in scope **only when exactly one** `calibre:series` element is present; with 2+ and
 * no adjacency there is no non-arbitrary pairing, so the position is `null`.
 *
 * `seriesPosition: 0` survives — `generateOpf` guards its write with `!= null` precisely so a
 * legitimate position of 0 is emitted, and an empty/whitespace `content` is *not usable* rather than
 * coerced to 0.
 */
function collectSeries(children: OpfElement[], diagnostics: OpfDiagnostic[]) {
  let chosenAt = -1;
  let seriesName: string | null = null;
  let nameElementCount = 0;
  for (let i = 0; i < children.length; i++) {
    const child = children[i]!;
    if (!hasLocalName(child, 'meta') || trimmedAttr(child, 'name') !== SERIES_NAME_META) continue;
    nameElementCount++;
    const content = trimmedAttr(child, 'content');
    if (seriesName === null && content) {
      seriesName = bound(content, SHORT_TEXT_MAX, 'seriesName', diagnostics);
      chosenAt = i;
    }
  }
  if (seriesName === null) return { seriesName: null, seriesPosition: null };

  const adjacent = children[chosenAt + 1];
  let raw = adjacent ? metaContent(adjacent, SERIES_INDEX_META) : '';
  if (!raw && nameElementCount === 1) {
    raw = children.map((child) => metaContent(child, SERIES_INDEX_META)).find((content) => content !== '') ?? '';
  }
  if (!raw) return { seriesName, seriesPosition: null };
  const position = Number.parseFloat(raw);
  return { seriesName, seriesPosition: Number.isFinite(position) ? position : null };
}

// ── Document scope ───────────────────────────────────────────────────────

/**
 * The direct element children of the **first** `<metadata>` that is itself a direct child of the
 * `<package>` root — the only scope any lookup above searches.
 *
 * Never document-wide: a `<dc:title>` inside `<guide>`, inside a second `<metadata>` sibling, or
 * nested one level deeper inside the real `<metadata>` is invisible to the reader.
 */
function loadMetadataScope(xml: string): { $: CheerioAPI; children: OpfElement[] } | null {
  let $: CheerioAPI;
  try {
    $ = cheerio.load(xml, { xmlMode: true });
  } catch {
    // Defence in depth: htmlparser2 is not known to throw on any input, but the reader's contract
    // is "never throws", and that must not depend on a third-party invariant staying true.
    return null;
  }
  // `.children()` already filters to ELEMENT nodes, so the XML declaration, a DOCTYPE, a leading
  // comment, and surrounding whitespace do not count toward the single-root check.
  const roots = $.root().children().toArray();
  const root = roots[0];
  if (roots.length !== 1 || !root || !hasLocalName(root, 'package')) return null;
  const metadata = $(root).children().toArray().find((child) => hasLocalName(child, 'metadata'));
  if (!metadata) return null;
  return { $, children: $(metadata).children().toArray() };
}

/** Whether anything at all was recovered — the AC2 "all-null is not a reachable return" gate. */
function hasAnyField(metadata: OpfMetadata): boolean {
  return (
    metadata.title !== null ||
    metadata.subtitle !== null ||
    metadata.description !== null ||
    metadata.publisher !== null ||
    metadata.publishedDate !== null ||
    metadata.asin !== null ||
    metadata.isbn !== null ||
    metadata.seriesName !== null ||
    metadata.seriesPosition !== null ||
    metadata.authors.length > 0 ||
    metadata.narrators.length > 0 ||
    metadata.genres.length > 0
  );
}

// ── Public API ───────────────────────────────────────────────────────────

/**
 * Parse OPF XML, returning both the values and the normalization events.
 *
 * Exported as the **diagnostic** surface rather than the consumed one: production callers use
 * {@link readOpfMetadata} and {@link parseOpf} is the convenience form. This lower-level shape exists
 * so a test can assert diagnostics directly instead of inferring them from log output, and so the
 * pipeline can be exercised from `pnpm exec tsx` with no auth, HTTP, or logger — the same reason
 * `parseFolderStructureRaw` sits beside `parseFolderStructure`.
 *
 * **Diagnostics travel as data, not as a side effect.** That is what keeps {@link parseOpf} pure.
 */
export function parseOpfWithDiagnostics(xml: string): OpfParseOutcome {
  const diagnostics: OpfDiagnostic[] = [];
  const scope = loadMetadataScope(xml);
  if (!scope) return { metadata: null, diagnostics };

  const { $, children } = scope;
  const arrays = collectArrays($, children, diagnostics);
  const identifiers = collectIdentifiers($, children, diagnostics);
  const series = collectSeries(children, diagnostics);
  const metadata: OpfMetadata = {
    title: firstScalar($, children, 'title', 'title', SHORT_TEXT_MAX, diagnostics),
    subtitle: firstScalar($, children, 'subtitle', 'subtitle', SHORT_TEXT_MAX, diagnostics),
    // `dc:description` is taken VERBATIM, entity-unescaped, HTML **not** stripped — a deliberate
    // divergence from ABS's `fetchDescription` (`abs-opf-parser.fixture.ts:22`), which strips tags.
    // Stripping here would corrode the operator's description on every round-trip.
    description: firstScalar($, children, 'description', 'description', DESCRIPTION_MAX, diagnostics),
    publisher: firstScalar($, children, 'publisher', 'publisher', SHORT_TEXT_MAX, diagnostics),
    // `dc:date` is the RAW text, not ABS's 4-digit-year reduction — `generateOpf` writes the full
    // `book.publishedDate` string and the round-trip must return it unchanged.
    publishedDate: firstScalar($, children, 'date', 'publishedDate', SHORT_TEXT_MAX, diagnostics),
    ...arrays,
    ...identifiers,
    ...series,
  };
  return { metadata: hasAnyField(metadata) ? metadata : null, diagnostics };
}

/**
 * Parse OPF XML into {@link OpfMetadata}, or `null` when the document yields nothing usable.
 *
 * **Never throws, takes no logger, and `null` is its only "nothing here" return** — see the module
 * doc for why all three are contract rather than convenience.
 */
export function parseOpf(xml: string): OpfMetadata | null {
  return parseOpfWithDiagnostics(xml).metadata;
}

/**
 * Read `metadata.opf` from a book folder. **Absent-on-failure and never throws** — every failure
 * mode (no file, unreadable, oversized, malformed, nothing usable) yields `null`, which the import
 * overlay treats as "no sidecar" and falls through to the next rung of the ladder.
 */
async function readOpfSource(opfPath: string, log: FastifyBaseLogger): Promise<string | null> {
  try {
    const info = await stat(opfPath);
    if (info.size > MAX_OPF_BYTES) {
      log.warn({ opfPath, size: info.size, maxBytes: MAX_OPF_BYTES }, 'metadata.opf exceeds the reader size bound — ignoring sidecar');
      return null;
    }
    return await readFile(opfPath, 'utf-8');
  } catch (error: unknown) {
    // ENOENT is the overwhelmingly common case (most folders have no sidecar) — debug, not warn.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      log.debug({ opfPath }, 'No metadata.opf sidecar in book folder');
      return null;
    }
    log.warn({ opfPath, error: serializeError(error) }, 'Could not read metadata.opf — ignoring sidecar');
    return null;
  }
}

/** See {@link readOpfSource} for the failure contract. */
export async function readOpfMetadata(bookFolder: string, log: FastifyBaseLogger): Promise<OpfMetadata | null> {
  // A pointer single-file import persists a FILE path (`/audiobooks/Doctor Sleep.m4b`), not a book
  // directory, so there is no sidecar to look for. Mirrors `writeOpfSidecar`'s guard.
  if (AUDIO_EXTENSIONS.has(extname(bookFolder).toLowerCase())) {
    log.debug({ bookFolder }, 'OPF read skipped — single-file pointer path has no book folder');
    return null;
  }

  const opfPath = join(bookFolder, OPF_FILENAME);
  const xml = await readOpfSource(opfPath, log);
  if (xml === null) return null;

  const { metadata, diagnostics } = parseOpfWithDiagnostics(xml);
  // One line per diagnostic, naming the field and the kind but NEVER the value.
  for (const diagnostic of diagnostics) {
    log.debug({ opfPath, field: diagnostic.field, kind: diagnostic.kind }, 'metadata.opf value normalized to reader bounds');
  }
  if (!metadata) {
    log.debug({ opfPath }, 'metadata.opf yielded no usable metadata — ignoring sidecar');
    return null;
  }
  log.debug(
    { opfPath, authors: metadata.authors.length, narrators: metadata.narrators.length, genres: metadata.genres.length },
    'Read metadata.opf sidecar',
  );
  return metadata;
}
