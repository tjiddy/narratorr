import { open } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import { Readable } from 'node:stream';
import unzipper from 'unzipper';
import type { CentralDirectory, File } from 'unzipper';
import { createCountingStream } from './counting-stream.js';
import type { EpubReadErrorLabel } from './errors.js';
import { classifyEpubReadError } from './errors.js';
import { MAX_ARCHIVE_ENTRIES, MAX_CENTRAL_DIRECTORY_BYTES } from './limits.js';
import { READ_NO_FOLLOW } from '../utils/no-follow-open.js';
import { decodeEntryName, findDuplicateEntry, normalizeArchivePath } from './paths.js';
import type { EpubValidationCode } from './result.js';

/**
 * Single-handle positional archive adapter for companion EPUBs. unzipper allocates
 * from an unchecked ZIP64 record count, so a tiny forgery can exhaust the heap unless
 * the count is validated before Open.custom reads it from the same descriptor.
 *
 * One descriptor pins the inode, not its bytes. The replay queue therefore gives the
 * reader the exact tail, locator, and record that preflight accepted.
 *
 * The central directory and payloads remain live; replay prevents count substitution,
 * not general TOCTOU or content tampering. Nothing outlives withZipSource's callback.
 */

/** 22-byte EOCD record plus the 65,535-byte legal maximum ZIP comment. */
const EOCD_WINDOW_BYTES = 65557;
const EOCD_RECORD_BYTES = 22;
const ZIP64_LOCATOR_BYTES = 20;
const ZIP64_RECORD_BYTES = 56;
/** A ZIP64 locator and record must physically precede the EOCD. */
const ZIP64_TAIL_BYTES = ZIP64_LOCATOR_BYTES + ZIP64_RECORD_BYTES;

const EOCD_SIGNATURE = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;
const ZIP64_RECORD_SIGNATURE = 0x06064b50;
const DISK_SENTINEL = 0xffff;
const OFFSET_SENTINEL = 0xffffffff;
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

/** Chunk live reads because unzipper requests central-directory offset through EOF. */
const READ_CHUNK_BYTES = 64 * 1024;

/**
 * Pinned-reader protocol drift, never evidence about a book. This subclass and
 * non-decoder code must classify as throw; a plain Error would become decoder-failure.
 */
export class ZipSourceProtocolError extends TypeError {
  readonly code = 'EPUB_ZIP_SOURCE_PROTOCOL';

  constructor(message: string) {
    super(message);
    this.name = 'ZipSourceProtocolError';
  }
}

/** Positional source handed to Open.custom. */
export interface ZipPositionalSource {
  /** Size frozen by the single preflight fh.stat(). */
  size(): Promise<number>;
  /**
   * Runtime structural reads omit length, meaning through EOF. Implementing only
   * the two-parameter @types signature fails on the first read.
   */
  stream(offset: number, length?: number): Readable;
}

/** Reported failure labels; throw always propagates. */
export type ZipReadFailure = Exclude<EpubReadErrorLabel, 'throw'>;

/**
 * A failed read reports every inflated byte, including the cap-crossing chunk, so
 * callers can charge shared budgets without rollback. Successful bytes already carry that count.
 */
export type ZipEntryRead =
  | { kind: 'bytes'; bytes: Buffer }
  | { kind: 'failed'; label: ZipReadFailure; inflatedBytes: number };

/** Validated central-directory member exposed inside src/core/epub. */
export interface ZipArchiveEntry {
  /** Fatally decoded, normalized POSIX key; consumers must not use unzipper's path. */
  readonly name: string;
  /** Raw general-purpose flags used for encryption detection. */
  readonly flags: number;
  /** Attacker-authored declared size; advisory, never enforcement. */
  readonly uncompressedSize: number;
  /**
   * Streams through the counting transform under the caller's cap. File.buffer()
   * is forbidden because it inflates without a bound.
   */
  read(cap: number): Promise<ZipEntryRead>;
}

export type ZipArchiveResult =
  | { kind: 'archive'; entries: ZipArchiveEntry[] }
  | { kind: 'rejected'; code: EpubValidationCode }
  | { kind: 'failed'; label: ZipReadFailure };

/** Callback-scoped view; never exposes the FileHandle or close operation. */
export interface ZipSourceSession {
  /** Stats from the single handle-based stat. */
  readonly stat: Stats;
  readonly source: ZipPositionalSource;
  /** Preflights structure and count before invoking the pinned reader. */
  preflightAndOpen(): Promise<ZipArchiveResult>;
}

/**
 * Runtime Open.custom forwards tailSize although pinned @types declares one parameter;
 * preserve the real two-parameter shape locally.
 */
type OpenCustom = (
  source: ZipPositionalSource,
  options: { tailSize: number },
) => Promise<CentralDirectory>;

const openCustom = unzipper.Open.custom as OpenCustom;

interface ReplayEntry {
  readonly offset: number;
  readonly bytes: Buffer;
}

interface ScratchWindow {
  readonly offset: number;
  readonly bytes: Buffer;
}

/** Shared ZIP32/ZIP64 declaration so both branches receive identical ceilings. */
interface DeclaredDirectory {
  readonly count: number;
  /** Absolute offset the reader will seek to. The span is `eocdOffset - this`. */
  readonly centralDirectoryOffset: number;
}

type PreflightOutcome =
  | { kind: 'ok'; eocdOffset: number; declaredCount: number; queue: ReplayEntry[] }
  | { kind: 'rejected'; code: 'truncated' | 'limit_exceeded' };

const TRUNCATED = { kind: 'rejected', code: 'truncated' } as const;

/**
 * Read `[offset, offset + length)` in full.
 *
 * FileHandle.read may return a nonzero partial read; continue until the range is
 * full or bytesRead === 0 proves EOF.
 */
async function readRange(fh: FileHandle, offset: number, length: number): Promise<Buffer> {
  if (length <= 0) return Buffer.alloc(0);
  const buffer = Buffer.allocUnsafe(length);
  let filled = 0;
  while (filled < length) {
    const { bytesRead } = await fh.read(buffer, filled, length - filled, offset + filled);
    if (bytesRead === 0) break;
    filled += bytesRead;
  }
  // Return only bytes actually read, never the uninitialized scratch-buffer tail.
  return buffer.subarray(0, filled);
}

/**
 * Assembles a range from the tail window plus any uncovered prefix. Replay stores
 * the assembled structure, so ranges crossing the window boundary behave identically.
 */
async function acquireRange(
  fh: FileHandle,
  window: ScratchWindow,
  offset: number,
  length: number,
): Promise<Buffer> {
  if (offset >= window.offset) {
    const start = offset - window.offset;
    return window.bytes.subarray(start, start + length);
  }
  const headLength = Math.min(offset + length, window.offset) - offset;
  const head = await readRange(fh, offset, headLength);
  if (offset + length <= window.offset || head.length < headLength) return head;
  return Buffer.concat([head, window.bytes.subarray(0, offset + length - window.offset)]);
}

function createBufferStream(bytes: Buffer): Readable {
  let pushed = false;
  return new Readable({
    read() {
      if (pushed) return;
      pushed = true;
      this.push(bytes);
      this.push(null);
    },
  });
}

/**
 * Positional stream whose destroy never closes the shared handle; unzipper destroys
 * every entry stream. Ranges clamp to the frozen size because its padded requests
 * routinely extend beyond EOF.
 */
function createLiveStream(
  fh: FileHandle,
  size: number,
  offset: number,
  length: number | undefined,
  isClosed: () => boolean,
): Readable {
  let position = Math.min(Math.max(offset, 0), size);
  const end = length === undefined ? size : Math.min(size, position + Math.max(length, 0));
  let reading = false;

  const stream: Readable = new Readable({
    read() {
      if (reading || stream.destroyed) return;
      // The central-directory stream can outlive parsing; stop before it reaches a closed handle.
      if (position >= end || isClosed()) {
        stream.push(null);
        return;
      }
      reading = true;
      const chunk = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, end - position));
      fh.read(chunk, 0, chunk.length, position).then(
        ({ bytesRead }) => {
          reading = false;
          if (stream.destroyed) return;
          if (bytesRead === 0) {
            stream.push(null);
            return;
          }
          position += bytesRead;
          stream.push(chunk.subarray(0, bytesRead));
        },
        (error: unknown) => {
          reading = false;
          if (stream.destroyed) return;
          // Preserve the original value for classification.
          stream.destroy(error as Error);
        },
      );
    },
  });
  return stream;
}

interface PositionalSourceControl {
  readonly source: ZipPositionalSource;
  arm(entries: readonly ReplayEntry[]): void;
  close(): void;
}

/**
 * Builds a source over one handle and frozen size. Replay follows request sequence,
 * not covered offsets: each structural entry must match and is consumed once, then
 * central-directory and payload reads are live. One-shot consumption also separates
 * the empty archive's EOCD and directory reads at the same offset.
 */
function createPositionalSource(fh: FileHandle, size: number): PositionalSourceControl {
  const queue: ReplayEntry[] = [];
  const live = new Set<Readable>();
  let closed = false;

  const source: ZipPositionalSource = {
    size: () => Promise.resolve(size),
    stream(offset: number, length?: number): Readable {
      if (closed) {
        throw new ZipSourceProtocolError('zip source used after its session closed');
      }
      const head = queue[0];
      if (!head) {
        const stream = createLiveStream(fh, size, offset, length, () => closed);
        live.add(stream);
        stream.once('close', () => live.delete(stream));
        return stream;
      }
      if (offset !== head.offset) {
        // Fail closed on reader protocol drift; a live fallback would restore the allocation bug.
        throw new ZipSourceProtocolError(
          `pinned reader requested offset ${offset} while the validated replay queue expected ${head.offset}`,
        );
      }
      queue.shift();
      return createBufferStream(length === undefined ? head.bytes : head.bytes.subarray(0, length));
    },
  };

  return {
    source,
    arm(entries) {
      queue.length = 0;
      queue.push(...entries);
    },
    close() {
      closed = true;
      queue.length = 0;
      // Destroy live streams before their shared handle closes; stream destruction cannot close it.
      for (const stream of live) stream.destroy();
      live.clear();
    },
  };
}

/**
 * Scans backward for an EOCD signature with a full record and an exact
 * `offset + 22 + commentLength === size`, rejecting planted or short candidates.
 */
function selectEocdCandidate(window: ScratchWindow, size: number): number | null {
  let index = window.bytes.lastIndexOf(EOCD_SIGNATURE);
  while (index >= 0) {
    const offset = window.offset + index;
    if (size - offset >= EOCD_RECORD_BYTES && index + EOCD_RECORD_BYTES <= window.bytes.length) {
      if (offset + EOCD_RECORD_BYTES + window.bytes.readUInt16LE(index + 20) === size) return offset;
    }
    if (index === 0) return null;
    index = window.bytes.lastIndexOf(EOCD_SIGNATURE, index - 1);
  }
  return null;
}

/** Legacy EOCD fields at the offsets unzipper parses. */
function readLegacyEocd(tail: Buffer) {
  return {
    diskNumber: tail.readUInt16LE(4),
    diskStart: tail.readUInt16LE(6),
    recordsOnDisk: tail.readUInt16LE(8),
    numberOfRecords: tail.readUInt16LE(10),
    centralDirectoryOffset: tail.readUInt32LE(16),
  };
}

/**
 * Validates the locator immediately before EOCD; tailSize makes unzipper derive
 * the same address before replaying it.
 */
function validateZip64Locator(locator: Buffer, eocdOffset: number): number | null {
  if (locator.length < ZIP64_LOCATOR_BYTES) return null;
  if (locator.readUInt32LE(0) !== ZIP64_LOCATOR_SIGNATURE) return null;
  if (locator.readUInt32LE(4) !== 0) return null;
  if (locator.readUInt32LE(16) !== 1) return null;
  const rawOffset = locator.readBigUInt64LE(8);
  // Reject above 2^53 before Number conversion can lose precision.
  if (rawOffset > MAX_SAFE) return null;
  if (rawOffset > BigInt(eocdOffset - ZIP64_TAIL_BYTES)) return null;
  return Number(rawOffset);
}

/**
 * Validates authoritative ZIP64 disk fields, matching counts, safe integers, and
 * the record's central-directory offset. That offset must be returned for the span
 * ceiling because the legacy field is a sentinel on this branch.
 */
function validateZip64Record(record: Buffer, size: number): DeclaredDirectory | null {
  if (record.length < ZIP64_RECORD_BYTES) return null;
  if (record.readUInt32LE(0) !== ZIP64_RECORD_SIGNATURE) return null;
  if (record.readUInt32LE(16) !== 0 || record.readUInt32LE(20) !== 0) return null;
  const count = record.readBigUInt64LE(32);
  if (record.readBigUInt64LE(24) !== count) return null;
  const centralDirectoryOffset = record.readBigUInt64LE(48);
  if (centralDirectoryOffset > MAX_SAFE || centralDirectoryOffset >= BigInt(size)) return null;
  if (count > MAX_SAFE) return null;
  return { count: Number(count), centralDirectoryOffset: Number(centralDirectoryOffset) };
}

/** ZIP64 permits either zero or the 0xffff sentinel here. */
function isZeroOrDiskSentinel(value: number): boolean {
  return value === 0 || value === DISK_SENTINEL;
}

/**
 * ZIP64 authority moves to the locator and record; both are acquired from the
 * shared handle and queued for exact replay.
 */
async function preflightZip64(
  fh: FileHandle,
  window: ScratchWindow,
  eocdOffset: number,
  size: number,
  queue: ReplayEntry[],
): Promise<DeclaredDirectory | null> {
  // Reject before reading if the locator and record cannot physically precede EOCD.
  if (eocdOffset < ZIP64_TAIL_BYTES) return null;

  const locatorOffset = eocdOffset - ZIP64_LOCATOR_BYTES;
  const locator = await acquireRange(fh, window, locatorOffset, ZIP64_LOCATOR_BYTES);
  const recordOffset = validateZip64Locator(locator, eocdOffset);
  if (recordOffset === null) return null;

  const record = await acquireRange(fh, window, recordOffset, ZIP64_RECORD_BYTES);
  const declared = validateZip64Record(record, size);
  if (declared === null) return null;

  queue.push({ offset: locatorOffset, bytes: locator }, { offset: recordOffset, bytes: record });
  return declared;
}

/**
 * Selects EOCD and builds the reader-order replay queue: tail for ZIP32, then
 * locator and record for ZIP64. Structural failures are truncated; only a valid
 * declaration above a resource ceiling is limit_exceeded, before Open.custom.
 * Structure therefore takes precedence over both ceilings.
 */
async function preflight(fh: FileHandle, size: number): Promise<PreflightOutcome> {
  const windowLength = Math.min(size, EOCD_WINDOW_BYTES);
  const windowOffset = size - windowLength;
  const window: ScratchWindow = {
    offset: windowOffset,
    bytes: await readRange(fh, windowOffset, windowLength),
  };

  const eocdOffset = selectEocdCandidate(window, size);
  if (eocdOffset === null) return TRUNCATED;

  const tail = window.bytes.subarray(eocdOffset - windowOffset);
  const queue: ReplayEntry[] = [{ offset: eocdOffset, bytes: tail }];
  const legacy = readLegacyEocd(tail);

  // Only exact sentinels trigger ZIP64; near-sentinels stay legacy.
  const isZip64 =
    legacy.diskNumber === DISK_SENTINEL ||
    legacy.numberOfRecords === DISK_SENTINEL ||
    legacy.centralDirectoryOffset === OFFSET_SENTINEL;

  let declared: DeclaredDirectory | null;
  if (isZip64) {
    declared =
      isZeroOrDiskSentinel(legacy.diskNumber) && isZeroOrDiskSentinel(legacy.diskStart)
        ? await preflightZip64(fh, window, eocdOffset, size, queue)
        : null;
  } else {
    // OCF forbids split containers; unzipper does not check these fields.
    declared =
      legacy.diskNumber === 0 &&
      legacy.diskStart === 0 &&
      legacy.recordsOnDisk === legacy.numberOfRecords
        ? { count: legacy.numberOfRecords, centralDirectoryOffset: legacy.centralDirectoryOffset }
        : null;
  }

  if (declared === null) return TRUNCATED;
  // One formula caps both branches; ZIP64 deliberately includes its 76-byte tail envelope.
  const span = eocdOffset - declared.centralDirectoryOffset;
  // Negative is structurally invalid; zero is the valid empty archive.
  if (span < 0) return TRUNCATED;
  if (declared.count > MAX_ARCHIVE_ENTRIES) return { kind: 'rejected', code: 'limit_exceeded' };
  if (span > MAX_CENTRAL_DIRECTORY_BYTES) return { kind: 'rejected', code: 'limit_exceeded' };
  return { kind: 'ok', eocdOffset, declaredCount: declared.count, queue };
}

/**
 * Streams one member through the counting transform. Declared uncompressed size
 * is advisory; only streamed bytes enforce the cap, and File.buffer() is forbidden.
 */
async function readEntry(file: File, cap: number): Promise<ZipEntryRead> {
  const counter = createCountingStream(cap);
  let source: Readable | undefined;
  let sourceFailure: { value: unknown } | undefined;
  try {
    // pipe does not forward source errors; preserve their original identity for classification.
    source = file.stream();
    source.on('error', (value: unknown) => {
      sourceFailure = { value };
      counter.destroy(value instanceof Error ? value : new Error('archive entry stream failed'));
    });
    source.pipe(counter);
    const chunks: Buffer[] = [];
    for await (const chunk of counter) chunks.push(chunk as Buffer);
    return { kind: 'bytes', bytes: Buffer.concat(chunks) };
  } catch (caught: unknown) {
    const value = sourceFailure ? sourceFailure.value : caught;
    const label = classifyEpubReadError(value, { archiveRead: true });
    if (label === 'throw') throw value;
    // Failed transforms can discard pushed output; bytesCounted is the honest inflated total.
    return { kind: 'failed', label, inflatedBytes: counter.bytesCounted };
  } finally {
    // A cap breach leaves the source flowing; destroy only that stream, never the handle.
    source?.destroy();
  }
}

/**
 * Fatally decodes, normalizes, and duplicate-checks names from pathBuffer.
 * unzipper's path uses non-fatal UTF-8 replacement and is never trusted.
 */
function normalizeEntries(files: readonly File[]): ZipArchiveResult {
  const entries: ZipArchiveEntry[] = [];
  for (const file of files) {
    const decoded = decodeEntryName(file.pathBuffer);
    if (decoded.kind === 'rejected') return { kind: 'rejected', code: 'unsafe_entry_path' };
    const normalized = normalizeArchivePath(decoded.name);
    if (normalized.kind === 'rejected') return { kind: 'rejected', code: 'unsafe_entry_path' };
    entries.push({
      name: normalized.name,
      flags: file.flags,
      uncompressedSize: file.uncompressedSize,
      read: (cap: number) => readEntry(file, cap),
    });
  }
  const duplicate = findDuplicateEntry(entries.map((entry) => entry.name));
  if (duplicate.kind === 'duplicate') return { kind: 'rejected', code: 'duplicate_entry' };
  return { kind: 'archive', entries };
}

/**
 * Preflights before arming exact replay. tailSize starts unzipper at the accepted
 * candidate, preventing a planted EOCD signature from selecting another record.
 */
async function preflightAndOpen(
  fh: FileHandle,
  size: number,
  control: PositionalSourceControl,
): Promise<ZipArchiveResult> {
  // Let preflight I/O failures propagate; catching them risks labelling OS errors as corrupt books.
  const outcome = await preflight(fh, size);
  if (outcome.kind === 'rejected') return { kind: 'rejected', code: outcome.code };

  control.arm(outcome.queue);
  let directory: CentralDirectory;
  try {
    directory = await openCustom(control.source, { tailSize: size - outcome.eocdOffset });
  } catch (error: unknown) {
    const label = classifyEpubReadError(error, { archiveRead: true });
    if (label === 'throw') throw error;
    return { kind: 'failed', label };
  }

  // Defensive protocol assertion only: pinned unzipper constructs files from the declared count.
  if (directory.files.length !== outcome.declaredCount) {
    throw new ZipSourceProtocolError(
      `pinned reader returned ${directory.files.length} members for a validated declared count of ${outcome.declaredCount}`,
    );
  }
  return normalizeEntries(directory.files);
}

/**
 * Opens once and always closes after the callback. Open failures propagate before
 * callback or close; afterward the session and its streams are unusable.
 */
export async function withZipSource<T>(
  filePath: string,
  callback: (session: ZipSourceSession) => Promise<T>,
): Promise<T> {
  // This second pathname resolution must not follow a swapped symlink.
  const handle = await open(filePath, READ_NO_FOLLOW);
  let disarm: (() => void) | undefined;
  try {
    const stat = await handle.stat();
    const control = createPositionalSource(handle, stat.size);
    disarm = () => control.close();
    const session: ZipSourceSession = {
      stat,
      source: control.source,
      preflightAndOpen: () => preflightAndOpen(handle, stat.size, control),
    };
    return await callback(session);
  } finally {
    // Disarm streams before the only handle close; no source exists if stat failed.
    disarm?.();
    await handle.close();
  }
}
