import { extname } from 'node:path';
import { execFile } from 'node:child_process';
// Direct import: sanitizedEnv is Node-only; the utils barrel is bundled for Vite.
import { sanitizedEnv } from './sanitized-env.js';
import type { AudioScanResult, AudioScanOptions, MetadataFormat } from './audio-scanner.js';

interface FFprobeStreamInfo {
  codec: string;
  bitrate?: number;
  sampleRate?: number;
  channels?: number;
}

/** Runs ffprobe without a shell or inherited secrets; all probe failures degrade to null. */
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

/** Reads stream duration for containers that omit format duration, notably fragmented MP4/xHE-AAC. */
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

/** Codec fallback for formats music-metadata cannot identify, notably xHE-AAC/USAC. */
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
      // ffprobe and music-metadata both report bits per second, not kbps.
      const bitrate = Number.parseInt(String(stream.bit_rate), 10);
      if (Number.isFinite(bitrate)) info.bitrate = bitrate;
      const sampleRate = Number.parseInt(String(stream.sample_rate), 10);
      if (Number.isFinite(sampleRate)) info.sampleRate = sampleRate;
      if (typeof stream.channels === 'number') info.channels = stream.channels;
      return info;
    },
  );
}

// The observed library bottoms out at 32 kbps; 8 kbps rejected no valid long-form files.
export const MIN_PLAUSIBLE_BITRATE_BPS = 8000;
// Apply the bitrate floor only beyond 30 minutes so legitimate clips and stingers survive.
export const MIN_GUARDED_DURATION_SECONDS = 1800;
// The generous ceiling catches grossly short claims while allowing cover-heavy short files.
export const MAX_PLAUSIBLE_BITRATE_BPS = 10_000_000;

// This catches gross duration lies only; errors within the bitrate bounds need another source.
export function isPlausibleDuration(duration: number | undefined, fileSize: number): boolean {
  if (typeof duration !== 'number' || !Number.isFinite(duration) || duration <= 0) return false;
  if (!Number.isFinite(fileSize) || fileSize <= 0) return false;
  const impliedBitrateBps = (fileSize * 8) / duration;
  if (impliedBitrateBps < MIN_PLAUSIBLE_BITRATE_BPS && duration > MIN_GUARDED_DURATION_SECONDS) return false;
  if (impliedBitrateBps > MAX_PLAUSIBLE_BITRATE_BPS) return false;
  return true;
}

function impliedBitrateBps(duration: number | undefined, fileSize: number): number | undefined {
  if (typeof duration !== 'number' || !Number.isFinite(duration) || duration <= 0) return undefined;
  if (!Number.isFinite(fileSize) || fileSize <= 0) return undefined;
  return (fileSize * 8) / duration;
}

/** Avoids an ffprobe process when music-metadata already produced a plausible duration. */
export async function resolveFileDuration(
  filePath: string,
  metadataDuration: number | undefined,
  fileSize: number,
  ffprobePath: string | undefined,
  onWarn: AudioScanOptions['onWarn'],
  onDebug: AudioScanOptions['onDebug'],
): Promise<number | undefined> {
  if (isPlausibleDuration(metadataDuration, fileSize)) return metadataDuration;

  const ffprobeDuration = ffprobePath ? await getFFprobeDuration(ffprobePath, filePath) : null;
  if (ffprobeDuration !== null && isPlausibleDuration(ffprobeDuration, fileSize)) {
    // Guard a zero metadata value to prevent a division-by-zero mismatch payload.
    if (metadataDuration && metadataDuration > 0) {
      const diff = Math.abs(ffprobeDuration - metadataDuration) / metadataDuration;
      if (diff > 0.1) {
        onWarn?.('ffprobe/music-metadata duration mismatch (>10%)', { filePath, ffprobeDuration, metadataDuration });
      }
    }
    return ffprobeDuration;
  }

  reportRejectedDuration({ filePath, metadataDuration, ffprobeDuration, fileSize, onWarn, onDebug });
  return undefined;
}

/** Warns on returned-but-rejected values; debugs only when neither source returned anything. */
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
  const hasNamedRejection = metadataDuration !== undefined || ffprobeDuration !== null;
  if (hasNamedRejection) {
    onWarn?.('duration omitted: no plausible value from music-metadata or ffprobe', payload);
  } else {
    onDebug?.('duration omitted: neither music-metadata nor ffprobe produced a duration', payload);
  }
}

/** Fills codec details missing from music-metadata; zero-valued fields remain valid. */
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
