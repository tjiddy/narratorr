import path from 'node:path';
import { buildArchive, type ArchiveEntrySpec } from './epub-zip.fixture.js';

/**
 * EPUB XML fixtures for container, package metadata, nav, and NCX documents. Consumers
 * import through epub-archive.fixture; this module may depend on ZIP fixtures, never the reverse.
 */

/**
 * Explicit `| undefined` permits forwarding optional builder values under
 * exactOptionalPropertyTypes.
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

/**
 * Manifest item paired with the emitted ch1.xhtml. Since items replaces the entire
 * manifest, callers adding resources should extend this item.
 */
export const CHAPTER_ITEM: ManifestItem = {
  id: 'ch1',
  href: 'ch1.xhtml',
  mediaType: 'application/xhtml+xml',
};

export const DEFAULT_ITEMS: readonly ManifestItem[] = [CHAPTER_ITEM];
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
  /** Raw inner XML replacing all generated fields. */
  raw?: string | undefined;
  /** null omits dc:title; default is Fixture. */
  title?: string | null | undefined;
  /** One ordered dc:creator element per entry. */
  creators?: readonly string[] | undefined;
  language?: string | undefined;
  /** One cover meta per entry; null omits its content attribute. */
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
  /** Raw manifest override for shapes the typed form cannot express. */
  manifest?: string | undefined;
  /** Raw spine override. */
  spine?: string | undefined;
  metadata?: MetadataOptions | undefined;
  /** Whole metadata-element override, including multiple metadata siblings. */
  metadataSection?: string | undefined;
  /** Whole-document override. */
  raw?: string | undefined;
  /** Padding after the root for byte-budget fixtures. */
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

/** Pads XML to exactly bytes outside its root element. */
export function padTo(document: string, bytes: number): string {
  return document + ' '.repeat(bytes - Buffer.byteLength(document));
}

export interface EpubOptions {
  packageName?: string | undefined;
  /** false omits the entry. */
  mimetype?: string | Buffer | false | undefined;
  /** false omits META-INF/container.xml. */
  container?: string | false | undefined;
  /** full-path for a generated container. */
  containerFullPath?: string | null | undefined;
  /** false omits the package document. */
  package?: string | false | undefined;
  packageOptions?: PackageOptions | undefined;
  encryption?: string | Buffer | undefined;
  /** Members appended after standard entries. */
  files?: ArchiveEntrySpec[] | undefined;
  /** Moves mimetype to the archive end. */
  mimetypeLast?: boolean | undefined;
  store?: boolean | undefined;
}

/**
 * Derives the chapter beside packageName. drmProtectedEpub must share this join;
 * a stale missing DRM target still classifies protected and would hide drift.
 */
function chapterEntryName(packageName: string): string {
  return path.posix.join(path.posix.dirname(packageName), 'ch1.xhtml');
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
  entries.push({ name: chapterEntryName(packageName), content: XHTML });
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

/**
 * Well-formed encryption.xml that encrypts nothing. Padding this fourth mandatory
 * read consumes a chosen budget without changing the verdict.
 */
export const EMPTY_ENCRYPTION_XML =
  '<?xml version="1.0"?><encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container"></encryption>';

/** Decorative realistic algorithm; the classifier ignores it. */
const DRM_ALGORITHM = 'http://www.w3.org/2001/04/xmlenc#aes128-cbc';

/**
 * Adds encryption.xml targeting the built chapter. The CipherReference URI drives
 * classification; derive it from packageName because a stale missing target also
 * (incorrectly) appears protected. This helper overwrites caller encryption but
 * preserves other options. Earlier structural failures still take precedence.
 */
export function drmProtectedEpub(options: EpubOptions = {}): EpubOptions {
  const uri = chapterEntryName(options.packageName ?? DEFAULT_PACKAGE);
  return {
    ...options,
    encryption:
      '<?xml version="1.0" encoding="UTF-8"?>' +
      '<encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container" ' +
      'xmlns:enc="http://www.w3.org/2001/04/xmlenc#">' +
      `<EncryptedData><EncryptionMethod Algorithm="${DRM_ALGORITHM}"/>` +
      `<CipherData><CipherReference URI="${uri}"/></CipherData></EncryptedData>` +
      '</encryption>',
  };
}

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

export function ncxDocumentXml(inner: string): string {
  return (
    `<?xml version="1.0" encoding="UTF-8"?><ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">` +
    `<head/><docTitle><text>Fixture</text></docTitle>${inner}</ncx>`
  );
}
