import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
// Direct import: sanitizedEnv is Node-only; this module must stay out of the Vite-facing barrel.
import { sanitizedEnv } from './sanitized-env.js';

const execFileAsync = promisify(execFile);

/** The 10s timeout is load-bearing: boot awaits detection, so a hung binary must not brick startup. */
export async function probeFfmpeg(ffmpegPath: string): Promise<string> {
  const { stdout } = await execFileAsync(ffmpegPath, ['-version'], { timeout: 10_000, env: sanitizedEnv() });
  const firstLine = stdout.split('\n')[0]!;
  const versionMatch = firstLine.match(/ffmpeg version (\S+)/);
  return versionMatch ? versionMatch[1]! : firstLine.trim();
}

/** Returns the first candidate that successfully runs `-version`. */
export async function detectFfmpegPath(): Promise<string | null> {
  const override = process.env.FFMPEG_PATH?.trim();
  if (override) {
    try {
      await probeFfmpeg(override);
      return override;
    } catch {
      // A stale override must not block a working system binary.
    }
  }
  const knownPath = '/usr/bin/ffmpeg';
  try {
    await probeFfmpeg(knownPath);
    return knownPath;
  } catch {
    // Fall through to the PATH lookup.
  }
  try {
    const { stdout } = await execFileAsync('which', ['ffmpeg'], { timeout: 10_000, env: sanitizedEnv() });
    const resolved = stdout.trim();
    // Detection and status must agree; a `which` hit is unusable until it runs.
    if (resolved) {
      await probeFfmpeg(resolved);
      return resolved;
    }
  } catch {
    // No usable PATH candidate was found.
  }
  return null;
}

// Cache successes for the process; cache misses briefly and coalesce concurrent detection.
const FFMPEG_MISS_TTL_MS = 30_000;
let cachedFfmpegPath: string | null = null;
let ffmpegInFlight: Promise<string | null> | null = null;
let ffmpegMissUntil = 0;

export async function resolveFfmpegPath(): Promise<string | null> {
  if (cachedFfmpegPath) return cachedFfmpegPath;
  if (Date.now() < ffmpegMissUntil) return null;
  if (ffmpegInFlight) return ffmpegInFlight;
  ffmpegInFlight = (async () => {
    try {
      const path = await detectFfmpegPath();
      if (path) cachedFfmpegPath = path;
      else ffmpegMissUntil = Date.now() + FFMPEG_MISS_TTL_MS;
      return path;
    } finally {
      ffmpegInFlight = null;
    }
  })();
  return ffmpegInFlight;
}

/** Test-only. */
export function resetFfmpegPathCache(): void {
  cachedFfmpegPath = null;
  ffmpegInFlight = null;
  ffmpegMissUntil = 0;
}
