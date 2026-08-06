import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { FastifyBaseLogger } from 'fastify';

/**
 * AC6 — the I/O half of the OPF reader.
 *
 * Uses the `fs-spy-over-importactual` pattern: `node:fs/promises` is partially mocked and the two
 * spied functions are defaulted to the REAL implementations in `beforeEach`, so the happy-path test
 * runs against a genuine tmpdir while each failure case injects one errno. Every fixture/assertion
 * call goes through the `actualFs` handle, never the imported binding — an armed
 * `mockImplementationOnce` rejection meant for the code under test must not be consumed by the test's
 * own setup.
 */
const actualFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');

vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal() as Record<string, unknown>),
  readFile: vi.fn(),
  stat: vi.fn(),
}));

const { readFile, stat } = await import('node:fs/promises');
const { readOpfMetadata, MAX_OPF_BYTES } = await import('./opf-reader.js');

function makeLog(): FastifyBaseLogger {
  return {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    fatal: vi.fn(), trace: vi.fn(), child: vi.fn().mockReturnThis(),
    silent: vi.fn(), level: 'info',
  } as unknown as FastifyBaseLogger;
}

const errno = (code: string): NodeJS.ErrnoException =>
  Object.assign(new Error(code), { code }) as NodeJS.ErrnoException;

const OPF = [
  '<?xml version="1.0" encoding="utf-8"?>',
  '<package version="2.0"><metadata><dc:title>On Disk</dc:title></metadata></package>',
].join('\n');

describe('readOpfMetadata (AC6)', () => {
  let log: FastifyBaseLogger;
  let dirs: string[];

  beforeEach(() => {
    vi.clearAllMocks();
    (readFile as Mock).mockImplementation(actualFs.readFile as never);
    (stat as Mock).mockImplementation(actualFs.stat as never);
    log = makeLog();
    dirs = [];
  });

  afterEach(async () => {
    for (const dir of dirs) {
      // Tolerant teardown per `windows-hostile-test-primitives` — a leaked tmpdir beats a red suite.
      try { await actualFs.rm(dir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  });

  async function seedFolder(contents?: string): Promise<string> {
    const dir = await actualFs.mkdtemp(join(tmpdir(), 'opf-reader-'));
    dirs.push(dir);
    if (contents !== undefined) await actualFs.writeFile(join(dir, 'metadata.opf'), contents, 'utf-8');
    return dir;
  }

  it('ENOENT → null, no warn, one debug', async () => {
    const dir = await seedFolder();

    expect(await readOpfMetadata(dir, log)).toBeNull();

    expect(log.warn).not.toHaveBeenCalled();
    expect(log.debug).toHaveBeenCalledTimes(1);
    expect(vi.mocked(log.debug).mock.calls[0]![1]).toMatch(/No metadata\.opf sidecar/);
  });

  it.each(['EACCES', 'EISDIR'] as const)('%s → null plus exactly one serialized warn', async (code) => {
    const dir = await seedFolder(OPF);
    (readFile as Mock).mockImplementationOnce(() => Promise.reject(errno(code)));

    expect(await readOpfMetadata(dir, log)).toBeNull();

    expect(log.warn).toHaveBeenCalledTimes(1);
    const logged = vi.mocked(log.warn).mock.calls[0]![0] as { error: Record<string, unknown> };
    // `type: 'Error'` is the load-bearing term: `expect.objectContaining({ message })` reads through
    // to Error.prototype and would pass against a RAW error, leaving `serializeError` deletable.
    expect(logged.error).not.toBeInstanceOf(Error);
    expect(Object.keys(logged.error).sort()).toEqual(['code', 'message', 'stack', 'type']);
    expect(logged.error).toMatchObject({ type: 'Error', code });
  });

  it('a bookFolder ending in .m4b is skipped with ZERO reads', async () => {
    expect(await readOpfMetadata('/audiobooks/Doctor Sleep.m4b', log)).toBeNull();

    expect(readFile).not.toHaveBeenCalled();
    expect(stat).not.toHaveBeenCalled();
  });

  it('a file over MAX_OPF_BYTES → null + warn, and the bytes are never read', async () => {
    const dir = await seedFolder(OPF);
    (stat as Mock).mockImplementationOnce(() => Promise.resolve({ size: 5 * 1024 * 1024 }));

    expect(await readOpfMetadata(dir, log)).toBeNull();

    // readFile is never reached, so the parser is never entered either.
    expect(readFile).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(vi.mocked(log.warn).mock.calls[0]![0]).toMatchObject({ maxBytes: MAX_OPF_BYTES });
  });

  it('reads a real metadata.opf off disk', async () => {
    const dir = await seedFolder(OPF);

    expect(await readOpfMetadata(dir, log)).toMatchObject({ title: 'On Disk' });

    // Never assert a path.join()ed string without normalising — backslashes on Windows.
    const opfPath = String((readFile as Mock).mock.calls[0]![0]).split('\\').join('/');
    expect(opfPath).toContain('/metadata.opf');
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('a corrupt sidecar reads as absent, with no warn', async () => {
    const dir = await seedFolder('\u0000\u0001binary garbage\u00ff');

    expect(await readOpfMetadata(dir, log)).toBeNull();

    expect(log.warn).not.toHaveBeenCalled();
  });

  it('emits one debug per normalization diagnostic, naming the field and kind but never the value', async () => {
    const dir = await seedFolder([
      '<package version="2.0"><metadata>',
      `<dc:description>${'d'.repeat(20_000)}</dc:description>`,
      `<dc:identifier opf:scheme="ASIN">${'x'.repeat(65)}</dc:identifier>`,
      ...Array.from({ length: 200 }, (_, i) => `<dc:subject>Genre ${i}</dc:subject>`),
      '</metadata></package>',
    ].join(''));

    await readOpfMetadata(dir, log);

    const payloads = vi.mocked(log.debug).mock.calls.map((call) => call[0] as Record<string, unknown>);
    expect(payloads).toContainEqual(expect.objectContaining({ field: 'description', kind: 'truncated' }));
    expect(payloads).toContainEqual(expect.objectContaining({ field: 'genres', kind: 'capped' }));
    expect(payloads).toContainEqual(expect.objectContaining({ field: 'asin', kind: 'dropped-over-bound' }));
    // The 8 000-char description must not reach a log line.
    expect(JSON.stringify(vi.mocked(log.debug).mock.calls)).not.toContain('dddddddddd');
  });
});
