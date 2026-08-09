import { vi, describe, it, expect, afterEach } from 'vitest';
import { rmSync as realRmSync } from 'fs';
import type * as FsModule from 'fs';

/** Isolated so the hoisted fs mock cannot contaminate real-filesystem harness tests. */

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof FsModule>('fs');
  return {
    ...actual,
    rmSync: vi.fn(actual.rmSync),
  };
});

// Import after mock registration.
const { createE2EApp } = await import('./e2e-helpers.js');
const fs = await import('fs');

describe('createE2EApp cleanup() error surfacing', () => {
  const orphans: string[] = [];

  afterEach(() => {
    for (const p of orphans) {
      try {
        realRmSync(p, { recursive: true, force: true });
      } catch {
        // best effort
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
