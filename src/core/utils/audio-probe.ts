import { extname } from 'node:path';
import { execFile } from 'node:child_process';
// Imported by path, not via the core/utils barrel (Node-only; barrel feeds the Vite client build).
import { sanitizedEnv } from './sanitized-env.js';
import type { AudioScanResult, AudioScanOptions, MetadataFormat } from './audio-scanner.js';

/** Technical fields ffprobe can supply when music-metadata cannot read the codec. */
interface FFprobeStreamInfo {
  codec: string;
  bitrate?: number;
  sampleRate?: number;
  channels?: number;
}

/**
 * Single canonical ffprobe exec-and-parse skeleton for every entry in this module.
 *
 * Owns the security-relevant contract the three public probe helpers share: a
 * no-shell `execFile` with `{ timeout: 10_000, env: sanitizedEnv() }` (sanitizedEnv
 * strips NARRATORR_SECRET_KEY/DATABASE_URL and every non-allowlisted var from the
 * subprocess env), JSON parsing of stdout, and a graceful-null contract — it never
 * throws: the single `catch` covers a rejected exec Promise (spawn error, non-zero
 * exit, timeout) and a `JSON.parse` failure alike, returning `null`. Callers supply
 * only the per-entry `argv` and an `extract` callback that narrows the parsed JSON.
 *
 * This is intentionally private and NOT added to the core/utils barrel (this module
 * is Node-only and imported by path; the barrel feeds the Vite client build). It is
 * also the one place a future `--` end-of-options separator would land — a one-line
 * change instead of three.
 */
async function runFfprobeJson<T>(
  ffprobePath: string,
  argv: string[],
  extract: (parsed: unknown) => T | null,
): Promise<T | null> {
  try {
    const { stdout } = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      execFile(ffprobePath, argv, { timeout: 10_000, env: sanitizedEnv() }, (error, stdout, stderr) => {
        if (error) reject(error);
        else resolve({ stdout: stdout as string, stderr: stderr as string });
      });
    });
    return extract(JSON.parse(stdout));
  } catch {
    return null;
  }
}

/**
 * Get duration of a single audio file using ffprobe.
 * Returns the duration in seconds, or null if ffprobe fails or returns invalid data.
 */
export async function getFFprobeDuration(ffprobePath: string, filePath: string): Promise<number | null> {
  return runFfprobeJson(
    ffprobePath,
    ['-v', 'quiet', '-show_entries', 'format=duration', '-of', 'json', filePath],
    (parsed) => {
      const format = (parsed as { format?: { duration?: string } } | null)?.format;
      const duration = parseFloat(format?.duration as string);
      if (!Number.isFinite(duration) || duration <= 0) return null;
      return duration;
    },
  );
}

/**
 * Get the **stream-level** duration of a single audio file via ffprobe.
 *
 * This is a deliberately *different* ffprobe entry than `getFFprobeDuration`'s
 * `format=duration`: it queries `stream=duration` on the first audio stream, so it
 * can recover a duration for containers that expose a stream-level duration but no
 * `format`-level one (fragmented / streamed / atypical MP4s — exactly the
 * xHE-AAC-class releases the codec fallback exists to rescue). Mirrors
 * `getFFprobeDuration`'s signature and graceful-null contract: returns the duration
 * in seconds, or null if ffprobe fails, times out, returns malformed JSON, or
 * yields an absent / `<= 0` value. Never throws.
 */
export async function getFFprobeStreamDuration(ffprobePath: string, filePath: string): Promise<number | null> {
  return runFfprobeJson(
    ffprobePath,
    ['-v', 'quiet', '-select_streams', 'a:0', '-show_entries', 'stream=duration', '-of', 'json', filePath],
    (parsed) => {
      const stream = (parsed as { streams?: Array<{ duration?: string }> } | null)?.streams?.[0];
      const duration = parseFloat(stream?.duration as string);
      if (!Number.isFinite(duration) || duration <= 0) return null;
      return duration;
    },
  );
}

/**
 * Read a single audio file's first audio stream technical info via ffprobe.
 * This is the codec fallback for files music-metadata cannot read — notably
 * xHE-AAC / USAC, whose pure-JS parser yields no codec (which ffmpeg ≥ 7.1 / the
 * 3.23 image's 8.x decodes). Returns null if ffprobe is unavailable, errors,
 * times out, returns malformed JSON, or yields no stream with a codec name.
 * Never throws — mirrors the graceful-null shape of `getFFprobeDuration`.
 */
export async function getFFprobeStreamInfo(ffprobePath: string, filePath: string): Promise<FFprobeStreamInfo | null> {
  return runFfprobeJson(
    ffprobePath,
    ['-v', 'quiet', '-select_streams', 'a:0', '-show_entries', 'stream=codec_name,bit_rate,sample_rate,channels', '-of', 'json', filePath],
    (parsed) => {
      const stream = (
        parsed as {
          streams?: Array<{ codec_name?: unknown; bit_rate?: unknown; sample_rate?: unknown; channels?: unknown }>;
        } | null
      )?.streams?.[0];
      if (!stream || typeof stream.codec_name !== 'string' || stream.codec_name.length === 0) return null;
      const info: FFprobeStreamInfo = { codec: stream.codec_name };
      // bit_rate is a bps string (e.g. "128000") — store as a bps number to match the
      // music-metadata semantics already in AudioScanResult.bitrate (never kbps).
      const bitrate = Number.parseInt(String(stream.bit_rate), 10);
      if (Number.isFinite(bitrate)) info.bitrate = bitrate;
      const sampleRate = Number.parseInt(String(stream.sample_rate), 10);
      if (Number.isFinite(sampleRate)) info.sampleRate = sampleRate;
      if (typeof stream.channels === 'number') info.channels = stream.channels;
      return info;
    },
  );
}

/**
 * A duration claim below this implied bitrate (bps) is implausible — but only once the
 * claimed duration exceeds MIN_GUARDED_DURATION_SECONDS (see the floor's gate below). The
 * lie class this catches claims *hours* for minutes-long files (The Rise of Endymion:
 * 2,882,020 bytes claiming 27,868 s ⇒ 827 bps). Library observed minimum is 32 kbps, so 8
 * kbps leaves generous headroom; measured false-rejection count on the live library is 0.
 * music-metadata reports bitrate in bps, so this constant is bps (never kbps — #see the
 * bitrate-bps-kbps-boundary learning).
 */
export const MIN_PLAUSIBLE_BITRATE_BPS = 8000;
/**
 * The floor (min-bitrate) check fires only when the *claimed* duration exceeds this many
 * seconds (30 min). Short low-bitrate files are legitimate — the tracked e2e fixture
 * `e2e/assets/silent.m4b` (4,297 bytes, ~10 s ⇒ ~3.4 kbps implied) and real-library
 * stingers/intros are the same shape; gating the floor on claimed duration lets them pass.
 */
export const MIN_GUARDED_DURATION_SECONDS = 1800;
/**
 * A duration claim above this implied bitrate (bps) is implausible unconditionally — it
 * catches gross too-SHORT lies (a source claiming seconds for a whole book: 1 GB @ 60 s ⇒
 * 133 Mbps). Deliberately generous: embedded cover art inflates a short file's implied
 * bitrate (10 s + 2 MB art ⇒ ~1.6 Mbps — honest, passes), and no real audio class in this
 * library approaches 10 Mbps.
 */
export const MAX_PLAUSIBLE_BITRATE_BPS = 10_000_000;

/**
 * Is a duration claim plausible for a file of `fileSize` bytes?
 *
 * Single home for both music-metadata and ffprobe duration values (mm can return
 * `undefined`/`0`, ffprobe can yield `NaN`); the two input validations run first and
 * unconditionally, so `NaN`/`Infinity`/`0`/negative for either input resolve to
 * implausible without any division-by-zero and without slipping past the duration-gated
 * floor. A claim is implausible iff any of:
 *   - `duration` is not a finite number, or `duration <= 0`;
 *   - `fileSize` is not a finite number, or `fileSize <= 0`;
 *   - implied bitrate `fileSize * 8 / duration` < MIN_PLAUSIBLE_BITRATE_BPS AND the claimed
 *     `duration` > MIN_GUARDED_DURATION_SECONDS (duration-gated floor);
 *   - implied bitrate > MAX_PLAUSIBLE_BITRATE_BPS (unconditional ceiling).
 *
 * Honest limitation: this catches *gross* lies only. A subtle error inside both bounds —
 * e.g. a 2× halving recurrence on a normal-bitrate file (128 kbps read as an apparent 256
 * kbps) — is undetectable by any bitrate check; a downstream duration-mismatch comparison
 * (where one exists) is the backstop for that class.
 */
export function isPlausibleDuration(duration: number | undefined, fileSize: number): boolean {
  if (typeof duration !== 'number' || !Number.isFinite(duration) || duration <= 0) return false;
  if (!Number.isFinite(fileSize) || fileSize <= 0) return false;
  const impliedBitrateBps = (fileSize * 8) / duration;
  if (impliedBitrateBps < MIN_PLAUSIBLE_BITRATE_BPS && duration > MIN_GUARDED_DURATION_SECONDS) return false;
  if (impliedBitrateBps > MAX_PLAUSIBLE_BITRATE_BPS) return false;
  return true;
}

/**
 * Implied bitrate (bps) for a duration claim, or `undefined` when it can't be computed
 * (non-finite / non-positive inputs). Used only to enrich the rejected-duration diagnostic.
 */
function impliedBitrateBps(duration: number | undefined, fileSize: number): number | undefined {
  if (typeof duration !== 'number' || !Number.isFinite(duration) || duration <= 0) return undefined;
  if (!Number.isFinite(fileSize) || fileSize <= 0) return undefined;
  return (fileSize * 8) / duration;
}

/**
 * Resolve the duration for a single file: music-metadata primary, ffprobe fallback/arbiter.
 *
 * music-metadata's duration is already parsed (for tags) on every file and — since the
 * v11.13.0 bump fixed the 64-bit atom halving (#434) — trusted: when it is present and
 * plausible we return it and spawn NO ffprobe (the perf contract). ffprobe is consulted
 * only when mm's value is missing or implausible; a plausible ffprobe answer wins, and
 * when NEITHER source is plausible the file's duration is omitted (`undefined`) rather than
 * resurrecting a known-implausible mm value. Logs diagnostics on disagreement and omission.
 */
export async function resolveFileDuration(
  filePath: string,
  metadataDuration: number | undefined,
  fileSize: number,
  ffprobePath: string | undefined,
  onWarn: AudioScanOptions['onWarn'],
  onDebug: AudioScanOptions['onDebug'],
): Promise<number | undefined> {
  // Happy path: mm duration present and plausible → return it, no ffprobe spawn.
  if (isPlausibleDuration(metadataDuration, fileSize)) return metadataDuration;

  const ffprobeDuration = ffprobePath ? await getFFprobeDuration(ffprobePath, filePath) : null;
  if (ffprobeDuration !== null && isPlausibleDuration(ffprobeDuration, fileSize)) {
    // ffprobe arbitrated: retain the existing >10% disagreement diagnostic, guarded on a
    // positive mm value so an mm value of 0 never produces a division-by-zero warn payload.
    if (metadataDuration && metadataDuration > 0) {
      const diff = Math.abs(ffprobeDuration - metadataDuration) / metadataDuration;
      if (diff > 0.1) {
        onWarn?.('ffprobe/music-metadata duration mismatch (>10%)', { filePath, ffprobeDuration, metadataDuration });
      }
    }
    return ffprobeDuration;
  }

  // Neither source produced a plausible duration — omit it. An honestly-absent duration is
  // better than summing a known lie; the implausible mm value is never resurrected.
  reportRejectedDuration({ filePath, metadataDuration, ffprobeDuration, fileSize, onWarn, onDebug });
  return undefined;
}

/**
 * Diagnose a fully-rejected duration. When a rejected value can actually be *named* — a
 * present-but-implausible mm or ffprobe value — emit a warn naming the value(s) and implied
 * bitrate(s). When neither source produced a value to name (mm missing + ffprobe null/spawn
 * failure), there is nothing to report as rejected, so it degrades to a debug diagnostic.
 */
function reportRejectedDuration(args: {
  filePath: string;
  metadataDuration: number | undefined;
  ffprobeDuration: number | null;
  fileSize: number;
  onWarn: AudioScanOptions['onWarn'];
  onDebug: AudioScanOptions['onDebug'];
}): void {
  const { filePath, metadataDuration, ffprobeDuration, fileSize, onWarn, onDebug } = args;
  const payload = {
    filePath,
    metadataDuration,
    ffprobeDuration,
    fileSize,
    metadataImpliedBitrateBps: impliedBitrateBps(metadataDuration, fileSize),
    ffprobeImpliedBitrateBps: impliedBitrateBps(ffprobeDuration ?? undefined, fileSize),
  };
  const hasNamedRejection =
    (typeof metadataDuration === 'number' && Number.isFinite(metadataDuration) && metadataDuration > 0) ||
    (ffprobeDuration !== null && ffprobeDuration > 0);
  if (hasNamedRejection) {
    onWarn?.('duration omitted: no plausible value from music-metadata or ffprobe', payload);
  } else {
    onDebug?.('duration omitted: neither music-metadata nor ffprobe produced a duration', payload);
  }
}

/**
 * Fill technical fields from ffprobe when music-metadata left the codec empty.
 * Music-metadata values already present are preserved (AC4); ffprobe only fills
 * the gaps. A valid codec with 0 bitrate/channels is accepted (don't reject odd
 * but real streams). No-op when ffprobe finds no readable stream — the scan then
 * falls through to the null guard / onFilesWithoutCodec signal.
 */
export async function fillTechnicalViaFFprobe(
  result: AudioScanResult,
  mmFormat: MetadataFormat,
  filePath: string,
  ffprobePath: string,
  onDebug: AudioScanOptions['onDebug'],
): Promise<void> {
  const info = await getFFprobeStreamInfo(ffprobePath, filePath);
  if (!info) {
    onDebug?.('ffprobe codec fallback found no readable audio stream', { filePath });
    return;
  }
  result.codec = info.codec;
  result.bitrate = mmFormat.bitrate ?? info.bitrate ?? 0;
  result.sampleRate = mmFormat.sampleRate ?? info.sampleRate ?? 0;
  result.channels = mmFormat.numberOfChannels ?? info.channels ?? 0;
  result.fileFormat = extname(filePath).slice(1).toLowerCase();
  if (result.bitrate) result.bitrateMode = 'cbr';
}
