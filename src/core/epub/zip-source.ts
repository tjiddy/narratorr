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
 * The single-handle positional (`pread`) archive adapter for companion EPUBs
 * (#1988, design §4). Every byte any later module reads from an archive comes
 * through here.
 *
 * **Internal to `src/core/epub/`.** Nothing here appears in an exported
 * signature outside this folder, and no `FileHandle`, source, stream, or session
 * outlives {@link withZipSource}'s callback.
 *
 * **Why the module exists, in one measurement.** §4 declined an EOCD preflight
 * on the reasoning that a 256 MiB `stat` ceiling bounds the worst case. It does
 * not: a 213-byte forged archive OOM-kills the process after ~31 s under a 1 GiB
 * heap cap, because `unzipper@0.12.3/lib/Open/directory.js:185` is
 * `Bluebird.mapSeries(Array(vars.numberOfRecords), …)` and `numberOfRecords` is
 * an unchecked 8-byte field on the ZIP64 path (`:68`). A pathname-based
 * preflight cannot fix it either — `Open.file(path)` does its own `stat` and its
 * own ranged reads *by pathname*, so the bytes validated beforehand are not the
 * bytes it parses.
 *
 * **One descriptor is necessary but not sufficient.** A shared handle pins the
 * *inode*; it does not freeze the *bytes*. The reader re-reads the tail, the
 * ZIP64 locator, and the ZIP64 record after the preflight already read them
 * (`directory.js:92-100`, `:132-137`, `:53`), and `fh.read` returns current
 * inode contents on every call — so an in-place rewrite between the two reads
 * would hand the reader a count we never validated. The bound is real only when
 * the reader consumes **the exact bytes the preflight accepted** for those three
 * structures, and only those. That is the validated replay queue below.
 *
 * **What that guarantees, and what it does not.** A live rewrite cannot change
 * the record count the reader allocates against. It does *not* freeze the
 * central directory or entry payloads — those are read live by construction, a
 * same-length rename simply parses as the new name, and a framing-breaking
 * rewrite surfaces as a reported decoder failure. §5 cut the TOCTOU requirement
 * and this module does not reinstate it; the replay scope is deliberately narrow
 * so it cannot accidentally provide content authenticity.
 */

/** 22-byte EOCD record plus the 65,535-byte legal maximum ZIP comment. */
const EOCD_WINDOW_BYTES = 65557;
const EOCD_RECORD_BYTES = 22;
const ZIP64_LOCATOR_BYTES = 20;
const ZIP64_RECORD_BYTES = 56;
/** A ZIP64 locator plus a record must physically precede the EOCD. */
const ZIP64_TAIL_BYTES = ZIP64_LOCATOR_BYTES + ZIP64_RECORD_BYTES;

const EOCD_SIGNATURE = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;
const ZIP64_RECORD_SIGNATURE = 0x06064b50;
const DISK_SENTINEL = 0xffff;
const OFFSET_SENTINEL = 0xffffffff;
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

/**
 * Live reads are chunked. `directory.js:149` streams from the central-directory
 * offset to EOF in a single `stream()` call, so a `fh.read` of `size - offset`
 * would allocate up to `MAX_ARCHIVE_BYTES` in one buffer.
 */
const READ_CHUNK_BYTES = 64 * 1024;

/**
 * A broken assumption about the pinned dependency — never evidence about a book.
 *
 * The identity is load-bearing, not free choice. `classifyEpubReadError` must
 * route it to `throw`, and it does so twice over: it is an excluded subclass
 * (`errors.ts:81`) *and* it carries a non-decoder `code` (`errors.ts:88`). A
 * plain uncoded `Error` would be wrong — raised inside the reader's promise
 * chain it is caught with `archiveRead: true` provenance and falls through to
 * `errors.ts:92` as a `decoder-failure`, so 1.1d would persist a dependency bump
 * as `truncated`, i.e. "this book is corrupt".
 */
export class ZipSourceProtocolError extends TypeError {
  readonly code = 'EPUB_ZIP_SOURCE_PROTOCOL';

  constructor(message: string) {
    super(message);
    this.name = 'ZipSourceProtocolError';
  }
}

/** The positional source handed to `Open.custom`. */
export interface ZipPositionalSource {
  /** Frozen — the size captured by the one preflight `fh.stat()`, never a fresh `stat`. */
  size(): Promise<number>;
  /**
   * `length` is optional and `undefined` means "to end of file". Every
   * structural read in the pinned reader passes one argument — the tail
   * (`directory.js:96`), the ZIP64 locator (`:132`), the ZIP64 record (`:53`),
   * and the whole central directory (`:149`); only per-entry reads pass a length
   * (`Open/unzip.js:13`). The built-in sources spell this the same way
   * (`Open/index.js:7-9`). An implementation written to the two-parameter
   * `@types` signature alone fails on the very first read.
   */
  stream(offset: number, length?: number): Readable;
}

/** A failure reported rather than thrown. `throw` is never reported — it propagates. */
export type ZipReadFailure = Exclude<EpubReadErrorLabel, 'throw'>;

/**
 * The outcome of reading one member through the counting transform.
 *
 * The failed arm carries `inflatedBytes` — every byte the counting transform
 * observed before it aborted, **including the chunk that crossed the cap**
 * (`counting-stream.ts:57-63`). Nothing else exposes that count, and a caller
 * sharing one budget across several reads has to charge it: forgiving a failed
 * read's inflated bytes is a rollback, which would let one call inflate more
 * than its ceiling by failing repeatedly (#1990 Decision 3). The successful arm
 * needs no such field — a clean end pushes every counted chunk, so
 * `bytes.length` *is* the observed count.
 */
export type ZipEntryRead =
  | { kind: 'bytes'; bytes: Buffer }
  | { kind: 'failed'; label: ZipReadFailure; inflatedBytes: number };

/** One central-directory member, as this module hands it to the rest of `src/core/epub/`. */
export interface ZipArchiveEntry {
  /** The fatally-decoded, normalised POSIX archive key — the only name any consumer may use. */
  readonly name: string;
  /** ZIP general-purpose bit flags, surfaced unchanged for 1.1d's encryption-bit scan. */
  readonly flags: number;
  /** The declared inflated size. Attacker-authored and advisory; never an enforcement point. */
  readonly uncompressedSize: number;
  /**
   * Stream this member through the counting transform, bounded at `cap`.
   * The cap is the caller's — `MAX_INSPECTION_BYTES`, `MAX_XML_BYTES`, and
   * `MAX_EPUB_COVER_BYTES` are selected per read by 1.1d and 1.1e, and this
   * module owns no budget. `File.buffer()` is never called; it inflates without
   * bound.
   */
  read(cap: number): Promise<ZipEntryRead>;
}

/** {@link ZipSourceSession.preflightAndOpen}'s outcome. */
export type ZipArchiveResult =
  | { kind: 'archive'; entries: ZipArchiveEntry[] }
  | { kind: 'rejected'; code: EpubValidationCode }
  | { kind: 'failed'; label: ZipReadFailure };

/**
 * The session {@link withZipSource} hands its callback. Exposes exactly the
 * `Stats` from the one `fh.stat()`, the positional source, and the preflight
 * entry point — never the `FileHandle`, and never a `close()`.
 */
export interface ZipSourceSession {
  /**
   * The `Stats` from the single `fh.stat()`, so a caller can satisfy "`fstat` on
   * the handle, not the path, is the authority" without re-opening.
   */
  readonly stat: Stats;
  readonly source: ZipPositionalSource;
  /**
   * Run the structural preflight and, if it passes, the pinned reader. The
   * entry-count ceiling is enforced here — once, pre-open, against the validated
   * declared count.
   */
  preflightAndOpen(): Promise<ZipArchiveResult>;
}

/**
 * The pinned `@types/unzipper@0.10.11` declares `Open.custom` with **one**
 * parameter (`index.d.ts:63-68`), while the runtime forwards a second straight
 * to the directory parser (`lib/Open/index.js:137-138`), so `tailSize` is
 * honoured. Declare the two-parameter shape locally rather than casting to
 * `any`.
 */
type OpenCustom = (
  source: ZipPositionalSource,
  options: { tailSize: number },
) => Promise<CentralDirectory>;

const openCustom = unzipper.Open.custom as OpenCustom;

/** One validated structure, held exactly as the preflight accepted it. */
interface ReplayEntry {
  readonly offset: number;
  readonly bytes: Buffer;
}

/** The tail of the file the preflight read to find the EOCD candidate. Scratch, then released. */
interface ScratchWindow {
  readonly offset: number;
  readonly bytes: Buffer;
}

/**
 * What a validated EOCD (legacy) or ZIP64 record declares about the central
 * directory: how many records it holds, and where it starts. Both branches
 * surface both fields so the count and span ceilings apply identically to each.
 */
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
 * **A short read means partial, not final.** `FileHandle.read()` reports
 * `bytesRead` and never promises to fill the buffer, so a nonzero-but-short
 * result with data still remaining is ordinary — loop until the range is
 * obtained or `bytesRead === 0` proves true EOF. Returning a truncated window is
 * not permitted: a short first read of the 65,557-byte tail would silently
 * shrink the scan window and reject a valid book as `truncated`. Never loops on
 * a zero-byte read.
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
  // Only bytes actually returned — never the uninitialised tail of the scratch buffer.
  return buffer.subarray(0, filled);
}

/**
 * Assemble `[offset, offset + length)`, taking whatever the scratch window
 * already holds and reading only the uncovered remainder from the handle.
 *
 * The window is always the file's tail, so the uncovered part is always a
 * *prefix* of the request. **Acquisition is separate from replay**: whether a
 * structure lies wholly inside the window, wholly outside it, or across its edge
 * only affects how the bytes are assembled here, never how they are replayed —
 * the queue stores assembled bytes, not buffer fragments. A legal 65,525-byte
 * comment puts the locator at `T - 10` for `T = size - 65557`, and a
 * 65,480-byte comment puts the record across `[T - 21, T + 35)`; both are
 * conformant and both assemble into one queue entry.
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

/** A stream over bytes we already hold. */
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
 * A stream over `[offset, end)` read positionally from the shared handle.
 *
 * **`destroy()` never touches the shared handle.** The reader destroys the
 * source stream after *every* entry (`Open/unzip.js:100-108`), so a destroyed
 * stream must stop reading and release only itself. That invariant is why the
 * positional form exists at all: a `filehandle.createReadStream()`-backed source
 * closes its handle on destroy, leaving `fh.fd = -1` and `EBADF` on the second
 * entry.
 *
 * **The range is clamped and short reads are normal.** Per-entry the reader asks
 * for `30 + padding(1000) + extraFieldLength + fileNameLength + compressedSize`
 * (`directory.js:222-228`), which routinely runs past EOF on the last entry; an
 * offset at or beyond the frozen size yields an immediately-ending stream.
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
      // The reader leaves its central-directory stream flowing after it has
      // parsed what it needs (`directory.js:149` is never destroyed), so a read
      // can still be pending when the session ends. Ending quietly here keeps
      // that from landing on a closed handle.
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
          // Forward the original value onto the stream; the caller classifies it.
          stream.destroy(error as Error);
        },
      );
    },
  });
  return stream;
}

/** The positional source plus the two controls `withZipSource` keeps to itself. */
interface PositionalSourceControl {
  readonly source: ZipPositionalSource;
  arm(entries: readonly ReplayEntry[]): void;
  close(): void;
}

/**
 * Build the source over one handle and one frozen size.
 *
 * **Replay is keyed on the reader's request sequence, not on byte offsets.**
 * Interception by "is this offset covered by a buffer I retained?" cannot work:
 * the acquisition window is the whole file for any archive under 65,557 bytes,
 * so an offset test cannot tell a structural read apart from a central-directory
 * or payload read. While the queue is non-empty the next call must match the
 * head's offset exactly; it is served from that entry and the entry is consumed
 * one-shot. Once the queue is empty every call is live — which is why the
 * central directory and every payload are live *by construction*, with no offset
 * arithmetic: by the time the reader reaches `:149` the queue is empty. One-shot
 * consumption is what makes that hold even in an empty archive, whose EOCD sits
 * at 0 and whose `offsetToStartOfCentralDirectory` is also 0.
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
        // Not a silent live read: falling through would reinstate the unbounded
        // allocation this module exists to prevent. Reachable only by a
        // dependency bump, which is exactly what it is here to catch.
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
      // Release every stream still flowing — destroying them touches only the
      // streams, never the handle, and it is what keeps a pending positional
      // read from reaching a descriptor `withZipSource` is about to close.
      for (const stream of live) stream.destroy();
      live.clear();
    },
  };
}

/**
 * Scan backward for the first offset satisfying **all** of: the four bytes are
 * `PK\x05\x06`; at least 22 bytes remain to end-of-file; and
 * `offset + 22 + commentLength === size`. The length check is part of candidate
 * acceptance, so no field is ever read out of range and no `RangeError` can
 * arise from a short candidate.
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

/** The legacy EOCD fields, at the same offsets the reader parses (`directory.js:109-120`). */
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
 * Validate the ZIP64 locator at `eocdOffset - 20` and return the record offset.
 *
 * The reader derives the same address as
 * `sourceSize - (tailSize - endDir.match + 20)` (`directory.js:129`); with
 * `tailSize = size - eocdOffset` the window starts at our candidate, so
 * `match === 0` and the expression reduces to exactly `eocdOffset - 20`.
 */
function validateZip64Locator(locator: Buffer, eocdOffset: number): number | null {
  if (locator.length < ZIP64_LOCATOR_BYTES) return null;
  if (locator.readUInt32LE(0) !== ZIP64_LOCATOR_SIGNATURE) return null;
  if (locator.readUInt32LE(4) !== 0) return null;
  if (locator.readUInt32LE(16) !== 1) return null;
  const rawOffset = locator.readBigUInt64LE(8);
  // Safe-integer first, BEFORE any `Number(...)` — the reader coerces the same
  // field at `parseBuffer.js:13-16` and silently loses precision above 2^53.
  if (rawOffset > MAX_SAFE) return null;
  if (rawOffset > BigInt(eocdOffset - ZIP64_TAIL_BYTES)) return null;
  return Number(rawOffset);
}

/**
 * Validate the ZIP64 record and return its declared entry count **and** the
 * central-directory offset it declares.
 *
 * The legacy disk fields are not authoritative on this branch, but these are:
 * `diskNumber` (+16) and `diskStart` (+20) must be 0, and
 * `numberOfRecordsOnDisk` (+24) must equal `numberOfRecords` (+32). The record's
 * own `offsetToStartOfCentralDirectory` (+48) is the field the reader actually
 * seeks to (`directory.js:59-71` → `parseBuffer.js:13-16` → `:149`), so it is
 * held to the same safe-integer and in-range rule as the locator's — without it
 * a record with a safe count and an offset of `2^53 + 1` reaches `Open.custom()`
 * and is silently rounded before use.
 *
 * The offset is *returned* rather than validated and dropped (#2025): it is the
 * only place the ZIP64 branch can learn where its central directory starts, and
 * the span ceiling needs it. The legacy field cannot stand in — on this branch it
 * carries the `0xffffffff` sentinel by definition.
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

/** `0` or the `0xffff` sentinel — a conformant ZIP64 writer may emit either. */
function isZeroOrDiskSentinel(value: number): boolean {
  return value === 0 || value === DISK_SENTINEL;
}

/**
 * The ZIP64 branch. Authority moves off the legacy fields and onto the locator
 * and record, both read from the same handle and both captured as replay-queue
 * entries so the reader parses exactly the bytes validated here.
 */
async function preflightZip64(
  fh: FileHandle,
  window: ScratchWindow,
  eocdOffset: number,
  size: number,
  queue: ReplayEntry[],
): Promise<DeclaredDirectory | null> {
  // 20 bytes of locator plus a 56-byte record must physically precede the EOCD;
  // a smaller offset leaves no room, and rejecting here means no out-of-range
  // read is ever attempted.
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
 * Select the EOCD candidate, validate the declared record count, and build the
 * ordered replay queue — `[tail]` on the ZIP32 branch, `[tail, locator, record]`
 * on the ZIP64 one, mirroring the reader's fixed, ordered structural calls.
 *
 * Retained memory is bounded by that queue: `size - eocdOffset` (≤ 65,557) plus
 * 76 bytes on the ZIP64 branch. The scratch window is released on return.
 *
 * Outcome mapping is exact and non-overlapping: any structural failure is
 * `truncated`; a well-formed declaration over either resource ceiling is
 * `limit_exceeded`. In both cases `Open.custom()` is never called.
 *
 * **Structure is decided before the ceilings.** A central directory declared to
 * start *after* the EOCD is a broken file, not an oversized one, so it is
 * `truncated` whatever it declares — that ordering is contractual (#2025), and
 * only the two ceilings below it are order-independent relative to each other.
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

  // Exact equality on each field independently, mirroring `directory.js:124-125`.
  // A near-sentinel such as 0xfffe or 0xfffffffe does not take this branch.
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
    // OCF forbids split containers, and the reader checks none of these fields.
    declared =
      legacy.diskNumber === 0 &&
      legacy.diskStart === 0 &&
      legacy.recordsOnDisk === legacy.numberOfRecords
        ? { count: legacy.numberOfRecords, centralDirectoryOffset: legacy.centralDirectoryOffset }
        : null;
  }

  if (declared === null) return TRUNCATED;
  // One formula, both branches. On the ZIP64 branch this is the *pre-EOCD
  // envelope*: it includes the 56-byte record and 20-byte locator sitting
  // between the directory and the EOCD, over-counting the true extent by exactly
  // 76 bytes. Accepted deliberately — one mental model, and 76 bytes is nothing
  // against a multi-MiB ceiling. `recordOffset` is not the endpoint.
  const span = eocdOffset - declared.centralDirectoryOffset;
  // Structural, and therefore first. A span of exactly 0 is the empty archive,
  // which is well-formed and must still reach the reader — `< 0`, never `<= 0`.
  if (span < 0) return TRUNCATED;
  if (declared.count > MAX_ARCHIVE_ENTRIES) return { kind: 'rejected', code: 'limit_exceeded' };
  if (span > MAX_CENTRAL_DIRECTORY_BYTES) return { kind: 'rejected', code: 'limit_exceeded' };
  return { kind: 'ok', eocdOffset, declaredCount: declared.count, queue };
}

/**
 * Read one member through the counting transform.
 *
 * `File.buffer()` is never called — it inflates without bound. The declared
 * `uncompressedSize` is not consulted: the reader bounds the *compressed* pull
 * by the honest `compressedSize` and lets central-directory vars override the
 * local header (`Open/unzip.js:44`, `:87`), so a lying declared size changes
 * nothing the reader does and the streamed counter is the only enforcement point
 * that fires.
 */
async function readEntry(file: File, cap: number): Promise<ZipEntryRead> {
  const counter = createCountingStream(cap);
  let source: Readable | undefined;
  let sourceFailure: { value: unknown } | undefined;
  try {
    // `File.stream()` returns a `Readable`, not a promise, and `pipe` does not
    // forward source errors — hand them to the counter, preserving the original
    // value so the classifier sees the identity the library raised.
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
    // `counter.bytesCounted` rather than the bytes that reached us: a `Transform`
    // aborted through `callback(error)` discards chunks it had already pushed but
    // we had not yet pulled (#1992), so delivered and inflated diverge here and
    // only the counter's total is the honest one.
    return { kind: 'failed', label, inflatedBytes: counter.bytesCounted };
  } finally {
    // A cap breach aborts the counter while the entry stream is still flowing.
    // This releases the stream only — never the shared handle.
    source?.destroy();
  }
}

/**
 * Decode, normalise, and duplicate-check every central-directory name.
 *
 * `File.path` is never used for lookup, comparison, or classification: it comes
 * from a non-fatal `Buffer.toString('utf8')` (`directory.js:212`) that silently
 * replaces malformed bytes with U+FFFD. `File.pathBuffer` is the only name
 * source this module trusts.
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
 * Preflight, then hand the pinned reader a source armed with the validated
 * replay queue.
 *
 * `tailSize` pins the reader to our candidate: its window *begins* at the
 * accepted offset, so its forward `Buffer.indexOf` necessarily matches at
 * position 0. One candidate, chosen by one algorithm, consumed by both — a
 * comment containing a planted `PK\x05\x06` cannot make the two disagree.
 */
async function preflightAndOpen(
  fh: FileHandle,
  size: number,
  control: PositionalSourceControl,
): Promise<ZipArchiveResult> {
  // Preflight `fh.read` failures are deliberately not caught: with
  // `archiveRead: false` provenance `classifyEpubReadError` routes every value
  // but our own cap breach to `throw`, so an explicit catch here would be a
  // no-op that only risks mislabelling an OS error as a corrupt book.
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

  // A defensive equality assertion, NOT a second independent measurement: the
  // reader builds `vars.files` from `Bluebird.mapSeries(Array(numberOfRecords))`
  // (`directory.js:185-239`), so `files.length` *is* the declared count by
  // construction and can never disagree. It is a cheap guard against a future
  // reader-version change, and says nothing about the archive.
  if (directory.files.length !== outcome.declaredCount) {
    throw new ZipSourceProtocolError(
      `pinned reader returned ${directory.files.length} members for a validated declared count of ${outcome.declaredCount}`,
    );
  }
  return normalizeEntries(directory.files);
}

/**
 * Open `filePath` once, run `callback` with a session, and close the handle in a
 * `finally` on **every** exit — success, structural rejection, or thrown error.
 *
 * `fs.open` is the only failure that happens before a handle exists: its
 * rejection propagates unchanged, `callback` never runs, and **no close is
 * attempted**, because nothing was acquired. After this function returns, the
 * session, its source, and every stream either produced are unusable.
 */
export async function withZipSource<T>(
  filePath: string,
  callback: (session: ZipSourceSession) => Promise<T>,
): Promise<T> {
  // `READ_NO_FOLLOW`, never `'r'`: callers verify the path before handing it here, so this open
  // is a second resolution of a pathname they already checked. See no-follow-open.ts.
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
    // The only close in the module, and idempotent: `FileHandle.close()` caches
    // its own promise, so a second call is a no-op rather than a double close.
    // `disarm` is undefined only when `fh.stat()` itself rejected, in which case
    // no source was ever built.
    disarm?.();
    await handle.close();
  }
}
