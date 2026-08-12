import type { CheerioAPI } from 'cheerio';
import { MAX_EPUB_COVER_BYTES, MAX_TOC_ENTRIES, MAX_XML_BYTES } from './limits.js';
import { resolveHref } from './paths.js';
import type { EpubCover, EpubMetadata, EpubTocEntry } from './result.js';
import type { EpubXmlElement, EpubXmlResult, EpubXmlRootName } from './xml.js';
import {
  attrByExactName,
  attrByLocalName,
  childrenByLocalName,
  hasLocalName,
  parseEpubXml,
} from './xml.js';
import type { ZipArchiveEntry, ZipEntryRead } from './zip-source.js';

/**
 * Extracts metadata, TOC, and cover from an already-validated EPUB. Optional read
 * failures become null and never change `available`; discovery follows OPF references,
 * never filenames. Covers are byte-capped and signature-sniffed but never decoded here.
 */

type EpubDocument = Extract<EpubXmlResult, { kind: 'document' }>;

/** Narrow projection of the already-parsed package document. */
export interface EpubPackageView {
  readonly document: EpubDocument;
  /** The directory manifest `href`s resolve against (EPUB 3.3 §5.2). */
  readonly baseDir: string;
  /** The manifest's `<item>` elements, in document order. */
  readonly items: readonly EpubXmlElement[];
  /** Manifest items keyed by `id`; a **duplicated** id maps to `null`. */
  readonly itemsById: ReadonlyMap<string, EpubXmlElement | null>;
  /** The first `<spine>` element, or `undefined`. */
  readonly spine: EpubXmlElement | undefined;
}

/** Optional reads charge as they go without rollback; non-throw failures dispose to null. */
export interface EpubOptionalReader {
  entry(name: string): ZipArchiveEntry | undefined;
  read(entry: ZipArchiveEntry, ceiling: number): Promise<ZipEntryRead>;
}

/** XML whitespace (XML 1.0 §2.3) — the separator for every token-set attribute here. */
const XML_WHITESPACE_RE = /[\t\n\f\r ]+/;

/** Exact XML-whitespace token membership; never substring or prefix matching. */
function hasToken(value: string | undefined, token: string): boolean {
  return value !== undefined && value.split(XML_WHITESPACE_RE).includes(token);
}

/** Resolves and budget-reads one item; reader-propagated I/O errors remain throws. */
async function readItemBytes(
  view: EpubPackageView,
  reader: EpubOptionalReader,
  item: EpubXmlElement,
  ceiling: number,
): Promise<Buffer | null> {
  const href = attrByExactName(item, 'href');
  if (href === undefined) return null;
  const resolved = resolveHref(view.baseDir, href);
  if (resolved.kind !== 'entry') return null;
  const entry = reader.entry(resolved.name);
  if (!entry) return null;
  const read = await reader.read(entry, ceiling);
  return read.kind === 'bytes' ? read.bytes : null;
}

async function readItemXml(
  view: EpubPackageView,
  reader: EpubOptionalReader,
  item: EpubXmlElement,
  expectedRoot: EpubXmlRootName,
): Promise<EpubDocument | null> {
  const bytes = await readItemBytes(view, reader, item, MAX_XML_BYTES);
  if (bytes === null) return null;
  const document = parseEpubXml(bytes, expectedRoot);
  return document.kind === 'document' ? document : null;
}

/** First direct metadata child, shared with cover discovery. */
function metadataParent(document: EpubDocument): EpubXmlElement | undefined {
  return childrenByLocalName(document.$, document.root, 'metadata')[0];
}

/** First non-empty direct child in document order; multiple values are not joined. */
function firstNonEmptyField(
  $: CheerioAPI,
  parent: EpubXmlElement,
  expected: string,
): string | null {
  for (const candidate of childrenByLocalName($, parent, expected)) {
    const text = $(candidate).text().trim();
    if (text !== '') return text;
  }
  return null;
}

/** Reads direct metadata children by local name; missing fields are null without I/O or budget use. */
export function extractEpubMetadata(view: EpubPackageView): EpubMetadata {
  const parent = metadataParent(view.document);
  if (!parent) return { title: null, author: null, language: null };
  const { $ } = view.document;
  return {
    title: firstNonEmptyField($, parent, 'title'),
    author: firstNonEmptyField($, parent, 'creator'),
    language: firstNonEmptyField($, parent, 'language'),
  };
}

/** Parameterizes the shared EPUB 3 nav and EPUB 2 NCX traversal. */
interface TocDialect {
  readonly row: string;
  /** EPUB 3 descends through ol; NCX descends through the navPoint itself. */
  container($: CheerioAPI, row: EpubXmlElement): EpubXmlElement | undefined;
  label($: CheerioAPI, row: EpubXmlElement): string | null;
}

/** Collapse runs of whitespace to a single space and trim; empty becomes `null`. */
function normalizeTitle(raw: string): string | null {
  const title = raw.replace(/\s+/g, ' ').trim();
  return title === '' ? null : title;
}

/** Uses a direct a/span child so a parent row cannot swallow nested row titles. */
function navRowLabel($: CheerioAPI, row: EpubXmlElement): string | null {
  const label = childrenByLocalName($, row, 'a')[0] ?? childrenByLocalName($, row, 'span')[0];
  return label ? normalizeTitle($(label).text()) : null;
}

function ncxRowLabel($: CheerioAPI, row: EpubXmlElement): string | null {
  const navLabel = childrenByLocalName($, row, 'navLabel')[0];
  if (!navLabel) return null;
  const text = childrenByLocalName($, navLabel, 'text')[0];
  return text ? normalizeTitle($(text).text()) : null;
}

const NAV_DIALECT: TocDialect = {
  row: 'li',
  container: ($, row) => childrenByLocalName($, row, 'ol')[0],
  label: navRowLabel,
};

const NCX_DIALECT: TocDialect = {
  row: 'navPoint',
  container: (_$, row) => row,
  label: ncxRowLabel,
};

interface PendingRow {
  readonly element: EpubXmlElement;
  readonly depth: number;
}

/**
 * Iterative depth-first pre-order flattening. Depth follows structure even when a
 * label-less row is omitted. The visit cap bounds work, not merely emitted rows.
 */
function flattenToc(
  $: CheerioAPI,
  startContainer: EpubXmlElement,
  dialect: TocDialect,
): EpubTocEntry[] {
  const entries: EpubTocEntry[] = [];
  const stack: PendingRow[] = [];
  pushRows(stack, childrenByLocalName($, startContainer, dialect.row), 0);

  let visited = 0;
  while (visited < MAX_TOC_ENTRIES) {
    const pending = stack.pop();
    if (!pending) break;
    visited += 1;
    const title = dialect.label($, pending.element);
    if (title !== null) entries.push({ title, depth: pending.depth });
    const container = dialect.container($, pending.element);
    if (container === undefined) continue;
    pushRows(stack, childrenByLocalName($, container, dialect.row), pending.depth + 1);
  }
  return entries;
}

function pushRows(stack: PendingRow[], rows: readonly EpubXmlElement[], depth: number): void {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    stack.push({ element: rows[index]!, depth });
  }
}

/**
 * Iteratively finds the first descendant nav with a toc type token. Nav is the one
 * intentional descendant search, and local-name attribute lookup permits rebound prefixes.
 */
function findTocNav(document: EpubDocument): EpubXmlElement | null {
  const { $ } = document;
  const stack: EpubXmlElement[] = [document.root];
  while (stack.length > 0) {
    const element = stack.pop()!;
    if (hasLocalName(element, 'nav') && hasToken(attrByLocalName(element, 'epub:type'), 'toc')) {
      return element;
    }
    const children = $(element).children().toArray();
    for (let index = children.length - 1; index >= 0; index -= 1) stack.push(children[index]!);
  }
  return null;
}

async function readNavToc(
  view: EpubPackageView,
  reader: EpubOptionalReader,
  item: EpubXmlElement,
): Promise<EpubTocEntry[] | null> {
  const document = await readItemXml(view, reader, item, 'html');
  if (!document) return null;
  const nav = findTocNav(document);
  if (!nav) return null;
  const list = childrenByLocalName(document.$, nav, 'ol')[0];
  if (!list) return null;
  return flattenToc(document.$, list, NAV_DIALECT);
}

/** Resolves the spine toc id to an NCX; duplicated manifest ids resolve to null. */
async function readNcxToc(
  view: EpubPackageView,
  reader: EpubOptionalReader,
): Promise<EpubTocEntry[] | null> {
  if (!view.spine) return null;
  const tocId = attrByExactName(view.spine, 'toc');
  if (tocId === undefined) return null;
  const item = view.itemsById.get(tocId);
  if (!item) return null;
  const document = await readItemXml(view, reader, item, 'ncx');
  if (!document) return null;
  const navMap = childrenByLocalName(document.$, document.root, 'navMap')[0];
  if (!navMap) return null;
  return flattenToc(document.$, navMap, NCX_DIALECT);
}

/**
 * EPUB 3 nav selection precludes NCX fallback, even when the selected nav is unusable;
 * retrying would couple both resources through one charged budget. Empty output becomes null.
 */
export async function extractEpubToc(
  view: EpubPackageView,
  reader: EpubOptionalReader,
): Promise<EpubTocEntry[] | null> {
  const navItem = view.items.find((item) => hasToken(attrByExactName(item, 'properties'), 'nav'));
  const entries = navItem
    ? await readNavToc(view, reader, navItem)
    : await readNcxToc(view, reader);
  return entries === null || entries.length === 0 ? null : entries;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_SIGNATURE = Buffer.from([0xff, 0xd8, 0xff]);
const GIF87A_SIGNATURE = Buffer.from('GIF87a', 'ascii');
const GIF89A_SIGNATURE = Buffer.from('GIF89a', 'ascii');
const RIFF_SIGNATURE = Buffer.from('RIFF', 'ascii');
const WEBP_SIGNATURE = Buffer.from('WEBP', 'ascii');
/** WebP's second marker follows RIFF and its four-byte chunk size. */
const WEBP_MARKER_OFFSET = 8;

/** Full signature match; clamped short inputs cannot match partially. */
function matchesAt(bytes: Buffer, signature: Buffer, offset: number): boolean {
  return bytes.subarray(offset, offset + signature.length).equals(signature);
}

/** Uses full byte signatures rather than manifest claims; unsupported bytes, including SVG, return null. */
function sniffMediaType(bytes: Buffer): EpubCover['mediaType'] | null {
  if (matchesAt(bytes, PNG_SIGNATURE, 0)) return 'image/png';
  if (matchesAt(bytes, JPEG_SIGNATURE, 0)) return 'image/jpeg';
  if (matchesAt(bytes, GIF87A_SIGNATURE, 0) || matchesAt(bytes, GIF89A_SIGNATURE, 0)) {
    return 'image/gif';
  }
  if (matchesAt(bytes, RIFF_SIGNATURE, 0) && matchesAt(bytes, WEBP_SIGNATURE, WEBP_MARKER_OFFSET)) {
    return 'image/webp';
  }
  return null;
}

/**
 * Cover selection uses the first metadata declaration, otherwise the first cover-image
 * manifest item. A declared but unusable tier-one cover never falls back to tier two.
 */
function findCoverItem(view: EpubPackageView): EpubXmlElement | null {
  const { $ } = view.document;
  const parent = metadataParent(view.document);
  const declared = parent
    ? childrenByLocalName($, parent, 'meta').find(
        (meta) => attrByExactName(meta, 'name') === 'cover',
      )
    : undefined;
  if (declared) {
    const content = attrByExactName(declared, 'content');
    return content === undefined ? null : (view.itemsById.get(content) ?? null);
  }
  return (
    view.items.find((item) => hasToken(attrByExactName(item, 'properties'), 'cover-image')) ?? null
  );
}

/** Oversize, failed, skipped, or unrecognized cover reads return null. */
export async function extractEpubCover(
  view: EpubPackageView,
  reader: EpubOptionalReader,
): Promise<EpubCover | null> {
  const item = findCoverItem(view);
  if (!item) return null;
  const bytes = await readItemBytes(view, reader, item, MAX_EPUB_COVER_BYTES);
  if (bytes === null) return null;
  const mediaType = sniffMediaType(bytes);
  return mediaType === null ? null : { mediaType, bytes };
}
