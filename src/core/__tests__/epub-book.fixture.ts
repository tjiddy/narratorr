import path from 'node:path';
import { buildArchive, type ArchiveEntrySpec } from './epub-zip.fixture.js';

/**
 * EPUB *document* fixtures — the XML that goes inside a container: `container.xml`,
 * the OPF package/metadata, and both navigation forms (EPUB 3 `nav` and EPUB 2 NCX).
 *
 * Split out of `epub-archive.fixture.ts` (#2003), which had reached 396 of the
 * repo's 400-line `max-lines` cap with four lines of headroom. That cap counts code
 * only (`skipBlankLines`/`skipComments`), so the file read as 629 lines in an editor
 * while lint saw 396 — the next fixture shape anyone added would have failed lint and
 * blocked `pnpm verify` for an unrelated change.
 *
 * The seam was already marked in that file by a comment banner: ZIP/archive byte
 * plumbing on one side, EPUB document shapes on the other. Two reasons to change,
 * now two files.
 *
 * `epub-archive.fixture.ts` remains the import path for every consumer — it is now a
 * barrel over this file and `epub-zip.fixture.ts`. Import from it, not from here, so
 * a future re-split does not churn call sites again.
 *
 * Depends on `epub-zip.fixture.ts` (for `buildArchive`) and never the reverse — the
 * barrel re-exports both, so a dependency in the other direction would be circular.
 */

/**
 * Every optional field is written `?: T | undefined` rather than bare `?: T`.
 * `exactOptionalPropertyTypes` is on (`tsconfig.json:9`), and forwarding one
 * builder's possibly-undefined option into another — which the composition below
 * does constantly — is rejected under the bare spelling.
 */

export const EPUB_MEDIA_TYPE = 'application/epub+zip';
export const DEFAULT_PACKAGE = 'OEBPS/content.opf';

/** A minimal, valid XHTML content document. */
export const XHTML =
  '<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>c</title></head><body><p>c</p></body></html>';

export interface ManifestItem {
  id: string;
  href: string;
  mediaType: string;
  properties?: string | undefined;
}

export interface SpineItemref {
  idref?: string | undefined;
  linear?: string | undefined;
}

const DEFAULT_ITEMS: ManifestItem[] = [
  { id: 'ch1', href: 'ch1.xhtml', mediaType: 'application/xhtml+xml' },
];
const DEFAULT_ITEMREFS: SpineItemref[] = [{ idref: 'ch1' }];

export function containerXml(fullPath: string | null): string {
  const rootfile =
    fullPath === null
      ? '<rootfile media-type="application/oebps-package+xml"/>'
      : `<rootfile full-path="${fullPath}" media-type="application/oebps-package+xml"/>`;
  return `<?xml version="1.0" encoding="UTF-8"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles>${rootfile}</rootfiles></container>`;
}

export function itemXml(item: ManifestItem): string {
  const properties = item.properties === undefined ? '' : ` properties="${item.properties}"`;
  return `<item id="${item.id}" href="${item.href}" media-type="${item.mediaType}"${properties}/>`;
}

function itemrefXml(itemref: SpineItemref): string {
  const idref = itemref.idref === undefined ? '' : ` idref="${itemref.idref}"`;
  const linear = itemref.linear === undefined ? '' : ` linear="${itemref.linear}"`;
  return `<itemref${idref}${linear}/>`;
}

export interface MetadataOptions {
  /** Raw inner XML, replacing every generated field below. */
  raw?: string | undefined;
  /** `null` omits `<dc:title>`; the default is `Fixture`. */
  title?: string | null | undefined;
  /** Emitted as `<dc:creator>`, one element per entry, in order. */
  creators?: readonly string[] | undefined;
  language?: string | undefined;
  /** One `<meta name="cover">` per entry; `null` omits its `content` attribute. */
  covers?: readonly (string | null)[] | undefined;
}

const DC_NAMESPACE = 'xmlns:dc="http://purl.org/dc/elements/1.1/"';

export function metadataXml(options: MetadataOptions = {}): string {
  if (options.raw !== undefined) return `<metadata ${DC_NAMESPACE}>${options.raw}</metadata>`;
  const parts: string[] = [];
  if (options.title !== null) parts.push(`<dc:title>${options.title ?? 'Fixture'}</dc:title>`);
  for (const creator of options.creators ?? []) parts.push(`<dc:creator>${creator}</dc:creator>`);
  if (options.language !== undefined) parts.push(`<dc:language>${options.language}</dc:language>`);
  for (const content of options.covers ?? []) {
    parts.push(content === null ? '<meta name="cover"/>' : `<meta name="cover" content="${content}"/>`);
  }
  return `<metadata ${DC_NAMESPACE}>${parts.join('')}</metadata>`;
}

export interface PackageOptions {
  items?: ManifestItem[] | undefined;
  itemrefs?: SpineItemref[] | undefined;
  /** Raw `<manifest>` override, for the shapes the typed form cannot express. */
  manifest?: string | undefined;
  /** Raw `<spine>` override. */
  spine?: string | undefined;
  metadata?: MetadataOptions | undefined;
  /** Raw override for the whole `<metadata>` element — for multi-`<metadata>` shapes. */
  metadataSection?: string | undefined;
  /** Raw whole-document override. */
  raw?: string | undefined;
  /** Padding appended after the root element, for the byte-budget fixtures. */
  padTo?: number | undefined;
}

export function packageXml(options: PackageOptions = {}): string {
  if (options.raw !== undefined) return options.raw;
  const manifest =
    options.manifest ?? `<manifest>${(options.items ?? DEFAULT_ITEMS).map(itemXml).join('')}</manifest>`;
  const spine =
    options.spine ?? `<spine>${(options.itemrefs ?? DEFAULT_ITEMREFS).map(itemrefXml).join('')}</spine>`;
  const metadata = options.metadataSection ?? metadataXml(options.metadata);
  const document =
    `<?xml version="1.0" encoding="UTF-8"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">` +
    `${metadata}${manifest}${spine}</package>`;
  return options.padTo === undefined ? document : padTo(document, options.padTo);
}

/** Whitespace-pad an XML document to exactly `bytes`, outside the root element. */
export function padTo(document: string, bytes: number): string {
  return document + ' '.repeat(bytes - Buffer.byteLength(document));
}

export interface EpubOptions {
  packageName?: string | undefined;
  /** `false` omits the entry entirely. */
  mimetype?: string | Buffer | false | undefined;
  /** `false` omits `META-INF/container.xml`. */
  container?: string | false | undefined;
  /** The `full-path` written into a generated container. */
  containerFullPath?: string | null | undefined;
  /** `false` omits the package document entry. */
  package?: string | false | undefined;
  packageOptions?: PackageOptions | undefined;
  encryption?: string | Buffer | undefined;
  /** Extra members, appended after the standard ones. */
  files?: ArchiveEntrySpec[] | undefined;
  /** Move `mimetype` to the end of the archive. */
  mimetypeLast?: boolean | undefined;
  store?: boolean | undefined;
}

export function epubEntries(options: EpubOptions = {}): ArchiveEntrySpec[] {
  const packageName = options.packageName ?? DEFAULT_PACKAGE;
  const entries: ArchiveEntrySpec[] = [];
  if (options.mimetype !== false) {
    entries.push({ name: 'mimetype', content: options.mimetype ?? EPUB_MEDIA_TYPE });
  }
  if (options.container !== false) {
    entries.push({
      name: 'META-INF/container.xml',
      content:
        options.container ??
        containerXml(
          options.containerFullPath === undefined ? packageName : options.containerFullPath,
        ),
    });
  }
  if (options.package !== false) {
    entries.push({ name: packageName, content: options.package ?? packageXml(options.packageOptions) });
  }
  entries.push({ name: path.posix.join(path.posix.dirname(packageName), 'ch1.xhtml'), content: XHTML });
  if (options.encryption !== undefined) {
    entries.push({ name: 'META-INF/encryption.xml', content: options.encryption });
  }
  entries.push(...(options.files ?? []));
  if (options.mimetypeLast) {
    const index = entries.findIndex((entry) => entry.name === 'mimetype');
    if (index >= 0) entries.push(...entries.splice(index, 1));
  }
  return entries;
}

export function buildEpub(options: EpubOptions = {}): Promise<Buffer> {
  return buildArchive({ store: options.store ?? false, entries: epubEntries(options) });
}

// --- navigation document and NCX shapes -------------------------------------

/** One table-of-contents row for {@link navListXml} and {@link navMapXml}. */
export interface TocNode {
  /** Absent emits no label element at all; `''` and whitespace emit an empty one. */
  label?: string | undefined;
  /** Label the row with a `<span>` instead of an `<a>` (navigation documents only). */
  span?: boolean | undefined;
  /** NCX only — written verbatim so document order and `playOrder` can disagree. */
  playOrder?: number | undefined;
  children?: readonly TocNode[] | undefined;
}

/** A nav `<ol>`: one `<li>` per node, nested `<ol>`s as *siblings* of the label. */
export function navListXml(nodes: readonly TocNode[]): string {
  const rows = nodes.map((node) => {
    const tag = node.span === true ? 'span' : 'a';
    const attributes = tag === 'a' ? ' href="c.xhtml"' : '';
    const label = node.label === undefined ? '' : `<${tag}${attributes}>${node.label}</${tag}>`;
    const nested = node.children === undefined ? '' : navListXml(node.children);
    return `<li>${label}${nested}</li>`;
  });
  return `<ol>${rows.join('')}</ol>`;
}

/** A `<nav>` carrying an `epub:type` and an `<ol>` built from `nodes`. */
export function navXml(nodes: readonly TocNode[], epubType = 'toc'): string {
  return `<nav epub:type="${epubType}">${navListXml(nodes)}</nav>`;
}

/** An XHTML navigation document wrapping `body` — the realistic shape, `nav` under `<body>`. */
export function navDocumentXml(body: string): string {
  return (
    `<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">` +
    `<head><title>nav</title></head><body>${body}</body></html>`
  );
}

function navPointXml(node: TocNode, index: number): string {
  const label = node.label === undefined ? '' : `<navLabel><text>${node.label}</text></navLabel>`;
  const playOrder = node.playOrder === undefined ? '' : ` playOrder="${node.playOrder}"`;
  const children = (node.children ?? []).map(navPointXml).join('');
  return `<navPoint id="p${index}"${playOrder}>${label}<content src="c.xhtml"/>${children}</navPoint>`;
}

/** An NCX `<navMap>`: `<navPoint>` rows nesting directly, with no container element. */
export function navMapXml(nodes: readonly TocNode[]): string {
  return `<navMap>${nodes.map(navPointXml).join('')}</navMap>`;
}

/** An NCX document wrapping `inner`. */
export function ncxDocumentXml(inner: string): string {
  return (
    `<?xml version="1.0" encoding="UTF-8"?><ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">` +
    `<head/><docTitle><text>Fixture</text></docTitle>${inner}</ncx>`
  );
}
