import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
// Imported by path, not via the core/utils barrel — the barrel is excluded from the Vite client
// build, and sanitizedEnv is Node-only. Mirrors the audio-processor / script call sites.
import { sanitizedEnv } from './sanitized-env.js';

const execFileAsync = promisify(execFile);

/**
 * Probe an ffmpeg binary at the given path. Returns the version string on success.
 * The 10s timeout is load-bearing: boot awaits detection, so a hung binary must not brick startup.
 */
export async function probeFfmpeg(ffmpegPath: string): Promise<string> {
  const { stdout } = await execFileAsync(ffmpegPath, ['-version'], { timeout: 10_000, env: sanitizedEnv() });
  const firstLine = stdout.split('\n')[0]!;
  const versionMatch = firstLine.match(/ffmpeg version (\S+)/);
  return versionMatch ? versionMatch[1]! : firstLine.trim();
}

/**
 * Discover ffmpeg on the system. Returns the absolute path if found, null otherwise.
 * Order: `$FFMPEG_PATH` override → `/usr/bin/ffmpeg` → `which ffmpeg` — every candidate is PROBED
 * before it is trusted, so a non-running binary never reads as available.
 */
export async function detectFfmpegPath(): Promise<string | null> {
  // Operator override for non-standard installs (bare-metal, custom image). Honored
  // first, but a non-probing override falls through to auto-detection rather than
  // hard-failing — so a stale FFMPEG_PATH never bricks a working container binary.
  const override = process.env.FFMPEG_PATH?.trim();
  if (override) {
    try {
      await probeFfmpeg(override);
      return override;
    } catch {
      // override didn't probe — fall through to auto-detection
    }
  }
  const knownPath = '/usr/bin/ffmpeg';
  try {
    await probeFfmpeg(knownPath);
    return knownPath;
  } catch {
    // fall through to which
  }
  try {
    const { stdout } = await execFileAsync('which', ['ffmpeg'], { timeout: 10_000, env: sanitizedEnv() });
    const resolved = stdout.trim();
    // Probe the PATH candidate before trusting it: a `which` hit that can't run `-version`
    // (broken/partial install) must NOT be returned as usable, or the service gates would
    // admit work the status route's fresh probe reports as unavailable (two definitions of
    // "available"). Falling through to null keeps the gate and the status row in agreement.
    if (resolved) {
      await probeFfmpeg(resolved);
      return resolved;
    }
  } catch {
    // not found, or the PATH candidate failed to probe
  }
  return null;
}

// ffmpeg is baked into the container, so a *successful* detect is memoized for the process
// lifetime. A miss is NOT cached forever (an operator can install ffmpeg at runtime) but is
// held under a short negative TTL so a degraded library scan doesn't re-spawn `probe + which`
// once per book; concurrent callers coalesce onto a single in-flight detection.
const FFMPEG_MISS_TTL_MS = 30_000;
let cachedFfmpegPath: string | null = null;
let ffmpegInFlight: Promise<string | null> | null = null;
let ffmpegMissUntil = 0;

/** Resolve ffmpeg's absolute path (cached on success; negative-TTL + single-flight on a miss), or null. */
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

/** Test-only: clear the memoized path + negative-TTL + in-flight state between cases. */
export function resetFfmpegPathCache(): void {
  cachedFfmpegPath = null;
  ffmpegInFlight = null;
  ffmpegMissUntil = 0;
}
