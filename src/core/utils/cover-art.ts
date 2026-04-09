import { rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { deriveFfprobePath } from './ffprobe-path.js';

const execFileAsync = promisify(execFile);

/** Type for an ffmpeg spawn function (injected from audio-processor). */
type SpawnFfmpegFn = (ffmpegPath: string, args: string[]) => Promise<void>;

export interface CoverArtPipelineResult {
  outputFiles: string[];
  warnings: string[];
}

/**
 * Run a processing callback with cover art detection, extraction, reattach, and cleanup.
 * Handles the full cover art lifecycle: detect → extract → process(callback) → reattach → cleanup.
 * Returns both output files and any degradation warnings.
 */
export async function withCoverArtPipeline(
  ffmpegPath: string,
  audioFiles: string[],
  targetDir: string,
  outputFormat: 'm4b' | 'mp3',
  processFn: () => Promise<string[]>,
  spawnFfmpeg: SpawnFfmpegFn,
): Promise<CoverArtPipelineResult> {
  const warnings: string[] = [];
  const coverSource = await detectCoverArtSource(ffmpegPath, audioFiles);
  let coverPath: string | null = null;
  if (coverSource) {
    coverPath = await extractCoverArt(ffmpegPath, coverSource, targetDir, spawnFfmpeg);
    if (!coverPath) {
      warnings.push('Cover art extraction failed — output will not contain embedded cover art');
    }
  }

  try {
    const outputFiles = await processFn();

    // Reattach cover art to M4B outputs (if extracted and output is M4B)
    if (coverPath && outputFormat === 'm4b') {
      for (const outputFile of outputFiles) {
        const ok = await reattachCoverArt(ffmpegPath, outputFile, coverPath, targetDir, spawnFfmpeg);
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
export async function detectCoverArtSource(ffmpegPath: string, filePaths: string[]): Promise<string | null> {
  const ffprobePath = deriveFfprobePath(ffmpegPath);

  for (const filePath of filePaths) {
    try {
      const { stdout } = await execFileAsync(ffprobePath, [
        '-v', 'quiet',
        '-show_entries', 'stream=codec_type',
        '-of', 'default=noprint_wrappers=1:nokey=1',
        filePath,
      ]);
      const types = stdout.trim().split('\n').map(l => l.trim());
      if (types.includes('video')) return filePath;
    } catch {
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
): Promise<string | null> {
  const coverPath = join(targetDir, '_cover.jpg');
  try {
    await spawnFfmpeg(ffmpegPath, ['-y', '-i', sourceFile, '-an', '-vcodec', 'copy', coverPath]);
    const info = await stat(coverPath);
    if (info.size === 0) {
      await rm(coverPath, { force: true });
      return null;
    }
    return coverPath;
  } catch {
    await rm(coverPath, { force: true }).catch(() => {});
    return null;
  }
}

/**
 * Re-attach cover art to an M4B output file.
 * Graceful — logs failure but does not throw. The audio-only file is preserved.
 */
async function reattachCoverArt(
  ffmpegPath: string,
  audioFile: string,
  coverFile: string,
  targetDir: string,
  spawnFfmpeg: SpawnFfmpegFn,
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
      '-disposition:v:0', 'attached_pic',
      '-f', 'mp4',
      tempOutput,
    ]);
    await rename(tempOutput, audioFile);
    return true;
  } catch {
    await rm(tempOutput, { force: true }).catch(() => {});
    return false;
  }
}
