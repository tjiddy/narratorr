import { rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { deriveFfprobePath } from './ffprobe-path.js';
// Import directly: the barrel feeds the browser build, but this module is Node-only.
import { sanitizedEnv } from './sanitized-env.js';

const execFileAsync = promisify(execFile);

/**
 * Narrow injectable subset of spawnFfmpeg: cover remuxes need cancellation but no progress
 * denominator. Optional members keep the production function assignable.
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

export interface CoverArtPipelineOptions {
  signal?: AbortSignal;
}

/**
 * Cover failures warn and preserve audio-only output. An aborted signal always propagates so
 * cancellation cannot look successful and delete sources.
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
      // An aborted probe must propagate; treating it as unprobeable would continue the merge.
      if (signal?.aborted) throw error;
      // Other probe failures mean this file has no usable cover.
    }
  }
  return null;
}

async function extractCoverArt(
  ffmpegPath: string,
  sourceFile: string,
  targetDir: string,
  spawnFfmpeg: SpawnFfmpegFn,
  signal?: AbortSignal,
): Promise<string | null> {
  const coverPath = join(targetDir, '_cover.jpg');
  try {
    // `-c copy` emits no stdout; progress output keeps spawnFfmpeg's 60-second stall timer alive.
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
    // Use the signal as the verdict: ffmpeg reports both cancellation and ordinary failure as code null.
    if (signal?.aborted) throw error;
    return null;
  }
}

/**
 * Ordinary failures preserve audio-only output; cancellation propagates so a cancelled merge cannot
 * report success and delete sources.
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
      // Preserve audio-input metadata and chapters; ffmpeg otherwise picks the first eligible input.
      '-map_metadata', '0',
      '-map_chapters', '0',
      '-disposition:v:0', 'attached_pic',
      '-f', 'mp4',
      // Large remuxes need stdout progress to satisfy the stall timer.
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
