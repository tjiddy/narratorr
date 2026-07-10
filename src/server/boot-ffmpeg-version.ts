import type { FastifyBaseLogger } from 'fastify';
import { serializeError } from './utils/serialize-error.js';
import { deriveFfprobePath } from '../core/utils/ffprobe-path.js';
import { extractFfmpegMajor } from '../core/utils/ffmpeg-version.js';
import { detectFfmpegPath, probeFfmpeg } from '../core/utils/audio-processor.js';

/** Injected probes — mirror the `audio-processor` exports, kept as deps for testability. */
export interface FfmpegVersionProbeDeps {
  detectFfmpegPath: () => Promise<string | null>;
  probeFfmpeg: (path: string) => Promise<string>;
  /** The FFMPEG_PATH override value, if set (injected so boot tests don't read ambient env). */
  getFfmpegOverride?: () => string | undefined;
  /** The RAW stored ffmpegPath from an older version, if any (the removed setting). */
  getLegacyFfmpegPath?: () => Promise<string | undefined>;
}

/**
 * Best-effort startup probe that logs the detected ffmpeg version and the
 * resolved ffprobe path exactly once at `info` level (#1679).
 *
 * xHE-AAC / USAC import support is operationally dependent on the runtime ffmpeg
 * package being >= 8 (#1667). The CI smoke step guards the image at build time;
 * this log gives a 3am debugger the actually-installed version straight from the
 * boot output, without shelling into the container.
 *
 * Mirrors the fire-once, best-effort style of `boot-warnings.ts`: if ffmpeg is
 * unavailable or the probe throws, boot continues — the failure is logged at
 * `warn` (the thrown case via `serializeError()` per `narratorr/no-raw-error-logging`)
 * and never rethrown, so it cannot crash the process or block listening. It reuses
 * the existing `probeFfmpeg` spawn (which goes through `sanitizedEnv()`, #1549) and
 * `deriveFfprobePath` rather than introducing a second spawn path.
 */
export async function logFfmpegVersionAtBoot(
  deps: FfmpegVersionProbeDeps,
  log: FastifyBaseLogger,
): Promise<void> {
  try {
    const ffmpegPath = await deps.detectFfmpegPath();
    // Read the legacy stored path REGARDLESS of detection outcome. The editable ffmpeg-path
    // setting was removed in favor of auto-detection, so a previously-configured custom path
    // is now silently dropped — and the dangerous case is not "ffmpeg missing" but "a
    // *different* system ffmpeg was detected", which swaps binaries with no signal.
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
    // Guided migration: a stored custom path that differs from the resolved binary (and isn't
    // the active FFMPEG_PATH override) was dropped on upgrade — it may have been a newer or
    // purpose-built binary. Surface the swap rather than changing binaries invisibly.
    if (legacy && legacy !== ffmpegPath && legacy !== override) {
      log.warn(
        { legacyFfmpegPath: legacy, resolvedFfmpegPath: ffmpegPath },
        'A custom ffmpeg path was configured in an older version but is no longer used — narratorr resolved a different binary; set the FFMPEG_PATH environment variable to keep using the custom one',
      );
    }
    // The operator set FFMPEG_PATH but it did not win (it failed to probe, so detection fell
    // through). Surface the silent fallback rather than leaving a 3am "why is my override ignored".
    if (override && override !== ffmpegPath) {
      log.warn(
        { ffmpegPath: override, resolved: ffmpegPath },
        'FFMPEG_PATH was set but did not probe — using the auto-detected ffmpeg instead',
      );
    }
    const ffmpegVersion = await deps.probeFfmpeg(ffmpegPath);
    const ffprobePath = deriveFfprobePath(ffmpegPath);
    log.info({ ffmpegPath, ffmpegVersion, ffprobePath }, 'Detected ffmpeg/ffprobe');
    // Runtime complement to the build-time CI smoke gate (#1689): warn only when the
    // major is parseably < 8. Use extractFfmpegMajor (not ffmpegMajorAtLeast) so an
    // indeterminate/custom build (null major) stays info-only and never cries wolf.
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

/**
 * Boot orchestration for the ffmpeg/ffprobe version log (#1679).
 *
 * Binds the production `detectFfmpegPath` / `probeFfmpeg` probes (which spawn
 * through `sanitizedEnv()`, #1549) and forwards them to `logFfmpegVersionAtBoot`.
 * Extracted from `main()` — mirroring `checkReverseProxyBootConfig` in
 * `boot-warnings.ts` — so the production wiring AND the best-effort
 * never-rethrow contract are unit-testable without booting the server; the call
 * site in `index.ts` stays a single TypeScript-checked line.
 */
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
