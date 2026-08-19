import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { E2E_DEFAULT_PORTS } from '../fixtures/ports.js';
import { readFakesHostInputs, startFakesHost, runFakesHostCli, type FakesHostHandles } from './host.js';

const FAKES_DIR = dirname(fileURLToPath(import.meta.url));

// These tests bind real listeners; unique ports prevent Vitest and kernel TIME_WAIT collisions.
// Base offset differs from global-setup.test.ts (15100) so parallel workers never collide.
let nextPortBase = 15400;
function allocatePorts(): { mam: number; qbit: number; audible: number } {
  return { mam: nextPortBase++, qbit: nextPortBase++, audible: nextPortBase++ };
}

function hostEnv(ports: { mam: number; qbit: number; audible: number }, downloadsPath: string): NodeJS.ProcessEnv {
  return {
    E2E_MAM_PORT: String(ports.mam),
    E2E_QBIT_PORT: String(ports.qbit),
    E2E_AUDIBLE_PORT: String(ports.audible),
    E2E_DOWNLOADS_PATH: downloadsPath,
  };
}

describe('readFakesHostInputs', () => {
  it('derives ports and the downloads dir from its own env', () => {
    const inputs = readFakesHostInputs(hostEnv({ mam: 5100, qbit: 5200, audible: 5300 }, '/tmp/downloads'));

    expect(inputs).toEqual({ mamPort: 5100, qbitPort: 5200, audiblePort: 5300, downloadsPath: '/tmp/downloads' });
  });

  it('falls back to the shared default ports when they are unset', () => {
    const inputs = readFakesHostInputs({ E2E_DOWNLOADS_PATH: '/tmp/downloads' });

    expect(inputs.mamPort).toBe(E2E_DEFAULT_PORTS.mam);
    expect(inputs.qbitPort).toBe(E2E_DEFAULT_PORTS.qbit);
    expect(inputs.audiblePort).toBe(E2E_DEFAULT_PORTS.audible);
  });

  it.each([undefined, '', '   '])('rejects an E2E_DOWNLOADS_PATH of %o with a named error', (raw) => {
    expect(() => readFakesHostInputs({ E2E_DOWNLOADS_PATH: raw })).toThrow(/E2E_DOWNLOADS_PATH/);
  });
});

describe('startFakesHost', () => {
  let downloadsPath: string;
  let handles: FakesHostHandles | undefined;

  beforeEach(() => {
    downloadsPath = mkdtempSync(join(tmpdir(), 'narratorr-fakes-host-test-'));
  });

  afterEach(async () => {
    await handles?.close();
    handles = undefined;
    try { rmSync(downloadsPath, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it('serves all three fakes on the configured ports', async () => {
    const ports = allocatePorts();
    handles = await startFakesHost(readFakesHostInputs(hostEnv(ports, downloadsPath)));

    const mamRes = await fetch(`http://localhost:${ports.mam}/jsonLoad.php`, {
      headers: { Cookie: 'mam_id=test-mam-id' },
    });
    expect(mamRes.status).toBe(200);

    const qbitRes = await fetch(`http://localhost:${ports.qbit}/api/v2/app/version`);
    expect(qbitRes.status).toBe(200);

    const audibleRes = await fetch(`http://localhost:${ports.audible}/1.0/catalog/products?title=test`);
    expect(audibleRes.status).toBe(200);
    const body = await audibleRes.json() as { products: unknown[]; total_results: number };
    expect(body.products).toEqual([]);
    expect(body.total_results).toBe(0);
  });

  it('pre-seeds MAM with a fixture matching the seeded book title', async () => {
    const ports = allocatePorts();
    handles = await startFakesHost(readFakesHostInputs(hostEnv(ports, downloadsPath)));

    const res = await fetch(
      `http://localhost:${ports.mam}/tor/js/loadSearchJSONbasic.php?tor%5Btext%5D=E2E+Test+Book`,
      { headers: { Cookie: 'mam_id=test-mam-id' } },
    );
    const body = await res.json() as { data?: Array<{ title: string }> };
    expect(body.data).toBeDefined();
    expect(body.data!.length).toBeGreaterThan(0);
    expect(body.data![0]!.title).toMatch(/E2E Test Book/);
  });

  it('binds MAM last, so the config readiness check on its port implies all three are up', () => {
    // Source-order sentinel: the config's `port: MAM_PORT` readiness is only sound while MAM is
    // the final bind. Reds if someone reorders the awaits in startFakesHost.
    const content = readFileSync(join(FAKES_DIR, 'host.ts'), 'utf-8');
    const audibleAt = content.indexOf('await createAudibleFake');
    const qbitAt = content.indexOf('await createQBitFake');
    const mamAt = content.indexOf('await createMAMFake');
    expect(audibleAt).toBeGreaterThan(-1);
    expect(qbitAt).toBeGreaterThan(audibleAt);
    expect(mamAt).toBeGreaterThan(qbitAt);
  });
});

describe('runFakesHostCli', () => {
  it('exits non-zero with a diagnostic when the env is unusable, binding nothing', async () => {
    const exit = vi.fn();
    const writeStderr = vi.fn();
    const writeStdout = vi.fn();

    await runFakesHostCli({ env: {}, exit, writeStderr, writeStdout });

    expect(exit).toHaveBeenCalledWith(1);
    expect(writeStdout).not.toHaveBeenCalled();
    expect(writeStderr.mock.calls.at(-1)![0]).toContain('E2E_DOWNLOADS_PATH');
  });

  it('announces the bound ports on the success path', async () => {
    const ports = allocatePorts();
    const downloadsPath = mkdtempSync(join(tmpdir(), 'narratorr-fakes-host-test-'));
    const exit = vi.fn();
    const writeStderr = vi.fn();
    const writeStdout = vi.fn();
    let handles: FakesHostHandles | undefined;

    try {
      handles = await runFakesHostCli({ env: hostEnv(ports, downloadsPath), exit, writeStderr, writeStdout });

      expect(exit).not.toHaveBeenCalled();
      expect(writeStderr).not.toHaveBeenCalled();
      const [message] = writeStdout.mock.calls.at(-1)!;
      expect(message).toContain(`mam:${ports.mam}`);

      const res = await fetch(`http://localhost:${ports.mam}/jsonLoad.php`, {
        headers: { Cookie: 'mam_id=test-mam-id' },
      });
      expect(res.status).toBe(200);
    } finally {
      await handles?.close();
      try { rmSync(downloadsPath, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  });
});
