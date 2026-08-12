import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';

vi.mock('node:child_process', () => ({ execFile: vi.fn() }));

import { execFile } from 'node:child_process';
import {
  probeMutagen,
  detectMutagenPython,
  resolveMutagenDetection,
  resolveMutagenPython,
  resetMutagenPythonCache,
} from './mutagen-resolver.js';

/**
 * `promisify(execFile)` resolves with the FIRST callback value, so this consumer needs the object
 * form `cb(null, { stdout, stderr })`. The positional form would surface as an undefined stdout and
 * read as a probe failure rather than a mock bug.
 */
function installDispatcher(behaviour: {
  /** Interpreters whose `import mutagen` succeeds. */
  withMutagen?: string[];
  /** Interpreters that exist but raise ModuleNotFoundError. */
  withoutMutagen?: string[];
  /** stdout for `which python3`; omit to make the lookup fail. */
  whichResult?: string;
  version?: string;
}): void {
  const withMutagen = new Set(behaviour.withMutagen ?? []);
  const withoutMutagen = new Set(behaviour.withoutMutagen ?? []);

  (execFile as unknown as Mock).mockImplementation((...args: unknown[]) => {
    const bin = args[0] as string;
    const cb = args[args.length - 1] as (e: Error | null, r?: { stdout: string; stderr: string }) => void;

    if (bin === 'which') {
      if (behaviour.whichResult) cb(null, { stdout: `${behaviour.whichResult}\n`, stderr: '' });
      else cb(new Error('which: no python3'));
      return {};
    }
    if (withMutagen.has(bin)) {
      cb(null, { stdout: `${behaviour.version ?? '1.47.0'}\n`, stderr: '' });
    } else if (withoutMutagen.has(bin)) {
      cb(new Error("ModuleNotFoundError: No module named 'mutagen'"));
    } else {
      cb(new Error(`spawn ${bin} ENOENT`));
    }
    return {};
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  resetMutagenPythonCache();
  delete process.env.MUTAGEN_PYTHON;
});

afterEach(() => {
  delete process.env.MUTAGEN_PYTHON;
  resetMutagenPythonCache();
});

describe('probeMutagen', () => {
  it('imports mutagen through the given interpreter and returns its version', async () => {
    installDispatcher({ withMutagen: ['/usr/bin/python3'], version: '1.47.0' });

    expect(await probeMutagen('/usr/bin/python3')).toBe('1.47.0');

    const [bin, args] = (execFile as unknown as Mock).mock.calls[0]!;
    expect(bin).toBe('/usr/bin/python3');
    expect(args).toEqual(['-c', 'import mutagen; print(mutagen.version_string)']);
  });

  it('rejects when the import fails, so a mutagen-less Python is never a hit', async () => {
    installDispatcher({ withoutMutagen: ['/usr/bin/python3'] });
    await expect(probeMutagen('/usr/bin/python3')).rejects.toThrow('ModuleNotFoundError');
  });
});

describe('detectMutagenPython — MUTAGEN_PYTHON (AC21)', () => {
  it('resolves the default interpreter when the override is unset', async () => {
    installDispatcher({ withMutagen: ['/usr/bin/python3'] });

    expect(await detectMutagenPython()).toEqual({
      python: '/usr/bin/python3', version: '1.47.0', override: undefined, overrideSuperseded: false,
    });
  });

  it('uses the exact override executable for the probe when it has mutagen', async () => {
    process.env.MUTAGEN_PYTHON = '/opt/venv/bin/python';
    installDispatcher({ withMutagen: ['/opt/venv/bin/python', '/usr/bin/python3'] });

    const detection = await detectMutagenPython();

    expect(detection).toEqual({
      python: '/opt/venv/bin/python', version: '1.47.0',
      override: '/opt/venv/bin/python', overrideSuperseded: false,
    });
    expect((execFile as unknown as Mock).mock.calls[0]![0]).toBe('/opt/venv/bin/python');
  });

  it.each([
    ['a nonexistent path', { withMutagen: ['/usr/bin/python3'] }],
    ['a real Python without mutagen', { withMutagen: ['/usr/bin/python3'], withoutMutagen: ['/opt/stale/python'] }],
  ])('falls through to the default for %s and still reports detected', async (_name, behaviour) => {
    process.env.MUTAGEN_PYTHON = '/opt/stale/python';
    installDispatcher(behaviour);

    expect(await detectMutagenPython()).toEqual({
      python: '/usr/bin/python3', version: '1.47.0',
      override: '/opt/stale/python', overrideSuperseded: true,
    });
  });

  it('falls back to a PATH lookup when /usr/bin/python3 is absent', async () => {
    installDispatcher({ withMutagen: ['/usr/local/bin/python3'], whichResult: '/usr/local/bin/python3' });

    const detection = await detectMutagenPython();

    expect(detection?.python).toBe('/usr/local/bin/python3');
  });

  it('rejects a `which` hit whose interpreter cannot import mutagen', async () => {
    installDispatcher({ withoutMutagen: ['/usr/local/bin/python3'], whichResult: '/usr/local/bin/python3' });

    expect(await detectMutagenPython()).toBeNull();
  });

  it('returns null when no candidate anywhere is usable', async () => {
    installDispatcher({});
    expect(await detectMutagenPython()).toBeNull();
  });

  it('never logs — the core resolver stays pure and the server boot helper owns warnings', async () => {
    const spies = (['warn', 'error', 'info', 'log'] as const).map(level => vi.spyOn(console, level).mockImplementation(() => {}));
    process.env.MUTAGEN_PYTHON = '/opt/stale/python';
    installDispatcher({ withMutagen: ['/usr/bin/python3'], withoutMutagen: ['/opt/stale/python'] });

    await detectMutagenPython();

    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    for (const spy of spies) spy.mockRestore();
  });
});

describe('resolveMutagenDetection — caching', () => {
  it('caches a success for the process lifetime', async () => {
    installDispatcher({ withMutagen: ['/usr/bin/python3'] });

    await resolveMutagenDetection();
    await resolveMutagenDetection();

    expect((execFile as unknown as Mock).mock.calls).toHaveLength(1);
  });

  it('coalesces concurrent detection through a single in-flight probe', async () => {
    installDispatcher({ withMutagen: ['/usr/bin/python3'] });

    const [a, b] = await Promise.all([resolveMutagenDetection(), resolveMutagenDetection()]);

    expect(a).toBe(b);
    expect((execFile as unknown as Mock).mock.calls).toHaveLength(1);
  });

  it('caches a miss for 30s, then re-probes after the TTL', async () => {
    vi.useFakeTimers();
    try {
      installDispatcher({});
      expect(await resolveMutagenPython()).toBeNull();
      const callsAfterMiss = (execFile as unknown as Mock).mock.calls.length;

      expect(await resolveMutagenPython()).toBeNull();
      expect((execFile as unknown as Mock).mock.calls).toHaveLength(callsAfterMiss);

      vi.advanceTimersByTime(30_001);
      installDispatcher({ withMutagen: ['/usr/bin/python3'] });
      expect(await resolveMutagenPython()).toBe('/usr/bin/python3');
    } finally {
      vi.useRealTimers();
    }
  });

  it('resetMutagenPythonCache clears a cached success', async () => {
    installDispatcher({ withMutagen: ['/usr/bin/python3'] });
    await resolveMutagenPython();

    resetMutagenPythonCache();
    await resolveMutagenPython();

    expect((execFile as unknown as Mock).mock.calls.length).toBeGreaterThan(1);
  });
});
