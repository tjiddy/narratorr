import { readFile, stat } from 'node:fs/promises';
import { extname, join } from 'node:path';
import * as cheerio from 'cheerio';
import type { Cheerio, CheerioAPI } from 'cheerio';
import type { FastifyBaseLogger } from 'fastify';
import { OPF_FILENAME } from '@core/utils/opf-regex.js';
import { AUDIO_EXTENSIONS } from '@core/utils/audio-constants.js';
import { serializeError } from './serialize-error.js';

/**
 * htmlparser2's lack of DTD/entity resolution is the XXE control; replacing the parser requires
 * re-evaluating that threat. `null` means no usable metadata, not a well-formedness verdict.
 * Foreign OPFs are intentionally readable even though only narratorr-owned OPFs are writable.
 */

// This bypasses staged metadata validation. Over-bound identifiers are dropped, never
// truncated into a different identity that could corrupt deduplication.

const ID_MAX = 64;
const SHORT_TEXT_MAX = 512;
const DESCRIPTION_MAX = 8_000;
const GENRE_ELEMENT_MAX = 128;
const ARRAY_MAX = 64;

/** Largest sidecar parsed, checked before reading the file. */
export const MAX_OPF_BYTES = 4 * 1024 * 1024;

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

/** A normalization event without field values, safe to log. */
export interface OpfDiagnostic {
  field: string;
  kind: 'truncated' | 'capped' | 'dropped-over-bound';
}

export interface OpfParseOutcome {
  metadata: OpfMetadata | null;
  diagnostics: OpfDiagnostic[];
}

/** Derive the element type without importing the transitive-only domhandler package. */
type RootChildren = ReturnType<ReturnType<CheerioAPI['root']>['children']>;
type OpfElement = RootChildren extends Cheerio<infer T> ? T : never;

function localName(qualifiedName: string): string {
  const colon = qualifiedName.lastIndexOf(':');
  return colon === -1 ? qualifiedName : qualifiedName.slice(colon + 1);
}

/** Match prefix-agnostically but case-sensitively; xmlMode preserves tag case. */
function hasLocalName(element: OpfElement, expected: string): boolean {
  return localName(element.name) === expected;
}

function attrByLocalName(element: OpfElement, expected: string): string | undefined {
  const attribs = element.attribs;
  const exact = attribs[expected];
  if (exact !== undefined) return exact;
  for (const [name, value] of Object.entries(attribs)) {
    if (localName(name) === expected) return value;
  }
  return undefined;
}

/** htmlparser2 leaves raw attribute whitespace intact, so trim explicitly. */
function trimmedAttr(element: OpfElement, expected: string): string {
  return attrByLocalName(element, expected)?.trim() ?? '';
}

function bound(value: string, max: number, field: string, diagnostics: OpfDiagnostic[]): string {
  if (value.length <= max) return value;
  diagnostics.push({ field, kind: 'truncated' });
  return value.slice(0, max);
}

/**
 * Order is load-bearing: trim, drop empty, truncate, first-seen deduplicate, then cap.
 * Reversing truncate/deduplicate creates visible duplicates; capping earlier loses unique values.
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

/** First non-empty scalar wins, then truncates; identifiers deliberately use different rules. */
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

/** Bucket creators by role; role-less means author, unknown roles are ignored. */
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

/** First usable identifier per scheme wins; over-bound values are dropped without consuming it. */
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

function metaContent(element: OpfElement, name: string): string {
  if (!hasLocalName(element, 'meta') || trimmedAttr(element, 'name') !== name) return '';
  return trimmedAttr(element, 'content');
}

const SERIES_NAME_META = 'calibre:series';
const SERIES_INDEX_META = 'calibre:series_index';

/**
 * Pair a series with its immediately adjacent index. A lone series may fall back to the only
 * usable index; multiple unpaired series are ambiguous. Position zero remains valid.
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

/** Search only direct children of the first metadata element directly under the package root. */
function loadMetadataScope(xml: string): { $: CheerioAPI; children: OpfElement[] } | null {
  let $: CheerioAPI;
  try {
    $ = cheerio.load(xml, { xmlMode: true });
  } catch {
    // Preserve the never-throws contract if htmlparser2 changes.
    return null;
  }
  // children() excludes declarations, doctypes, comments, and whitespace from root counting.
  const roots = $.root().children().toArray();
  const root = roots[0];
  if (roots.length !== 1 || !root || !hasLocalName(root, 'package')) return null;
  const metadata = $(root).children().toArray().find((child) => hasLocalName(child, 'metadata'));
  if (!metadata) return null;
  return { $, children: $(metadata).children().toArray() };
}

/** Prevent an all-null metadata result from escaping. */
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

/** Parse values and normalization diagnostics without logging side effects. */
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
    // Preserve description markup on round-trip; ABS stripping applies only to its import parser.
    description: firstScalar($, children, 'description', 'description', DESCRIPTION_MAX, diagnostics),
    publisher: firstScalar($, children, 'publisher', 'publisher', SHORT_TEXT_MAX, diagnostics),
    // Preserve the full written date rather than ABS's year-only projection.
    publishedDate: firstScalar($, children, 'date', 'publishedDate', SHORT_TEXT_MAX, diagnostics),
    ...arrays,
    ...identifiers,
    ...series,
  };
  return { metadata: hasAnyField(metadata) ? metadata : null, diagnostics };
}

/** Pure, never-throwing parse; `null` is the only no-usable-metadata result. */
export function parseOpf(xml: string): OpfMetadata | null {
  return parseOpfWithDiagnostics(xml).metadata;
}

/** Read a bounded sidecar; every failure returns null so overlay can fall through. */
async function readOpfSource(opfPath: string, log: FastifyBaseLogger): Promise<string | null> {
  try {
    const info = await stat(opfPath);
    if (info.size > MAX_OPF_BYTES) {
      log.warn({ opfPath, size: info.size, maxBytes: MAX_OPF_BYTES }, 'metadata.opf exceeds the reader size bound — ignoring sidecar');
      return null;
    }
    return await readFile(opfPath, 'utf-8');
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      log.debug({ opfPath }, 'No metadata.opf sidecar in book folder');
      return null;
    }
    log.warn({ opfPath, error: serializeError(error) }, 'Could not read metadata.opf — ignoring sidecar');
    return null;
  }
}

export async function readOpfMetadata(bookFolder: string, log: FastifyBaseLogger): Promise<OpfMetadata | null> {
  // A pointer single-file import has no book directory in which to find a sidecar.
  if (AUDIO_EXTENSIONS.has(extname(bookFolder).toLowerCase())) {
    log.debug({ bookFolder }, 'OPF read skipped — single-file pointer path has no book folder');
    return null;
  }

  const opfPath = join(bookFolder, OPF_FILENAME);
  const xml = await readOpfSource(opfPath, log);
  if (xml === null) return null;

  const { metadata, diagnostics } = parseOpfWithDiagnostics(xml);
  // Never log normalized field values.
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
