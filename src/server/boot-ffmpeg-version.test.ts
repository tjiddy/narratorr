import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Mock } from 'vitest';

// Mock the production probes so the boot orchestration (`checkFfmpegVersionAtBoot`)
// can be exercised with the SAME real dependency module it wires in production —
// proving the wiring, not just the deps-injected helper.
vi.mock('../core/utils/audio-processor.js', () => ({
  detectFfmpegPath: vi.fn(),
  probeFfmpeg: vi.fn(),
}));

import { detectFfmpegPath, probeFfmpeg } from '../core/utils/audio-processor.js';
import { logFfmpegVersionAtBoot, checkFfmpegVersionAtBoot } from './boot-ffmpeg-version.js';
import { createMockLogger, inject } from './__tests__/helpers.js';
import type { FastifyBaseLogger } from 'fastify';

function calls(fn: unknown): unknown[][] {
  return (fn as { mock: { calls: unknown[][] } }).mock.calls;
}

describe('logFfmpegVersionAtBoot (#1679)', () => {
  it('logs ffmpeg version and ffprobe path once at info level on success', async () => {
    const log = inject<FastifyBaseLogger>(createMockLogger());
    const detectFfmpegPath = vi.fn().mockResolvedValue('/usr/bin/ffmpeg');
    const probeFfmpeg = vi.fn().mockResolvedValue('8.0.1');

    await logFfmpegVersionAtBoot({ detectFfmpegPath, probeFfmpeg }, log);

    expect(log.info).toHaveBeenCalledTimes(1);
    expect(log.warn).not.toHaveBeenCalled();
    const [payload] = calls(log.info)[0]! as [Record<string, unknown>, string];
    expect(payload).toMatchObject({
      ffmpegPath: '/usr/bin/ffmpeg',
      ffmpegVersion: '8.0.1',
      ffprobePath: '/usr/bin/ffprobe',
    });
    expect(probeFfmpeg).toHaveBeenCalledWith('/usr/bin/ffmpeg');
  });

  it('warns (best-effort) and does not throw when the probe rejects', async () => {
    const log = inject<FastifyBaseLogger>(createMockLogger());
    const detectFfmpegPath = vi.fn().mockResolvedValue('/usr/bin/ffmpeg');
    const probeFfmpeg = vi.fn().mockRejectedValue(new Error('spawn ENOENT'));

    await expect(
      logFfmpegVersionAtBoot({ detectFfmpegPath, probeFfmpeg }, log),
    ).resolves.toBeUndefined();

    expect(log.info).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledTimes(1);
    // Error routes through serializeError() — payload carries a structured error,
    // not a raw Error instance (narratorr/no-raw-error-logging).
    const [payload] = calls(log.warn)[0]! as [Record<string, unknown>, string];
    expect(payload.error).toMatchObject({ message: 'spawn ENOENT', type: 'Error' });
  });

  it('warns once about ffmpeg < 8 while still emitting the info log (#1689)', async () => {
    const log = inject<FastifyBaseLogger>(createMockLogger());
    const detectFfmpegPath = vi.fn().mockResolvedValue('/usr/bin/ffmpeg');
    const probeFfmpeg = vi.fn().mockResolvedValue('7.1.2');

    await logFfmpegVersionAtBoot({ detectFfmpegPath, probeFfmpeg }, log);

    // The existing info log is NOT suppressed by the new warn.
    expect(log.info).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledTimes(1);
    const [payload, message] = calls(log.warn)[0]! as [Record<string, unknown>, string];
    // Plain object payload, not an Error — the value never traced a catch binding.
    expect(payload).not.toBeInstanceOf(Error);
    expect(payload).toMatchObject({ ffmpegVersion: '7.1.2', ffmpegPath: '/usr/bin/ffmpeg' });
    expect(message).toMatch(/xHE-AAC|< 8/);
  });

  it('warns about a sub-8 distro-suffixed version (#1689)', async () => {
    const log = inject<FastifyBaseLogger>(createMockLogger());
    const detectFfmpegPath = vi.fn().mockResolvedValue('/usr/bin/ffmpeg');
    const probeFfmpeg = vi.fn().mockResolvedValue('6.1.1-3ubuntu5');

    await logFfmpegVersionAtBoot({ detectFfmpegPath, probeFfmpeg }, log);

    expect(log.info).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledTimes(1);
    const [payload] = calls(log.warn)[0]! as [Record<string, unknown>, string];
    expect(payload).toMatchObject({ ffmpegVersion: '6.1.1-3ubuntu5', ffmpegPath: '/usr/bin/ffmpeg' });
  });

  it('does not warn for ffmpeg major >= 8 (info only) (#1689)', async () => {
    const log = inject<FastifyBaseLogger>(createMockLogger());
    const detectFfmpegPath = vi.fn().mockResolvedValue('/usr/bin/ffmpeg');
    const probeFfmpeg = vi.fn().mockResolvedValue('8.0.1');

    await logFfmpegVersionAtBoot({ detectFfmpegPath, probeFfmpeg }, log);

    expect(log.info).toHaveBeenCalledTimes(1);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('does not warn for an unparseable/custom version (no false < 8 signal) (#1689)', async () => {
    const log = inject<FastifyBaseLogger>(createMockLogger());
    const detectFfmpegPath = vi.fn().mockResolvedValue('/usr/bin/ffmpeg');
    const probeFfmpeg = vi.fn().mockResolvedValue('ffmpeg version N-109060-gabcdef custom build');

    await logFfmpegVersionAtBoot({ detectFfmpegPath, probeFfmpeg }, log);

    // extractFfmpegMajor returns null here — must stay info-only, never warn.
    expect(log.info).toHaveBeenCalledTimes(1);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('does not warn at the >= 8 boundary (#1689)', async () => {
    const log = inject<FastifyBaseLogger>(createMockLogger());
    const detectFfmpegPath = vi.fn().mockResolvedValue('/usr/bin/ffmpeg');
    const probeFfmpeg = vi.fn().mockResolvedValue('8.0');

    await logFfmpegVersionAtBoot({ detectFfmpegPath, probeFfmpeg }, log);

    expect(log.info).toHaveBeenCalledTimes(1);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('warns and does not probe when ffmpeg is not found on the system', async () => {
    const log = inject<FastifyBaseLogger>(createMockLogger());
    const detectFfmpegPath = vi.fn().mockResolvedValue(null);
    const probeFfmpeg = vi.fn();

    await logFfmpegVersionAtBoot({ detectFfmpegPath, probeFfmpeg }, log);

    expect(probeFfmpeg).not.toHaveBeenCalled();
    expect(log.info).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(calls(log.warn)[0]![0] as string).toMatch(/ffmpeg/i);
  });

  it('warns that FFMPEG_PATH did not win when the override differs from the resolved path (P3-10)', async () => {
    const log = inject<FastifyBaseLogger>(createMockLogger());
    const detectFfmpegPath = vi.fn().mockResolvedValue('/usr/bin/ffmpeg');
    const probeFfmpeg = vi.fn().mockResolvedValue('8.0.1');
    const getFfmpegOverride = () => '/custom/ffmpeg';

    await logFfmpegVersionAtBoot({ detectFfmpegPath, probeFfmpeg, getFfmpegOverride }, log);

    expect(log.info).toHaveBeenCalledTimes(1); // version log still emitted
    expect(log.warn).toHaveBeenCalledTimes(1);
    const [payload, message] = calls(log.warn)[0]! as [Record<string, unknown>, string];
    expect(payload).toMatchObject({ ffmpegPath: '/custom/ffmpeg', resolved: '/usr/bin/ffmpeg' });
    expect(message).toMatch(/FFMPEG_PATH/);
  });

  it('does NOT warn about the override when it matches the resolved path (P3-10)', async () => {
    const log = inject<FastifyBaseLogger>(createMockLogger());
    const detectFfmpegPath = vi.fn().mockResolvedValue('/custom/ffmpeg');
    const probeFfmpeg = vi.fn().mockResolvedValue('8.0.1');
    const getFfmpegOverride = () => '/custom/ffmpeg';

    await logFfmpegVersionAtBoot({ detectFfmpegPath, probeFfmpeg, getFfmpegOverride }, log);

    expect(log.warn).not.toHaveBeenCalled();
  });

  it('warns about a dropped legacy ffmpegPath when ffmpeg is not found (P2-3)', async () => {
    const log = inject<FastifyBaseLogger>(createMockLogger());
    const detectFfmpegPath = vi.fn().mockResolvedValue(null);
    const probeFfmpeg = vi.fn();
    const getLegacyFfmpegPath = vi.fn().mockResolvedValue('/opt/custom/ffmpeg');

    await logFfmpegVersionAtBoot({ detectFfmpegPath, probeFfmpeg, getLegacyFfmpegPath }, log);

    expect(probeFfmpeg).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledTimes(2); // "not found" + guided-migration
    const legacyWarn = calls(log.warn).find(([p]) => (p as Record<string, unknown>)?.legacyFfmpegPath);
    expect(legacyWarn).toBeDefined();
    expect((legacyWarn![0] as Record<string, unknown>).legacyFfmpegPath).toBe('/opt/custom/ffmpeg');
    expect(legacyWarn![1] as string).toMatch(/FFMPEG_PATH/);
  });

  it('warns about a dropped legacy path even when a DIFFERENT ffmpeg is found (finding 1)', async () => {
    const log = inject<FastifyBaseLogger>(createMockLogger());
    const detectFfmpegPath = vi.fn().mockResolvedValue('/usr/bin/ffmpeg');
    const probeFfmpeg = vi.fn().mockResolvedValue('8.0.1');
    const getLegacyFfmpegPath = vi.fn().mockResolvedValue('/opt/custom/ffmpeg');

    await logFfmpegVersionAtBoot({ detectFfmpegPath, probeFfmpeg, getLegacyFfmpegPath }, log);

    // The dangerous case is a SILENT binary swap: a configured custom path is dropped while a
    // different system ffmpeg is used. It must warn (naming both paths + FFMPEG_PATH), not stay quiet.
    expect(getLegacyFfmpegPath).toHaveBeenCalledTimes(1);
    const legacyWarn = calls(log.warn).find(([p]) => (p as Record<string, unknown>)?.legacyFfmpegPath);
    expect(legacyWarn).toBeDefined();
    expect(legacyWarn![0]).toMatchObject({ legacyFfmpegPath: '/opt/custom/ffmpeg', resolvedFfmpegPath: '/usr/bin/ffmpeg' });
    expect(legacyWarn![1] as string).toMatch(/FFMPEG_PATH/);
  });

  it('does NOT warn when the legacy path equals the resolved binary (finding 1)', async () => {
    const log = inject<FastifyBaseLogger>(createMockLogger());
    const detectFfmpegPath = vi.fn().mockResolvedValue('/usr/bin/ffmpeg');
    const probeFfmpeg = vi.fn().mockResolvedValue('8.0.1');
    const getLegacyFfmpegPath = vi.fn().mockResolvedValue('/usr/bin/ffmpeg'); // same as resolved → no swap

    await logFfmpegVersionAtBoot({ detectFfmpegPath, probeFfmpeg, getLegacyFfmpegPath }, log);

    expect(log.warn).not.toHaveBeenCalled();
  });
});

describe('checkFfmpegVersionAtBoot — production wiring (#1679 F2)', () => {
  // Isolate FFMPEG_PATH: checkFfmpegVersionAtBoot binds the real env override, so a dev box
  // with it set would spuriously fire the P3-10 warning and skew warn-count assertions.
  let savedFfmpegPathEnv: string | undefined;
  beforeEach(() => {
    savedFfmpegPathEnv = process.env.FFMPEG_PATH;
    delete process.env.FFMPEG_PATH;
    (detectFfmpegPath as Mock).mockReset();
    (probeFfmpeg as Mock).mockReset();
  });

  afterEach(() => {
    if (savedFfmpegPathEnv === undefined) delete process.env.FFMPEG_PATH;
    else process.env.FFMPEG_PATH = savedFfmpegPathEnv;
  });

  it('wires the production detectFfmpegPath/probeFfmpeg probes and logs once on success', async () => {
    const log = inject<FastifyBaseLogger>(createMockLogger());
    (detectFfmpegPath as Mock).mockResolvedValue('/usr/bin/ffmpeg');
    (probeFfmpeg as Mock).mockResolvedValue('8.0.1');

    await checkFfmpegVersionAtBoot(log);

    expect(detectFfmpegPath).toHaveBeenCalledTimes(1);
    expect(probeFfmpeg).toHaveBeenCalledWith('/usr/bin/ffmpeg');
    expect(log.info).toHaveBeenCalledTimes(1);
    const [payload] = calls(log.info)[0]! as [Record<string, unknown>, string];
    expect(payload).toMatchObject({
      ffmpegPath: '/usr/bin/ffmpeg',
      ffmpegVersion: '8.0.1',
      ffprobePath: '/usr/bin/ffprobe',
    });
  });

  it('stays best-effort: resolves (boot proceeds) and warns when the production probe rejects', async () => {
    const log = inject<FastifyBaseLogger>(createMockLogger());
    (detectFfmpegPath as Mock).mockResolvedValue('/usr/bin/ffmpeg');
    (probeFfmpeg as Mock).mockRejectedValue(new Error('spawn ENOENT'));

    // Resolving without throwing is the contract that lets main() reach listen().
    await expect(checkFfmpegVersionAtBoot(log)).resolves.toBeUndefined();

    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.info).not.toHaveBeenCalled();
  });

  it('wires getLegacyFfmpegPath from the settings service and warns on a dropped config (P2-3)', async () => {
    const log = inject<FastifyBaseLogger>(createMockLogger());
    (detectFfmpegPath as Mock).mockResolvedValue(null);
    const settingsService = { getLegacyFfmpegPath: vi.fn().mockResolvedValue('/opt/x/ffmpeg') };

    await checkFfmpegVersionAtBoot(log, settingsService);

    expect(settingsService.getLegacyFfmpegPath).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledTimes(2); // not-found + dropped-config
  });
});
