import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
// Direct import: sanitizedEnv is Node-only; this module must stay out of the Vite-facing barrel.
import { sanitizedEnv } from './sanitized-env.js';

const execFileAsync = promisify(execFile);

export interface MutagenDetection {
  /** The interpreter that probed successfully; used for both the probe and every write. */
  python: string;
  version: string;
  /** MUTAGEN_PYTHON as set, whether or not it won. */
  override: string | undefined;
  /** An override was set but a different interpreter resolved — the server boot helper warns. */
  overrideSuperseded: boolean;
}

/**
 * A candidate only counts when the import succeeds, so detection and use cannot disagree: a Python
 * without mutagen is a miss, not a hit. The 10s timeout is load-bearing — boot awaits detection,
 * so a hung interpreter must not brick startup.
 */
export async function probeMutagen(pythonPath: string): Promise<string> {
  const { stdout } = await execFileAsync(
    pythonPath,
    ['-c', 'import mutagen; print(mutagen.version_string)'],
    { timeout: 10_000, env: sanitizedEnv() },
  );
  return stdout.trim();
}

/** Mirrors `detectFfmpegPath`: a stale or mutagen-less override must not block a working default. */
export async function detectMutagenPython(): Promise<MutagenDetection | null> {
  const override = process.env.MUTAGEN_PYTHON?.trim() || undefined;
  if (override) {
    try {
      return { python: override, version: await probeMutagen(override), override, overrideSuperseded: false };
    } catch {
      // Fall through; the boot helper reports the substitution once a default resolves.
    }
  }

  const knownPath = '/usr/bin/python3';
  try {
    return { python: knownPath, version: await probeMutagen(knownPath), override, overrideSuperseded: !!override };
  } catch {
    // Fall through to the PATH lookup.
  }

  try {
    const { stdout } = await execFileAsync('which', ['python3'], { timeout: 10_000, env: sanitizedEnv() });
    const resolved = stdout.trim();
    if (resolved) {
      return { python: resolved, version: await probeMutagen(resolved), override, overrideSuperseded: !!override };
    }
  } catch {
    // No usable PATH candidate was found.
  }
  return null;
}

// Cache successes for the process; cache misses briefly and coalesce concurrent detection.
const MUTAGEN_MISS_TTL_MS = 30_000;
let cachedDetection: MutagenDetection | null = null;
let detectionInFlight: Promise<MutagenDetection | null> | null = null;
let mutagenMissUntil = 0;

export async function resolveMutagenDetection(): Promise<MutagenDetection | null> {
  if (cachedDetection) return cachedDetection;
  if (Date.now() < mutagenMissUntil) return null;
  if (detectionInFlight) return detectionInFlight;
  detectionInFlight = (async () => {
    try {
      const detection = await detectMutagenPython();
      if (detection) cachedDetection = detection;
      else mutagenMissUntil = Date.now() + MUTAGEN_MISS_TTL_MS;
      return detection;
    } finally {
      detectionInFlight = null;
    }
  })();
  return detectionInFlight;
}

export async function resolveMutagenPython(): Promise<string | null> {
  return (await resolveMutagenDetection())?.python ?? null;
}

/** Test-only. */
export function resetMutagenPythonCache(): void {
  cachedDetection = null;
  detectionInFlight = null;
  mutagenMissUntil = 0;
}
