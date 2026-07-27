import archiver from 'archiver';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';

/**
 * Binary archive fixtures for the companion-EPUB read path (#1988, design §4).
 *
 * **Synthesised, never copied.** The plan suggested using the real library EPUB
 * as a fixture; that file is a commercial, copyrighted book and does not belong
 * in the repo. This builder reproduces its *shape* with `archiver@7`, already a
 * production dependency (`package.json`, `backup.service.ts:5`), so no new
 * dependency is needed and nothing binary is committed.
 *
 * **Lives outside `src/core/epub/` deliberately.** `layer-guard.test.ts` treats
 * every non-`.test.ts` file in that folder as a production module and would scan
 * this one.
 *
 * **Two modes for entry names.** `archiver-utils@5.0.2`'s `sanitizePath`
 * (`index.js:92`) rewrites leading traversal, absolute, drive-letter, and
 * backslash names on the way in — `../../etc/passwd` is written as
 * `etc/passwd`, `/abs/x.txt` as `abs/x.txt`, `C:/x.txt` as `x.txt`, and
 * `dir\win.txt` as `dir/win.txt` — while **mid-path** traversal such as
 * `a/../../b.txt` survives verbatim. So names archiver preserves are appended
 * directly, and the rest are built then patched with {@link patchEntryName},
 * which rewrites the filename bytes in **both** the local file header and the
 * central directory. Every hostile-name fixture asserts its precondition on the
 * raw central-directory bytes before invoking anything.
 *
 * **The EPUB-document builders at the bottom** (#1990) started life inside
 * `validate.test.ts` and were lifted here when `extract.test.ts` needed the same
 * shapes. The `vi.mock`-based `fs`/`unzipper` spy harness deliberately did
 * **not** come with them: `vi.mock` calls are hoisted per test file, so a
 * factory living here would be registered after the module under test had
 * already resolved its imports.
 */

/** One member to write into the archive. */
export interface ArchiveEntrySpec {
  /** The name handed to `archiver` — see the sanitisation note above. */
  name: string;
  content: string | Buffer;
}

export interface BuildArchiveOptions {
  entries: readonly ArchiveEntrySpec[];
  /**
   * The ZIP archive comment. `archiver` writes it verbatim after the EOCD, so an
   * ASCII string of length N produces a `commentLength` of N.
   */
  comment?: string;
  /**
   * Emit ZIP64 structures. `forceZip64` is the only ZIP64 knob that exists:
   * `@types/archiver@7`'s `ZipOptions` declares it and no `zip64`, and the
   * pinned writer reads only `forceZip64`
   * (`compress-commons@6.0.2/lib/archivers/zip/zip-archive-output-stream.js:117`).
   */
  forceZip64?: boolean;
  /** STORE instead of DEFLATE, so fixture sizes are exactly predictable. */
  store?: boolean;
}

/** The four-byte end-of-central-directory signature. */
export const EOCD_SIGNATURE = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
/** The ZIP64 end-of-central-directory *locator* signature. */
export const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;
/** The ZIP64 end-of-central-directory *record* signature. */
export const ZIP64_RECORD_SIGNATURE = 0x06064b50;

const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const LOCAL_HEADER_SIGNATURE = 0x04034b50;

/** Build an archive in memory. */
export async function buildArchive(options: BuildArchiveOptions): Promise<Buffer> {
  const archive = archiver('zip', {
    comment: options.comment ?? '',
    forceZip64: options.forceZip64 ?? false,
    store: options.store ?? false,
  });
  const chunks: Buffer[] = [];
  const sink = new PassThrough();
  sink.on('data', (chunk: Buffer) => chunks.push(chunk));
  const drained = new Promise<void>((resolve, reject) => {
    sink.on('end', resolve);
    sink.on('error', reject);
    archive.on('error', reject);
  });
  archive.pipe(sink);
  for (const entry of options.entries) {
    archive.append(Buffer.isBuffer(entry.content) ? entry.content : Buffer.from(entry.content), {
      name: entry.name,
    });
  }
  await archive.finalize();
  await drained;
  return Buffer.concat(chunks);
}

/** A per-suite temp directory. Callers `rm` it in `afterAll`. */
export async function createArchiveDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'narratorr-epub-'));
}

/** Write `bytes` into `dir` and return the absolute path. */
export async function writeArchive(dir: string, name: string, bytes: Buffer): Promise<string> {
  const filePath = path.join(dir, name);
  await writeFile(filePath, bytes);
  return filePath;
}

/** Build an archive and write it out in one step. */
export async function writeBuiltArchive(
  dir: string,
  name: string,
  options: BuildArchiveOptions,
): Promise<string> {
  return writeArchive(dir, name, await buildArchive(options));
}

/**
 * The offset of the EOCD record, located the same way the adapter locates it —
 * a backward scan accepting the first candidate whose `commentLength` accounts
 * for exactly the bytes that follow it.
 */
export function eocdOffset(archive: Buffer): number {
  let index = archive.lastIndexOf(EOCD_SIGNATURE);
  while (index >= 0) {
    if (
      archive.length - index >= 22 &&
      index + 22 + archive.readUInt16LE(index + 20) === archive.length
    ) {
      return index;
    }
    if (index === 0) break;
    index = archive.lastIndexOf(EOCD_SIGNATURE, index - 1);
  }
  throw new Error('fixture has no end-of-central-directory record');
}

/** The ZIP64 locator sits in the 20 bytes immediately before the EOCD. */
export function zip64LocatorOffset(archive: Buffer): number {
  return eocdOffset(archive) - 20;
}

/** The ZIP64 record offset, read out of the locator's 8-byte field at +8. */
export function zip64RecordOffset(archive: Buffer): number {
  return Number(archive.readBigUInt64LE(zip64LocatorOffset(archive) + 8));
}

/** One rewritten integer field. */
export interface ArchivePatch {
  /** Absolute byte offset in the archive. */
  offset: number;
  /** Field width. 8-byte fields take a `bigint` value. */
  size: 2 | 4 | 8;
  value: number | bigint;
  /** Which field is rewritten and why — every patch site documents itself. */
  why: string;
}

/**
 * The single byte-patching helper. Returns a **copy**, so a shared base archive
 * is never mutated out from under another fixture.
 */
export function patchArchive(archive: Buffer, patches: readonly ArchivePatch[]): Buffer {
  const patched = Buffer.from(archive);
  for (const patch of patches) {
    if (patch.size === 8) patched.writeBigUInt64LE(BigInt(patch.value), patch.offset);
    else if (patch.size === 4) patched.writeUInt32LE(Number(patch.value), patch.offset);
    else patched.writeUInt16LE(Number(patch.value), patch.offset);
  }
  return patched;
}

/** A central-directory member, located by walking the directory from its start. */
export interface CentralDirectoryEntry {
  /** Offset of the 46-byte fixed header. */
  headerOffset: number;
  /** Offset of the raw filename bytes. */
  nameOffset: number;
  nameLength: number;
  /** Offset of the matching local file header. */
  localHeaderOffset: number;
  /** The raw filename bytes, as written. */
  rawName: Buffer;
}

/**
 * Walk the central directory. Reads its start offset from the ZIP64 record when
 * the ZIP32 field carries the `0xffffffff` sentinel, so `forceZip64` fixtures
 * work too.
 */
export function listCentralDirectory(archive: Buffer): CentralDirectoryEntry[] {
  const eocd = eocdOffset(archive);
  const legacyOffset = archive.readUInt32LE(eocd + 16);
  let cursor =
    legacyOffset === 0xffffffff
      ? Number(archive.readBigUInt64LE(zip64RecordOffset(archive) + 48))
      : legacyOffset;

  const entries: CentralDirectoryEntry[] = [];
  while (cursor + 46 <= archive.length && archive.readUInt32LE(cursor) === CENTRAL_DIRECTORY_SIGNATURE) {
    const nameLength = archive.readUInt16LE(cursor + 28);
    const extraLength = archive.readUInt16LE(cursor + 30);
    const commentLength = archive.readUInt16LE(cursor + 32);
    entries.push({
      headerOffset: cursor,
      nameOffset: cursor + 46,
      nameLength,
      localHeaderOffset: archive.readUInt32LE(cursor + 42),
      rawName: Buffer.from(archive.subarray(cursor + 46, cursor + 46 + nameLength)),
    });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** The local file header of member `index`, and where its stored payload begins. */
export interface LocalFileHeader {
  headerOffset: number;
  nameOffset: number;
  /** First byte of the member's (possibly compressed) payload. */
  dataOffset: number;
}

export function localFileHeader(archive: Buffer, index: number): LocalFileHeader {
  const entry = listCentralDirectory(archive)[index];
  if (!entry) throw new Error(`fixture has no central-directory entry at index ${index}`);
  const headerOffset = entry.localHeaderOffset;
  if (archive.readUInt32LE(headerOffset) !== LOCAL_HEADER_SIGNATURE) {
    throw new Error(`fixture entry ${index} has no local file header at ${headerOffset}`);
  }
  const nameLength = archive.readUInt16LE(headerOffset + 26);
  const extraLength = archive.readUInt16LE(headerOffset + 28);
  return {
    headerOffset,
    nameOffset: headerOffset + 30,
    dataOffset: headerOffset + 30 + nameLength + extraLength,
  };
}

/**
 * Rewrite one member's filename bytes in **both** the local file header and the
 * central directory. Same length only — anything else would move every offset
 * downstream and require rebuilding the whole archive.
 */
export function patchEntryName(archive: Buffer, index: number, rawName: Buffer): Buffer {
  const entry = listCentralDirectory(archive)[index];
  if (!entry) throw new Error(`fixture has no central-directory entry at index ${index}`);
  if (entry.nameLength !== rawName.length) {
    throw new Error(
      `patchEntryName is same-length only: entry is ${entry.nameLength} bytes, replacement is ${rawName.length}`,
    );
  }
  const patched = Buffer.from(archive);
  const local = entry.localHeaderOffset;
  if (patched.readUInt32LE(local) !== LOCAL_HEADER_SIGNATURE) {
    throw new Error(`fixture entry ${index} has no local file header at ${local}`);
  }
  // Both copies of the name are rewritten: the central directory is what the
  // reader hands us as `pathBuffer`, and the local file header is what it
  // re-reads when the entry is streamed. Leaving them disagreeing would make the
  // fixture test a shape no real archive has.
  rawName.copy(patched, entry.nameOffset);
  rawName.copy(patched, local + 30);
  return patched;
}

/** The ZIP64 tail {@link forgeZip64Tail} appends, in the layout the reader walks. */
export interface Zip64ForgeryOptions {
  /** The count written into both authoritative 8-byte fields of the record. */
  declaredRecords: bigint;
  /** Overrides the locator's record offset, for out-of-range/unsafe-integer rows. */
  locatorRecordOffset?: bigint;
  /** Overrides the record's central-directory offset (+48). */
  recordCentralDirectoryOffset?: bigint;
  /** Overrides the locator's `numberOfDisks` (+16), normally 1. */
  locatorNumberOfDisks?: number;
  /** Overrides the locator's `diskNumber` (+4), normally 0. */
  locatorDiskNumber?: number;
  /** Overrides the record's `diskNumber` (+16), normally 0. */
  recordDiskNumber?: number;
  /** Overrides the record's `diskStart` (+20), normally 0. */
  recordDiskStart?: number;
  /** Overrides the record's `numberOfRecordsOnDisk` (+24), normally `declaredRecords`. */
  recordRecordsOnDisk?: bigint;
  /** Corrupts the locator signature (+0). */
  locatorSignature?: number;
  /** Corrupts the record signature (+0). */
  recordSignature?: number;
}

/**
 * Turn a conformant ZIP32 archive into a forged ZIP64 one: keep everything up to
 * the EOCD, splice in a 56-byte ZIP64 record and a 20-byte locator, then re-emit
 * the EOCD with its sentinels set.
 *
 * This is how the motivating 213-byte fixture is built — a tiny, entirely valid
 * ZIP32 file that declares half a billion members. The rewritten offsets are the
 * EOCD's `numberOfRecords` (+10) and `offsetToStartOfCentralDirectory` (+16),
 * both set to their sentinels so the reader takes its ZIP64 branch.
 */
export function forgeZip64Tail(base: Buffer, options: Zip64ForgeryOptions): Buffer {
  const eocd = eocdOffset(base);
  const head = base.subarray(0, eocd);
  const centralDirectoryOffset = base.readUInt32LE(eocd + 16);

  const record = Buffer.alloc(56);
  record.writeUInt32LE(options.recordSignature ?? ZIP64_RECORD_SIGNATURE, 0);
  record.writeBigUInt64LE(44n, 4); // size of the record after this field
  record.writeUInt16LE(45, 12); // version made by
  record.writeUInt16LE(45, 14); // version needed to extract
  record.writeUInt32LE(options.recordDiskNumber ?? 0, 16);
  record.writeUInt32LE(options.recordDiskStart ?? 0, 20);
  record.writeBigUInt64LE(options.recordRecordsOnDisk ?? options.declaredRecords, 24);
  record.writeBigUInt64LE(options.declaredRecords, 32);
  record.writeBigUInt64LE(BigInt(base.readUInt32LE(eocd + 12)), 40); // size of the central directory
  record.writeBigUInt64LE(
    options.recordCentralDirectoryOffset ?? BigInt(centralDirectoryOffset),
    48,
  );

  const locator = Buffer.alloc(20);
  locator.writeUInt32LE(options.locatorSignature ?? ZIP64_LOCATOR_SIGNATURE, 0);
  locator.writeUInt32LE(options.locatorDiskNumber ?? 0, 4);
  locator.writeBigUInt64LE(options.locatorRecordOffset ?? BigInt(head.length), 8);
  locator.writeUInt32LE(options.locatorNumberOfDisks ?? 1, 16);

  const tail = Buffer.from(base.subarray(eocd));
  tail.writeUInt16LE(0xffff, 10); // numberOfRecords sentinel — takes the reader's ZIP64 branch
  tail.writeUInt32LE(0xffffffff, 16); // offsetToStartOfCentralDirectory sentinel

  return Buffer.concat([head, record, locator, tail]);
}

// --- EPUB document shapes ---------------------------------------------------

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
