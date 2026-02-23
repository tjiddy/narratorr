import { execFile } from 'node:child_process';
import { readdir, rename, unlink, writeFile, rm } from 'node:fs/promises';
import { join, extname, basename } from 'node:path';
import { promisify } from 'node:util';
import { AUDIO_EXTENSIONS } from './audio-constants.js';
import { readChapterSources, resolveChapterTitle } from './chapter-resolver.js';

const execFileAsync = promisify(execFile);

export interface ProcessingConfig {
  ffmpegPath: string;
  outputFormat: 'm4b' | 'mp3';
  bitrate: number;
  mergeBehavior: 'always' | 'multi-file-only' | 'never';
}

export interface ProcessingContext {
  /** Author name for output file naming */
  author: string;
  /** Book title for output file naming */
  title: string;
}

export type ProcessingResult =
  | { success: true; outputFiles: string[] }
  | { success: false; error: string };

/**
 * Probe an ffmpeg binary at the given path. Returns the version string on success.
 */
export async function probeFfmpeg(ffmpegPath: string): Promise<string> {
  const { stdout } = await execFileAsync(ffmpegPath, ['-version']);
  const firstLine = stdout.split('\n')[0];
  const versionMatch = firstLine.match(/ffmpeg version (\S+)/);
  return versionMatch ? versionMatch[1] : firstLine.trim();
}

/**
 * Process audio files in a directory: merge and/or convert based on config.
 * Returns the list of output files on success, or an error message on failure.
 */
export async function processAudioFiles(
  targetDir: string,
  config: ProcessingConfig,
  context: ProcessingContext,
): Promise<ProcessingResult> {
  const audioFiles = await collectAudioFiles(targetDir);

  if (audioFiles.length === 0) {
    return { success: true, outputFiles: [] };
  }

  // Skip processing for single m4b (already ABS-ready)
  if (audioFiles.length === 1 && extname(audioFiles[0]).toLowerCase() === '.m4b') {
    return { success: true, outputFiles: audioFiles };
  }

  const shouldMerge = config.mergeBehavior === 'always' ||
    (config.mergeBehavior === 'multi-file-only' && audioFiles.length > 1);

  try {
    if (shouldMerge && audioFiles.length > 1) {
      return await mergeFiles(targetDir, audioFiles, config, context);
    } else {
      return await convertFiles(targetDir, audioFiles, config);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Audio processing failed';
    const stderr = (error as { stderr?: string }).stderr;
    return {
      success: false,
      error: stderr ? `${message}\nffmpeg stderr: ${stderr}` : message,
    };
  }
}

/**
 * Merge multiple audio files into a single output file with chapter markers.
 */
async function mergeFiles(
  targetDir: string,
  audioFiles: string[],
  config: ProcessingConfig,
  context: ProcessingContext,
): Promise<ProcessingResult> {
  const outputExt = config.outputFormat;
  const outputName = `${context.author} - ${context.title}.${outputExt}`;
  const outputPath = join(targetDir, outputName);

  // Read chapter sources to get sorted order + metadata
  const chapterSources = await readChapterSources(audioFiles);

  // Get durations for chapter markers
  const durations = await getFileDurations(config.ffmpegPath, chapterSources.map(s => s.filePath));

  // Build concat file
  const concatPath = join(targetDir, '_concat.txt');
  const concatContent = chapterSources
    .map(s => `file '${s.filePath.replace(/'/g, "'\\''")}'`)
    .join('\n');
  await writeFile(concatPath, concatContent, 'utf-8');

  try {
    const args = [
      '-y',
      '-f', 'concat',
      '-safe', '0',
      '-i', concatPath,
    ];

    // Build chapter metadata for m4b
    let metadataPath: string | undefined;
    if (outputExt === 'm4b') {
      metadataPath = join(targetDir, '_metadata.txt');
      const metadataContent = buildChapterMetadata(chapterSources, durations);
      await writeFile(metadataPath, metadataContent, 'utf-8');
      args.push('-i', metadataPath, '-map_metadata', '1');
    } else {
      // mp3 doesn't support chapters — this is logged by the caller
    }

    args.push(
      '-c:a', outputExt === 'm4b' ? 'aac' : 'libmp3lame',
      '-b:a', `${config.bitrate}k`,
    );

    if (outputExt === 'm4b') {
      args.push('-f', 'mp4');
    }

    args.push(outputPath);

    await execFileAsync(config.ffmpegPath, args, { timeout: 0 });

    // Clean up: remove source files and temp files
    await cleanupTempFiles(concatPath, metadataPath);
    await removeSourceFiles(audioFiles, outputPath);

    return { success: true, outputFiles: [outputPath] };
  } catch (error) {
    // Clean up temp files but preserve source files on failure
    await cleanupTempFiles(concatPath, join(targetDir, '_metadata.txt')).catch(() => {});
    throw error;
  }
}

/**
 * Convert individual files to the target format/bitrate without merging.
 */
async function convertFiles(
  targetDir: string,
  audioFiles: string[],
  config: ProcessingConfig,
): Promise<ProcessingResult> {
  const outputFiles: string[] = [];

  for (const filePath of audioFiles) {
    const stem = basename(filePath, extname(filePath));
    const outputPath = join(targetDir, `${stem}.${config.outputFormat}`);
    const sameFile = filePath === outputPath;

    // When input and output paths match, encode to a temp file then replace
    const writePath = sameFile
      ? join(targetDir, `${stem}_tmp.${config.outputFormat}`)
      : outputPath;

    const args = [
      '-y',
      '-i', filePath,
      '-c:a', config.outputFormat === 'm4b' ? 'aac' : 'libmp3lame',
      '-b:a', `${config.bitrate}k`,
    ];

    if (config.outputFormat === 'm4b') {
      args.push('-f', 'mp4');
    }

    args.push(writePath);

    await execFileAsync(config.ffmpegPath, args, { timeout: 0 });

    // Remove original and rename temp if needed
    if (sameFile) {
      await unlink(filePath);
      await rename(writePath, outputPath);
    } else {
      await unlink(filePath);
    }

    outputFiles.push(outputPath);
  }

  return { success: true, outputFiles };
}

/**
 * Build ffmpeg chapter metadata in FFMETADATA1 format.
 */
export function buildChapterMetadata(
  sources: { filePath: string; title?: string }[],
  durations: number[],
): string {
  let lines = ';FFMETADATA1\n';
  let timeBase = 0;

  for (let i = 0; i < sources.length; i++) {
    const title = resolveChapterTitle(sources[i] as Parameters<typeof resolveChapterTitle>[0], i);
    const startMs = Math.round(timeBase * 1000);
    const endMs = Math.round((timeBase + (durations[i] || 0)) * 1000);

    lines += '\n[CHAPTER]\n';
    lines += 'TIMEBASE=1/1000\n';
    lines += `START=${startMs}\n`;
    lines += `END=${endMs}\n`;
    lines += `title=${title}\n`;

    timeBase += durations[i] || 0;
  }

  return lines;
}

/**
 * Get duration of each file using ffprobe (bundled with ffmpeg).
 */
async function getFileDurations(ffmpegPath: string, filePaths: string[]): Promise<number[]> {
  // ffprobe is typically alongside ffmpeg
  const ffprobePath = ffmpegPath.replace(/ffmpeg(\.exe)?$/i, 'ffprobe$1');

  const durations: number[] = [];
  for (const filePath of filePaths) {
    try {
      const { stdout } = await execFileAsync(ffprobePath, [
        '-v', 'quiet',
        '-show_entries', 'format=duration',
        '-of', 'default=noprint_wrappers=1:nokey=1',
        filePath,
      ]);
      durations.push(parseFloat(stdout.trim()) || 0);
    } catch {
      durations.push(0);
    }
  }
  return durations;
}

/** Collect audio files in a directory (non-recursive, sorted). */
async function collectAudioFiles(dirPath: string): Promise<string[]> {
  const entries = await readdir(dirPath, { withFileTypes: true });
  return entries
    .filter(e => e.isFile() && AUDIO_EXTENSIONS.has(extname(e.name).toLowerCase()))
    .map(e => join(dirPath, e.name))
    .sort();
}

async function cleanupTempFiles(...paths: (string | undefined)[]): Promise<void> {
  for (const p of paths) {
    if (p) await rm(p, { force: true });
  }
}

async function removeSourceFiles(sourceFiles: string[], keepPath: string): Promise<void> {
  for (const f of sourceFiles) {
    if (f !== keepPath) {
      await unlink(f).catch(() => {});
    }
  }
}
