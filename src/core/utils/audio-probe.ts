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
 * Get duration of a single audio file using ffprobe.
 * Returns the duration in seconds, or null if ffprobe fails or returns invalid data.
 */
export async function getFFprobeDuration(ffprobePath: string, filePath: string): Promise<number | null> {
  try {
    const { stdout } = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      execFile(
        ffprobePath,
        ['-v', 'quiet', '-show_entries', 'format=duration', '-of', 'json', filePath],
        { timeout: 10_000, env: sanitizedEnv() },
        (error, stdout, stderr) => {
          if (error) reject(error);
          else resolve({ stdout: stdout as string, stderr: stderr as string });
        },
      );
    });
    const parsed = JSON.parse(stdout);
    const duration = parseFloat(parsed?.format?.duration);
    if (!Number.isFinite(duration) || duration <= 0) return null;
    return duration;
  } catch {
    return null;
  }
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
  try {
    const { stdout } = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      execFile(
        ffprobePath,
        ['-v', 'quiet', '-select_streams', 'a:0', '-show_entries', 'stream=codec_name,bit_rate,sample_rate,channels', '-of', 'json', filePath],
        { timeout: 10_000, env: sanitizedEnv() },
        (error, stdout, stderr) => {
          if (error) reject(error);
          else resolve({ stdout: stdout as string, stderr: stderr as string });
        },
      );
    });
    const parsed = JSON.parse(stdout);
    const stream = parsed?.streams?.[0];
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
  } catch {
    return null;
  }
}

/**
 * Resolve the duration for a single file: ffprobe if available, music-metadata fallback.
 * Logs diagnostics when the two sources disagree or ffprobe fails.
 */
export async function resolveFileDuration(
  filePath: string,
  metadataDuration: number | undefined,
  ffprobePath: string | undefined,
  onWarn: AudioScanOptions['onWarn'],
  onDebug: AudioScanOptions['onDebug'],
): Promise<number | undefined> {
  if (!ffprobePath) return metadataDuration ?? undefined;

  const ffprobeDuration = await getFFprobeDuration(ffprobePath, filePath);
  if (ffprobeDuration === null) {
    onDebug?.('ffprobe failed for file, falling back to music-metadata duration', { filePath });
    return metadataDuration ?? undefined;
  }

  // Warn if ffprobe and music-metadata differ significantly
  if (metadataDuration && metadataDuration > 0) {
    const diff = Math.abs(ffprobeDuration - metadataDuration) / metadataDuration;
    if (diff > 0.1) {
      onWarn?.('ffprobe/music-metadata duration mismatch (>10%)', { filePath, ffprobeDuration, metadataDuration });
    }
  }
  return ffprobeDuration;
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
