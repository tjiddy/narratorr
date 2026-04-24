import { vi, describe, it, expect, afterEach } from 'vitest';
import { rmSync as realRmSync } from 'fs';
import type * as FsModule from 'fs';

/**
 * Regression guard for AC #3 of issue #685: happy-path `cleanup()` must
 * surface `rmSync` failures to the caller instead of swallowing them.
 *
 * Structured as its own file so the `vi.mock('fs', ...)` hoists cleanly
 * above the `e2e-helpers` import without interfering with the other
 * harness tests, which exercise real filesystem behavior.
 */

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof FsModule>('fs');
  return {
    ...actual,
    // Default to real behavior; tests override via mockImplementationOnce to
    // simulate failures. Keeping a passthrough means mkdtempSync, createE2EApp
    // teardown via process exit, etc. all work normally.
    rmSync: vi.fn(actual.rmSync),
  };
});

// Import AFTER the mock so the helper picks up the mocked rmSync.
const { createE2EApp } = await import('./e2e-helpers.js');
const fs = await import('fs');

describe('createE2EApp cleanup() error surfacing', () => {
  const orphans: string[] = [];

  afterEach(() => {
    for (const p of orphans) {
      try {
        realRmSync(p, { recursive: true, force: true });
      } catch {
        // Best-effort — test-scope cleanup using the real, unmocked rmSync.
      }
    }
    orphans.length = 0;
    vi.mocked(fs.rmSync).mockClear();
  });

  it('propagates rmSync failures to the caller (does not silently swallow)', async () => {
    const e2e = await createE2EApp();
    orphans.push(e2e.dir);

    const failure = new Error('synthetic rmSync failure — must surface to caller');
    vi.mocked(fs.rmSync).mockImplementationOnce(() => {
      throw failure;
    });

    await expect(e2e.cleanup()).rejects.toBe(failure);
    expect(vi.mocked(fs.rmSync)).toHaveBeenCalledWith(
      e2e.dir,
      expect.objectContaining({ recursive: true, force: true }),
    );
  });
});
