import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';
import { once } from 'node:events';
import path from 'node:path';
import type { FileHandle } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import * as F from '../__tests__/epub-archive.fixture.js';
import { scanProductionSources, scanSources } from '../__tests__/source-scan.js';
import { classifyEpubReadError } from './errors.js';
import { MAX_ARCHIVE_ENTRIES, MAX_CENTRAL_DIRECTORY_BYTES } from './limits.js';
import type { ZipArchiveResult, ZipSourceSession } from './zip-source.js';
import { withZipSource, ZipSourceProtocolError } from './zip-source.js';

/**
 * OS and unzipper boundary mocks delegate to real implementations. Module-local
 * bindings cannot be intercepted through exported helpers; the spies only observe
 * reader entry, handle reads, and replayed stream calls.
 */

type ReadArgs = [buffer: Buffer, offset: number, length: number, position: number];
type ReadResult = { bytesRead: number; buffer: Buffer };

const h = vi.hoisted(() => ({
  fsOpen: vi.fn(),
  openCustom: vi.fn(),
  real: {} as {
    fsOpen: (typeof import('node:fs/promises'))['open'];
    Open: (typeof import('unzipper'))['Open'];
  },
  /** Runs after preflight, immediately before the pinned reader. */
  beforeOpen: undefined as (() => void | Promise<void>) | undefined,
  onRead: undefined as ((raw: FileHandle, args: ReadArgs) => Promise<ReadResult>) | undefined,
  onStat: undefined as (() => Promise<Stats>) | undefined,
  reads: [] as Array<{ position: number; bytesRead: number; streamCall: number; preOpen: boolean }>,
  handles: [] as Array<{ closes: number; raw: FileHandle }>,
  streamCall: -1,
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  h.real.fsOpen = actual.open;
  return { ...actual, default: actual, open: h.fsOpen };
});

vi.mock('unzipper', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const real = (actual.default ?? actual) as typeof import('unzipper');
  h.real.Open = real.Open;
  return { ...actual, default: { ...real, Open: { ...real.Open, custom: h.openCustom } } };
});

/** Forwards only the three FileHandle methods production uses. */
function wrapHandle(raw: FileHandle, record: { closes: number; raw: FileHandle }): FileHandle {
  return {
    async read(...args: ReadArgs): Promise<ReadResult> {
      const result = h.onRead ? await h.onRead(raw, args) : await raw.read(...args);
      h.reads.push({
        position: args[3],
        bytesRead: result.bytesRead,
        streamCall: h.streamCall,
        preOpen: h.openCustom.mock.calls.length === 0,
      });
      return result;
    },
    async stat(): Promise<Stats> {
      return h.onStat ? h.onStat() : raw.stat();
    },
    async close(): Promise<void> {
      record.closes += 1;
      return raw.close();
    },
  } as unknown as FileHandle;
}

/** Records every reader call on the source passed to Open.custom. */
function traceStreams(session: ZipSourceSession): Array<{ offset: number; length?: number }> {
  const calls: Array<{ offset: number; length?: number }> = [];
  const original = session.source.stream.bind(session.source);
  session.source.stream = (offset: number, length?: number) => {
    calls.push(length === undefined ? { offset } : { offset, length });
    h.streamCall = calls.length - 1;
    return original(offset, length);
  };
  return calls;
}

function drain(stream: Readable): Promise<Buffer[]> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on('data', (chunk: Buffer) => chunks.push(chunk));
    stream.on('end', () => resolve(chunks));
    stream.on('error', reject);
  });
}

/** Emits an error event, matching File.stream's failure shape. */
function erroringStream(value: unknown): Readable {
  const stream = new Readable({ read() {} });
  queueMicrotask(() => stream.emit('error', value));
  return stream;
}

function errno(code: string): Error {
  return Object.assign(new Error(`simulated ${code}`), { code });
}

let dir: string;
let sequence = 0;
let manyAtCeiling: string;
let manyOverCeiling: string;

async function place(bytes: Buffer): Promise<string> {
  sequence += 1;
  return F.writeArchive(dir, `fixture-${sequence}.zip`, bytes);
}

async function openArchive(filePath: string): Promise<ZipArchiveResult> {
  return withZipSource(filePath, (session) => session.preflightAndOpen());
}

async function namesOf(filePath: string): Promise<string[] | ZipArchiveResult> {
  const result = await openArchive(filePath);
  return result.kind === 'archive' ? result.entries.map((entry) => entry.name) : result;
}

beforeAll(async () => {
  dir = await F.createArchiveDir();
  // Build the only heavyweight fixtures once; patched counts cannot replace real records.
  const entries = (count: number) =>
    Array.from({ length: count }, (_, index) => ({ name: `e${index}.txt`, content: 'x' }));
  manyAtCeiling = await F.writeBuiltArchive(dir, 'ceiling.zip', {
    store: true,
    entries: entries(MAX_ARCHIVE_ENTRIES),
  });
  manyOverCeiling = await F.writeBuiltArchive(dir, 'over-ceiling.zip', {
    store: true,
    entries: entries(MAX_ARCHIVE_ENTRIES + 1),
  });
});

afterAll(async () => {
  const { rm } = await import('node:fs/promises');
  await rm(dir, { recursive: true, force: true });
});

beforeEach(() => {
  // `*Once()` queues are used below; `vi.clearAllMocks()` does not drain them.
  vi.resetAllMocks();
  h.beforeOpen = undefined;
  h.onRead = undefined;
  h.onStat = undefined;
  h.reads = [];
  h.handles = [];
  h.streamCall = -1;
  h.fsOpen.mockImplementation(async (...args: unknown[]) => {
    const raw = await (h.real.fsOpen as (...a: unknown[]) => Promise<FileHandle>)(...args);
    const record = { closes: 0, raw };
    h.handles.push(record);
    return wrapHandle(raw, record);
  });
  h.openCustom.mockImplementation(async (source: unknown, options: unknown) => {
    await h.beforeOpen?.();
    return (h.real.Open.custom as (s: unknown, o: unknown) => Promise<unknown>)(source, options);
  });
});

describe('the archive primitive', () => {
  it('reads three entries from one handle, with the fd alive throughout', async () => {
    const filePath = await place(
      await F.buildArchive({
        entries: [
          { name: 'a.txt', content: 'aaa' },
          { name: 'b.txt', content: 'bbb' },
          { name: 'c.txt', content: 'ccc' },
        ],
      }),
    );

    const contents = await withZipSource(filePath, async (session) => {
      const result = await session.preflightAndOpen();
      if (result.kind !== 'archive') throw new Error(`unexpected ${result.kind}`);
      const read: string[] = [];
      for (const entry of result.entries) {
        const bytes = await entry.read(1024);
        expect(bytes.kind).toBe('bytes');
        expect(h.handles[0]?.raw.fd).toBeGreaterThan(0);
        if (bytes.kind === 'bytes') read.push(bytes.bytes.toString('utf8'));
      }
      return read;
    });

    expect(contents).toEqual(['aaa', 'bbb', 'ccc']);
    expect(h.fsOpen).toHaveBeenCalledTimes(1);
    expect(h.handles).toHaveLength(1);
    expect(h.handles[0]?.closes).toBe(1);
  });

  it('keeps reading after an entry stream is destroyed early', async () => {
    const filePath = await place(
      await F.buildArchive({
        store: true,
        entries: [
          { name: 'a.txt', content: 'a'.repeat(200_000) },
          { name: 'b.txt', content: 'bbb' },
        ],
      }),
    );

    const second = await withZipSource(filePath, async (session) => {
      const result = await session.preflightAndOpen();
      if (result.kind !== 'archive') throw new Error(`unexpected ${result.kind}`);
      // A one-byte cap aborts and destroys the first entry stream mid-read.
      expect(await result.entries[0]?.read(1)).toEqual({
        kind: 'failed',
        label: 'cap-exceeded',
        // A dedicated test below pins the crossing-chunk count.
        inflatedBytes: expect.any(Number),
      });
      return result.entries[1]?.read(1024);
    });

    expect(second).toEqual({ kind: 'bytes', bytes: Buffer.from('bbb') });
    expect(h.handles[0]?.closes).toBe(1);
  });

  it.each([
    ['success', async (p: string) => void (await openArchive(p))],
    [
      'a structural rejection',
      async (p: string) => {
        expect(await openArchive(p)).toMatchObject({ kind: 'rejected' });
      },
    ],
    [
      'a thrown error',
      async (p: string) => {
        await expect(
          withZipSource(p, () => Promise.reject(new Error('callback blew up'))),
        ).rejects.toThrow('callback blew up');
      },
    ],
  ])('closes the handle exactly once on %s', async (label, run) => {
    const good = await F.buildArchive({ entries: [{ name: 'a.txt', content: 'hi' }] });
    const filePath = await place(
      label === 'a structural rejection'
        ? F.patchArchive(good, [
            { offset: F.eocdOffset(good) + 6, size: 2, why: 'diskStart — split declaration', value: 3 },
          ])
        : good,
    );
    await run(filePath);
    expect(h.handles).toHaveLength(1);
    expect(h.handles[0]?.closes).toBe(1);
  });

  it('leaves no usable session, source, or stream behind', async () => {
    const filePath = await place(await F.buildArchive({ entries: [{ name: 'a.txt', content: 'hi' }] }));
    const escaped = await withZipSource(filePath, (session) => Promise.resolve(session));

    expect(() => escaped.source.stream(0)).toThrow(ZipSourceProtocolError);
    expect(h.handles[0]?.raw.fd).toBe(-1);
  });

  it('destroys an already-created live stream at teardown, before closing the handle', async () => {
    // An already-created, undrained stream bypasses the post-close source guard;
    // teardown must destroy it before its descriptor closes.
    const body = Buffer.alloc(512 * 1024, 5);
    const filePath = await place(body);

    const escaped = await withZipSource(filePath, (session) =>
      // Leave _read dormant so only teardown can end the stream.
      Promise.resolve(session.source.stream(0)),
    );

    expect(escaped.destroyed).toBe(true);

    const readsAtTeardown = h.reads.length;
    const chunks: Buffer[] = [];
    const errors: unknown[] = [];
    escaped.on('data', (chunk: Buffer) => chunks.push(chunk));
    escaped.on('error', (error: unknown) => errors.push(error));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(chunks).toEqual([]);
    expect(errors).toEqual([]);
    expect(h.reads).toHaveLength(readsAtTeardown);
    expect(h.handles).toHaveLength(1);
    expect(h.handles[0]?.closes).toBe(1);
    expect(h.handles[0]?.raw.fd).toBe(-1);
  });

  it('pins Decision 3 — a createReadStream-backed source kills the shared handle', async () => {
    // unzipper destroys every bounded range; FileHandle.createReadStream then closes
    // the shared handle and kills later reads.
    const filePath = await place(Buffer.from('0123456789abcdefghij'));
    const raw = await h.real.fsOpen(filePath, 'r');
    const stream = raw.createReadStream({ start: 0, end: 3 });
    await drain(stream);
    stream.destroy();
    await once(stream, 'close');

    expect(raw.fd).toBe(-1);
    await expect(raw.read(Buffer.alloc(4), 0, 4, 0)).rejects.toThrow(/closed/);

    await withZipSource(filePath, async (session) => {
      const first = session.source.stream(0, 4);
      await drain(first);
      first.destroy();
      expect(await drain(session.source.stream(4, 4))).toEqual([Buffer.from('4567')]);
    });
  });
});

describe('the stream() contract', () => {
  const body = Buffer.from('0123456789abcdefghij');

  it('serves stream(offset) with no length to end of file', async () => {
    const filePath = await place(body);
    await withZipSource(filePath, async (session) => {
      expect(Buffer.concat(await drain(session.source.stream(12)))).toEqual(Buffer.from('cdefghij'));
    });
  });

  it('clamps an overrunning stream(offset, length) instead of throwing', async () => {
    const filePath = await place(body);
    await withZipSource(filePath, async (session) => {
      // Matches unzipper's padded last-entry overrun.
      expect(Buffer.concat(await drain(session.source.stream(16, 5_000)))).toEqual(
        Buffer.from('ghij'),
      );
    });
  });

  it('ends cleanly for an offset at or beyond the frozen size', async () => {
    const filePath = await place(body);
    await withZipSource(filePath, async (session) => {
      expect(await drain(session.source.stream(20))).toEqual([]);
      expect(await drain(session.source.stream(9_000, 10))).toEqual([]);
    });
  });

  it('leaves the shared handle open when a stream is destroyed mid-read', async () => {
    const filePath = await place(Buffer.alloc(512 * 1024, 7));
    await withZipSource(filePath, async (session) => {
      const stream = session.source.stream(0);
      await once(stream, 'data');
      stream.destroy();
      await once(stream, 'close');
      expect(Buffer.concat(await drain(session.source.stream(0, 4)))).toEqual(Buffer.alloc(4, 7));
    });
    expect(h.handles[0]?.closes).toBe(1);
  });

  it('reads to EOF in bounded chunks rather than one allocation', async () => {
    const filePath = await place(Buffer.alloc(3 * 1024 * 1024, 3));
    await withZipSource(filePath, async (session) => {
      const chunks = await drain(session.source.stream(0));
      expect(chunks.length).toBeGreaterThan(1);
      expect(Buffer.concat(chunks).length).toBe(3 * 1024 * 1024);
      expect(Math.max(...chunks.map((chunk) => chunk.length))).toBeLessThanOrEqual(64 * 1024);
    });
  });

  it('freezes size() against a file growing underneath it', async () => {
    const filePath = await place(body);
    await withZipSource(filePath, async (session) => {
      expect(await session.source.size()).toBe(20);
      const grower = await h.real.fsOpen(filePath, 'a');
      await grower.write(Buffer.alloc(1_000, 1));
      await grower.close();
      expect(await session.source.size()).toBe(20);
      expect(session.stat.size).toBe(20);
      expect(Buffer.concat(await drain(session.source.stream(0))).length).toBe(20);
    });
  });

  it('calls fh.stat() exactly once for the whole session', async () => {
    const statSpy = vi.fn<() => Promise<Stats>>();
    const filePath = await place(body);
    await withZipSource(filePath, async (session) => {
      h.onStat = statSpy;
      await drain(session.source.stream(0));
      await session.source.size();
      await session.source.size();
    });
    // Installed after the legitimate stat, this catches any later stat.
    expect(statSpy).not.toHaveBeenCalled();
  });
});

describe('validated structural replay', () => {
  /** Rewrites in place through a second descriptor, preserving the pinned inode. */
  async function rewrite(filePath: string, patches: readonly F.ArchivePatch[]): Promise<void> {
    const handle = await h.real.fsOpen(filePath, 'r+');
    for (const patch of patches) {
      const buffer = Buffer.alloc(patch.size);
      if (patch.size === 8) buffer.writeBigUInt64LE(BigInt(patch.value));
      else if (patch.size === 4) buffer.writeUInt32LE(Number(patch.value));
      else buffer.writeUInt16LE(Number(patch.value));
      await handle.write(buffer, 0, patch.size, patch.offset);
    }
    await handle.close();
  }

  it('hands the reader the validated count when the EOCD is rewritten mid-flight', async () => {
    // A small forgery keeps an unprotected real-reader path fail-safe instead of allocating.
    const bytes = await F.buildArchive({ store: true, entries: [{ name: 'a.txt', content: 'hi' }] });
    const eocd = F.eocdOffset(bytes);
    const filePath = await place(bytes);

    h.beforeOpen = () =>
      rewrite(filePath, [
        { offset: eocd + 8, size: 2, value: 2, why: 'numberOfRecordsOnDisk: 1 -> 2' },
        { offset: eocd + 10, size: 2, value: 2, why: 'numberOfRecords: 1 -> 2' },
      ]);

    expect(await namesOf(filePath)).toEqual(['a.txt']);
  });

  // Small deltas keep an unprotected real-reader path fail-safe.
  it.each([
    ['locator', (b: Buffer) => F.zip64LocatorOffset(b) + 8, 4 as const, 0xdeadbeef],
    ['record', (b: Buffer) => F.zip64RecordOffset(b) + 32, 8 as const, 2],
  ])('does not observe a mid-flight rewrite of the ZIP64 %s', async (_label, at, size, value) => {
    const bytes = await F.buildArchive({
      store: true,
      forceZip64: true,
      entries: [{ name: 'a.txt', content: 'hi' }],
    });
    const offset = at(bytes);
    const filePath = await place(bytes);
    h.beforeOpen = () => rewrite(filePath, [{ offset, size, value, why: 'post-preflight forgery' }]);

    expect(await namesOf(filePath)).toEqual(['a.txt']);
  });

  it.each([
    ['ZIP32', false, 1],
    ['ZIP64', true, 3],
  ])('arms exactly the queue the %s branch requires', async (_label, forceZip64, queued) => {
    const filePath = await place(
      await F.buildArchive({
        store: true,
        forceZip64,
        entries: [{ name: 'a.txt', content: 'hi' }],
      }),
    );

    const calls = await withZipSource(filePath, async (session) => {
      const recorded = traceStreams(session);
      expect((await session.preflightAndOpen()).kind).toBe('archive');
      return recorded;
    });

    const postOpen = h.reads.filter((read) => !read.preOpen);
    // Queue-served calls avoid fh.read; the first live call follows queue exhaustion.
    expect(postOpen.filter((read) => read.streamCall < queued)).toEqual([]);
    expect(postOpen.some((read) => read.streamCall === queued)).toBe(true);
    expect(calls.length).toBeGreaterThan(queued);
  });

  it('serves the empty archive twice at offset 0 — once queued, once live', async () => {
    // EOCD and directory both start at zero, so replay must follow consumption, not offset.
    const filePath = await place(await F.buildArchive({ entries: [] }));

    const calls = await withZipSource(filePath, async (session) => {
      const recorded = traceStreams(session);
      expect(await session.preflightAndOpen()).toEqual({ kind: 'archive', entries: [] });
      return recorded;
    });

    expect(calls).toEqual([{ offset: 0 }, { offset: 0 }]);
    const postOpen = h.reads.filter((read) => !read.preOpen && read.bytesRead > 0);
    expect(postOpen.map((read) => read.streamCall)).toEqual([1]);
  });

  it('throws through the classifier throw arm when the reader deviates from the queue', async () => {
    const filePath = await place(
      await F.buildArchive({ store: true, entries: [{ name: 'a.txt', content: 'hi' }] }),
    );

    const outcome = await withZipSource(filePath, async (session) => {
      let thrown: unknown;
      h.beforeOpen = () => {
        const before = h.reads.length;
        try {
          session.source.stream(999_999);
        } catch (error: unknown) {
          thrown = error;
        }
        expect(h.reads).toHaveLength(before);
      };
      const result = await session.preflightAndOpen();
      return { thrown, result };
    });

    expect(outcome.thrown).toBeInstanceOf(ZipSourceProtocolError);
    expect(outcome.thrown).toBeInstanceOf(TypeError);
    // Protocol failure did not consume the validated queue head.
    expect(outcome.result.kind).toBe('archive');
  });
});

describe('replay scope — the central directory and payloads stay live', () => {
  async function rewriteBytes(filePath: string, offset: number, replacement: Buffer): Promise<void> {
    const handle = await h.real.fsOpen(filePath, 'r+');
    await handle.write(replacement, 0, replacement.length, offset);
    await handle.close();
  }

  it('observes a same-length central-directory rename applied after the preflight', async () => {
    const bytes = await F.buildArchive({ store: true, entries: [{ name: 'a.xhtml', content: 'hi' }] });
    // Whole-file acquisition makes this catch replay keyed by covered offsets.
    expect(bytes.length).toBeLessThan(65_557);
    const nameOffset = F.listCentralDirectory(bytes)[0]!.nameOffset;
    const filePath = await place(bytes);
    h.beforeOpen = () => rewriteBytes(filePath, nameOffset, Buffer.from('b.xhtml'));

    expect(await namesOf(filePath)).toEqual(['b.xhtml']);
  });

  it('reads the rewritten payload, offering no content-authenticity snapshot', async () => {
    const bytes = await F.buildArchive({ store: true, entries: [{ name: 'a.txt', content: 'AAAAA' }] });
    const dataOffset = F.localFileHeader(bytes, 0).dataOffset;
    const filePath = await place(bytes);
    h.beforeOpen = () => rewriteBytes(filePath, dataOffset, Buffer.from('BBBBB'));

    const read = await withZipSource(filePath, async (session) => {
      const result = await session.preflightAndOpen();
      if (result.kind !== 'archive') throw new Error(`unexpected ${result.kind}`);
      expect(result.entries).toHaveLength(1);
      return result.entries[0]!.read(1024);
    });

    expect(read).toEqual({ kind: 'bytes', bytes: Buffer.from('BBBBB') });
  });

  it('reports a decoder failure for a framing-breaking central-directory rewrite', async () => {
    const bytes = await F.buildArchive({ store: true, entries: [{ name: 'a.txt', content: 'hi' }] });
    const headerOffset = F.listCentralDirectory(bytes)[0]!.headerOffset;
    const filePath = await place(bytes);
    h.beforeOpen = async () => {
      const handle = await h.real.fsOpen(filePath, 'r+');
      const buffer = Buffer.alloc(2);
      buffer.writeUInt16LE(60_000);
      // Inflate fileNameLength so the reader exhausts the rewritten framing.
      await handle.write(buffer, 0, 2, headerOffset + 28);
      await handle.close();
    };

    expect(await openArchive(filePath)).toEqual({ kind: 'failed', label: 'decoder-failure' });
  });
});

describe('replay boundary — structures straddling the acquisition window', () => {
  /**
   * With T at the acquisition-window start, valid comments can straddle the locator
   * across T - 10 or the record across T - 21.
   */
  it.each([
    [65_525, 'locator', -10],
    [65_480, 'record', -21],
  ])('opens a ZIP64 archive whose %d-byte comment straddles the %s', async (comment, which, delta) => {
    const bytes = await F.buildArchive({
      store: true,
      forceZip64: true,
      entries: [{ name: 'a.txt', content: 'hi' }],
      comment: 'c'.repeat(comment),
    });
    const windowStart = bytes.length - 65_557;
    const structureOffset =
      which === 'locator' ? F.zip64LocatorOffset(bytes) : F.zip64RecordOffset(bytes);
    // Pin the intended straddling geometry.
    expect(structureOffset - windowStart).toBe(delta);

    const validated = Buffer.from(
      bytes.subarray(structureOffset, structureOffset + (which === 'locator' ? 20 : 56)),
    );
    const filePath = await place(bytes);

    h.beforeOpen = async () => {
      const handle = await h.real.fsOpen(filePath, 'r+');
      await handle.write(Buffer.alloc(4, 0xee), 0, 4, structureOffset);
      await handle.close();
    };

    const calls = await withZipSource(filePath, async (session) => {
      const recorded: Buffer[] = [];
      const original = session.source.stream.bind(session.source);
      session.source.stream = (offset: number, length?: number) => {
        const stream = original(offset, length);
        if (offset === structureOffset) {
          stream.on('data', (chunk: Buffer) => recorded.push(chunk));
        }
        return stream;
      };
      expect((await session.preflightAndOpen()).kind).toBe('archive');
      return recorded;
    });

    expect(Buffer.concat(calls)).toEqual(validated);
  });

  it('reads each preflight byte at most once, as pairwise-disjoint intervals', async () => {
    // Compare intervals, not starts: a tail-window read and a locator read can overlap
    // despite different offsets.
    const filePath = await place(
      await F.buildArchive({
        store: true,
        forceZip64: true,
        entries: [{ name: 'a.txt', content: 'hi' }],
        comment: 'c'.repeat(65_525),
      }),
    );
    expect((await openArchive(filePath)).kind).toBe('archive');

    const intervals = h.reads
      .filter((read) => read.preOpen && read.bytesRead > 0)
      .map((read) => [read.position, read.position + read.bytesRead] as const)
      .sort((a, b) => a[0] - b[0]);
    expect(intervals.length).toBeGreaterThan(1);
    for (let index = 1; index < intervals.length; index += 1) {
      expect(intervals[index]![0]).toBeGreaterThanOrEqual(intervals[index - 1]![1]);
    }
  });

  it('drains every queue entry from memory, with no fh.read and the validated bytes', async () => {
    const bytes = await F.buildArchive({
      store: true,
      forceZip64: true,
      entries: [{ name: 'a.txt', content: 'hi' }],
    });
    const eocd = F.eocdOffset(bytes);
    const locatorOffset = F.zip64LocatorOffset(bytes);
    const recordOffset = F.zip64RecordOffset(bytes);
    const validated = new Map<number, Buffer>([
      [eocd, Buffer.from(bytes.subarray(eocd))],
      [locatorOffset, Buffer.from(bytes.subarray(locatorOffset, locatorOffset + 20))],
      [recordOffset, Buffer.from(bytes.subarray(recordOffset, recordOffset + 56))],
    ]);
    const filePath = await place(bytes);

    const served = await withZipSource(filePath, async (session) => {
      const captured = new Map<number, Buffer[]>();
      const original = session.source.stream.bind(session.source);
      let index = 0;
      session.source.stream = (offset: number, length?: number) => {
        h.streamCall = index;
        index += 1;
        const stream = original(offset, length);
        if (validated.has(offset) && !captured.has(offset)) {
          const chunks: Buffer[] = [];
          captured.set(offset, chunks);
          stream.on('data', (chunk: Buffer) => chunks.push(chunk));
        }
        return stream;
      };
      expect((await session.preflightAndOpen()).kind).toBe('archive');
      return captured;
    });

    for (const [offset, expected] of validated) {
      expect(Buffer.concat(served.get(offset) ?? [])).toEqual(expected);
    }
    // The first live handle read is the central directory after all three replay entries.
    expect(h.reads.filter((read) => !read.preOpen && read.streamCall < 3)).toEqual([]);
    expect(h.reads.some((read) => !read.preOpen && read.streamCall === 3)).toBe(true);
  });
});

describe('EOCD candidate selection', () => {
  it.each([
    ['no comment', ''],
    ['a 100-byte comment', 'c'.repeat(100)],
    ['a 60,000-byte comment', 'c'.repeat(60_000)],
    // Exact legal maximum catches an off-by-one tail window.
    ['a 65,535-byte comment', 'c'.repeat(65_535)],
    ['a comment containing a planted PK\\x05\\x06', `${'c'.repeat(40)}\x50\x4b\x05\x06${'c'.repeat(56)}`],
  ])('opens an archive with %s', async (label, comment) => {
    const bytes = await F.buildArchive({ entries: [{ name: 'a.txt', content: 'hi' }], comment });
    const eocd = F.eocdOffset(bytes);
    expect(bytes.readUInt16LE(eocd + 20)).toBe(comment.length);
    if (label.includes('planted')) {
      // The later decoy is encountered first and must fail the length rule.
      expect(bytes.lastIndexOf(F.EOCD_SIGNATURE)).toBe(eocd + 62);
    }
    const filePath = await place(bytes);

    expect(await namesOf(filePath)).toEqual(['a.txt']);

    if (comment.length > 0) {
      // Pinned unzipper's default tail window cannot open a commented archive.
      await expect(h.real.Open.file(filePath)).rejects.toThrow();
    }
  });

  it.each([
    [
      'no PK\\x05\\x06 anywhere in the window',
      () => Buffer.alloc(500, 0x41),
    ],
    [
      'a commentLength that does not account for the trailing bytes',
      (bytes: Buffer) =>
        F.patchArchive(bytes, [
          { offset: F.eocdOffset(bytes) + 20, size: 2, value: 7, why: 'commentLength lie' },
        ]),
    ],
    [
      'a file ending in PK\\x05\\x06 with no room for the record',
      () => Buffer.concat([Buffer.alloc(200, 0x41), F.EOCD_SIGNATURE]),
    ],
    [
      'a candidate leaving only 21 bytes',
      () => Buffer.concat([Buffer.alloc(200, 0x41), F.EOCD_SIGNATURE, Buffer.alloc(17, 0)]),
    ],
  ])('rejects %s as truncated', async (_label, make) => {
    const base = await F.buildArchive({ entries: [{ name: 'a.txt', content: 'hi' }] });
    const filePath = await place(make(base));

    expect(await openArchive(filePath)).toEqual({ kind: 'rejected', code: 'truncated' });
    expect(h.openCustom).not.toHaveBeenCalled();
  });
});

describe('the declared-entry-count preflight', () => {
  /** A tiny, entirely valid ZIP32 archive turned into a ZIP64 forgery. */
  async function forge(options: Partial<F.Zip64ForgeryOptions> = {}): Promise<Buffer> {
    const base = await F.buildArchive({
      store: true,
      entries: [{ name: 'chapter-one.xhtml', content: 'hello' }],
    });
    return F.forgeZip64Tail(base, { declaredRecords: 1n, ...options });
  }

  it('rejects the 213-byte forgery pre-open, without calling the reader', async () => {
    // Bare Open.file on this 213-byte, half-billion-record forgery exhausts the heap.
    // Keep the real reader stubbed so a preflight regression fails safely.
    h.openCustom.mockResolvedValue({ files: [] });
    const forged = await forge({ declaredRecords: 500_000_000n });
    expect(forged).toHaveLength(213);
    const filePath = await place(forged);

    expect(await openArchive(filePath)).toEqual({ kind: 'rejected', code: 'limit_exceeded' });
    expect(h.openCustom).not.toHaveBeenCalled();
  });

  it.each([
    ['diskNumber', ['numberOfRecords', 'centralDirectoryOffset']],
    ['numberOfRecords', ['centralDirectoryOffset']],
    ['centralDirectoryOffset', ['numberOfRecords']],
  ])('takes the ZIP64 branch on the %s sentinel alone', async (trigger, restore) => {
    // Each independent sentinel must trigger ZIP64; setting all three would miss an AND bug.
    // Valid locator and record data make only the ZIP64 interpretation open successfully.
    const base = await F.buildArchive({
      store: true,
      entries: [{ name: 'chapter-one.xhtml', content: 'hello' }],
    });
    const baseEocd = F.eocdOffset(base);
    const realCount = base.readUInt16LE(baseEocd + 10);
    const realOffset = base.readUInt32LE(baseEocd + 16);

    const forged = F.forgeZip64Tail(base, { declaredRecords: BigInt(realCount) });
    const eocd = F.eocdOffset(forged);
    const patches: F.ArchivePatch[] = restore.map((field) =>
      field === 'numberOfRecords'
        ? { offset: eocd + 10, size: 2 as const, value: realCount, why: 'clear the count sentinel' }
        : { offset: eocd + 16, size: 4 as const, value: realOffset, why: 'clear the offset sentinel' },
    );
    if (trigger === 'diskNumber') {
      patches.push({ offset: eocd + 4, size: 2, value: 0xffff, why: 'the lone trigger under test' });
    }
    const bytes = F.patchArchive(forged, patches);

    const set = [
      bytes.readUInt16LE(eocd + 4) === 0xffff,
      bytes.readUInt16LE(eocd + 10) === 0xffff,
      bytes.readUInt32LE(eocd + 16) === 0xffffffff,
    ];
    expect(set.filter(Boolean)).toHaveLength(1);
    const filePath = await place(bytes);

    const calls = await withZipSource(filePath, async (session) => {
      const recorded = traceStreams(session);
      expect(await session.preflightAndOpen()).toMatchObject({ kind: 'archive' });
      return recorded;
    });

    // Queued locator replay proves preflight, not only unzipper, took the ZIP64 branch.
    expect(calls[1]).toEqual({ offset: eocd - 20 });
    expect(h.reads.filter((read) => !read.preOpen && read.streamCall < 3)).toEqual([]);
  });

  it.each([
    ['diskNumber', [{ at: 4, size: 2 as const, value: 0xfffe }], { kind: 'rejected', code: 'truncated' }],
    [
      'numberOfRecords',
      [
        { at: 8, size: 2 as const, value: 0xfffe },
        { at: 10, size: 2 as const, value: 0xfffe },
      ],
      { kind: 'rejected', code: 'limit_exceeded' },
    ],
    [
      'offsetToStartOfCentralDirectory',
      [{ at: 16, size: 4 as const, value: 0xfffffffe }],
      // As a legacy offset, 0xfffffffe creates a structurally negative span.
      { kind: 'rejected', code: 'truncated' },
    ],
  ])('does not take the ZIP64 branch on a near-sentinel %s', async (_field, patches, expected) => {
    const bytes = await F.buildArchive({ store: true, entries: [{ name: 'a.txt', content: 'hi' }] });
    const eocd = F.eocdOffset(bytes);
    const filePath = await place(
      F.patchArchive(
        bytes,
        patches.map((patch) => ({
          offset: eocd + patch.at,
          size: patch.size,
          value: patch.value,
          why: 'near-sentinel, one below the exact ZIP64 trigger',
        })),
      ),
    );

    expect(await openArchive(filePath)).toEqual(expected);
    expect(h.reads.some((read) => read.position === eocd - 20)).toBe(false);
  });

  it.each([
    ['ZIP32 diskStart', 6, 2 as const, 1],
    ['ZIP32 numberOfRecordsOnDisk disagreeing with numberOfRecords', 8, 2 as const, 5],
  ])('rejects a split declaration in %s', async (_label, at, size, value) => {
    const bytes = await F.buildArchive({ store: true, entries: [{ name: 'a.txt', content: 'hi' }] });
    const filePath = await place(
      F.patchArchive(bytes, [
        { offset: F.eocdOffset(bytes) + at, size, value, why: 'OCF forbids split containers' },
      ]),
    );

    expect(await openArchive(filePath)).toEqual({ kind: 'rejected', code: 'truncated' });
    expect(h.openCustom).not.toHaveBeenCalled();
  });

  it.each<[string, Partial<F.Zip64ForgeryOptions>]>([
    ['a bad locator signature', { locatorSignature: 0x01020304 }],
    ['a locator diskNumber other than 0', { locatorDiskNumber: 1 }],
    ['a locator numberOfDisks other than 1', { locatorNumberOfDisks: 2 }],
    ['a locator record offset past its legal ceiling', { locatorRecordOffset: 4_000_000n }],
    // This isolates rejection before Number conversion; the prior range row cannot.
    ['a locator record offset above 2^53 - 1', { locatorRecordOffset: (1n << 53n) + 1n }],
    ['a bad record signature', { recordSignature: 0x01020304 }],
    ['a record diskNumber other than 0', { recordDiskNumber: 1 }],
    ['a record diskStart other than 0', { recordDiskStart: 1 }],
    ['a record whose on-disk count disagrees with its total', { recordRecordsOnDisk: 9n }],
    ['a declared count that is not a safe integer', { declaredRecords: (1n << 53n) + 1n }],
    [
      'a record central-directory offset above 2^53 - 1',
      { recordCentralDirectoryOffset: (1n << 53n) + 1n },
    ],
    ['a record central-directory offset outside the file', { recordCentralDirectoryOffset: 999_999n }],
  ])('rejects %s as truncated', async (_label, overrides) => {
    const filePath = await place(await forge(overrides));

    expect(await openArchive(filePath)).toEqual({ kind: 'rejected', code: 'truncated' });
    expect(h.openCustom).not.toHaveBeenCalled();
  });

  it('rejects sentinels set on an archive too small to hold a ZIP64 tail', async () => {
    // No ZIP64 tail can precede EOCD at zero; rejection must avoid a negative read.
    const empty = await F.buildArchive({ entries: [] });
    expect(F.eocdOffset(empty)).toBe(0);
    const filePath = await place(
      F.patchArchive(empty, [
        { offset: 10, size: 2, value: 0xffff, why: 'numberOfRecords sentinel on a 22-byte file' },
      ]),
    );

    expect(await openArchive(filePath)).toEqual({ kind: 'rejected', code: 'truncated' });
    expect(h.reads.every((read) => read.position >= 0)).toBe(true);
    expect(h.openCustom).not.toHaveBeenCalled();
  });

  it.each([
    ['0', 0],
    ['the 0xffff sentinel', 0xffff],
  ])('accepts ZIP32 disk fields of %s on the ZIP64 branch', async (_label, value) => {
    const bytes = await F.buildArchive({
      store: true,
      forceZip64: true,
      entries: [{ name: 'a.txt', content: 'hi' }],
    });
    const eocd = F.eocdOffset(bytes);
    const filePath = await place(
      F.patchArchive(bytes, [
        { offset: eocd + 4, size: 2, value, why: 'legacy diskNumber — not authoritative here' },
        { offset: eocd + 6, size: 2, value, why: 'legacy diskStart — not authoritative here' },
      ]),
    );

    expect(await namesOf(filePath)).toEqual(['a.txt']);
  });

  it('opens a conformant forceZip64 archive through the ZIP64 branch', async () => {
    const bytes = await F.buildArchive({
      store: true,
      forceZip64: true,
      entries: [
        { name: 'mimetype', content: 'application/epub+zip' },
        { name: 'OEBPS/a.xhtml', content: 'hi' },
      ],
    });
    expect(bytes.readUInt32LE(F.zip64LocatorOffset(bytes))).toBe(F.ZIP64_LOCATOR_SIGNATURE);
    expect(bytes.readUInt32LE(F.zip64RecordOffset(bytes))).toBe(F.ZIP64_RECORD_SIGNATURE);
    const filePath = await place(bytes);

    expect(await namesOf(filePath)).toEqual(['mimetype', 'OEBPS/a.xhtml']);
  });
});

describe('the entry-count ceiling', () => {
  it(`opens an archive declaring and holding exactly ${MAX_ARCHIVE_ENTRIES} members`, async () => {
    const result = await openArchive(manyAtCeiling);
    expect(result.kind).toBe('archive');
    if (result.kind === 'archive') expect(result.entries).toHaveLength(MAX_ARCHIVE_ENTRIES);
  });

  it('rejects one member above the ceiling pre-open', async () => {
    expect(await openArchive(manyOverCeiling)).toEqual({ kind: 'rejected', code: 'limit_exceeded' });
    expect(h.openCustom).not.toHaveBeenCalled();
  });

  it('pins that files.length follows the declaration, not the archive', async () => {
    // vars.files is Array(numberOfRecords), so a patched-down declaration yields that many.
    const bytes = await F.buildArchive({
      store: true,
      entries: [
        { name: 'a.txt', content: 'a' },
        { name: 'b.txt', content: 'b' },
        { name: 'c.txt', content: 'c' },
      ],
    });
    const eocd = F.eocdOffset(bytes);
    const filePath = await place(
      F.patchArchive(bytes, [
        { offset: eocd + 8, size: 2, value: 2, why: 'numberOfRecordsOnDisk: 3 -> 2' },
        { offset: eocd + 10, size: 2, value: 2, why: 'numberOfRecords: 3 -> 2' },
      ]),
    );

    expect(await namesOf(filePath)).toEqual(['a.txt', 'b.txt']);
  });

  it.each([
    ['fewer', 0],
    ['more', 2],
  ])('throws when the reader returns %s members than the validated count', async (_label, count) => {
    // Pinned unzipper cannot disagree with its declaration; a stub exercises future protocol drift.
    const filePath = await place(
      await F.buildArchive({ store: true, entries: [{ name: 'a.txt', content: 'hi' }] }),
    );
    h.openCustom.mockResolvedValueOnce({
      files: Array.from({ length: count }, (_, index) => ({
        pathBuffer: Buffer.from(`e${index}.txt`),
        flags: 0,
        uncompressedSize: 0,
        stream: () => erroringStream(new Error('never read')),
      })),
    });

    const thrown = await openArchive(filePath).catch((error: unknown) => error);

    expect(thrown).toBeInstanceOf(ZipSourceProtocolError);
    expect((thrown as Error).message).toContain(`returned ${count} members`);
    expect((thrown as Error).message).toContain('validated declared count of 1');
    // A plain Error would misclassify dependency drift as book corruption.
    expect(classifyEpubReadError(thrown, { archiveRead: true })).toBe('throw');
    expect(h.handles).toHaveLength(1);
    expect(h.handles[0]?.closes).toBe(1);
  });
});

describe('the central-directory span ceiling', () => {
  /** Long names, few entries: the span is tripped in isolation, far under the entry ceiling. */
  const SPAN_FIXTURE_ENTRIES = 150;
  const CAP = MAX_CENTRAL_DIRECTORY_BYTES;

  let atCap: string;
  let overCap: string;
  let zip64OverCap: string;

  beforeAll(async () => {
    // Build these ~17 MB fixtures once; unlike a forged count, an over-cap span
    // requires the bytes to exist.
    const atCapBytes = await F.buildArchiveWithCentralDirectorySpan({
      span: CAP,
      filler: SPAN_FIXTURE_ENTRIES,
    });
    const overCapBytes = await F.buildArchiveWithCentralDirectorySpan({
      span: CAP + 1,
      filler: SPAN_FIXTURE_ENTRIES,
    });
    const forged = F.forgeZip64Tail(atCapBytes, { declaredRecords: BigInt(SPAN_FIXTURE_ENTRIES) });
    // The forged ZIP64 envelope adds exactly its 56-byte record and 20-byte locator.
    expect(F.centralDirectorySpan(forged)).toBe(CAP + 76);

    atCap = await place(atCapBytes);
    overCap = await place(overCapBytes);
    zip64OverCap = await place(forged);
  });

  it('rejects a central directory one byte over the cap, without calling the reader', async () => {
    // Production-path measurements retain 2.06–2.39× the directory span. Without
    // this cap, four readers can retain roughly 0.9–1.2 GiB within the file-size limit.
    expect(await openArchive(overCap)).toEqual({ kind: 'rejected', code: 'limit_exceeded' });
    expect(h.openCustom).not.toHaveBeenCalled();
  });

  it('opens an archive whose central directory sits exactly at the cap', async () => {
    const result = await openArchive(atCap);

    expect(result.kind).toBe('archive');
    if (result.kind === 'archive') expect(result.entries).toHaveLength(SPAN_FIXTURE_ENTRIES);
  });

  it('accepts a span of exactly zero', async () => {
    const bytes = await F.buildArchive({ entries: [] });
    expect(F.eocdOffset(bytes)).toBe(0);
    expect(F.centralDirectorySpan(bytes)).toBe(0);
    const filePath = await place(bytes);

    expect(await openArchive(filePath)).toEqual({ kind: 'archive', entries: [] });
    expect(h.openCustom).toHaveBeenCalledTimes(1);
  });

  it('rejects a central-directory offset past the EOCD as truncated, not limit_exceeded', async () => {
    const bytes = await F.buildArchive({ store: true, entries: [{ name: 'a.txt', content: 'hi' }] });
    const eocd = F.eocdOffset(bytes);
    const filePath = await place(
      F.patchArchive(bytes, [
        { offset: eocd + 16, size: 4, value: eocd + 1, why: 'central directory starts after the EOCD' },
      ]),
    );

    expect(await openArchive(filePath)).toEqual({ kind: 'rejected', code: 'truncated' });
    expect(h.openCustom).not.toHaveBeenCalled();
  });

  it('reports a negative span as truncated even when the declared count is over the ceiling', async () => {
    // Keep both count fields coherently over-cap; otherwise their mismatch would
    // return truncated without proving structure precedes resource ceilings.
    const bytes = await F.buildArchive({ store: true, entries: [{ name: 'a.txt', content: 'hi' }] });
    const eocd = F.eocdOffset(bytes);
    const filePath = await place(
      F.patchArchive(bytes, [
        { offset: eocd + 8, size: 2, value: MAX_ARCHIVE_ENTRIES + 1, why: 'recordsOnDisk over the ceiling' },
        { offset: eocd + 10, size: 2, value: MAX_ARCHIVE_ENTRIES + 1, why: 'numberOfRecords, kept coherent' },
        { offset: eocd + 16, size: 4, value: eocd + 1, why: 'central directory starts after the EOCD' },
      ]),
    );

    expect(await openArchive(filePath)).toEqual({ kind: 'rejected', code: 'truncated' });
    expect(h.openCustom).not.toHaveBeenCalled();
  });

  it('caps the ZIP64 branch on the same span, pre-EOCD envelope included', async () => {
    // ZIP64 must use its record offset; the legacy sentinel would produce a negative span.
    expect(await openArchive(zip64OverCap)).toEqual({ kind: 'rejected', code: 'limit_exceeded' });
    expect(h.openCustom).not.toHaveBeenCalled();
  });

  it('leaves a conformant archive at the entry ceiling far under the cap', async () => {
    // A 10,000-member conformant archive spans 1.57 MiB, ruling out a 1 MiB cap.
    const { readFile } = await import('node:fs/promises');

    expect(F.centralDirectorySpan(await readFile(manyAtCeiling))).toBeLessThan(CAP);
  });
});

describe('entry-name handling', () => {
  it('rejects an invalid UTF-8 central-directory name as unsafe_entry_path', async () => {
    const bytes = await F.buildArchive({ store: true, entries: [{ name: 'abcd', content: 'hi' }] });
    const hostile = Buffer.from([0x61, 0xff, 0xfe, 0x62]);
    const patched = F.patchEntryName(bytes, 0, hostile);
    expect(F.listCentralDirectory(patched)[0]?.rawName).toEqual(hostile);
    const filePath = await place(patched);

    expect(await openArchive(filePath)).toEqual({ kind: 'rejected', code: 'unsafe_entry_path' });

    // unzipper's non-fatal File.path decoder substitutes U+FFFD.
    const directory = await h.real.Open.file(filePath);
    expect(directory.files[0]?.path).toContain('�');
  });

  it('rejects a byte-patched leading-traversal name', async () => {
    // archiver sanitizes leading traversal, so byte patching creates the hostile name;
    // the fixture-contract suite below pins that dependency behavior.
    const bytes = await F.buildArchive({
      store: true,
      entries: [{ name: 'aaaaaaaaaaaaaaaa', content: 'hi' }],
    });
    const hostile = Buffer.from('../../etc/passwd');
    expect(hostile).toHaveLength(16);
    const patched = F.patchEntryName(bytes, 0, hostile);
    expect(F.listCentralDirectory(patched)[0]?.rawName.toString('utf8')).toBe('../../etc/passwd');
    const filePath = await place(patched);

    expect(await openArchive(filePath)).toEqual({ kind: 'rejected', code: 'unsafe_entry_path' });
  });

  it('rejects mid-path traversal, which archiver preserves verbatim', async () => {
    const bytes = await F.buildArchive({ store: true, entries: [{ name: 'a/../../b.txt', content: 'hi' }] });
    expect(F.listCentralDirectory(bytes)[0]?.rawName.toString('utf8')).toBe('a/../../b.txt');
    const filePath = await place(bytes);

    expect(await openArchive(filePath)).toEqual({ kind: 'rejected', code: 'unsafe_entry_path' });
  });

  it('rejects two entries that normalise to the same name', async () => {
    const bytes = await F.buildArchive({
      store: true,
      entries: [
        { name: 'OEBPS/a.xhtml', content: 'one' },
        { name: 'OEBPS/./a.xhtml', content: 'two' },
      ],
    });
    const filePath = await place(bytes);

    expect(await openArchive(filePath)).toEqual({ kind: 'rejected', code: 'duplicate_entry' });
  });
});

/**
 * Pins raw archiver behavior relied on by hostile-name and span fixtures; dependency
 * drift could otherwise make their attacks or arithmetic vacuous. This test file owns
 * the assertions because fixture files have no suite and the layer guard treats non-tests as production.
 */
describe('archiver 8 fixture-construction contract', () => {
  /**
   * Pins which names sanitizePath rewrites and preserves; hostile fixtures rely on
   * both halves. Inputs are append strings, never filesystem paths, so cases remain portable.
   */
  it.each([
    { name: 'a/../../b.txt', raw: 'a/../../b.txt', mode: 'mid-path traversal preserved' },
    { name: 'OEBPS/./a.xhtml', raw: 'OEBPS/./a.xhtml', mode: 'mid-path dot preserved' },
    { name: '../../etc/passwd', raw: 'etc/passwd', mode: 'leading traversal stripped' },
    { name: '/abs/x.txt', raw: 'abs/x.txt', mode: 'leading slash stripped' },
    { name: 'C:/x.txt', raw: 'x.txt', mode: 'drive letter stripped' },
    { name: 'dir\\win.txt', raw: 'dir/win.txt', mode: 'backslash normalised' },
  ])('writes $name as $raw — $mode', async ({ name, raw }) => {
    const bytes = await F.buildArchive({ store: true, entries: [{ name, content: 'hi' }] });

    expect(F.listCentralDirectory(bytes)[0]?.rawName.toString('utf8')).toBe(raw);
  });

  it('costs exactly 46 + nameLength per central-directory record', async () => {
    // The span fixture derives filler names from this record-size contract.
    const names = ['a.txt', 'OEBPS/content.opf', 'x'.repeat(200), 'META-INF/container.xml'];
    const bytes = await F.buildArchive({
      store: true,
      entries: names.map((name) => ({ name, content: 'hi' })),
    });

    const entries = F.listCentralDirectory(bytes);
    expect(entries).toHaveLength(names.length);
    for (const [index, entry] of entries.entries()) {
      expect(entry.extraLength).toBe(0);
      expect(entry.commentLength).toBe(0);
      expect(entry.nameLength).toBe(Buffer.byteLength(names[index]!));
      const next = entries[index + 1];
      if (next) expect(next.headerOffset - entry.headerOffset).toBe(46 + entry.nameLength);
    }
    const last = entries.at(-1)!;
    expect(F.eocdOffset(bytes) - last.headerOffset).toBe(46 + last.nameLength);
  });

  it('writes the archive comment verbatim into the EOCD', async () => {
    const bytes = await F.buildArchive({
      store: true,
      comment: 'HELLO-WORLD',
      entries: [{ name: 'a.txt', content: 'hi' }],
    });

    expect(bytes.readUInt16LE(F.eocdOffset(bytes) + 20)).toBe(11);
  });

  it('emits the ZIP64 sentinel and a real ZIP64 record under forceZip64', async () => {
    const bytes = await F.buildArchive({
      store: true,
      forceZip64: true,
      entries: [{ name: 'a.txt', content: 'hi' }],
    });

    expect(bytes.readUInt32LE(F.eocdOffset(bytes) + 16)).toBe(0xffffffff);
    expect(bytes.readUInt32LE(F.zip64RecordOffset(bytes))).toBe(F.ZIP64_RECORD_SIGNATURE);
  });
});

describe('bounded reads', () => {
  it('enforces the cap on the inflated stream, not on the declared size', async () => {
    // Compressible filler keeps the archive small while genuinely inflating past the cap.
    const bytes = await F.buildArchive({ entries: [{ name: 'a.txt', content: 'a'.repeat(200_000) }] });
    const central = F.listCentralDirectory(bytes)[0]!;
    const local = F.localFileHeader(bytes, 0);
    // Understate both declared sizes; compressed pull remains honest, leaving the
    // streamed counter as the only enforcement point.
    const filePath = await place(
      F.patchArchive(bytes, [
        { offset: central.headerOffset + 24, size: 4, value: 500, why: 'central uncompressedSize lie' },
        { offset: local.headerOffset + 22, size: 4, value: 500, why: 'local uncompressedSize lie' },
      ]),
    );

    const read = await withZipSource(filePath, async (session) => {
      const result = await session.preflightAndOpen();
      if (result.kind !== 'archive') throw new Error(`unexpected ${result.kind}`);
      expect(result.entries[0]?.uncompressedSize).toBe(500);
      return result.entries[0]!.read(1_000);
    });

    expect(read).toEqual({
      kind: 'failed',
      label: 'cap-exceeded',
      inflatedBytes: expect.any(Number),
    });
  });

  it('reports the bytes the counting transform observed when a read aborts on its cap', async () => {
    // STORE delivers one chunk, making the crossing count exact.
    const filePath = await place(
      await F.buildArchive({ store: true, entries: [{ name: 'a.txt', content: 'abcdefghij' }] }),
    );

    const read = await withZipSource(filePath, async (session) => {
      const result = await session.preflightAndOpen();
      if (result.kind !== 'archive') throw new Error(`unexpected ${result.kind}`);
      return result.entries[0]!.read(4);
    });

    // The cap-crossing chunk remains fully charged rather than rolled back.
    expect(read).toEqual({ kind: 'failed', label: 'cap-exceeded', inflatedBytes: 10 });
  });

  it('reads a member up to and including its cap', async () => {
    const filePath = await place(
      await F.buildArchive({ store: true, entries: [{ name: 'a.txt', content: 'abcde' }] }),
    );
    const read = await withZipSource(filePath, async (session) => {
      const result = await session.preflightAndOpen();
      if (result.kind !== 'archive') throw new Error(`unexpected ${result.kind}`);
      return result.entries[0]!.read(5);
    });

    expect(read).toEqual({ kind: 'bytes', bytes: Buffer.from('abcde') });
  });

  it('surfaces File.flags unchanged without interpreting them', async () => {
    const filePath = await place(
      await F.buildArchive({ store: true, entries: [{ name: 'a.txt', content: 'hi' }] }),
    );
    const [ours, theirs] = await Promise.all([
      withZipSource(filePath, async (session) => {
        const result = await session.preflightAndOpen();
        return result.kind === 'archive' ? result.entries.map((entry) => entry.flags) : [];
      }),
      h.real.Open.file(filePath).then((directory) => directory.files.map((file) => file.flags)),
    ]);

    expect(ours).toEqual(theirs);
  });

  it('never calls File.buffer() anywhere in src/core/epub/', async () => {
    // Strip comments so the ban applies to calls, not this module's rationale.
    const sources = await scanProductionSources(import.meta.dirname, { stripComments: true });

    expect(sources.filter(({ code }) => /\.buffer\s*\(/.test(code)).map(({ file }) => file)).toEqual(
      [],
    );
  });
});

describe('error classification', () => {
  const THROWN: Array<[string, unknown]> = [
    ['EACCES', errno('EACCES')],
    ['EIO', errno('EIO')],
    ['ESTALE', errno('ESTALE')],
    ['EMFILE', errno('EMFILE')],
    ['ENOENT', errno('ENOENT')],
    ['the undocumented ETIMEDOUT', errno('ETIMEDOUT')],
    ['the undocumented ENODEV', errno('ENODEV')],
    ['the undocumented EREMOTEIO', errno('EREMOTEIO')],
    ['a TypeError', new TypeError('our own defect')],
  ];

  const REPORTED: Array<[string, unknown]> = [
    ['Z_DATA_ERROR', errno('Z_DATA_ERROR')],
    ['ERR_ZLIB_BINDING_CLOSED', errno('ERR_ZLIB_BINDING_CLOSED')],
    ['an uncoded parse error', new Error('unparseable')],
    // unzipper surfaces these as uncoded archive-read Errors.
    ['unzippers FILE_ENDED', new Error('FILE_ENDED')],
    ['unzippers MISSING_PASSWORD', new Error('MISSING_PASSWORD')],
  ];

  async function archive(): Promise<string> {
    return place(await F.buildArchive({ store: true, entries: [{ name: 'a.txt', content: 'hi' }] }));
  }

  it.each(THROWN)('propagates %s from Open.custom()', async (_label, value) => {
    const filePath = await archive();
    h.openCustom.mockRejectedValueOnce(value);
    await expect(openArchive(filePath)).rejects.toBe(value);
  });

  it.each(REPORTED)('reports %s from Open.custom() as a decoder failure', async (_label, value) => {
    const filePath = await archive();
    h.openCustom.mockRejectedValueOnce(value);
    expect(await openArchive(filePath)).toEqual({ kind: 'failed', label: 'decoder-failure' });
  });

  /**
   * File.stream returns a Readable, so failures must emit; a rejected mock promise
   * would only exercise a missing-pipe TypeError.
   */
  function withErroringEntry(value: unknown): void {
    h.openCustom.mockResolvedValueOnce({
      files: [
        {
          pathBuffer: Buffer.from('a.txt'),
          flags: 0,
          uncompressedSize: 2,
          stream: () => erroringStream(value),
        },
      ],
    });
  }

  async function readFirst(filePath: string): Promise<unknown> {
    return withZipSource(filePath, async (session) => {
      const result = await session.preflightAndOpen();
      if (result.kind !== 'archive') throw new Error(`unexpected ${result.kind}`);
      return result.entries[0]!.read(1024);
    });
  }

  it.each(THROWN)('propagates %s from File.stream()', async (_label, value) => {
    const filePath = await archive();
    withErroringEntry(value);
    await expect(readFirst(filePath)).rejects.toBe(value);
  });

  it.each(REPORTED)('reports %s from File.stream() as a decoder failure', async (_label, value) => {
    const filePath = await archive();
    withErroringEntry(value);
    expect(await readFirst(filePath)).toEqual({
      kind: 'failed',
      label: 'decoder-failure',
      inflatedBytes: 0,
    });
  });
});

describe('adapter-owned OS failures', () => {
  it('propagates an fs.open() rejection without running the callback or closing', async () => {
    const failure = errno('EACCES');
    h.fsOpen.mockRejectedValueOnce(failure);
    const callback = vi.fn();

    await expect(withZipSource('/nowhere.epub', callback)).rejects.toBe(failure);
    expect(callback).not.toHaveBeenCalled();
    expect(h.handles).toEqual([]);
  });

  it('propagates an fh.stat() rejection and still closes the handle exactly once', async () => {
    const filePath = await place(await F.buildArchive({ entries: [{ name: 'a.txt', content: 'hi' }] }));
    const failure = errno('EIO');
    const callback = vi.fn();
    h.onStat = () => Promise.reject(failure);

    await expect(withZipSource(filePath, callback)).rejects.toBe(failure);
    expect(callback).not.toHaveBeenCalled();
    expect(h.handles).toHaveLength(1);
    expect(h.handles[0]?.closes).toBe(1);
  });

  it('forwards an in-flight fh.read() rejection onto the stream and closes once', async () => {
    const filePath = await place(Buffer.alloc(512 * 1024, 9));
    const failure = errno('EIO');
    let reads = 0;

    const observed = await withZipSource(filePath, async (session) => {
      h.onRead = async (raw, args) => {
        reads += 1;
        if (reads > 1) throw failure;
        return raw.read(...args);
      };
      const stream = session.source.stream(0);
      return drain(stream).catch((error: unknown) => error);
    });

    expect(observed).toBe(failure);
    expect(h.handles).toHaveLength(1);
    expect(h.handles[0]?.closes).toBe(1);
  });

  it('reconstructs complete bytes across repeated partial successful reads', async () => {
    // FileHandle.read may return a successful partial buffer; all pieces must be reassembled.
    const bytes = await F.buildArchive({
      store: true,
      forceZip64: true,
      entries: [
        { name: 'a.txt', content: 'abcdefghijklmnopqrstuvwxyz' },
        { name: 'b.txt', content: 'second' },
      ],
      comment: 'c'.repeat(300),
    });
    const filePath = await place(bytes);
    h.onRead = async (raw, [buffer, offset, length, position]) =>
      raw.read(buffer, offset, Math.min(length, 7), position);

    const read = await withZipSource(filePath, async (session) => {
      expect(Buffer.concat(await drain(session.source.stream(0)))).toEqual(bytes);
      const result = await session.preflightAndOpen();
      if (result.kind !== 'archive') throw new Error(`unexpected ${result.kind}`);
      expect(result.entries.map((entry) => entry.name)).toEqual(['a.txt', 'b.txt']);
      return result.entries[0]!.read(1024);
    });

    expect(read).toEqual({ kind: 'bytes', bytes: Buffer.from('abcdefghijklmnopqrstuvwxyz') });
    expect(h.reads.every((record) => record.bytesRead <= 7)).toBe(true);
  });

  /**
   * Shrinks through a second descriptor so the frozen size exceeds real EOF and
   * fh.read genuinely returns zero.
   */
  async function truncateUnderneath(filePath: string, to: number): Promise<void> {
    const shrinker = await h.real.fsOpen(filePath, 'r+');
    await shrinker.truncate(to);
    await shrinker.close();
  }

  /**
   * Converts a missing zero-byte termination into a fast failure instead of a hung suite.
   */
  function guardAgainstLooping(limit: number): void {
    let reads = 0;
    h.onRead = async (raw, args) => {
      reads += 1;
      if (reads > limit) throw errno('EPUB_TEST_READ_LOOP');
      return raw.read(...args);
    };
  }

  it('ends a live stream on a zero-byte read at true EOF, without looping or padding', async () => {
    const body = Buffer.from('0123456789'.repeat(10));
    const filePath = await place(body);

    const observed = await withZipSource(filePath, async (session) => {
      expect(await session.source.size()).toBe(100);
      guardAgainstLooping(50);
      await truncateUnderneath(filePath, 40);
      return Buffer.concat(await drain(session.source.stream(0)));
    });

    // Return only surviving bytes, never the uninitialized buffer tail.
    expect(observed).toEqual(body.subarray(0, 40));
    expect(h.reads.filter((read) => read.bytesRead === 0)).toHaveLength(1);
    expect(h.reads).toHaveLength(2);
  });

  it('ends a preflight range read on a zero-byte result at true EOF', async () => {
    const bytes = await F.buildArchive({ store: true, entries: [{ name: 'a.txt', content: 'hi' }] });
    const filePath = await place(bytes);

    const result = await withZipSource(filePath, async (session) => {
      expect(session.stat.size).toBe(bytes.length);
      guardAgainstLooping(50);
      // Truncate before EOCD so acquisition cannot fill its frozen window.
      await truncateUnderneath(filePath, 20);
      return session.preflightAndOpen();
    });

    expect(result).toEqual({ kind: 'rejected', code: 'truncated' });
    expect(h.reads.filter((read) => read.bytesRead === 0)).toHaveLength(1);
    expect(h.openCustom).not.toHaveBeenCalled();
  });
});

describe('the internal-only surface', () => {
  // This raw scan includes comments; outside documentation must name the folder, not this module.
  it('is imported by no module outside src/core/epub/', async () => {
    const root = path.resolve(import.meta.dirname, '../..');
    // Scan all src tests and comments; prune only the segment-exact epub directory.
    const sources = await scanSources({
      root,
      extensions: ['.ts', '.tsx'],
      includeTests: true,
      excludeDirs: [path.join(root, 'core', 'epub')],
    });

    const offenders = sources.filter(({ code }) => /zip-source/.test(code)).map(({ file }) => file);
    expect(offenders).toEqual([]);
  });
});
