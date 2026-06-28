import { describe, it, expect, vi, beforeEach } from 'vitest';
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
});

describe('checkFfmpegVersionAtBoot — production wiring (#1679 F2)', () => {
  beforeEach(() => {
    (detectFfmpegPath as Mock).mockReset();
    (probeFfmpeg as Mock).mockReset();
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
});
