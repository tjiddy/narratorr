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
 * The optional reads for companion EPUBs (#1990, design §4) — metadata, the
 * table of contents, and the cover image.
 *
 * **An optional read never changes the status.** A book whose structure
 * validates is `available` even when its cover is oversize, its magic bytes are
 * wrong, its nav document is malformed, or its NCX entry carries corrupt deflate
 * bytes. Those yield `toc: null` / `cover: null`. `truncated` applies to the
 * *mandatory* reads, which 1.1d owns. Classification is identical at both kinds
 * of site — 1.1a's predicate, unchanged — and only the **disposition** differs:
 * the same `Z_DATA_ERROR` is `truncated` at the package document and
 * `{ status: 'available', cover: null }` at the cover. A readable book with one
 * damaged decorative resource is readable.
 *
 * **No path, no handle, no archive.** Nothing here accepts a filesystem path and
 * nothing here opens, closes, or re-opens anything; `validate.ts` owns the
 * lifecycle and calls these after its structural pipeline succeeds. The two
 * parameter interfaces below are declared *locally* and deliberately narrow —
 * `validate.ts`'s `EpubStructure` and `EpubInspectionBudget` stay module-private
 * to it, and exporting either would resurrect the rejected `EpubContext`
 * (#1990 Decision 2, #1989 Decision 1).
 *
 * **Discovery is by reference, never by filename** (#1990 Decision 6). The nav
 * document is not required to be `nav.xhtml`, the NCX is not required to be
 * `toc.ncx`, and the cover is never guessed from an entry name.
 *
 * **No image library, and no dimension cap** (#1990 Decision 1). Nothing in
 * Narratorr decodes the cover — it is streamed to a browser that has its own
 * bounded decoder — so a pixel-dimension bomb has no decoder here to attack. The
 * byte cap plus magic-byte sniffing closes the case that is actually reachable.
 * Do not add `sharp`, `image-size`, `probe-image-size`, `jimp`, or `canvas`, and
 * do not hand-roll a header parser.
 */

/** A document 1.1b accepted, as this module consumes it. */
type EpubDocument = Extract<EpubXmlResult, { kind: 'document' }>;

/**
 * What the optional reads need from the **already-parsed** package document.
 *
 * Structural, not nominal: `validate.ts` assembles one of these at the call site
 * from its private structure. Nothing here re-reads or re-parses the OPF, and
 * nothing here re-derives a selection the package index already made.
 */
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

/**
 * The archive capability: name lookup plus one budgeted read.
 *
 * `read` is the **optional** form of the caller's budget — charge-as-you-go,
 * pre-rejecting on the declared size, never rolled back. This module never sees
 * the remaining allowance and never needs to: every failure arm, whatever
 * produced it, disposes to `null`.
 */
export interface EpubOptionalReader {
  entry(name: string): ZipArchiveEntry | undefined;
  read(entry: ZipArchiveEntry, ceiling: number): Promise<ZipEntryRead>;
}

// --- the one token predicate -------------------------------------------------

/** XML whitespace (XML 1.0 §2.3) — the separator for every token-set attribute here. */
const XML_WHITESPACE_RE = /[\t\n\f\r ]+/;

/**
 * Whether a whitespace-separated attribute's token set contains `token`.
 *
 * Asked in exactly three places — `properties~=nav`, `properties~=cover-image`,
 * and `epub:type~=toc` — and answered once. Three hand-rolled
 * `.split(' ').includes(…)` sites is the DRY-3 defect, and it is also how
 * `properties="navigation"` accidentally starts matching `nav`: matching is
 * **exact token equality**, never a substring or prefix test. A leading or
 * repeated separator yields empty tokens, which match nothing.
 */
function hasToken(value: string | undefined, token: string): boolean {
  return value !== undefined && value.split(XML_WHITESPACE_RE).includes(token);
}

// --- reading a referenced manifest item --------------------------------------

/**
 * Resolve a manifest item's `href`, find its entry, and read it under `ceiling`.
 *
 * Every way this can fail — no `href`, an `href` that is `remote` or `rejected`,
 * an entry absent from the archive, a pre-rejected or aborted or failed read —
 * lands on the same `null`, because every one of them disposes to a `null`
 * field. A filesystem error is the exception and never reaches here: 1.1a's
 * predicate routes it to `throw` and `readEntry` rethrows it, so I/O
 * indeterminacy is never converted into a confident `null`.
 */
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

/**
 * The same read, then a parse against `expectedRoot`.
 *
 * "Malformed" means exactly `parseEpubXml(...).kind === 'rejected'` and nothing
 * broader: bytes over `MAX_XML_BYTES`, a fatal decode failure, or a root that is
 * not exactly one element of the expected local name (`xml.ts:237-243`). Markup
 * cheerio silently repairs — unclosed tags, mismatched tags, an unterminated
 * attribute — is **not** a failure and yields whatever rows the repaired tree
 * produces. No second well-formedness mechanism is added here; that would put a
 * disagreeing parser inside the module whose security argument is that it does
 * nothing clever.
 */
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

// --- metadata ----------------------------------------------------------------

/**
 * The **first** direct `metadata` child of the package root. Later `metadata`
 * siblings are ignored — the same parent the cover's tier-1 lookup uses, so the
 * two cannot disagree about which one is the package's own.
 */
function metadataParent(document: EpubDocument): EpubXmlElement | undefined {
  return childrenByLocalName(document.$, document.root, 'metadata')[0];
}

/**
 * The first direct child of `parent` with this local name whose trimmed text is
 * non-empty.
 *
 * First-in-document-order, first-**non-empty**: `<dc:title></dc:title>
 * <dc:title>Real</dc:title>` yields `"Real"`, not `null`. A conforming book
 * routinely carries several `dc:creator` elements and `EpubMetadata` holds one
 * string, so multiple creators do not join, concatenate, or produce a list — the
 * first non-empty one is the author.
 */
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

/**
 * `title`, `author`, and `language` from the already-parsed package document.
 *
 * Not an optional read: it consumes no budget, performs no I/O, and has no
 * failure mode of its own — a missing element is `null`, not an error — so it is
 * present on every `available` result. Matching is by **local name** (so
 * `<dcterms:title>` is read) and scoped to direct children of `metadata`, never
 * a document-wide search: an unrelated subtree's `<title>` must not be mistaken
 * for the package's own (`xml.ts:155-160`).
 */
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

// --- the shared table-of-contents traversal ----------------------------------

/**
 * The two TOC dialects differ only in element names and label shape, so they are
 * one traversal parameterised by those, not two near-copies that can drift.
 */
interface TocDialect {
  /** The element whose direct children are rows — `li` for nav, `navPoint` for NCX. */
  readonly row: string;
  /**
   * The element whose direct `row` children are the next level down. EPUB 3 nests
   * through an `<ol>`; NCX nests `navPoint` inside `navPoint` directly, so it
   * returns the row itself.
   */
  container($: CheerioAPI, row: EpubXmlElement): EpubXmlElement | undefined;
  /** The row's title, or `null` when it has no usable label. */
  label($: CheerioAPI, row: EpubXmlElement): string | null;
}

/** Collapse runs of whitespace to a single space and trim; empty becomes `null`. */
function normalizeTitle(raw: string): string | null {
  const title = raw.replace(/\s+/g, ' ').trim();
  return title === '' ? null : title;
}

/**
 * An EPUB 3 row's label: its first direct `a`, or failing that its first direct
 * `span`.
 *
 * Taking the label from a **direct child** of the `li` is what stops a parent row
 * swallowing its children's titles. In EPUB 3 the nested `<ol>` is a *sibling* of
 * the `<a>`, not a descendant of it, so the anchor's full descendant text is this
 * row's title alone. The `li`'s own text is never used.
 */
function navRowLabel($: CheerioAPI, row: EpubXmlElement): string | null {
  const label = childrenByLocalName($, row, 'a')[0] ?? childrenByLocalName($, row, 'span')[0];
  return label ? normalizeTitle($(label).text()) : null;
}

/** An NCX row's label: the first direct `navLabel`'s first direct `text`. */
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

/** One row still to visit, carrying the depth its structure gives it. */
interface PendingRow {
  readonly element: EpubXmlElement;
  readonly depth: number;
}

/**
 * Flatten a TOC tree into rows, depth-first and pre-order in document order.
 *
 * `depth` is the nesting depth of the *container* holding the row, 0 at the
 * starting one. It is computed from document structure, so dropping a row never
 * shifts its children's depth — and a row with no usable label is dropped rather
 * than failing, with its nested container still traversed.
 *
 * **The visit cap bounds work, not just output.** At most `MAX_TOC_ENTRIES`
 * rows are *visited* and the walk then stops immediately, unvisited nodes
 * included. Every emitted row comes from a visited one, so this caps the output
 * too — but a cap counting only emitted rows would let a label-less chain nested
 * 100k deep run to the bottom. Reaching the cap is not an error.
 *
 * Iterative, with an explicit stack. Rows are pushed in reverse document order
 * so `pop()` yields document order, and a row's children go on top of its
 * remaining siblings, which is exactly pre-order.
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

/** Push `rows` so the first in document order is popped first. */
function pushRows(stack: PendingRow[], rows: readonly EpubXmlElement[], depth: number): void {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    stack.push({ element: rows[index]!, depth });
  }
}

// --- TOC discovery -----------------------------------------------------------

/**
 * The first `nav` element in document order, anywhere below the `html` root,
 * whose `epub:type` token set contains `toc`.
 *
 * **The one descendant search in this module.** A navigation document is XHTML:
 * the `nav` sits under `body`, possibly inside intervening flow content, and is
 * never a direct child of `html` — so `childrenByLocalName($, htmlRoot, 'nav')`
 * matches nothing for a conforming book. Everything else, here and in the package
 * document, stays direct-child, because there the whole point is that an
 * unrelated subtree's element must not be mistaken for the one asked for.
 *
 * **Iterative, deliberately.** A `MAX_XML_BYTES` document can nest deeply enough
 * to exhaust the JavaScript stack, and unlike the traversal above this walk has
 * no visit cap to bound its depth — the whole document is in scope until a match
 * is found.
 *
 * `attrByLocalName` for `epub:type`, not `attrByExactName`: the EPUB spec defines
 * it *with* a prefix and an author may bind that prefix under a different name
 * (`xml.ts:203-213`).
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

/**
 * The EPUB 3 path: the chosen nav item's document, its `toc` `nav`, that `nav`'s
 * first direct `ol`, flattened.
 */
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

/**
 * The EPUB 2 path: the first `<spine>`'s `toc` attribute names a manifest item
 * `id`, and that item's NCX supplies the first `navMap` in document order.
 *
 * An id declared by two manifest items resolves to `null` rather than to either
 * one (`validate.ts` maps a duplicated id to `null`), which is the same
 * first-in-document-order discipline as everywhere else, applied to a question
 * that has no first answer.
 */
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
 * The table of contents, or `null`.
 *
 * **EPUB 3 is preferred, and there is no fallback between the two.** If a
 * `properties="nav"` manifest item exists it is the only path attempted; when it
 * turns out to be unusable at any step the result is `null` and the NCX is not
 * tried. "Preferred" is a selection rule, not a retry rule — and a fallback
 * would make the NCX read's pre-reject depend on how many bytes the *failed* nav
 * read had already charged, coupling two independent resources through the
 * shared budget.
 *
 * A traversal that emits zero rows yields `null` rather than `[]`, so `toc` is
 * either `null` or a non-empty array and the panel has one fewer state.
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

// --- the cover ---------------------------------------------------------------

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_SIGNATURE = Buffer.from([0xff, 0xd8, 0xff]);
const GIF87A_SIGNATURE = Buffer.from('GIF87a', 'ascii');
const GIF89A_SIGNATURE = Buffer.from('GIF89a', 'ascii');
const RIFF_SIGNATURE = Buffer.from('RIFF', 'ascii');
const WEBP_SIGNATURE = Buffer.from('WEBP', 'ascii');
/** WebP's second marker sits after `RIFF` and the four-byte chunk size. */
const WEBP_MARKER_OFFSET = 8;

/**
 * Whether `signature` appears at `offset`.
 *
 * `subarray` clamps and `equals` compares length first, so input shorter than
 * the signature it would match falls out here — a truncated four-byte PNG prefix
 * is never a partial match.
 */
function matchesAt(bytes: Buffer, signature: Buffer, offset: number): boolean {
  return bytes.subarray(offset, offset + signature.length).equals(signature);
}

/**
 * The media type the **bytes** say, never the one the manifest claims.
 *
 * Each signature is matched in full — a four-byte prefix is not a signature —
 * and anything else is `null`, SVG explicitly: a manifest declaring `image/png`
 * over SVG bytes yields no cover, and one declaring `image/svg+xml` over PNG
 * bytes yields `image/png`. The four literals are the ones already frozen in
 * `result.ts:47-50`; no fifth is minted here.
 */
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
 * The manifest item the cover comes from, by **OPF metadata** and never by
 * filename guessing.
 *
 * Two exhaustively ordered tiers, with no fallback within or between them:
 *
 * 1. the **first** `<meta name="cover">` in document order among the direct
 *    children of the first `metadata` element, read through its `content`
 *    attribute;
 * 2. used **only when tier 1 declares nothing at all**, the **first** manifest
 *    `<item>` in document order whose `properties` token set contains
 *    `cover-image`.
 *
 * If tier 1 declares a cover, tier 2 is never consulted even when tier 1 turns
 * out to be unusable — a `content` naming no manifest item, or naming an id two
 * items declared, all yield no cover. A declared-but-broken cover is a defective
 * book, not a book with a second cover, and falling back would couple the two
 * tiers through the shared budget once bytes had been charged.
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

/**
 * The cover image, or `null`.
 *
 * Beyond the discovery failures above, `null` is also the answer for a read over
 * `MAX_EPUB_COVER_BYTES` — **a cap breach is never a truncated image** — and for
 * a read that failed or was skipped for budget reasons.
 */
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
