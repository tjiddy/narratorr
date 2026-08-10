import type { FastifyBaseLogger } from 'fastify';
import { serializeError } from './utils/serialize-error.js';
import { detectMutagenPython, type MutagenDetection } from '@core/utils/mutagen-resolver.js';

/** Injected probe retained for deterministic boot tests, mirroring `FfmpegVersionProbeDeps`. */
export interface MutagenVersionProbeDeps {
  detectMutagenPython: () => Promise<MutagenDetection | null>;
}

/**
 * The core resolver stays pure and logs nothing — `eslint.config.js` forbids `src/core/**` from
 * importing fastify precisely so core adapters return failures and let the calling service log.
 * This helper owns the operator-facing warnings, and like its ffmpeg twin it never blocks boot;
 * the health check is the gated surface.
 */
export async function logMutagenVersionAtBoot(
  deps: MutagenVersionProbeDeps,
  log: FastifyBaseLogger,
): Promise<void> {
  try {
    const detection = await deps.detectMutagenPython();

    if (!detection) {
      log.warn('Python with the mutagen module not found; audio tag embedding will be unavailable — install it or set MUTAGEN_PYTHON');
      return;
    }
    // Surface an override that failed probing and lost to auto-detection.
    if (detection.overrideSuperseded) {
      log.warn(
        { mutagenPython: detection.override, resolved: detection.python },
        'MUTAGEN_PYTHON was set but did not import mutagen — using the auto-detected interpreter instead',
      );
    }
    log.info(
      { mutagenPython: detection.python, mutagenVersion: detection.version },
      'Detected mutagen',
    );
  } catch (error: unknown) {
    log.warn({ error: serializeError(error) }, 'Failed to probe mutagen at startup');
  }
}

/** Bind the production probe while retaining the independently tested best-effort contract. */
export async function checkMutagenVersionAtBoot(log: FastifyBaseLogger): Promise<void> {
  await logMutagenVersionAtBoot({ detectMutagenPython }, log);
}
