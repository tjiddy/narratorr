import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';
import { once } from 'node:events';
import path from 'node:path';
import type { FileHandle } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import * as F from '../__tests__/epub-archive.fixture.js';
import { classifyEpubReadError } from './errors.js';
import { MAX_ARCHIVE_ENTRIES, MAX_CENTRAL_DIRECTORY_BYTES } from './limits.js';
import type { ZipArchiveResult, ZipSourceSession } from './zip-source.js';
import { withZipSource, ZipSourceProtocolError } from './zip-source.js';

/**
 * Both boundaries are mocked at the OS / library edge — `node:fs/promises` and
 * `unzipper` — never by stubbing this module's own exports: `zip-source.ts`
 * calls its own helpers through local bindings, so a `vi.mock` factory
 * overriding those exports would not intercept the internal calls, and adding
 * `__internal` indirection to production code to make it mockable is exactly the
 * shape to avoid.
 *
 * Both mocks **delegate to the real implementation by default**, so the great
 * majority of rows below are genuine end-to-end runs against real files and the
 * pinned reader. The spies exist to answer questions no black-box assertion can
 * — was `Open.custom()` reached at all, which reads happened before it, which
 * `stream()` calls were served from the replay queue.
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
  /** Fires after the preflight, immediately before the pinned reader runs. */
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

/** Only the three members production uses are forwarded; everything else is absent by design. */
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

/**
 * Replace the session's `stream` with a recording wrapper. This is the same
 * object the module hands `Open.custom`, so every reader call is observed.
 */
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

/** A readable that emits `value` on its `error` event, the shape `File.stream()` really has. */
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

/** Names as this module reports them, or the rejection/failure verbatim. */
async function namesOf(filePath: string): Promise<string[] | ZipArchiveResult> {
  const result = await openArchive(filePath);
  return result.kind === 'archive' ? result.entries.map((entry) => entry.name) : result;
}

beforeAll(async () => {
  dir = await F.createArchiveDir();
  // The only heavyweight fixtures in this suite: built once and shared. A
  // patched-down declaration cannot substitute — the reader would pull 10,000
  // records from a shorter stream and fail with FILE_ENDED.
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

// ---------------------------------------------------------------------------

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
      // A 1-byte cap aborts the counting transform mid-entry, which destroys the
      // entry stream — the exact `req.destroy()` shape at `Open/unzip.js:100-108`.
      expect(await result.entries[0]?.read(1)).toEqual({
        kind: 'failed',
        label: 'cap-exceeded',
        // Chunked by the positional source, so the exact crossing chunk is a
        // stream-plumbing detail; the dedicated row below pins the value.
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
    // A stream created inside the callback and left un-drained is the case the
    // post-close `stream()` guard cannot reach: the object already exists, so
    // only session teardown can stop it. Without that, a pending positional read
    // wakes up on a closed descriptor after the session is gone.
    const body = Buffer.alloc(512 * 1024, 5);
    const filePath = await place(body);

    const escaped = await withZipSource(filePath, (session) =>
      // Deliberately not consumed: `_read` has not run, so nothing is in flight
      // and nothing but teardown will ever end it.
      Promise.resolve(session.source.stream(0)),
    );

    expect(escaped.destroyed).toBe(true);

    // And it stays inert: resuming it after teardown yields no bytes, no error,
    // and no read against the closed handle.
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
    // This is why the positional form exists. `unzipper` destroys every bounded
    // range stream it creates (`Open/unzip.js:100-108` calls `req.destroy()` on
    // every entry `finish`), and a `FileHandle`-backed `createReadStream` closes
    // its handle on destroy — leaving `fh.fd = -1` and every later read dead.
    const filePath = await place(Buffer.from('0123456789abcdefghij'));
    const raw = await h.real.fsOpen(filePath, 'r');
    const stream = raw.createReadStream({ start: 0, end: 3 });
    await drain(stream);
    stream.destroy();
    await once(stream, 'close');

    expect(raw.fd).toBe(-1);
    await expect(raw.read(Buffer.alloc(4), 0, 4, 0)).rejects.toThrow(/closed/);

    // The positional form, on the same shape of operation, does not.
    await withZipSource(filePath, async (session) => {
      const first = session.source.stream(0, 4);
      await drain(first);
      first.destroy();
      expect(await drain(session.source.stream(4, 4))).toEqual([Buffer.from('4567')]);
    });
  });
});

// ---------------------------------------------------------------------------

describe('the stream() contract', () => {
  const body = Buffer.from('0123456789abcdefghij'); // 20 bytes

  it('serves stream(offset) with no length to end of file', async () => {
    const filePath = await place(body);
    await withZipSource(filePath, async (session) => {
      expect(Buffer.concat(await drain(session.source.stream(12)))).toEqual(Buffer.from('cdefghij'));
    });
  });

  it('clamps an overrunning stream(offset, length) instead of throwing', async () => {
    const filePath = await place(body);
    await withZipSource(filePath, async (session) => {
      // The last-entry overrun shape from `directory.js:222-228`.
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
      // The frozen size also clamps the reads derived from it.
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
    // The hook is installed after the one legitimate stat, so any *further*
    // stat would land on the spy.
    expect(statSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------

describe('validated structural replay', () => {
  /** Rewrite bytes in place through a *second* descriptor, as a live attacker would. */
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
    // A *small* forged delta on purpose: this row runs against the real reader,
    // and it fails safe — an unprotected implementation reads 2, runs off the
    // end of the central directory, and fails with FILE_ENDED rather than
    // allocating. The 500,000,000 forgery is never handed to the real reader.
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

  // Small forged deltas again, for the same reason: these rows run against the
  // real reader, so an unprotected implementation must fail *safe* — a bogus
  // record offset and a count of 2 both end in FILE_ENDED, where a huge count
  // would allocate and take the test process down instead.
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
    // Every queue-served call performs no fh.read at all; the first live call is
    // the central directory, immediately after the queue empties.
    expect(postOpen.filter((read) => read.streamCall < queued)).toEqual([]);
    expect(postOpen.some((read) => read.streamCall === queued)).toBe(true);
    expect(calls.length).toBeGreaterThan(queued);
  });

  it('serves the empty archive twice at offset 0 — once queued, once live', async () => {
    // The degenerate layout: EOCD at 0 and offsetToStartOfCentralDirectory at 0,
    // so consumption and not offset identity has to control replay.
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
        // A hard failure, never a silent live read.
        expect(h.reads).toHaveLength(before);
      };
      const result = await session.preflightAndOpen();
      return { thrown, result };
    });

    expect(outcome.thrown).toBeInstanceOf(ZipSourceProtocolError);
    expect(outcome.thrown).toBeInstanceOf(TypeError);
    // The head was not consumed, so the reader still got its validated tail.
    expect(outcome.result.kind).toBe('archive');
  });
});

// ---------------------------------------------------------------------------

describe('replay scope — the central directory and payloads stay live', () => {
  async function rewriteBytes(filePath: string, offset: number, replacement: Buffer): Promise<void> {
    const handle = await h.real.fsOpen(filePath, 'r+');
    await handle.write(replacement, 0, replacement.length, offset);
    await handle.close();
  }

  it('observes a same-length central-directory rename applied after the preflight', async () => {
    const bytes = await F.buildArchive({ store: true, entries: [{ name: 'a.xhtml', content: 'hi' }] });
    // Deliberately sub-65,557 bytes: the whole file is inside the acquisition
    // window, so an offset-covered replay rule would silently swallow this.
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
      // fileNameLength at +28 — the reader pulls that many bytes and runs out.
      await handle.write(buffer, 0, 2, headerOffset + 28);
      await handle.close();
    };

    expect(await openArchive(filePath)).toEqual({ kind: 'failed', label: 'decoder-failure' });
  });
});

// ---------------------------------------------------------------------------

describe('replay boundary — structures straddling the acquisition window', () => {
  /**
   * `T = size - 65557` is where the acquisition window starts. A 65,525-byte
   * comment puts the 20-byte locator across `[T - 10, T + 10)`; a 65,480-byte
   * comment puts the 56-byte record across `[T - 21, T + 35)`. Both are
   * conformant containers.
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
    // Precondition: the fixture really has the straddling geometry the row claims.
    expect(structureOffset - windowStart).toBe(delta);

    const validated = Buffer.from(
      bytes.subarray(structureOffset, structureOffset + (which === 'locator' ? 20 : 56)),
    );
    const filePath = await place(bytes);

    // Mutate the straddling structure after the preflight; it must not be observed.
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

    // The replayed bytes are byte-for-byte the ones the preflight validated.
    expect(Buffer.concat(calls)).toEqual(validated);
  });

  it('reads each preflight byte at most once, as pairwise-disjoint intervals', async () => {
    // The oracle is intervals, not start offsets: on the locator straddle a
    // scratch read from T covers [T, size) while a wrong full locator read from
    // T - 10 covers [T - 10, T + 10) — different starts, overlapping bytes.
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

    // Byte-for-byte what the preflight accepted, for all three queue entries.
    for (const [offset, expected] of validated) {
      expect(Buffer.concat(served.get(offset) ?? [])).toEqual(expected);
    }
    // And not one of those three reached the handle: the first live read belongs
    // to the central directory, stream call 3.
    expect(h.reads.filter((read) => !read.preOpen && read.streamCall < 3)).toEqual([]);
    expect(h.reads.some((read) => !read.preOpen && read.streamCall === 3)).toBe(true);
  });
});

// ---------------------------------------------------------------------------

describe('EOCD candidate selection', () => {
  it.each([
    ['no comment', ''],
    ['a 100-byte comment', 'c'.repeat(100)],
    ['a 60,000-byte comment', 'c'.repeat(60_000)],
    // The exact legal maximum behind the 65,557-byte tail constant, so an
    // off-by-one tail cannot pass every positive.
    ['a 65,535-byte comment', 'c'.repeat(65_535)],
    ['a comment containing a planted PK\\x05\\x06', `${'c'.repeat(40)}\x50\x4b\x05\x06${'c'.repeat(56)}`],
  ])('opens an archive with %s', async (label, comment) => {
    const bytes = await F.buildArchive({ entries: [{ name: 'a.txt', content: 'hi' }], comment });
    const eocd = F.eocdOffset(bytes);
    expect(bytes.readUInt16LE(eocd + 20)).toBe(comment.length);
    if (label.includes('planted')) {
      // Precondition: the decoy really is in the file, *after* the real EOCD, so
      // a backward scan meets it first and has to reject it on the length rule.
      expect(bytes.lastIndexOf(F.EOCD_SIGNATURE)).toBe(eocd + 62);
    }
    const filePath = await place(bytes);

    expect(await namesOf(filePath)).toEqual(['a.txt']);

    if (comment.length > 0) {
      // Pin the regression rather than assume it: the reader's previous 80-byte
      // tail default (`directory.js:83`) would have failed this very fixture.
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

    // Explicitly the frozen structural result, and explicitly not a RangeError.
    expect(await openArchive(filePath)).toEqual({ kind: 'rejected', code: 'truncated' });
    expect(h.openCustom).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------

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
    // This exact fixture OOM-kills the process when passed to a bare
    // `Open.file()` — a 213-byte file, ~31 s, a 1 GiB heap cap, dead. Never
    // "simplify" this row into calling the reader directly.
    //
    // Which is also why the half-billion count only ever appears behind a stub:
    // if the pre-open ceiling regresses, this row must fail with a clean
    // assertion, not by taking the worker down with it.
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
    // One trigger at a time — the contract is an OR across three independent
    // fields, and an erroneous AND or a missing arm still passes a fixture that
    // sets all three (which is exactly what the pinned writer emits).
    //
    // Each row carries a *valid* ZIP64 locator and record, so taking the branch
    // opens the archive. Not taking it cannot: on the ZIP32 branch a lone
    // `diskNumber = 0xffff` is a split declaration, a lone
    // `numberOfRecords = 0xffff` disagrees with the on-disk count, and a lone
    // `0xffffffff` central-directory offset seeks past EOF.
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

    // Precondition: exactly one of the three triggers is set.
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

    // The locator at eocdOffset - 20 was requested, and served from the
    // validated replay queue rather than live — so our preflight took the branch
    // too, not just the reader.
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
      // Read as a legacy offset, 0xfffffffe is far past the EOCD, so the span
      // check (#2025) answers `truncated` structurally. Before that check it
      // reached the reader, which seeked past EOF and reported
      // `decoder-failure`; same verdict for the book, one phase earlier and
      // without opening the archive.
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
    // Distinct from the row above: the safe-integer rule has to fire BEFORE any
    // `Number(...)` conversion, which a range check alone would not prove.
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
    // 76 bytes of locator plus record cannot precede an EOCD at offset 0, and
    // the rejection happens before any out-of-range read is attempted.
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
    // Precondition: the fixture really carries a ZIP64 locator and record.
    expect(bytes.readUInt32LE(F.zip64LocatorOffset(bytes))).toBe(F.ZIP64_LOCATOR_SIGNATURE);
    expect(bytes.readUInt32LE(F.zip64RecordOffset(bytes))).toBe(F.ZIP64_RECORD_SIGNATURE);
    const filePath = await place(bytes);

    expect(await namesOf(filePath)).toEqual(['mimetype', 'OEBPS/a.xhtml']);
  });
});

// ---------------------------------------------------------------------------

describe('the entry-count ceiling', () => {
  it(`opens an archive declaring and holding exactly ${MAX_ARCHIVE_ENTRIES} members`, async () => {
    const result = await openArchive(manyAtCeiling);
    // The ceiling is `>`, not `>=`.
    expect(result.kind).toBe('archive');
    if (result.kind === 'archive') expect(result.entries).toHaveLength(MAX_ARCHIVE_ENTRIES);
  });

  it('rejects one member above the ceiling pre-open', async () => {
    expect(await openArchive(manyOverCeiling)).toEqual({ kind: 'rejected', code: 'limit_exceeded' });
    expect(h.openCustom).not.toHaveBeenCalled();
  });

  it('pins that files.length follows the declaration, not the archive', async () => {
    // Why the post-open check is a defensive equality assertion and nothing more:
    // `vars.files` is `Array(vars.numberOfRecords)` by construction
    // (`directory.js:185`), so a patched-down declaration yields exactly that many.
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
    // The guard's whole purpose is a reader-version change, and the pinned
    // reader cannot express the disagreement — `vars.files` is
    // `Array(vars.numberOfRecords)` by construction. So the only way to give the
    // failure arm a regression signal is to stub the reader with a cardinality
    // the preflight did not validate.
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
    // The identity is load-bearing, not free choice: a plain uncoded Error here
    // would be labelled `decoder-failure` and persisted as "this book is
    // corrupt" instead of surfacing the dependency drift.
    expect(classifyEpubReadError(thrown, { archiveRead: true })).toBe('throw');
    expect(h.handles).toHaveLength(1);
    expect(h.handles[0]?.closes).toBe(1);
  });
});

// ---------------------------------------------------------------------------

describe('the central-directory span ceiling', () => {
  /** Long names, few entries: the span is tripped in isolation, far under the entry ceiling. */
  const SPAN_FIXTURE_ENTRIES = 150;
  const CAP = MAX_CENTRAL_DIRECTORY_BYTES;

  /** span === CAP exactly. */
  let atCap: string;
  /** span === CAP + 1, built genuinely — one more byte of filename, not a patched offset. */
  let overCap: string;
  /** The `atCap` central directory under a forged ZIP64 tail: span === CAP + 76. */
  let zip64OverCap: string;

  beforeAll(async () => {
    // The only heavyweight fixtures in this section, built once and shared: an
    // 8 MiB span is a ~17 MB temp file and cannot be smaller. `span ≤ eocdOffset
    // ≤ fileSize`, so unlike a declared *count* an over-cap span has no 213-byte
    // analogue — the bytes have to exist.
    const atCapBytes = await F.buildArchiveWithCentralDirectorySpan({
      span: CAP,
      filler: SPAN_FIXTURE_ENTRIES,
    });
    const overCapBytes = await F.buildArchiveWithCentralDirectorySpan({
      span: CAP + 1,
      filler: SPAN_FIXTURE_ENTRIES,
    });
    const forged = F.forgeZip64Tail(atCapBytes, { declaredRecords: BigInt(SPAN_FIXTURE_ENTRIES) });
    // Precondition for the parity row: the forged tail splices exactly the
    // 56-byte record and 20-byte locator into the capped pre-EOCD envelope.
    expect(F.centralDirectorySpan(forged)).toBe(CAP + 76);

    atCap = await place(atCapBytes);
    overCap = await place(overCapBytes);
    zip64OverCap = await place(forged);
  });

  it('rejects a central directory one byte over the cap, without calling the reader', async () => {
    // The motivating case, and the upper half of the boundary: this file differs
    // from the accepted one below by a single byte of filename.
    //
    // Measured through the production path — `withZipSource` →
    // `preflightAndOpen()` → `normalizeEntries`, holding the returned entries
    // live, `heapUsed + external` after a forced GC, one fresh process per point
    // — retention tracks this span linearly at **2.06–2.39×** (4.3 MiB span →
    // 9.2 MiB; 17.2 MiB span → 35.4 MiB). Uncapped, a ~112–128 MiB span fits
    // inside the 256 MiB file ceiling, which is ~230–305 MiB per reader and
    // ~0.9–1.2 GiB across the four concurrent reconciler slots. The four-slot
    // process death is an extrapolation along that measured slope, not a crash
    // that was watched; the proportionality is what was measured.
    expect(await openArchive(overCap)).toEqual({ kind: 'rejected', code: 'limit_exceeded' });
    expect(h.openCustom).not.toHaveBeenCalled();
  });

  it('opens an archive whose central directory sits exactly at the cap', async () => {
    // The ceiling is `>`, not `>=`.
    const result = await openArchive(atCap);

    expect(result.kind).toBe('archive');
    if (result.kind === 'archive') expect(result.entries).toHaveLength(SPAN_FIXTURE_ENTRIES);
  });

  it('accepts a span of exactly zero', async () => {
    // The `< 0` versus `<= 0` regression guard. The empty archive is the
    // degenerate layout — EOCD at 0 and central directory at 0 — and it reached
    // the reader before this ceiling existed, so it still must.
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
    // Precedence: structure is validated before either resource ceiling, so a
    // strictly negative span is `truncated` regardless of the count.
    //
    // Both count fields are patched to the *same* over-ceiling value on purpose.
    // `preflight` requires `recordsOnDisk === numberOfRecords` before it reaches
    // any ceiling, so patching +10 alone would return `truncated` for a
    // structural count mismatch and would pass just as happily against a
    // count-first implementation — proving nothing about the ordering.
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
    // The row that fails if only the legacy path is capped. These are the very
    // bytes accepted at the cap above; the forged tail pushes the envelope 76
    // bytes over, and the ZIP64 branch has to read its own central-directory
    // offset out of the record to see it — the legacy field is the 0xffffffff
    // sentinel here, which would compute a wildly negative span and answer
    // `truncated` instead.
    expect(await openArchive(zip64OverCap)).toEqual({ kind: 'rejected', code: 'limit_exceeded' });
    expect(h.openCustom).not.toHaveBeenCalled();
  });

  it('leaves a conformant archive at the entry ceiling far under the cap', async () => {
    // Why the cap cannot go much lower: `MAX_ARCHIVE_ENTRIES` already allows
    // 10,000 members, and a conformant book at that ceiling with 100-char names
    // spans 1.57 MiB — so a 1 MiB cap would reject a legitimate archive. That
    // this fixture still opens is pinned by the entry-ceiling section above.
    const { readFile } = await import('node:fs/promises');

    expect(F.centralDirectorySpan(await readFile(manyAtCeiling))).toBeLessThan(CAP);
  });
});

// ---------------------------------------------------------------------------

describe('entry-name handling', () => {
  it('rejects an invalid UTF-8 central-directory name as unsafe_entry_path', async () => {
    const bytes = await F.buildArchive({ store: true, entries: [{ name: 'abcd', content: 'hi' }] });
    const hostile = Buffer.from([0x61, 0xff, 0xfe, 0x62]);
    const patched = F.patchEntryName(bytes, 0, hostile);
    // Precondition on the raw bytes, before invoking anything.
    expect(F.listCentralDirectory(patched)[0]?.rawName).toEqual(hostile);
    const filePath = await place(patched);

    expect(await openArchive(filePath)).toEqual({ kind: 'rejected', code: 'unsafe_entry_path' });

    // And this is the decoder we are refusing to trust: unzipper's own
    // non-fatal `File.path` substitutes U+FFFD rather than rejecting.
    const directory = await h.real.Open.file(filePath);
    expect(directory.files[0]?.path).toContain('�');
  });

  it('rejects a byte-patched leading-traversal name', async () => {
    // `archiver-utils@5.0.2` rewrites `../../etc/passwd` to `etc/passwd` on the
    // way in, so this name only exists in the archive by byte patching.
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

// ---------------------------------------------------------------------------

describe('bounded reads', () => {
  it('enforces the cap on the inflated stream, not on the declared size', async () => {
    // Highly compressible filler so the fixture stays small while genuinely
    // inflating past the cap.
    const bytes = await F.buildArchive({ entries: [{ name: 'a.txt', content: 'a'.repeat(200_000) }] });
    const central = F.listCentralDirectory(bytes)[0]!;
    const local = F.localFileHeader(bytes, 0);
    // uncompressedSize at central +24 and local +22, understated in both. The
    // reader bounds the *compressed* pull by the honest `compressedSize` and
    // lets central-directory vars override the local header
    // (`Open/unzip.js:44`, `:87`), so this changes nothing the reader does —
    // the streamed counter is the only thing that fires.
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
    // STORE, so the whole member arrives in one chunk and the count is exact.
    const filePath = await place(
      await F.buildArchive({ store: true, entries: [{ name: 'a.txt', content: 'abcdefghij' }] }),
    );

    const read = await withZipSource(filePath, async (session) => {
      const result = await session.preflightAndOpen();
      if (result.kind !== 'archive') throw new Error(`unexpected ${result.kind}`);
      return result.entries[0]!.read(4);
    });

    // The 10-byte chunk crossed the 4-byte cap and every byte of it is reported,
    // not discarded. 1.1e charges exactly this against its shared inspection
    // budget and never rolls it back, so a `failed` arm reporting nothing would
    // silently forgive the inflation that already happened.
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
    const { readdir, readFile } = await import('node:fs/promises');
    const files = (await readdir(import.meta.dirname, { recursive: true })).filter(
      (entry) => entry.endsWith('.ts') && !entry.endsWith('.test.ts'),
    );
    const sources = await Promise.all(
      files.map(async (file) => ({
        file,
        // Comments are stripped first: this very module documents *why*
        // `File.buffer()` is never called, and the prose must not trip the scan.
        code: (await readFile(path.join(import.meta.dirname, file), 'utf8'))
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/\/\/.*$/gm, ''),
      })),
    );
    expect(sources.filter(({ code }) => /\.buffer\s*\(/.test(code)).map(({ file }) => file)).toEqual(
      [],
    );
  });
});

// ---------------------------------------------------------------------------

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
    // unzipper's own uncoded errors reach us as plain archive-read `Error`s.
    ['unzippers FILE_ENDED', new Error('FILE_ENDED')],
    ['unzippers MISSING_PASSWORD', new Error('MISSING_PASSWORD')],
  ];

  async function archive(): Promise<string> {
    return place(await F.buildArchive({ store: true, entries: [{ name: 'a.txt', content: 'hi' }] }));
  }

  it.each(THROWN)('propagates %s from Open.custom()', async (_label, value) => {
    const filePath = await archive();
    // `Open.custom()` returns a promise, so a rejection is the right shape here.
    h.openCustom.mockRejectedValueOnce(value);
    await expect(openArchive(filePath)).rejects.toBe(value);
  });

  it.each(REPORTED)('reports %s from Open.custom() as a decoder failure', async (_label, value) => {
    const filePath = await archive();
    h.openCustom.mockRejectedValueOnce(value);
    expect(await openArchive(filePath)).toEqual({ kind: 'failed', label: 'decoder-failure' });
  });

  /**
   * `File.stream()` returns a `Readable`, not a promise
   * (`@types/unzipper@0.10.11/index.d.ts:111`), so `mockRejectedValueOnce` would
   * hand production code a promise and produce a `TypeError` on the missing
   * `.pipe()` instead of exercising stream-error classification. These rows
   * return a readable that *emits*.
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
    // The stream fails before a byte is inflated, so nothing is charged.
    expect(await readFirst(filePath)).toEqual({
      kind: 'failed',
      label: 'decoder-failure',
      inflatedBytes: 0,
    });
  });
});

// ---------------------------------------------------------------------------

describe('adapter-owned OS failures', () => {
  it('propagates an fs.open() rejection without running the callback or closing', async () => {
    const failure = errno('EACCES');
    h.fsOpen.mockRejectedValueOnce(failure);
    const callback = vi.fn();

    await expect(withZipSource('/nowhere.epub', callback)).rejects.toBe(failure);
    expect(callback).not.toHaveBeenCalled();
    // Nothing was acquired, so nothing is closed.
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
    // `FileHandle.read()` reports `bytesRead` and never promises to fill the
    // buffer. A one-read-per-chunk implementation silently truncates the EOCD
    // window or a retained locator.
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
      // Several smaller nonzero pieces, then zero only at true EOF.
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
    // The companion arm — an actual zero-byte result — is covered by the two
    // early-EOF rows below; clamping to the frozen size means this fixture's
    // ranges always end exactly on data.
  });

  /**
   * Shrink the file underneath the frozen size through a second descriptor, so
   * a range the source still believes in now runs past true EOF and `fh.read`
   * genuinely returns `bytesRead === 0`. Nothing here is mocked: the divergence
   * is real, which is the only way to prove the termination branches fire.
   */
  async function truncateUnderneath(filePath: string, to: number): Promise<void> {
    const shrinker = await h.real.fsOpen(filePath, 'r+');
    await shrinker.truncate(to);
    await shrinker.close();
  }

  /**
   * Turns a missing `bytesRead === 0` break into a fast, clean assertion failure
   * instead of a suite-timeout hang — a loop that never terminates is exactly
   * the regression these rows exist to catch.
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

    // Exactly the surviving bytes — never the uninitialised tail of the scratch
    // buffer, which a `push(chunk)` instead of `push(chunk.subarray(0, n))`
    // would leak, and never a hang on the zero-byte result.
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
      // Well short of the EOCD, so the acquisition window can never be filled.
      await truncateUnderneath(filePath, 20);
      return session.preflightAndOpen();
    });

    // `readRange` returns the 20 bytes it actually got rather than a full-length
    // buffer, so no candidate can satisfy the frozen size and the outcome is the
    // frozen structural code — reached, not hung.
    expect(result).toEqual({ kind: 'rejected', code: 'truncated' });
    expect(h.reads.filter((read) => read.bytesRead === 0)).toHaveLength(1);
    expect(h.openCustom).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------

describe('the internal-only surface', () => {
  // This is a raw full-text scan, not an import parser, and it does not strip comments — so a
  // prose mention of this module's name in any file outside src/core/epub/ fails it, and only a
  // full-suite run reveals which one. When documenting a relationship to this module from
  // outside the folder, name the folder ("the `src/core/epub/` suites"), not the module.
  it('is imported by no module outside src/core/epub/', async () => {
    const { readdir, readFile } = await import('node:fs/promises');
    const root = path.resolve(import.meta.dirname, '../..');
    const epubDir = path.join(root, 'core', 'epub');
    const entries = await readdir(root, { recursive: true });
    const candidates = entries
      .map((entry) => path.join(root, entry))
      .filter((file) => /\.tsx?$/.test(file) && !file.startsWith(epubDir));

    const offenders: string[] = [];
    for (const file of candidates) {
      if (/zip-source/.test(await readFile(file, 'utf8'))) offenders.push(path.relative(root, file));
    }
    expect(offenders).toEqual([]);
  });
});
