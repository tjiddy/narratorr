import type { FastifyBaseLogger } from 'fastify';
import { serializeError } from './utils/serialize-error.js';
import { deriveFfprobePath } from '@core/utils/ffprobe-path.js';
import { extractFfmpegMajor } from '@core/utils/ffmpeg-version.js';
import { detectFfmpegPath, probeFfmpeg } from '@core/utils/audio-processor.js';

/** Injected audio-processor probes retained for deterministic boot tests. */
export interface FfmpegVersionProbeDeps {
  detectFfmpegPath: () => Promise<string | null>;
  probeFfmpeg: (path: string) => Promise<string>;
  /** Active FFMPEG_PATH override, isolated from ambient test environment. */
  getFfmpegOverride?: () => string | undefined;
  /** Raw value of the removed persisted ffmpegPath setting. */
  getLegacyFfmpegPath?: () => Promise<string | undefined>;
}

/** Best-effort boot probe; known ffmpeg < 8 lacks xHE-AAC support, but probing never blocks startup. */
export async function logFfmpegVersionAtBoot(
  deps: FfmpegVersionProbeDeps,
  log: FastifyBaseLogger,
): Promise<void> {
  try {
    const ffmpegPath = await deps.detectFfmpegPath();
    // Read legacy state even when detection fails so removed custom paths never disappear silently.
    const legacy = await deps.getLegacyFfmpegPath?.();
    const override = deps.getFfmpegOverride?.();

    if (!ffmpegPath) {
      log.warn('ffmpeg not found on the system; audio import/processing and xHE-AAC decode will be unavailable');
      if (legacy) {
        log.warn(
          { legacyFfmpegPath: legacy },
          'A custom ffmpeg path was configured in an older version but is no longer used — set the FFMPEG_PATH environment variable if you need a specific binary',
        );
      }
      return;
    }
    // Warn when an upgrade silently replaces a stored custom binary.
    if (legacy && legacy !== ffmpegPath && legacy !== override) {
      log.warn(
        { legacyFfmpegPath: legacy, resolvedFfmpegPath: ffmpegPath },
        'A custom ffmpeg path was configured in an older version but is no longer used — narratorr resolved a different binary; set the FFMPEG_PATH environment variable to keep using the custom one',
      );
    }
    // Surface an override that failed probing and lost to auto-detection.
    if (override && override !== ffmpegPath) {
      log.warn(
        { ffmpegPath: override, resolved: ffmpegPath },
        'FFMPEG_PATH was set but did not probe — using the auto-detected ffmpeg instead',
      );
    }
    const ffmpegVersion = await deps.probeFfmpeg(ffmpegPath);
    const ffprobePath = deriveFfprobePath(ffmpegPath);
    log.info({ ffmpegPath, ffmpegVersion, ffprobePath }, 'Detected ffmpeg/ffprobe');
    // Warn only for a parsed major; custom or indeterminate builds stay info-only.
    const major = extractFfmpegMajor(ffmpegVersion);
    if (major !== null && major < 8) {
      log.warn(
        { ffmpegVersion, ffmpegPath },
        'ffmpeg < 8 — xHE-AAC/USAC releases cannot be decoded and will be held for review (#1667/#1679)',
      );
    }
  } catch (error: unknown) {
    log.warn({ error: serializeError(error) }, 'Failed to probe ffmpeg version at startup');
  }
}

/** Bind the production probes while retaining the independently tested best-effort contract. */
export async function checkFfmpegVersionAtBoot(
  log: FastifyBaseLogger,
  settingsService?: { getLegacyFfmpegPath: () => Promise<string | undefined> },
): Promise<void> {
  await logFfmpegVersionAtBoot({
    detectFfmpegPath,
    probeFfmpeg,
    getFfmpegOverride: () => process.env.FFMPEG_PATH?.trim() || undefined,
    ...(settingsService && { getLegacyFfmpegPath: () => settingsService.getLegacyFfmpegPath() }),
  }, log);
}
