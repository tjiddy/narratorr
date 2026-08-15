import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { rm } from 'node:fs/promises';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  removeTree,
  removeTreeSync,
  REMOVE_TREE_MAX_RETRIES,
  REMOVE_TREE_RETRY_DELAY_MS,
} from './remove-tree.js';

// Real-filesystem behaviour (force/ENOENT, populated trees) and injected errno ladders both belong
// to this contract, so the two removal primitives are mocked but default back to the real ones.
const actualFsp = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
const actualFs = await vi.importActual<typeof import('node:fs')>('node:fs');

vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal() as Record<string, unknown>),
  rm: vi.fn(),
}));

vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal() as Record<string, unknown>),
  rmSync: vi.fn(),
}));

const errno = (code: string) => Object.assign(new Error(code), { code });

const RETRYABLE_CODES = ['EBUSY', 'EMFILE', 'ENFILE', 'ENOTEMPTY', 'EPERM'] as const;

/**
 * Captures the helper's own backoff and fires it immediately. The waits are observable precisely
 * because the helper owns them — `fs.rm`'s internal ladder would have been unreachable from here.
 */
function captureAsyncWaits(): number[] {
  const delays: number[] = [];
  const originalSetTimeout = globalThis.setTimeout;
  vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number) => {
    delays.push(ms ?? 0);
    return originalSetTimeout(fn, 0);
  }) as typeof globalThis.setTimeout);
  return delays;
}

/** The sync counterpart: `Atomics.wait` is the only blocking sleep the sync loop performs. */
function captureSyncWaits(): number[] {
  const delays: number[] = [];
  vi.spyOn(Atomics, 'wait').mockImplementation(((
    _typedArray: Int32Array,
    _index: number,
    _value: number,
    timeout?: number,
  ) => {
    delays.push(timeout ?? 0);
    return 'timed-out';
  }) as typeof Atomics.wait);
  return delays;
}

describe('removeTree', () => {
  // `*Once` queues drive most cases here, and `clearAllMocks` would leave them armed for the next test.
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(rm).mockImplementation(actualFsp.rm as never);
    vi.mocked(rmSync).mockImplementation(actualFs.rmSync as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('call shape', () => {
    it('calls fs.rm with exactly { recursive: true, force: true }', async () => {
      vi.mocked(rm).mockResolvedValue(undefined);

      await removeTree('/tmp/some-tree');

      expect(rm).toHaveBeenCalledTimes(1);
      expect(vi.mocked(rm).mock.calls[0]![0]).toBe('/tmp/some-tree');
      const options = vi.mocked(rm).mock.calls[0]![1];
      expect(options).toEqual({ recursive: true, force: true });
      // Redundant under toEqual, load-bearing if anyone loosens the line above to objectContaining:
      // a maxRetries here re-arms Node's per-child ladder, whose cost is exponential in tree depth.
      expect(options).not.toHaveProperty('maxRetries');
      expect(options).not.toHaveProperty('retryDelay');
    });

    it('calls fs.rmSync with exactly { recursive: true, force: true }', () => {
      vi.mocked(rmSync).mockReturnValue(undefined);

      removeTreeSync('/tmp/some-tree');

      expect(rmSync).toHaveBeenCalledTimes(1);
      expect(vi.mocked(rmSync).mock.calls[0]![0]).toBe('/tmp/some-tree');
      const options = vi.mocked(rmSync).mock.calls[0]![1];
      expect(options).toEqual({ recursive: true, force: true });
      expect(options).not.toHaveProperty('maxRetries');
      expect(options).not.toHaveProperty('retryDelay');
    });

    // This pins the VALUES only. It cannot prove the implementation reads the constants rather
    // than inline literals — reading them into the expectation is circular, and every assertion
    // in this file holds either way. Single-homing is a source-review property (AC2).
    it('exports the retry budget as constants', () => {
      expect(REMOVE_TREE_MAX_RETRIES).toBe(3);
      expect(REMOVE_TREE_RETRY_DELAY_MS).toBe(100);
    });

    it('stays out of the Vite-facing utils barrel', async () => {
      const barrel = await actualFsp.readFile(
        fileURLToPath(new URL('./index.ts', import.meta.url)),
        'utf8',
      );

      // Guard the read itself: a wrong path would make the real assertion vacuously green.
      expect(barrel).toContain("export * from './naming.js';");
      expect(barrel).not.toMatch(/^export .*remove-tree/m);
    });
  });

  describe('real filesystem', () => {
    let root: string;

    beforeEach(async () => {
      root = await actualFsp.mkdtemp(join(tmpdir(), 'narratorr-remove-tree-'));
    });

    afterEach(async () => {
      await actualFsp.rm(root, { recursive: true, force: true });
    });

    it('removes a populated nested tree', async () => {
      const nested = join(root, 'Author', 'Title', 'Disc 1');
      await actualFsp.mkdir(nested, { recursive: true });
      await actualFsp.writeFile(join(nested, 'track.m4b'), 'audio');
      await actualFsp.writeFile(join(root, '.hidden'), 'dot');

      await removeTree(root);

      expect(actualFs.existsSync(root)).toBe(false);
    });

    it('removes a populated nested tree synchronously', async () => {
      const nested = join(root, 'Author', 'Title');
      await actualFsp.mkdir(nested, { recursive: true });
      await actualFsp.writeFile(join(nested, 'track.m4b'), 'audio');

      removeTreeSync(root);

      expect(actualFs.existsSync(root)).toBe(false);
    });

    it('resolves when the path does not exist (force suppresses ENOENT)', async () => {
      const absent = join(root, 'never-created');

      await expect(removeTree(absent)).resolves.toBeUndefined();
      expect(() => removeTreeSync(absent)).not.toThrow();
    });

    it('removes an empty directory and a plain file', async () => {
      const emptyDir = join(root, 'empty');
      const file = join(root, 'lone.txt');
      await actualFsp.mkdir(emptyDir);
      await actualFsp.writeFile(file, 'x');

      await removeTree(emptyDir);
      removeTreeSync(file);

      expect(actualFs.existsSync(emptyDir)).toBe(false);
      expect(actualFs.existsSync(file)).toBe(false);
    });
  });

  describe('retry ladder', () => {
    it('retries a retryable code and recovers, waiting once for 100 ms', async () => {
      const delays = captureAsyncWaits();
      vi.mocked(rm)
        .mockRejectedValueOnce(errno('ENOTEMPTY'))
        .mockResolvedValueOnce(undefined);

      await expect(removeTree('/tmp/tree')).resolves.toBeUndefined();

      expect(rm).toHaveBeenCalledTimes(2);
      expect(delays).toEqual([100]);
    });

    it('exhausts after four attempts, waiting 100/200/300 ms — a bound that does not depend on tree depth', async () => {
      const delays = captureAsyncWaits();
      const busy = errno('EBUSY');
      vi.mocked(rm).mockRejectedValue(busy);

      await expect(removeTree('/tmp/tree')).rejects.toBe(busy);

      expect(rm).toHaveBeenCalledTimes(4);
      expect(delays).toEqual([100, 200, 300]);
    });

    it.each(RETRYABLE_CODES)('retries %s', async (code) => {
      captureAsyncWaits();
      vi.mocked(rm)
        .mockRejectedValueOnce(errno(code))
        .mockResolvedValueOnce(undefined);

      await expect(removeTree('/tmp/tree')).resolves.toBeUndefined();

      expect(rm).toHaveBeenCalledTimes(2);
    });

    it('rethrows a non-retryable code immediately, with no wait', async () => {
      const delays = captureAsyncWaits();
      const denied = errno('EACCES');
      vi.mocked(rm).mockRejectedValue(denied);

      await expect(removeTree('/tmp/tree')).rejects.toBe(denied);

      expect(rm).toHaveBeenCalledTimes(1);
      expect(delays).toEqual([]);
    });

    it('rethrows an error carrying no code immediately, with no wait', async () => {
      const delays = captureAsyncWaits();
      const bare = new Error('no code here');
      vi.mocked(rm).mockRejectedValue(bare);

      await expect(removeTree('/tmp/tree')).rejects.toBe(bare);

      expect(rm).toHaveBeenCalledTimes(1);
      expect(delays).toEqual([]);
    });

    it('rethrows a non-Error rejection immediately, with no wait', async () => {
      const delays = captureAsyncWaits();
      vi.mocked(rm).mockRejectedValue('not an error');

      await expect(removeTree('/tmp/tree')).rejects.toBe('not an error');

      expect(rm).toHaveBeenCalledTimes(1);
      expect(delays).toEqual([]);
    });

    it('rethrows a non-Error OBJECT carrying a retryable code immediately, with no wait', async () => {
      const delays = captureAsyncWaits();
      // A plain object is not ours no matter what it carries; a string fixture cannot catch a
      // classifier that reads `.code` off any value.
      const impostor = { code: 'EBUSY' };
      vi.mocked(rm).mockRejectedValue(impostor);

      await expect(removeTree('/tmp/tree')).rejects.toBe(impostor);

      expect(rm).toHaveBeenCalledTimes(1);
      expect(delays).toEqual([]);
    });

    it('schedules no wait at all when the first attempt succeeds', async () => {
      const delays = captureAsyncWaits();
      vi.mocked(rm).mockResolvedValue(undefined);

      await removeTree('/tmp/tree');

      expect(rm).toHaveBeenCalledTimes(1);
      expect(delays).toEqual([]);
    });

    it('rejects with the error object thrown by the LAST attempt', async () => {
      captureAsyncWaits();
      const last = errno('EPERM');
      vi.mocked(rm)
        .mockRejectedValueOnce(errno('EBUSY'))
        .mockRejectedValueOnce(errno('EBUSY'))
        .mockRejectedValueOnce(errno('EBUSY'))
        .mockRejectedValueOnce(last);

      const rejection = await removeTree('/tmp/tree').then(() => null, (e: unknown) => e);

      expect(rejection).toBe(last);
      expect((rejection as NodeJS.ErrnoException).code).toBe('EPERM');
    });
  });

  describe('sync variant parity', () => {
    it('retries a retryable code and recovers, sleeping once for 100 ms', () => {
      const delays = captureSyncWaits();
      let calls = 0;
      vi.mocked(rmSync).mockImplementation(() => {
        calls += 1;
        if (calls === 1) throw errno('ENOTEMPTY');
      });

      expect(() => removeTreeSync('/tmp/tree')).not.toThrow();

      expect(rmSync).toHaveBeenCalledTimes(2);
      expect(delays).toEqual([100]);
    });

    it('exhausts after four attempts, sleeping 100/200/300 ms', () => {
      const delays = captureSyncWaits();
      const busy = errno('EBUSY');
      vi.mocked(rmSync).mockImplementation(() => { throw busy; });

      expect(() => removeTreeSync('/tmp/tree')).toThrow(busy);

      expect(rmSync).toHaveBeenCalledTimes(4);
      expect(delays).toEqual([100, 200, 300]);
    });

    it('rethrows a non-retryable code immediately, with no sleep', () => {
      const delays = captureSyncWaits();
      const denied = errno('EACCES');
      vi.mocked(rmSync).mockImplementation(() => { throw denied; });

      expect(() => removeTreeSync('/tmp/tree')).toThrow(denied);

      expect(rmSync).toHaveBeenCalledTimes(1);
      expect(delays).toEqual([]);
    });

    it('rethrows a non-Error throw immediately, with no sleep', () => {
      const delays = captureSyncWaits();
      vi.mocked(rmSync).mockImplementation(() => { throw 'not an error'; });

      expect(() => removeTreeSync('/tmp/tree')).toThrow('not an error');

      expect(rmSync).toHaveBeenCalledTimes(1);
      expect(delays).toEqual([]);
    });

    it('rethrows an Error carrying no code immediately, with no sleep', () => {
      const delays = captureSyncWaits();
      const bare = new Error('no code here');
      vi.mocked(rmSync).mockImplementation(() => { throw bare; });

      let thrown: unknown;
      try {
        removeTreeSync('/tmp/tree');
      } catch (error: unknown) {
        thrown = error;
      }

      expect(thrown).toBe(bare);
      expect(rmSync).toHaveBeenCalledTimes(1);
      expect(delays).toEqual([]);
    });

    it('rethrows a non-Error OBJECT carrying a retryable code immediately, with no sleep', () => {
      const delays = captureSyncWaits();
      const impostor = { code: 'EBUSY' };
      vi.mocked(rmSync).mockImplementation(() => { throw impostor; });

      let thrown: unknown;
      try {
        removeTreeSync('/tmp/tree');
      } catch (error: unknown) {
        thrown = error;
      }

      expect(thrown).toBe(impostor);
      expect(rmSync).toHaveBeenCalledTimes(1);
      expect(delays).toEqual([]);
    });

    it('sleeps not at all when the first attempt succeeds', () => {
      const delays = captureSyncWaits();
      vi.mocked(rmSync).mockReturnValue(undefined);

      removeTreeSync('/tmp/tree');

      expect(rmSync).toHaveBeenCalledTimes(1);
      expect(delays).toEqual([]);
    });

    it('throws the error object thrown by the LAST attempt', () => {
      captureSyncWaits();
      const last = errno('EPERM');
      let calls = 0;
      vi.mocked(rmSync).mockImplementation(() => {
        calls += 1;
        throw calls < 4 ? errno('EBUSY') : last;
      });

      let thrown: unknown;
      try {
        removeTreeSync('/tmp/tree');
      } catch (error: unknown) {
        thrown = error;
      }

      expect(thrown).toBe(last);
    });
  });
});
