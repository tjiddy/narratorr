import { rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { deriveFfprobePath } from './ffprobe-path.js';
// Imported by path, not via the core/utils barrel (Node-only; barrel feeds the Vite client build).
import { sanitizedEnv } from './sanitized-env.js';

const execFileAsync = promisify(execFile);

/**
 * Type for an ffmpeg spawn function (injected from audio-processor).
 *
 * The options bag is what carries the merge/convert `AbortSignal` down to the cover remuxes
 * (#2080). It is deliberately a NARROW subset of the real `spawnFfmpeg`'s bag — the cover
 * phases have no progress denominator to report against — and every member is optional, so
 * the real function stays assignable here without a cast at either injection site.
 */
type SpawnFfmpegFn = (
  ffmpegPath: string,
  args: string[],
  options?: { signal?: AbortSignal },
) => Promise<void>;

export interface CoverArtPipelineResult {
  outputFiles: string[];
  warnings: string[];
}

/** Trailing options bag — `withCoverArtPipeline` already takes six positional parameters. */
export interface CoverArtPipelineOptions {
  signal?: AbortSignal;
}

/**
 * Run a processing callback with cover art detection, extraction, reattach, and cleanup.
 * Handles the full cover art lifecycle: detect → extract → process(callback) → reattach → cleanup.
 * Returns both output files and any degradation warnings.
 *
 * Cover failures are best-effort: they degrade to a warning and preserve the audio-only output.
 * Cancellation is NOT a cover failure (#2080) — when `options.signal` is aborted every phase
 * rethrows instead, so a cancelled merge can never report success (nor delete its sources).
 */
export async function withCoverArtPipeline(
  ffmpegPath: string,
  audioFiles: string[],
  targetDir: string,
  outputFormat: 'm4b' | 'mp3',
  processFn: () => Promise<string[]>,
  spawnFfmpeg: SpawnFfmpegFn,
  options?: CoverArtPipelineOptions,
): Promise<CoverArtPipelineResult> {
  const signal = options?.signal;
  const warnings: string[] = [];
  const coverSource = await detectCoverArtSource(ffmpegPath, audioFiles, options);
  let coverPath: string | null = null;
  if (coverSource) {
    coverPath = await extractCoverArt(ffmpegPath, coverSource, targetDir, spawnFfmpeg, signal);
    if (!coverPath) {
      warnings.push('Cover art extraction failed — output will not contain embedded cover art');
    }
  }

  try {
    const outputFiles = await processFn();

    // Reattach cover art to M4B outputs (if extracted and output is M4B)
    if (coverPath && outputFormat === 'm4b') {
      for (const outputFile of outputFiles) {
        const ok = await reattachCoverArt(ffmpegPath, outputFile, coverPath, targetDir, spawnFfmpeg, signal);
        if (!ok) {
          warnings.push('Cover art reattach failed — output will not contain embedded cover art');
        }
      }
    }

    return { outputFiles, warnings };
  } finally {
    if (coverPath) await rm(coverPath, { force: true }).catch(() => {});
  }
}

/**
 * Detect which file (if any) has an embedded video/image stream using ffprobe.
 * Returns the file path of the first file with a video stream, or null.
 */
export async function detectCoverArtSource(
  ffmpegPath: string,
  filePaths: string[],
  options?: CoverArtPipelineOptions,
): Promise<string | null> {
  const ffprobePath = deriveFfprobePath(ffmpegPath);
  const signal = options?.signal;

  for (const filePath of filePaths) {
    try {
      const { stdout } = await execFileAsync(ffprobePath, [
        '-v', 'quiet',
        '-show_entries', 'stream=codec_type',
        '-of', 'default=noprint_wrappers=1:nokey=1',
        filePath,
      ], { env: sanitizedEnv(), ...(signal !== undefined && { signal }) });
      const types = stdout.trim().split('\n').map(l => l.trim());
      if (types.includes('video')) return filePath;
    } catch (error: unknown) {
      // A cancelled probe is not an unprobeable file (#2080). Swallowing it here would let
      // every remaining probe fail instantly against the aborted signal, and the loop would
      // return null — cancellation reading as "no cover art", with the merge carrying on.
      if (signal?.aborted) throw error;
      // Skip files that can't be probed
    }
  }
  return null;
}

/**
 * Extract cover art from a source file to a temp file.
 * Returns the cover path on success, null on failure.
 */
async function extractCoverArt(
  ffmpegPath: string,
  sourceFile: string,
  targetDir: string,
  spawnFfmpeg: SpawnFfmpegFn,
  signal?: AbortSignal,
): Promise<string | null> {
  const coverPath = join(targetDir, '_cover.jpg');
  try {
    // `-progress pipe:1` is load-bearing, not diagnostic (#2078): spawnFfmpeg's 60 s stall timer
    // only resets on STDOUT activity, and a `-c copy` remux emits nothing there on its own.
    await spawnFfmpeg(
      ffmpegPath,
      ['-y', '-i', sourceFile, '-an', '-vcodec', 'copy', '-progress', 'pipe:1', coverPath],
      { ...(signal !== undefined && { signal }) },
    );
    const info = await stat(coverPath);
    if (info.size === 0) {
      await rm(coverPath, { force: true });
      return null;
    }
    return coverPath;
  } catch (error: unknown) {
    await rm(coverPath, { force: true }).catch(() => {});
    // Cleanup first, then propagate (#2080). Keyed on the signal, never on the error's message
    // or type: an abort mid-spawn surfaces only as `ffmpeg exited with code null`, which is
    // indistinguishable from an ordinary encode failure.
    if (signal?.aborted) throw error;
    return null;
  }
}

/**
 * Re-attach cover art to an M4B output file.
 * Graceful — reports failure but does not throw. The audio-only file is preserved.
 * The one exception is cancellation (#2080), which rethrows: this runs after the encode, so a
 * degraded `false` here would report success for a cancelled merge and delete its sources.
 */
async function reattachCoverArt(
  ffmpegPath: string,
  audioFile: string,
  coverFile: string,
  targetDir: string,
  spawnFfmpeg: SpawnFfmpegFn,
  signal?: AbortSignal,
): Promise<boolean> {
  const tempOutput = join(targetDir, '_cover_merged.m4b');
  try {
    await spawnFfmpeg(ffmpegPath, [
      '-y',
      '-i', audioFile,
      '-i', coverFile,
      '-map', '0:a',
      '-map', '1:v',
      '-c', 'copy',
      // Explicit (#2078): this is a second remux over the just-merged file, so it must carry
      // forward the global tags the merge preserved and the generated chapter set #2068 pinned.
      // ffmpeg's chapter default takes them from the FIRST chapter-bearing input (#2083) — a cover
      // JPEG has none today, but relying on that is a silent dependency on the other input's shape.
      '-map_metadata', '0',
      '-map_chapters', '0',
      '-disposition:v:0', 'attached_pic',
      '-f', 'mp4',
      // Same stall-timer reason as the extract above — this is the long one (multi-GB remux).
      '-progress', 'pipe:1',
      tempOutput,
    ], { ...(signal !== undefined && { signal }) });
    await rename(tempOutput, audioFile);
    return true;
  } catch (error: unknown) {
    await rm(tempOutput, { force: true }).catch(() => {});
    if (signal?.aborted) throw error;
    return false;
  }
}
