import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Real filesystem semantics are the point here (dirent kinds, mtime ordering, real reads), so the
// module is only partially mocked and every mocked function is defaulted back to the real one.
const actualFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');

vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal() as Record<string, unknown>),
  readdir: vi.fn(),
  stat: vi.fn(),
  unlink: vi.fn(),
  open: vi.fn(),
}));

import { readdir, stat, unlink, open } from 'node:fs/promises';
import {
  CRASH_ARTIFACT_DIR,
  REPORT_PARSE_LIMIT,
  checkCrashForensicsAtBoot,
  logCrashForensicsAtBoot,
  pruneCrashArtifacts,
  pruneCrashArtifactsAtBoot,
  type CrashForensicsProbeDeps,
} from './boot-crash-forensics.js';

function createLog() {
  return { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

type Log = ReturnType<typeof createLog>;

beforeEach(() => {
  vi.clearAllMocks();
  (readdir as Mock).mockImplementation(actualFs.readdir as never);
  (stat as Mock).mockImplementation(actualFs.stat as never);
  (unlink as Mock).mockImplementation(actualFs.unlink as never);
  (open as Mock).mockImplementation(actualFs.open as never);
});

// ---------------------------------------------------------------------------
// Readiness check
// ---------------------------------------------------------------------------

const ARMED_LIMITS = [
  'Limit                     Soft Limit           Hard Limit           Units',
  'Max cpu time              unlimited            unlimited            seconds',
  'Max core file size        unlimited            unlimited            bytes',
  'Max open files            1024                 4096                 files',
  '',
].join('\n');

function limitsWithCore(soft: string, hard = 'unlimited'): string {
  return [
    'Limit                     Soft Limit           Hard Limit           Units',
    `Max core file size        ${soft.padEnd(20)} ${hard.padEnd(20)} bytes`,
    'Max open files            1024                 4096                 files',
    '',
  ].join('\n');
}

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

function probes(overrides: Partial<CrashForensicsProbeDeps> = {}): CrashForensicsProbeDeps {
  return {
    readProcLimits: vi.fn().mockResolvedValue(ARMED_LIMITS),
    readCorePattern: vi.fn().mockResolvedValue('/config/crash-reports/core.%e.%p.%t\n'),
    getReportConfig: vi.fn().mockReturnValue({
      directory: CRASH_ARTIFACT_DIR,
      filename: '',
      reportOnFatalError: true,
      reportOnSignal: true,
      signal: 'SIGUSR2',
      excludeEnv: true,
    }),
    probeArtifactDir: vi.fn().mockResolvedValue(undefined),
    cwd: () => '/app',
    ...overrides,
  };
}

/** The one aggregate line the check is allowed to emit, whichever level it lands on. */
function readinessLine(log: Log): { level: 'info' | 'warn'; payload: Record<string, unknown>; message: string } {
  const serialized = log.warn.mock.calls.filter((call) => 'error' in (call[0] ?? {}));
  expect(serialized, 'the serialized-error catch must not fire for an expected probe failure').toHaveLength(0);

  const calls: Array<['info' | 'warn', unknown[]]> = [
    ...log.info.mock.calls.map((c) => ['info', c] as ['info', unknown[]]),
    ...log.warn.mock.calls.map((c) => ['warn', c] as ['warn', unknown[]]),
  ];
  expect(calls).toHaveLength(1);
  const [level, args] = calls[0]!;
  return { level, payload: args[0] as Record<string, unknown>, message: args[1] as string };
}

describe('logCrashForensicsAtBoot — core-limit leg', () => {
  it('is armed when the soft limit is unlimited', async () => {
    const log = createLog();
    await logCrashForensicsAtBoot(probes(), log as never);

    const line = readinessLine(log);
    expect(line.level).toBe('info');
    expect(line.payload.readiness).toBe('armed');
    expect(line.payload.coreLimit).toBe('unlimited');
  });

  it('is armed for a finite non-zero soft limit, and the parsed value reaches the payload', async () => {
    const log = createLog();
    await logCrashForensicsAtBoot(
      probes({ readProcLimits: vi.fn().mockResolvedValue(limitsWithCore('4294967296')) }),
      log as never,
    );

    const line = readinessLine(log);
    expect(line.payload.readiness).toBe('armed');
    expect(line.payload.coreLimit).toBe('4294967296');
  });

  it('is disarmed at exactly 0 — the boundary the kernel actually enforces', async () => {
    const log = createLog();
    await logCrashForensicsAtBoot(
      probes({ readProcLimits: vi.fn().mockResolvedValue(limitsWithCore('0')) }),
      log as never,
    );

    const line = readinessLine(log);
    expect(line.level).toBe('warn');
    expect(line.payload.readiness).toBe('disarmed');
    expect(line.payload.disarmedLegs).toContain('core-limit');
    expect(line.message).toContain('soft core-file limit is 0');
  });

  it('stays disarmed when the soft limit is 0 but the hard limit is unlimited', async () => {
    const log = createLog();
    await logCrashForensicsAtBoot(
      probes({ readProcLimits: vi.fn().mockResolvedValue(limitsWithCore('0', 'unlimited')) }),
      log as never,
    );

    expect(readinessLine(log).payload.readiness).toBe('disarmed');
  });

  it('is unknown — not disarmed — when the core row is absent from an otherwise valid file', async () => {
    const log = createLog();
    const noCoreRow = [
      'Limit                     Soft Limit           Hard Limit           Units',
      'Max open files            1024                 4096                 files',
      '',
    ].join('\n');

    await logCrashForensicsAtBoot(probes({ readProcLimits: vi.fn().mockResolvedValue(noCoreRow) }), log as never);

    const line = readinessLine(log);
    expect(line.payload.readiness).toBe('unknown');
    expect(line.payload.unknownLegs).toContain('core-limit');
    expect(line.payload.coreLimit).toBeNull();
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('is unknown with no disarmed warning on a platform that simply has no /proc', async () => {
    const log = createLog();
    await logCrashForensicsAtBoot(
      probes({ readProcLimits: vi.fn().mockRejectedValue(errno('ENOENT')) }),
      log as never,
    );

    const line = readinessLine(log);
    expect(line.level).toBe('info');
    expect(line.payload.unknownLegs).toContain('core-limit');
    expect(log.warn).not.toHaveBeenCalled();
  });
});

describe('logCrashForensicsAtBoot — core-pattern leg', () => {
  async function classify(pattern: string): Promise<{ line: ReturnType<typeof readinessLine>; log: Log }> {
    const log = createLog();
    await logCrashForensicsAtBoot(probes({ readCorePattern: vi.fn().mockResolvedValue(pattern) }), log as never);
    return { line: readinessLine(log), log };
  }

  it('is armed for the recommended pattern', async () => {
    const { line } = await classify('/config/crash-reports/core.%e.%p.%t');
    expect(line.payload.readiness).toBe('armed');
    expect(line.payload.corePattern).toBe('/config/crash-reports/core.%e.%p.%t');
  });

  it('is armed for a different basename in the artifact directory — content, not name, identifies a core', async () => {
    const { line } = await classify('/config/crash-reports/dump.%p');
    expect(line.payload.readiness).toBe('armed');
  });

  it('is disarmed for an absolute pattern pointing elsewhere', async () => {
    const { line } = await classify('/var/lib/systemd/coredump/core.%e.%p');
    expect(line.payload.readiness).toBe('disarmed');
    expect(line.payload.disarmedLegs).toContain('core-pattern');
    expect(line.message).toContain('/var/lib/systemd/coredump');
  });

  it('is disarmed for a bare relative pattern, naming the working-directory loss', async () => {
    const { line } = await classify('core');
    expect(line.payload.readiness).toBe('disarmed');
    expect(line.message).toContain('working directory');
  });

  it('is disarmed for a pipe pattern, naming the host handler and the coredumpctl retrieval path', async () => {
    const { line } = await classify('|/usr/lib/systemd/systemd-coredump %P %u %g %s %t %c %h');
    expect(line.payload.readiness).toBe('disarmed');
    expect(line.message).toContain('/usr/lib/systemd/systemd-coredump');
    expect(line.message).toContain('coredumpctl');
  });

  it('gives the four disarmed patterns mutually distinguishable messages', async () => {
    const messages = await Promise.all(
      [
        '/var/lib/systemd/coredump/core.%e.%p',
        'core',
        '|/usr/lib/systemd/systemd-coredump %P',
        '/tmp/core.%p',
      ].map(async (pattern) => (await classify(pattern)).line.message),
    );

    expect(new Set(messages).size).toBe(messages.length);
  });

  it('tolerates a trailing newline and surrounding whitespace', async () => {
    const bare = await classify('core');
    const padded = await classify('  core\n');
    expect(padded.line.message).toBe(bare.line.message);
    expect(padded.line.payload.corePattern).toBe('core');
  });

  it('is unknown when the pattern file cannot be read, with no classification warning', async () => {
    const log = createLog();
    await logCrashForensicsAtBoot(
      probes({ readCorePattern: vi.fn().mockRejectedValue(errno('ENOENT')) }),
      log as never,
    );

    const line = readinessLine(log);
    expect(line.payload.readiness).toBe('unknown');
    expect(line.payload.unknownLegs).toContain('core-pattern');
    expect(line.payload.corePattern).toBeNull();
    expect(log.warn).not.toHaveBeenCalled();
  });
});

describe('logCrashForensicsAtBoot — report configuration', () => {
  function withReport(overrides: Record<string, unknown>) {
    return probes({
      getReportConfig: vi.fn().mockReturnValue({
        directory: CRASH_ARTIFACT_DIR,
        filename: '',
        reportOnFatalError: true,
        reportOnSignal: true,
        signal: 'SIGUSR2',
        excludeEnv: true,
        ...overrides,
      }),
    });
  }

  async function classify(overrides: Record<string, unknown>) {
    const log = createLog();
    await logCrashForensicsAtBoot(withReport(overrides), log as never);
    return readinessLine(log);
  }

  it('emits the fully-armed line with every effective value in the payload', async () => {
    const log = createLog();
    await logCrashForensicsAtBoot(probes(), log as never);

    const line = readinessLine(log);
    expect(line.level).toBe('info');
    expect(line.message).toBe('Crash forensics armed');
    expect(line.payload).toEqual({
      readiness: 'armed',
      coreLimit: 'unlimited',
      corePattern: '/config/crash-reports/core.%e.%p.%t',
      reportDirectory: '/config/crash-reports',
      reportFilename: '',
      artifactDir: CRASH_ARTIFACT_DIR,
      signal: 'SIGUSR2',
      excludeEnv: true,
      disarmedLegs: [],
      unknownLegs: [],
    });
  });

  it.each([
    ['/config/crash-reports', 'armed'],
    ['/config/crash-reports/', 'armed'],
    ['/config/crash-reports/../crash-reports', 'armed'],
    ['', 'disarmed'],
    ['/tmp', 'disarmed'],
    ['/config/crash-reports-old', 'disarmed'],
    ['rel/dir', 'disarmed'],
  ])('resolves and normalizes the effective report directory %s -> %s', async (directory, expected) => {
    const line = await classify({ directory });
    expect(line.payload.readiness).toBe(expected);
  });

  it('reports the resolved directory, not the raw field, for a relative configuration', async () => {
    const line = await classify({ directory: 'rel/dir' });
    expect(line.payload.reportDirectory).toBe('/app/rel/dir');
    expect(line.message).toContain('/app/rel/dir');
  });

  it('says reports would land outside the persisted volume when the directory defaults to the CWD', async () => {
    const line = await classify({ directory: '' });
    expect(line.payload.reportDirectory).toBe('/app');
    expect(line.message).toContain('outside the persisted');
  });

  it('is armed for the default empty filename', async () => {
    const line = await classify({ filename: '' });
    expect(line.payload.readiness).toBe('armed');
    expect(line.payload.reportFilename).toBe('');
  });

  it('is disarmed for a filename override, on retrievability grounds only', async () => {
    const line = await classify({ filename: 'diagnostic.json' });
    expect(line.payload.readiness).toBe('disarmed');
    expect(line.payload.reportFilename).toBe('diagnostic.json');
    expect(line.message).toContain('diagnostic.json');
    expect(line.message).toContain('report.*.json');
    // The content classifier cannot be fooled by a name, so the override has no retention effect.
    expect(line.message).toContain('retention is unaffected');
  });

  it('gives a core-shaped filename override a distinct, more pointed message', async () => {
    const generic = await classify({ filename: 'diagnostic.json' });
    const coreShaped = await classify({ filename: 'core.report' });

    expect(coreShaped.payload.readiness).toBe('disarmed');
    expect(coreShaped.message).not.toBe(generic.message);
    expect(coreShaped.message).toContain('retention is unaffected');
  });

  it.each([
    [{ reportOnFatalError: false }, '--report-on-fatalerror'],
    [{ reportOnSignal: false }, '--report-on-signal'],
    [{ signal: 'SIGQUIT' }, 'SIGUSR2'],
  ])('is disarmed for %o, naming the flag', async (overrides, needle) => {
    const line = await classify(overrides);
    expect(line.payload.readiness).toBe('disarmed');
    expect(line.message).toContain(needle);
  });

  it('is disarmed when --report-exclude-env is off, saying which credentials a report would carry', async () => {
    const armed = await classify({ excludeEnv: true });
    expect(armed.payload.readiness).toBe('armed');

    const line = await classify({ excludeEnv: false });
    expect(line.payload.readiness).toBe('disarmed');
    expect(line.payload.excludeEnv).toBe(false);
    expect(line.message).toContain('--report-exclude-env');
    expect(line.message).toContain('NARRATORR_SECRET_KEY');
  });
});

describe('logCrashForensicsAtBoot — artifact-directory leg', () => {
  it('distinguishes a missing directory from an unwritable one', async () => {
    const missingLog = createLog();
    await logCrashForensicsAtBoot(
      probes({ probeArtifactDir: vi.fn().mockRejectedValue(errno('ENOENT')) }),
      missingLog as never,
    );
    const missing = readinessLine(missingLog);

    const deniedLog = createLog();
    await logCrashForensicsAtBoot(
      probes({ probeArtifactDir: vi.fn().mockRejectedValue(errno('EACCES')) }),
      deniedLog as never,
    );
    const denied = readinessLine(deniedLog);

    expect(missing.payload.readiness).toBe('disarmed');
    expect(denied.payload.readiness).toBe('disarmed');
    expect(missing.message).not.toBe(denied.message);
    expect(missing.message).toContain('does not exist');
    expect(denied.message).toContain('not writable');
  });

  it('is unknown for an unexpected probe errno', async () => {
    const log = createLog();
    await logCrashForensicsAtBoot(
      probes({ probeArtifactDir: vi.fn().mockRejectedValue(errno('EIO')) }),
      log as never,
    );

    const line = readinessLine(log);
    expect(line.payload.readiness).toBe('unknown');
    expect(line.payload.unknownLegs).toContain('artifact-directory');
  });

  it('claims write access only — it never asserts durability across container replacement', async () => {
    const log = createLog();
    await logCrashForensicsAtBoot(probes(), log as never);

    const line = readinessLine(log);
    expect(line.message).not.toMatch(/persist|durable|survive/i);
  });
});

describe('logCrashForensicsAtBoot — three-state aggregation', () => {
  it('emits exactly one info and zero warns when every leg is armed', async () => {
    const log = createLog();
    await logCrashForensicsAtBoot(probes(), log as never);

    expect(log.info).toHaveBeenCalledTimes(1);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('emits exactly one warn and no fully-armed info when a single leg is disarmed', async () => {
    const log = createLog();
    await logCrashForensicsAtBoot(
      probes({ readProcLimits: vi.fn().mockResolvedValue(limitsWithCore('0')) }),
      log as never,
    );

    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.info).not.toHaveBeenCalled();
  });

  it('emits the unknown info — and no warn — when a leg could not be determined', async () => {
    const log = createLog();
    await logCrashForensicsAtBoot(
      probes({ readCorePattern: vi.fn().mockRejectedValue(errno('ENOENT')) }),
      log as never,
    );

    const line = readinessLine(log);
    expect(line.payload.readiness).toBe('unknown');
    expect(line.message).not.toBe('Crash forensics armed');
    expect(line.payload.unknownLegs).toEqual(['core-pattern']);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('lets disarmed take precedence over unknown while keeping the unknown leg in the payload', async () => {
    const log = createLog();
    await logCrashForensicsAtBoot(
      probes({
        readCorePattern: vi.fn().mockRejectedValue(errno('ENOENT')),
        readProcLimits: vi.fn().mockResolvedValue(limitsWithCore('0')),
      }),
      log as never,
    );

    const line = readinessLine(log);
    expect(line.level).toBe('warn');
    expect(line.payload.readiness).toBe('disarmed');
    expect(line.payload.disarmedLegs).toEqual(['core-limit']);
    expect(line.payload.unknownLegs).toEqual(['core-pattern']);
  });

  it('aggregates to unknown with one info and zero warns on the Windows/macOS shape', async () => {
    const log = createLog();
    await logCrashForensicsAtBoot(
      probes({
        readProcLimits: vi.fn().mockRejectedValue(errno('ENOENT')),
        readCorePattern: vi.fn().mockRejectedValue(errno('ENOENT')),
      }),
      log as never,
    );

    const line = readinessLine(log);
    expect(line.level).toBe('info');
    expect(line.payload.readiness).toBe('unknown');
    expect(line.payload.unknownLegs).toEqual(['core-limit', 'core-pattern']);
    expect(log.warn).not.toHaveBeenCalled();
  });
});

describe('logCrashForensicsAtBoot — error isolation', () => {
  it('routes every expected probe failure through leg classification, never the serialized catch', async () => {
    const log = createLog();
    await logCrashForensicsAtBoot(
      probes({
        readProcLimits: vi.fn().mockRejectedValue(errno('ENOENT')),
        readCorePattern: vi.fn().mockRejectedValue(errno('ENOENT')),
        probeArtifactDir: vi.fn().mockRejectedValue(errno('EACCES')),
      }),
      log as never,
    );

    const line = readinessLine(log);
    expect(line.payload.readiness).toBe('disarmed');
    expect(log.warn.mock.calls.filter((call) => 'error' in (call[0] ?? {}))).toHaveLength(0);
  });

  it('routes an orchestration defect to one serialized warn and emits no readiness line', async () => {
    const log = createLog();
    const boom = Object.assign(new Error('process.report unavailable'), { code: 'EDEFECT' });

    await expect(logCrashForensicsAtBoot(
      probes({ getReportConfig: vi.fn().mockImplementation(() => { throw boom; }) }),
      log as never,
    )).resolves.toBeUndefined();

    expect(log.info).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledTimes(1);
    const [payload, message] = log.warn.mock.calls[0]!;
    expect(message).toBe('Failed to check crash forensics readiness at startup');
    const logged = (payload as { error: Record<string, unknown> }).error;
    expect(logged).not.toBeInstanceOf(Error);
    expect(Object.keys(logged).sort()).toEqual(['code', 'message', 'stack', 'type']);
    expect(logged.type).toBe('Error');
    expect(logged.message).toBe('process.report unavailable');
  });

  it('flips the aggregate from disarmed to unknown when only the directory write probe starts succeeding', async () => {
    const denied = createLog();
    await logCrashForensicsAtBoot(
      probes({
        readProcLimits: vi.fn().mockRejectedValue(errno('ENOENT')),
        readCorePattern: vi.fn().mockRejectedValue(errno('ENOENT')),
        probeArtifactDir: vi.fn().mockRejectedValue(errno('EACCES')),
      }),
      denied as never,
    );
    expect(readinessLine(denied).level).toBe('warn');

    const allowed = createLog();
    await logCrashForensicsAtBoot(
      probes({
        readProcLimits: vi.fn().mockRejectedValue(errno('ENOENT')),
        readCorePattern: vi.fn().mockRejectedValue(errno('ENOENT')),
        probeArtifactDir: vi.fn().mockResolvedValue(undefined),
      }),
      allowed as never,
    );

    const line = readinessLine(allowed);
    expect(line.level).toBe('info');
    expect(line.payload.readiness).toBe('unknown');
  });
});

// ---------------------------------------------------------------------------
// Content classification + prune
// ---------------------------------------------------------------------------

const CORE_HEADER_BYTES = 18;

/** Minimal ELF prefix: the magic, then `e_type` at offset 16. `4` is ET_CORE. */
function elfBytes(eType: number, totalBytes = 64): Buffer {
  const buffer = Buffer.alloc(totalBytes);
  buffer.write('\x7fELF', 0, 'latin1');
  buffer.writeUInt16LE(eType, 16);
  return buffer;
}

const REAL_REPORT = JSON.stringify({
  header: {
    reportVersion: 5,
    event: 'Signal',
    processId: 412,
    componentVersions: { node: '24.0.0' },
  },
  javascriptStack: { message: 'No stack.' },
  libuv: [],
}, null, 2);

const COMPACT_REPORT = JSON.stringify(JSON.parse(REAL_REPORT));

/** A genuine report padded to exactly `bytes` UTF-8 bytes. */
function reportOfSize(bytes: number): string {
  const skeleton = JSON.stringify({ header: { reportVersion: 5 }, pad: '' });
  return JSON.stringify({ header: { reportVersion: 5 }, pad: 'x'.repeat(bytes - skeleton.length) });
}

describe('pruneCrashArtifacts', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await actualFs.mkdtemp(path.join(os.tmpdir(), 'crash-forensics-'));
  });

  afterEach(async () => {
    // Windows keeps handles open longer than Linux; a leaked tmpdir beats a red suite.
    try {
      await actualFs.rm(dir, { recursive: true, force: true });
    } catch { /* tolerated: see windows-hostile-test-primitives */ }
  });

  /** Seeds a file and stamps a deterministic mtime so retention ordering never races the clock. */
  async function seed(name: string, content: string | Buffer, mtimeSeconds: number): Promise<string> {
    const filePath = path.join(dir, name);
    await actualFs.writeFile(filePath, content);
    await actualFs.utimes(filePath, mtimeSeconds, mtimeSeconds);
    return filePath;
  }

  function unlinked(): string[] {
    return (unlink as Mock).mock.calls.map((call) => String(call[0]));
  }

  describe('core classification', () => {
    it('recognises a core by content under three names a filename rule would have split', async () => {
      const log = createLog();
      await seed('core.node.412.1755624640', elfBytes(4), 1000);
      await seed('dump.412', elfBytes(4), 1001);
      await seed('evidence', elfBytes(4), 1002);

      const summary = await pruneCrashArtifacts(dir, log as never);

      expect(summary.cores).toBe(3);
      expect(summary.reports).toBe(0);
    });

    it('does not treat an ELF executable as a core', async () => {
      const log = createLog();
      await seed('busybox', elfBytes(2), 1000);
      await seed('shared.so', elfBytes(3), 1001);

      const summary = await pruneCrashArtifacts(dir, log as never);

      expect(summary.cores).toBe(0);
      expect(summary.reports).toBe(0);
      expect(unlinked()).toEqual([]);
    });

    it('classifies a huge core in 18 bytes without reading or parsing it', async () => {
      const log = createLog();
      await seed('core.huge', elfBytes(4), 1000);
      const reads: Array<{ length: number; position: number }> = [];

      (stat as Mock).mockImplementation(async (target: string) => ({
        ...(await actualFs.stat(target)),
        isFile: () => true,
        size: 40 * 1024 ** 3,
        mtimeMs: 1_000_000,
      }));
      (open as Mock).mockImplementation(async () => ({
        read: async (buffer: Buffer, offset: number, length: number, position: number) => {
          reads.push({ length, position });
          elfBytes(4).copy(buffer, offset, position, position + length);
          return { bytesRead: length };
        },
        close: async () => undefined,
      }));

      const summary = await pruneCrashArtifacts(dir, log as never);

      expect(summary.cores).toBe(1);
      expect(reads).toEqual([{ length: CORE_HEADER_BYTES, position: 0 }]);
    });
  });

  describe('report classification', () => {
    it('recognises a report by content regardless of name or formatting', async () => {
      const log = createLog();
      await seed('report.20260819.181000.412.0.json', REAL_REPORT, 1000);
      await seed('diagnostic.json', COMPACT_REPORT, 1001);
      await seed('core.report', REAL_REPORT, 1002);

      const summary = await pruneCrashArtifacts(dir, log as never);

      expect(summary.reports).toBe(3);
      expect(summary.cores).toBe(0);
    });

    it.each([1, 5, 42])('accepts positive-integer reportVersion %i', async (version) => {
      const log = createLog();
      await seed('report.json', JSON.stringify({ header: { reportVersion: version } }), 1000);

      expect((await pruneCrashArtifacts(dir, log as never)).reports).toBe(1);
    });

    it.each([
      ['nested one level below header', '{"header":{"meta":{"reportVersion":5}}}'],
      ['sibling of header', '{"header":{},"reportVersion":5}'],
      ['prototype-key spoof', '{"__proto__":{"header":{"reportVersion":5}}}'],
      ['string version', '{"header":{"reportVersion":"5"}}'],
      ['zero version', '{"header":{"reportVersion":0}}'],
      ['negative version', '{"header":{"reportVersion":-1}}'],
      ['fractional version', '{"header":{"reportVersion":1.5}}'],
      ['overflowing version', '{"header":{"reportVersion":1e400}}'],
      ['header one level down', '{"meta":{"header":{"reportVersion":5}}}'],
      ['quoted inside a string value', '{"observation":"the report used \\"reportVersion\\":5"}'],
      ['root null', 'null'],
      ['root array', '[{"header":{"reportVersion":5}}]'],
      ['root string', '"header reportVersion 5"'],
      ['null header', '{"header":null}'],
      ['primitive header', '{"header":7}'],
      ['not JSON at all', 'reportVersion: 5, but this is prose'],
      ['truncated mid-write', '{"header":{"reportVersion":5'],
    ])('rejects %s without throwing, and still classifies later candidates', async (_label, content) => {
      const log = createLog();
      await seed('aaa-suspect.json', content, 1000);
      await seed('zzz-genuine.json', REAL_REPORT, 1001);

      const summary = await pruneCrashArtifacts(dir, log as never);

      expect(summary.reports).toBe(1);
      expect(summary.cores).toBe(0);
      expect(unlinked()).toEqual([]);
    });

    it('ignores prose files that merely discuss reportVersion', async () => {
      const log = createLog();
      await seed('notes.txt', 'The "reportVersion" field is 5 in the artifacts we captured.', 1000);
      await seed('notes.md', '# reportVersion\n\nSee `header.reportVersion` (5).', 1001);

      const summary = await pruneCrashArtifacts(dir, log as never);

      expect(summary.reports).toBe(0);
      expect(unlinked()).toEqual([]);
    });
  });

  describe('degenerate and unreadable candidates', () => {
    it('ignores a file shorter than the core signature', async () => {
      const log = createLog();
      await seed('stub', Buffer.from('short'), 1000);

      const summary = await pruneCrashArtifacts(dir, log as never);

      expect(summary).toMatchObject({ cores: 0, reports: 0 });
      expect(unlinked()).toEqual([]);
    });

    it('never descends into or deletes a directory whose name looks like an artifact', async () => {
      const log = createLog();
      await actualFs.mkdir(path.join(dir, 'core.d'));
      await actualFs.writeFile(path.join(dir, 'core.d', 'core.inner'), elfBytes(4));
      await seed('narratorr.db', Buffer.from('SQLite format 3 '), 1000);

      const summary = await pruneCrashArtifacts(dir, log as never);

      expect(summary).toMatchObject({ cores: 0, reports: 0 });
      expect(unlinked()).toEqual([]);
    });

    it.each(['EACCES', 'ENOENT'])('skips a candidate whose open rejects %s and keeps going', async (code) => {
      const log = createLog();
      const blocked = await seed('blocked.json', REAL_REPORT, 1000);
      await seed('readable.json', REAL_REPORT, 1001);

      (open as Mock).mockImplementation(async (target: string, flags?: string) => {
        if (String(target) === blocked) throw errno(code);
        return actualFs.open(target, flags ?? 'r');
      });

      const summary = await pruneCrashArtifacts(dir, log as never);

      expect(summary.reports).toBe(1);
      expect(log.warn).not.toHaveBeenCalled();
    });
  });

  describe('the report parse limit', () => {
    it('classifies a genuine report of exactly the limit', async () => {
      const log = createLog();
      await seed('at-limit.json', reportOfSize(REPORT_PARSE_LIMIT), 1000);

      const summary = await pruneCrashArtifacts(dir, log as never);

      expect(summary.reports).toBe(1);
      expect(log.warn).not.toHaveBeenCalled();
    });

    it('leaves the same report untouched one byte over the limit and warns with its size', async () => {
      const log = createLog();
      const overLimit = REPORT_PARSE_LIMIT + 1;
      await seed('over-limit.json', reportOfSize(overLimit), 1000);

      const summary = await pruneCrashArtifacts(dir, log as never);

      expect(summary).toMatchObject({ reports: 0, cores: 0 });
      expect(unlinked()).toEqual([]);
      expect(log.warn).toHaveBeenCalledTimes(1);
      expect(log.warn.mock.calls[0]![0]).toEqual({ file: 'over-limit.json', size: overLimit });
    });

    it('bounds the read itself when the file grows between the stat and the read', async () => {
      const log = createLog();
      await seed('growing.json', '{"header":{"reportVersion":5}}', 1000);
      let requested = 0;

      (open as Mock).mockImplementation(async () => ({
        // A writer still appending: every read succeeds, so only the cap can stop it.
        read: async (buffer: Buffer, offset: number, length: number) => {
          requested += length;
          buffer.fill(0x20, offset, offset + length);
          return { bytesRead: length };
        },
        close: async () => undefined,
      }));

      const summary = await pruneCrashArtifacts(dir, log as never);

      expect(summary).toMatchObject({ reports: 0, cores: 0 });
      expect(requested).toBe(REPORT_PARSE_LIMIT + 1);
      expect(unlinked()).toEqual([]);
      expect(log.warn).toHaveBeenCalledTimes(1);
      expect(log.warn.mock.calls[0]![0]).toMatchObject({ file: 'growing.json' });
    });

    it('emits no over-limit warning for an ordinary report', async () => {
      const log = createLog();
      await seed('report.json', REAL_REPORT, 1000);

      await pruneCrashArtifacts(dir, log as never);

      expect(log.warn).not.toHaveBeenCalled();
    });
  });

  describe('classification is stable across filename configuration', () => {
    const originalFilename = process.report?.filename;

    afterEach(() => {
      if (process.report) process.report.filename = originalFilename ?? '';
    });

    it('gives the identical verdict whatever --report-filename is currently set to', async () => {
      await seed('core.a', elfBytes(4), 1000);
      await seed('core.b', elfBytes(4), 1001);
      await seed('core.report', REAL_REPORT, 1002);

      for (const filename of ['core.report', '', 'diagnostic.json']) {
        const log = createLog();
        if (process.report) process.report.filename = filename;

        const summary = await pruneCrashArtifacts(dir, log as never);

        expect(summary, `verdict changed for --report-filename=${filename}`)
          .toMatchObject({ cores: 2, reports: 1, deletedCores: 0, deletedReports: 0 });
        expect(unlinked()).toEqual([]);
      }
    });

    it('bounds reports written under three different historical names to five collectively', async () => {
      const log = createLog();
      const names = [
        'report.1.json', 'report.2.json',
        'diagnostic.json', 'diagnostic-2.json',
        'legacy-report.json', 'legacy-report-2.json',
      ];
      for (const [index, name] of names.entries()) await seed(name, REAL_REPORT, 1000 + index);

      const summary = await pruneCrashArtifacts(dir, log as never);

      expect(summary.reports).toBe(6);
      expect(summary.deletedReports).toBe(1);
      expect(unlinked()).toEqual([path.join(dir, 'report.1.json')]);
    });
  });

  describe('retention boundaries', () => {
    it('makes no unlink call on an empty directory', async () => {
      const log = createLog();

      const summary = await pruneCrashArtifacts(dir, log as never);

      expect(summary).toEqual({ reports: 0, cores: 0, deletedReports: 0, deletedCores: 0 });
      expect(unlink).not.toHaveBeenCalled();
    });

    it('deletes nothing at exactly five reports and two cores', async () => {
      const log = createLog();
      for (let i = 0; i < 5; i++) await seed(`report.${i}.json`, REAL_REPORT, 1000 + i);
      for (let i = 0; i < 2; i++) await seed(`core.${i}`, elfBytes(4), 2000 + i);

      const summary = await pruneCrashArtifacts(dir, log as never);

      expect(summary).toEqual({ reports: 5, cores: 2, deletedReports: 0, deletedCores: 0 });
      expect(unlink).not.toHaveBeenCalled();
    });

    it('deletes exactly the oldest report at six, keeping the newest five', async () => {
      const log = createLog();
      for (let i = 0; i < 6; i++) await seed(`report.${i}.json`, REAL_REPORT, 1000 + i);

      const summary = await pruneCrashArtifacts(dir, log as never);

      expect(summary.deletedReports).toBe(1);
      expect(unlinked()).toEqual([path.join(dir, 'report.0.json')]);
      for (let i = 1; i < 6; i++) {
        expect(unlinked()).not.toContain(path.join(dir, `report.${i}.json`));
      }
    });

    it('prunes cores independently, so a burst of reports never evicts one', async () => {
      const log = createLog();
      for (let i = 0; i < 20; i++) await seed(`report.${i}.json`, REAL_REPORT, 1000 + i);
      for (let i = 0; i < 2; i++) await seed(`core.${i}`, elfBytes(4), 2000 + i);

      const summary = await pruneCrashArtifacts(dir, log as never);

      expect(summary.deletedCores).toBe(0);
      expect(summary.deletedReports).toBe(15);
      expect(unlinked()).not.toContain(path.join(dir, 'core.0'));
      expect(unlinked()).not.toContain(path.join(dir, 'core.1'));
    });

    it('deletes the oldest core at three', async () => {
      const log = createLog();
      for (let i = 0; i < 3; i++) await seed(`core.${i}`, elfBytes(4), 2000 + i);

      const summary = await pruneCrashArtifacts(dir, log as never);

      expect(summary.deletedCores).toBe(1);
      expect(unlinked()).toEqual([path.join(dir, 'core.0')]);
    });

    it('breaks equal mtimes on the filename so retention is deterministic', async () => {
      const log = createLog();
      for (const name of ['core.a', 'core.b', 'core.c']) await seed(name, elfBytes(4), 3000);

      const summary = await pruneCrashArtifacts(dir, log as never);

      expect(summary.deletedCores).toBe(1);
      expect(unlinked()).toEqual([path.join(dir, 'core.c')]);
    });
  });

  describe('deletion tolerance', () => {
    it('treats an ENOENT unlink as the desired end state', async () => {
      const log = createLog();
      for (let i = 0; i < 4; i++) await seed(`core.${i}`, elfBytes(4), 2000 + i);
      (unlink as Mock).mockImplementationOnce(() => Promise.reject(errno('ENOENT')));

      const summary = await pruneCrashArtifacts(dir, log as never);

      // Deletion walks the doomed tail newest-first, so core.1 precedes core.0.
      expect(summary.deletedCores).toBe(2);
      expect(unlinked()).toEqual([path.join(dir, 'core.1'), path.join(dir, 'core.0')]);
      expect(log.warn).not.toHaveBeenCalled();
    });

    it('warns once on a non-ENOENT unlink failure and still attempts the rest', async () => {
      const log = createLog();
      for (let i = 0; i < 4; i++) await seed(`core.${i}`, elfBytes(4), 2000 + i);
      (unlink as Mock).mockImplementationOnce(() => Promise.reject(errno('EACCES')));

      const summary = await pruneCrashArtifacts(dir, log as never);

      expect(summary.deletedCores).toBe(1);
      expect(unlinked()).toEqual([path.join(dir, 'core.1'), path.join(dir, 'core.0')]);
      expect(log.warn).toHaveBeenCalledTimes(1);
      const [payload] = log.warn.mock.calls[0]!;
      const logged = (payload as { error: Record<string, unknown> }).error;
      expect(logged).not.toBeInstanceOf(Error);
      expect(logged.type).toBe('Error');
      expect(logged.code).toBe('EACCES');
    });

    it('is silent when the artifact directory does not exist yet', async () => {
      const log = createLog();

      const summary = await pruneCrashArtifacts(path.join(dir, 'never-created'), log as never);

      expect(summary).toEqual({ reports: 0, cores: 0, deletedReports: 0, deletedCores: 0 });
      expect(log.warn).not.toHaveBeenCalled();
      expect(log.info).not.toHaveBeenCalled();
    });
  });

  it('never claims one file as both a core and a report', async () => {
    const log = createLog();
    await seed('core.report', REAL_REPORT, 1000);
    await seed('report.core', elfBytes(4), 1001);

    const summary = await pruneCrashArtifacts(dir, log as never);

    expect(summary.cores + summary.reports).toBe(2);
    expect(summary.cores).toBe(1);
    expect(summary.reports).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Production wrappers + entrypoint wiring
// ---------------------------------------------------------------------------

describe('production wrappers', () => {
  it('checkCrashForensicsAtBoot binds the real probes and emits exactly one aggregate line', async () => {
    const log = createLog();

    await expect(checkCrashForensicsAtBoot(log as never)).resolves.toBeUndefined();

    expect(log.info.mock.calls.length + log.warn.mock.calls.length).toBe(1);
  });

  it('pruneCrashArtifactsAtBoot targets the fixed artifact directory', async () => {
    const log = createLog();

    await expect(pruneCrashArtifactsAtBoot(log as never)).resolves.toBeUndefined();

    expect(readdir).toHaveBeenCalledWith(CRASH_ARTIFACT_DIR, { withFileTypes: true });
  });

  it('pruneCrashArtifactsAtBoot stays best-effort when the directory read fails unexpectedly', async () => {
    const log = createLog();
    (readdir as Mock).mockImplementationOnce(() => Promise.reject(new Error('libuv exploded')));

    await expect(pruneCrashArtifactsAtBoot(log as never)).resolves.toBeUndefined();

    expect(log.warn).toHaveBeenCalledTimes(1);
    const logged = (log.warn.mock.calls[0]![0] as { error: Record<string, unknown> }).error;
    expect(logged).not.toBeInstanceOf(Error);
    expect(logged.type).toBe('Error');
  });

  // A boot helper that exists but is never called would pass every test above.
  it('both entry points are referenced by the server entrypoint', () => {
    const indexPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'index.ts');
    const source = readFileSync(indexPath, 'utf-8');

    expect(source).toContain("from './boot-crash-forensics.js';");
    expect(source).toContain('await pruneCrashArtifactsAtBoot(app.log);');
    expect(source).toContain('await checkCrashForensicsAtBoot(app.log);');
  });
});
