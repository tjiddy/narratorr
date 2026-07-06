import type { FastifyBaseLogger } from 'fastify';
import { serializeError } from './utils/serialize-error.js';
import { deriveFfprobePath } from '../core/utils/ffprobe-path.js';
import { extractFfmpegMajor } from '../core/utils/ffmpeg-version.js';
import { detectFfmpegPath, probeFfmpeg } from '../core/utils/audio-processor.js';

/** Injected probes — mirror the `audio-processor` exports, kept as deps for testability. */
export interface FfmpegVersionProbeDeps {
  detectFfmpegPath: () => Promise<string | null>;
  probeFfmpeg: (path: string) => Promise<string>;
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
    if (!ffmpegPath) {
      log.warn('ffmpeg not found on the system; audio import/processing and xHE-AAC decode will be unavailable');
      return;
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
export async function checkFfmpegVersionAtBoot(log: FastifyBaseLogger): Promise<void> {
  await logFfmpegVersionAtBoot({ detectFfmpegPath, probeFfmpeg }, log);
}
