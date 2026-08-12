import { ZipArchive } from 'archiver';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';

/**
 * Synthesizes binary EPUB fixtures with archiver instead of committing a copyrighted
 * book. It lives outside src/core/epub because that folder's layer guard treats
 * non-test files as production.
 *
 * Archiver sanitizes leading traversal, absolute, drive-letter, and backslash names,
 * but preserves mid-path traversal. Hostile sanitized names are therefore patched in
 * both headers; contract tests pin the raw writer behavior this fixture relies on.
 */

export interface ArchiveEntrySpec {
  /** Name before archiver sanitization. */
  name: string;
  content: string | Buffer;
}

export interface BuildArchiveOptions {
  entries: readonly ArchiveEntrySpec[];
  /**
   * Archiver writes this verbatim after EOCD, so ASCII length equals commentLength.
   */
  comment?: string;
  /**
   * Emits ZIP64 structures; forceZip64 is the pinned writer's only supported knob.
   */
  forceZip64?: boolean;
  /** STORE instead of DEFLATE, so fixture sizes are exactly predictable. */
  store?: boolean;
}

export const EOCD_SIGNATURE = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
export const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;
export const ZIP64_RECORD_SIGNATURE = 0x06064b50;

const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const LOCAL_HEADER_SIGNATURE = 0x04034b50;

export async function buildArchive(options: BuildArchiveOptions): Promise<Buffer> {
  const archive = new ZipArchive({
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

export interface CentralDirectorySpanOptions {
  /** The exact `eocdOffset - centralDirectoryOffset` the built archive must have. */
  span: number;
  /** Members written first, verbatim. Their central-directory records count toward the span. */
  entries?: readonly ArchiveEntrySpec[];
  /** How many long-named filler members carry the remaining span. */
  filler?: number;
}

/**
 * Builds an exact central-directory span from 46 + nameLength records and verifies
 * the result. Few long names isolate the span ceiling from the entry ceiling;
 * same-length patching cannot create them. Names are duplicated in local headers,
 * so an 8 MiB span necessarily produces roughly 17 MB of archive data.
 */
export async function buildArchiveWithCentralDirectorySpan(
  options: CentralDirectorySpanOptions,
): Promise<Buffer> {
  const { span, entries: base = [], filler = 150 } = options;
  const fixed = base.reduce((total, entry) => total + 46 + Buffer.byteLength(entry.name), 0);
  const nameBytes = span - fixed - filler * 46;
  const each = Math.floor(nameBytes / filler);
  const last = nameBytes - each * (filler - 1);
  if (each < 7 || last > 65535) throw new Error(`${nameBytes} name bytes do not fit ${filler} entries`);
  const fillerEntries = Array.from({ length: filler }, (_, index) => ({
    // A safe unique prefix keeps archiver from sanitizing the calculated length.
    name: `${String(index).padStart(6, '0')}${'a'.repeat((index === filler - 1 ? last : each) - 6)}`,
    content: 'x',
  }));
  const archive = await buildArchive({ store: true, entries: [...base, ...fillerEntries] });
  const built = centralDirectorySpan(archive);
  if (built !== span) throw new Error(`fixture span is ${built} bytes, expected exactly ${span}`);
  return archive;
}

export async function createArchiveDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'narratorr-epub-'));
}

export async function writeArchive(dir: string, name: string, bytes: Buffer): Promise<string> {
  const filePath = path.join(dir, name);
  await writeFile(filePath, bytes);
  return filePath;
}

export async function writeBuiltArchive(
  dir: string,
  name: string,
  options: BuildArchiveOptions,
): Promise<string> {
  return writeArchive(dir, name, await buildArchive(options));
}

/**
 * Locates EOCD like production: scan backward for the first candidate whose
 * commentLength accounts for every following byte.
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

/**
 * Returns production's capped pre-EOCD span using the authoritative ZIP32 or ZIP64
 * offset. ZIP64 includes its 76-byte record-and-locator envelope.
 */
export function centralDirectorySpan(archive: Buffer): number {
  const eocd = eocdOffset(archive);
  const legacyOffset = archive.readUInt32LE(eocd + 16);
  const start =
    legacyOffset === 0xffffffff
      ? Number(archive.readBigUInt64LE(zip64RecordOffset(archive) + 48))
      : legacyOffset;
  return eocd - start;
}

export interface ArchivePatch {
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

export interface CentralDirectoryEntry {
  headerOffset: number;
  nameOffset: number;
  nameLength: number;
  localHeaderOffset: number;
  /** Raw filename bytes as written. */
  rawName: Buffer;
  /**
   * Pinned writer emits no extra field; exact-span arithmetic depends on zero and
   * contract tests guard it.
   */
  extraLength: number;
  /** Per-entry comment width; zero from the pinned writer. */
  commentLength: number;
}

/**
 * Walks the directory using the ZIP64 record offset when the legacy field is a sentinel.
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
      extraLength,
      commentLength,
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
 * Rewrites a same-length filename in both headers; changing length would require
 * rebuilding every downstream offset.
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
  // Keep pathBuffer and the streamed local header consistent with a real archive.
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
 * Splices a ZIP64 record and locator before a ZIP32 EOCD, then sets its count and
 * offset sentinels. This creates the tiny 213-byte, half-billion-record forgery.
 */
export function forgeZip64Tail(base: Buffer, options: Zip64ForgeryOptions): Buffer {
  const eocd = eocdOffset(base);
  const head = base.subarray(0, eocd);
  const centralDirectoryOffset = base.readUInt32LE(eocd + 16);

  const record = Buffer.alloc(56);
  record.writeUInt32LE(options.recordSignature ?? ZIP64_RECORD_SIGNATURE, 0);
  record.writeBigUInt64LE(44n, 4); // Record size after this field.
  record.writeUInt16LE(45, 12); // Version made by.
  record.writeUInt16LE(45, 14); // Version needed to extract.
  record.writeUInt32LE(options.recordDiskNumber ?? 0, 16);
  record.writeUInt32LE(options.recordDiskStart ?? 0, 20);
  record.writeBigUInt64LE(options.recordRecordsOnDisk ?? options.declaredRecords, 24);
  record.writeBigUInt64LE(options.declaredRecords, 32);
  record.writeBigUInt64LE(BigInt(base.readUInt32LE(eocd + 12)), 40); // Central-directory size.
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
  tail.writeUInt16LE(0xffff, 10); // numberOfRecords ZIP64 sentinel.
  tail.writeUInt32LE(0xffffffff, 16); // central-directory-offset ZIP64 sentinel.

  return Buffer.concat([head, record, locator, tail]);
}
