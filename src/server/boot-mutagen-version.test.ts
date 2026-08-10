import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

vi.mock('@core/utils/mutagen-resolver.js', () => ({ detectMutagenPython: vi.fn() }));

import { logMutagenVersionAtBoot, checkMutagenVersionAtBoot } from './boot-mutagen-version.js';
import { detectMutagenPython } from '@core/utils/mutagen-resolver.js';
import type { MutagenDetection } from '@core/utils/mutagen-resolver.js';

function createLog() {
  return { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

function detection(overrides: Partial<MutagenDetection> = {}): MutagenDetection {
  return {
    python: '/usr/bin/python3',
    version: '1.47.0',
    override: undefined,
    overrideSuperseded: false,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('logMutagenVersionAtBoot', () => {
  it('logs the resolved interpreter and mutagen version on a clean resolution', async () => {
    const log = createLog();

    await logMutagenVersionAtBoot({ detectMutagenPython: vi.fn().mockResolvedValue(detection()) }, log as never);

    expect(log.info).toHaveBeenCalledWith(
      { mutagenPython: '/usr/bin/python3', mutagenVersion: '1.47.0' },
      'Detected mutagen',
    );
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('warns about unavailability when nothing resolves, naming MUTAGEN_PYTHON', async () => {
    const log = createLog();

    await logMutagenVersionAtBoot({ detectMutagenPython: vi.fn().mockResolvedValue(null) }, log as never);

    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn.mock.calls[0]![0]).toContain('MUTAGEN_PYTHON');
    expect(log.info).not.toHaveBeenCalled();
  });

  it('warns about the substitution when an override was set but superseded (AC21)', async () => {
    const log = createLog();
    const superseded = detection({ override: '/opt/stale/python', overrideSuperseded: true });

    await logMutagenVersionAtBoot({ detectMutagenPython: vi.fn().mockResolvedValue(superseded) }, log as never);

    expect(log.warn).toHaveBeenCalledWith(
      { mutagenPython: '/opt/stale/python', resolved: '/usr/bin/python3' },
      'MUTAGEN_PYTHON was set but did not import mutagen — using the auto-detected interpreter instead',
    );
    // The substitution is a warning, not a failure: detection still succeeded.
    expect(log.info).toHaveBeenCalledWith(expect.anything(), 'Detected mutagen');
  });

  it('does not warn about substitution when the override itself won', async () => {
    const log = createLog();
    const honoured = detection({ python: '/opt/venv/bin/python', override: '/opt/venv/bin/python' });

    await logMutagenVersionAtBoot({ detectMutagenPython: vi.fn().mockResolvedValue(honoured) }, log as never);

    expect(log.warn).not.toHaveBeenCalled();
  });

  it('never blocks boot when detection throws', async () => {
    const log = createLog();

    await expect(logMutagenVersionAtBoot(
      { detectMutagenPython: vi.fn().mockRejectedValue(new Error('spawn EACCES')) },
      log as never,
    )).resolves.toBeUndefined();

    expect(log.warn).toHaveBeenCalledWith(
      { error: expect.objectContaining({ message: 'spawn EACCES' }) },
      'Failed to probe mutagen at startup',
    );
  });
});

describe('checkMutagenVersionAtBoot — production wiring (AC21)', () => {
  it('binds the production detectMutagenPython probe and logs once on success', async () => {
    const log = createLog();
    (detectMutagenPython as Mock).mockResolvedValue(detection());

    await checkMutagenVersionAtBoot(log as never);

    expect(detectMutagenPython).toHaveBeenCalledTimes(1);
    expect(log.info).toHaveBeenCalledTimes(1);
  });

  it('stays best-effort: resolves so boot proceeds, and warns when the production probe rejects', async () => {
    const log = createLog();
    (detectMutagenPython as Mock).mockRejectedValue(new Error('spawn ENOENT'));

    await expect(checkMutagenVersionAtBoot(log as never)).resolves.toBeUndefined();

    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.info).not.toHaveBeenCalled();
  });

  // A boot helper that exists but is never called would pass every test above.
  it('is actually invoked from the server entrypoint', () => {
    const indexPath = join(dirname(fileURLToPath(import.meta.url)), 'index.ts');
    const source = readFileSync(indexPath, 'utf-8');

    expect(source).toContain("import { checkMutagenVersionAtBoot } from './boot-mutagen-version.js';");
    expect(source).toContain('await checkMutagenVersionAtBoot(app.log);');
  });
});
