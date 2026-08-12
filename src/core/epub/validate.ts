import { lstat } from 'node:fs/promises';
import path from 'node:path';
import type { EpubOptionalReader, EpubPackageView } from './extract.js';
import { extractEpubCover, extractEpubMetadata, extractEpubToc } from './extract.js';
import { MAX_ARCHIVE_BYTES, MAX_INSPECTION_BYTES, MAX_XML_BYTES } from './limits.js';
import { resolveHref } from './paths.js';
import type { EpubInspection, EpubValidation, EpubValidationCode } from './result.js';
import type { EpubXmlElement, EpubXmlResult } from './xml.js';
import { attrByExactName, childrenByLocalName, parseEpubXml } from './xml.js';
import type {
  ZipArchiveEntry,
  ZipEntryRead,
  ZipPositionalSource,
  ZipReadFailure,
  ZipSourceSession,
} from './zip-source.js';
import { withZipSource } from './zip-source.js';

const MIMETYPE_ENTRY = 'mimetype';
const EPUB_MEDIA_TYPE = 'application/epub+zip';
const CONTAINER_ENTRY = 'META-INF/container.xml';
const ENCRYPTION_ENTRY = 'META-INF/encryption.xml';

// Container full-paths and CipherReference URIs are root-relative; manifest hrefs are not.
const CONTAINER_ROOT = '';

/** ZIP general-purpose bit 0: the member is encrypted. */
const ZIP_ENCRYPTED_BIT = 0x1;

const SIGNATURE_BYTES = 4;
const LOCAL_FILE_SIGNATURE = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const EMPTY_ARCHIVE_SIGNATURE = Buffer.from([0x50, 0x4b, 0x05, 0x06]);

/** Classify fonts by manifest media type, never by filename extension. */
const FONT_MEDIA_TYPES = new Set([
  'font/ttf',
  'font/otf',
  'font/woff',
  'font/woff2',
  'font/sfnt',
  'font/collection',
  // Legacy publisher spellings; The Shining used x-font-truetype (UAT 2026-07-29).
  'application/font-sfnt',
  'application/vnd.ms-opentype',
  'application/font-woff',
  'application/x-font-ttf',
  'application/x-font-truetype',
  'application/x-truetype-font',
  'application/x-font-otf',
  'application/x-font-opentype',
]);

// Structural stages cannot return available; only encryption classification can.
type EpubRejection = Exclude<EpubValidation, { status: 'available' }>;

const AVAILABLE: EpubValidation = { status: 'available' };
const DRM_PROTECTED: EpubRejection = { status: 'drm_protected' };

function invalid(code: EpubValidationCode): EpubRejection {
  return { status: 'invalid', code };
}

function fromReadFailure(label: ZipReadFailure): EpubRejection {
  return invalid(label === 'cap-exceeded' ? 'limit_exceeded' : 'truncated');
}

/** One cumulative inflated-byte budget per validation or inspection call. */
interface EpubInspectionBudget {
  readonly consumed: number;
  /** Mandatory failures end the call, so failed reads are not charged. */
  read(entry: ZipArchiveEntry, ceiling: number): Promise<ZipEntryRead>;
  /**
   * Declared size only pre-rejects a doomed stream; streamed bytes enforce the cap.
   * Failed optional reads stay charged so retries cannot bypass the cumulative limit.
   */
  readOptional(entry: ZipArchiveEntry, ceiling: number): Promise<ZipEntryRead>;
}

const PRE_REJECTED: ZipEntryRead = { kind: 'failed', label: 'cap-exceeded', inflatedBytes: 0 };

function createInspectionBudget(): EpubInspectionBudget {
  let consumed = 0;
  return {
    get consumed(): number {
      return consumed;
    },
    async read(entry: ZipArchiveEntry, ceiling: number): Promise<ZipEntryRead> {
      const read = await entry.read(Math.min(MAX_INSPECTION_BYTES - consumed, ceiling));
      if (read.kind === 'bytes') consumed += read.bytes.length;
      return read;
    },
    async readOptional(entry: ZipArchiveEntry, ceiling: number): Promise<ZipEntryRead> {
      const remaining = MAX_INSPECTION_BYTES - consumed;
      if (remaining <= 0 || entry.uncompressedSize > remaining) return PRE_REJECTED;
      const read = await entry.read(Math.min(remaining, ceiling));
      consumed += read.kind === 'bytes' ? read.bytes.length : read.inflatedBytes;
      return read;
    },
  };
}

type EpubXmlDocument = Extract<EpubXmlResult, { kind: 'document' }>;

interface EpubPackageIndex {
  readonly itemCount: number;
  /** Manifest order is significant for first-match nav and cover discovery. */
  readonly items: readonly EpubXmlElement[];
  /** First spine element; EPUB 2 TOC discovery reads its `toc` attribute. */
  readonly spine: EpubXmlElement | undefined;
  /** Duplicate IDs map to `null` instead of silently selecting one item. */
  readonly itemsById: ReadonlyMap<string, EpubXmlElement | null>;
  readonly itemsByName: ReadonlyMap<string, EpubXmlElement[]>;
  /** Every `<itemref>`'s `idref`, linear or not. */
  readonly spineIdrefs: ReadonlySet<string>;
  readonly itemrefs: readonly EpubXmlElement[];
}

interface EpubStructure {
  readonly source: ZipPositionalSource;
  readonly entries: readonly ZipArchiveEntry[];
  readonly entriesByName: ReadonlyMap<string, ZipArchiveEntry>;
  readonly packageDocument: EpubXmlDocument;
  readonly packageBaseDir: string;
  readonly packageIndex: EpubPackageIndex;
  readonly budget: EpubInspectionBudget;
}

type EpubPipelineOutcome =
  | { kind: 'structure'; structure: EpubStructure }
  | { kind: 'verdict'; validation: EpubRejection };

function verdict(validation: EpubRejection): { kind: 'verdict'; validation: EpubRejection } {
  return { kind: 'verdict', validation };
}

/** Use `lstat` to reject symlinks; filesystem errors propagate unchanged. */
async function preOpenRejection(filePath: string): Promise<EpubRejection | null> {
  const stats = await lstat(filePath);
  if (!stats.isFile()) return invalid('not_a_zip');
  if (stats.size > MAX_ARCHIVE_BYTES) return invalid('limit_exceeded');
  return null;
}

/** Safe before preflight: `preflightAndOpen` resets the positional replay queue. */
async function readSignature(source: ZipPositionalSource): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of source.stream(0, SIGNATURE_BYTES)) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

function hasZipSignature(bytes: Buffer): boolean {
  return bytes.equals(LOCAL_FILE_SIGNATURE) || bytes.equals(EMPTY_ARCHIVE_SIGNATURE);
}

type ArchiveStage =
  | { kind: 'entries'; entries: ZipArchiveEntry[] }
  | { kind: 'verdict'; validation: EpubRejection };

/**
 * The open handle's `fstat` is authoritative; `lstat` is only an early rejection.
 * `preflightAndOpen` owns entry-count and central-directory limits.
 */
async function openArchive(session: ZipSourceSession): Promise<ArchiveStage> {
  if (!session.stat.isFile()) return verdict(invalid('not_a_zip'));
  if (session.stat.size > MAX_ARCHIVE_BYTES) return verdict(invalid('limit_exceeded'));
  if (!hasZipSignature(await readSignature(session.source))) return verdict(invalid('not_a_zip'));

  const archive = await session.preflightAndOpen();
  if (archive.kind === 'rejected') return verdict(invalid(archive.code));
  if (archive.kind === 'failed') return verdict(fromReadFailure(archive.label));

  // Check central-directory flags first so password protection outranks malformed content.
  const encrypted = archive.entries.some((entry) => (entry.flags & ZIP_ENCRYPTED_BIT) !== 0);
  if (encrypted) return verdict(DRM_PROTECTED);
  return { kind: 'entries', entries: archive.entries };
}

type MandatoryRead =
  | { kind: 'bytes'; bytes: Buffer }
  | { kind: 'verdict'; validation: EpubRejection };

async function readMandatory(
  entry: ZipArchiveEntry | undefined,
  absent: EpubValidationCode,
  budget: EpubInspectionBudget,
): Promise<MandatoryRead> {
  if (!entry) return verdict(invalid(absent));
  const read = await budget.read(entry, MAX_XML_BYTES);
  if (read.kind === 'failed') return verdict(fromReadFailure(read.label));
  return { kind: 'bytes', bytes: read.bytes };
}

/** Only the container's first rootfile is authoritative; later entries do not rescue it. */
function resolvePackageName(document: EpubXmlDocument): string | null {
  const rootfiles = childrenByLocalName(document.$, document.root, 'rootfiles')[0];
  if (!rootfiles) return null;
  const rootfile = childrenByLocalName(document.$, rootfiles, 'rootfile')[0];
  if (!rootfile) return null;
  const fullPath = attrByExactName(rootfile, 'full-path');
  if (fullPath === undefined) return null;
  const resolved = resolveHref(CONTAINER_ROOT, fullPath);
  return resolved.kind === 'entry' ? resolved.name : null;
}

/** Normalize root-level `dirname` from "." to the archive root "". */
function packageBaseDir(packageName: string): string {
  const directory = path.posix.dirname(packageName);
  return directory === '.' ? '' : directory;
}

function indexPackage(document: EpubXmlDocument, baseDir: string): EpubPackageIndex {
  const { $, root } = document;
  const manifest = childrenByLocalName($, root, 'manifest')[0];
  const items = manifest ? childrenByLocalName($, manifest, 'item') : [];
  const spine = childrenByLocalName($, root, 'spine')[0];
  const itemrefs = spine ? childrenByLocalName($, spine, 'itemref') : [];

  const itemsById = new Map<string, EpubXmlElement | null>();
  const itemsByName = new Map<string, EpubXmlElement[]>();
  for (const item of items) {
    const id = attrByExactName(item, 'id');
    if (id !== undefined) itemsById.set(id, itemsById.has(id) ? null : item);
    const href = attrByExactName(item, 'href');
    if (href === undefined) continue;
    const resolved = resolveHref(baseDir, href);
    if (resolved.kind !== 'entry') continue;
    const aliases = itemsByName.get(resolved.name);
    if (aliases) aliases.push(item);
    else itemsByName.set(resolved.name, [item]);
  }

  const spineIdrefs = new Set<string>();
  for (const itemref of itemrefs) {
    const idref = attrByExactName(itemref, 'idref');
    if (idref !== undefined) spineIdrefs.add(idref);
  }

  return { itemCount: items.length, items, spine, itemsById, itemsByName, spineIdrefs, itemrefs };
}

/** A mixed spine passes if any linear itemref resolves; malformed siblings are tolerated. */
function hasReadableSpine(structure: {
  packageIndex: EpubPackageIndex;
  packageBaseDir: string;
  entriesByName: ReadonlyMap<string, ZipArchiveEntry>;
}): boolean {
  const { packageIndex, packageBaseDir: baseDir, entriesByName } = structure;
  for (const itemref of packageIndex.itemrefs) {
    if (attrByExactName(itemref, 'linear') === 'no') continue;
    const idref = attrByExactName(itemref, 'idref');
    if (idref === undefined) continue;
    const item = packageIndex.itemsById.get(idref);
    if (!item) continue;
    const href = attrByExactName(item, 'href');
    if (href === undefined) continue;
    const resolved = resolveHref(baseDir, href);
    if (resolved.kind !== 'entry') continue;
    if (entriesByName.has(resolved.name)) return true;
  }
  return false;
}

async function buildStructure(session: ZipSourceSession): Promise<EpubPipelineOutcome> {
  const archive = await openArchive(session);
  if (archive.kind === 'verdict') return archive;

  const entries = archive.entries;
  const entriesByName = new Map(entries.map((entry) => [entry.name, entry]));
  const budget = createInspectionBudget();

  const mimetype = await readMandatory(entriesByName.get(MIMETYPE_ENTRY), 'bad_mimetype', budget);
  if (mimetype.kind === 'verdict') return mimetype;
  // Deliberately check content only; epubcheck's position/compression rule rejects readable books.
  if (mimetype.bytes.toString('utf8').trim() !== EPUB_MEDIA_TYPE) {
    return verdict(invalid('bad_mimetype'));
  }

  const container = await readMandatory(entriesByName.get(CONTAINER_ENTRY), 'missing_container', budget);
  if (container.kind === 'verdict') return container;
  const containerDocument = parseEpubXml(container.bytes, 'container');
  if (containerDocument.kind === 'rejected') return verdict(invalid(containerDocument.code));

  const packageName = resolvePackageName(containerDocument);
  if (packageName === null) return verdict(invalid('unresolvable_package'));
  const packageEntry = entriesByName.get(packageName);
  if (!packageEntry) return verdict(invalid('unresolvable_package'));

  const read = await readMandatory(packageEntry, 'unresolvable_package', budget);
  if (read.kind === 'verdict') return read;
  const packageDocument = parseEpubXml(read.bytes, 'package');
  if (packageDocument.kind === 'rejected') return verdict(invalid(packageDocument.code));

  const baseDir = packageBaseDir(packageName);
  const packageIndex = indexPackage(packageDocument, baseDir);
  if (packageIndex.itemCount === 0) return verdict(invalid('empty_manifest'));

  const structure: EpubStructure = {
    source: session.source,
    entries,
    entriesByName,
    packageDocument,
    packageBaseDir: baseDir,
    packageIndex,
    budget,
  };
  if (!hasReadableSpine(structure)) return verdict(invalid('empty_spine'));
  return { kind: 'structure', structure };
}

type EncryptionFinding = 'malformed' | 'unsafe' | 'drm';

/** Media types are case-insensitive, but parameterized values are not accepted as fonts. */
function isFontMediaType(value: string | undefined): boolean {
  return value !== undefined && FONT_MEDIA_TYPES.has(value.trim().toLowerCase());
}

/**
 * Every manifest alias must be an unspined font; existential matching makes
 * conflicting aliases order-dependent. `linear="no"` still counts as spined here.
 */
function isObfuscatedFont(name: string, structure: EpubStructure): boolean {
  if (!structure.entriesByName.has(name)) return false;
  const aliases = structure.packageIndex.itemsByName.get(name);
  if (!aliases || aliases.length === 0) return false;
  return aliases.every((item) => {
    if (!isFontMediaType(attrByExactName(item, 'media-type'))) return false;
    const id = attrByExactName(item, 'id');
    return id === undefined || !structure.packageIndex.spineIdrefs.has(id);
  });
}

function collectEncryptionFindings(
  document: EpubXmlDocument,
  structure: EpubStructure,
): Set<EncryptionFinding> {
  const { $, root } = document;
  const findings = new Set<EncryptionFinding>();
  for (const encryptedData of childrenByLocalName($, root, 'EncryptedData')) {
    // The helper searches direct children, so traverse EncryptedData -> CipherData -> CipherReference.
    const references = childrenByLocalName($, encryptedData, 'CipherData').flatMap((cipherData) =>
      childrenByLocalName($, cipherData, 'CipherReference'),
    );
    if (references.length === 0) {
      findings.add('malformed');
      continue;
    }
    for (const reference of references) {
      // EPUB defines URI unprefixed; a namespace prefix changes the attribute's identity.
      const uri = attrByExactName(reference, 'URI');
      if (uri === undefined || uri === '') {
        findings.add('malformed');
        continue;
      }
      const resolved = resolveHref(CONTAINER_ROOT, uri);
      if (resolved.kind !== 'entry') findings.add('unsafe');
      else if (!isObfuscatedFont(resolved.name, structure)) findings.add('drm');
    }
  }
  return findings;
}

/**
 * Presence alone is harmless. Inspect every reference, then apply
 * malformed > unsafe path > DRM precedence.
 */
async function classifyEncryption(structure: EpubStructure): Promise<EpubValidation> {
  const entry = structure.entriesByName.get(ENCRYPTION_ENTRY);
  if (!entry) return AVAILABLE;

  const read = await structure.budget.read(entry, MAX_XML_BYTES);
  if (read.kind === 'failed') return fromReadFailure(read.label);
  const document = parseEpubXml(read.bytes, 'encryption');
  if (document.kind === 'rejected') return invalid(document.code);

  const findings = collectEncryptionFindings(document, structure);
  if (findings.has('malformed')) return invalid('malformed_xml');
  if (findings.has('unsafe')) return invalid('unsafe_entry_path');
  if (findings.has('drm')) return DRM_PROTECTED;
  return AVAILABLE;
}

/** Keeps `EpubStructure` inside the open-handle callback so its source cannot escape. */
async function runEpubPipeline<T>(
  filePath: string,
  onOutcome: (outcome: EpubPipelineOutcome) => Promise<T>,
): Promise<T> {
  const preOpen = await preOpenRejection(filePath);
  if (preOpen) return onOutcome(verdict(preOpen));
  return withZipSource(filePath, async (session) => onOutcome(await buildStructure(session)));
}

export async function validateEpub(filePath: string): Promise<EpubValidation> {
  return runEpubPipeline(filePath, async (outcome) =>
    outcome.kind === 'verdict' ? outcome.validation : classifyEncryption(outcome.structure),
  );
}

function packageView(structure: EpubStructure): EpubPackageView {
  return {
    document: structure.packageDocument,
    baseDir: structure.packageBaseDir,
    items: structure.packageIndex.items,
    itemsById: structure.packageIndex.itemsById,
    spine: structure.packageIndex.spine,
  };
}

function optionalReader(structure: EpubStructure): EpubOptionalReader {
  return {
    entry: (name) => structure.entriesByName.get(name),
    read: (entry, ceiling) => structure.budget.readOptional(entry, ceiling),
  };
}

/** TOC precedes cover because their shared remaining budget makes exhaustion order-sensitive. */
async function inspectStructure(structure: EpubStructure): Promise<EpubInspection> {
  const validation = await classifyEncryption(structure);
  if (validation.status !== 'available') return validation;

  const view = packageView(structure);
  const reader = optionalReader(structure);
  const toc = await extractEpubToc(view, reader);
  const cover = await extractEpubCover(view, reader);
  return { status: 'available', metadata: extractEpubMetadata(view), toc, cover };
}

/**
 * Validate once, then read metadata, TOC, and cover. Optional read failures yield
 * null fields; filesystem errors still propagate.
 */
export async function inspectEpub(filePath: string): Promise<EpubInspection> {
  return runEpubPipeline(filePath, async (outcome) =>
    outcome.kind === 'verdict' ? outcome.validation : inspectStructure(outcome.structure),
  );
}
