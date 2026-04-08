import { execFile, spawn } from 'node:child_process';
import { rename, unlink, writeFile, rm } from 'node:fs/promises';
import { join, extname, basename } from 'node:path';
import { promisify } from 'node:util';
import { collectAudioFilePaths } from './collect-audio-files.js';
import { readChapterSources, resolveChapterTitle } from './chapter-resolver.js';
import type { ChapterSource } from './chapter-resolver.js';
import { renderFilename } from './naming.js';
import type { NamingOptions } from './naming.js';
import { withCoverArtPipeline } from './cover-art.js';
import { deriveFfprobePath } from './ffprobe-path.js';

const execFileAsync = promisify(execFile);

/** Fixed stall timeout for ffmpeg processes — kills after this many ms with no stdout progress. */
const FFMPEG_STALL_TIMEOUT_MS = 60_000;

export interface ProcessingConfig {
  ffmpegPath: string;
  outputFormat: 'm4b' | 'mp3';
  /** Target bitrate in kbps. When omitted, the original bitrate is preserved (copy codec where possible). */
  bitrate?: number;
  /** Source bitrate in kbps (converted from bps at the call site). When set, effective bitrate is min(source, target) to prevent upsampling. */
  sourceBitrateKbps?: number;
  mergeBehavior: 'always' | 'multi-file-only' | 'never';
}

export interface ProcessingContext {
  /** Author name for output file naming */
  author: string;
  /** Book title for output file naming */
  title: string;
  /** Optional file naming template (e.g. '{author} - {title}'). When omitted, falls back to '{author} - {title}'. */
  fileFormat?: string;
  /** Additional book-level tokens for renderFilename (series, year, narrator, etc.) */
  bookTokens?: Record<string, string | number | undefined | null>;
  /** Naming options for separator and case transforms. */
  namingOptions?: NamingOptions;
}

export type ProcessingResult =
  | { success: true; outputFiles: string[]; warnings?: string[] }
  | { success: false; error: string };

/** Callbacks for streaming progress and stderr from ffmpeg. Keeps src/core/ adapter-agnostic. */
export interface ProcessingCallbacks {
  onProgress?: (phase: string, percentage?: number) => void;
  onStderr?: (line: string) => void;
}

/**
 * Discover ffmpeg on the system. Returns the absolute path if found, null otherwise.
 * Tries /usr/bin/ffmpeg first, then falls back to `which ffmpeg`.
 */
export async function detectFfmpegPath(): Promise<string | null> {
  const knownPath = '/usr/bin/ffmpeg';
  try {
    await probeFfmpeg(knownPath);
    return knownPath;
  } catch {
    // fall through to which
  }
  try {
    const { stdout } = await execFileAsync('which', ['ffmpeg']);
    const resolved = stdout.trim();
    if (resolved) return resolved;
  } catch {
    // not found
  }
  return null;
}

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
  callbacks?: ProcessingCallbacks,
  signal?: AbortSignal,
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
    // Read chapter sources once — needed for merge (chapter markers) and convert (file naming)
    const chapterSources = await readChapterSources(audioFiles);

    if (shouldMerge && audioFiles.length > 1) {
      return await mergeFiles(targetDir, chapterSources, config, context, callbacks, signal);
    } else {
      return await convertFiles(targetDir, audioFiles, config, context, chapterSources, callbacks, signal);
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Audio processing failed';
    return {
      success: false,
      error: message,
    };
  }
}

/**
 * Run ffmpeg via spawn with streaming stdout/stderr.
 * Parses `-progress pipe:1` output for percentage calculation.
 */
function spawnFfmpeg(
  ffmpegPath: string,
  args: string[],
  options?: {
    totalDuration?: number;
    onProgress?: (phase: string, percentage?: number) => void;
    onStderr?: (line: string) => void;
    signal?: AbortSignal;
  },
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (options?.signal?.aborted) {
      reject(new Error('Processing aborted'));
      return;
    }

    const child = spawn(ffmpegPath, args);

    // AbortSignal listener — kill ffmpeg on external cancel
    if (options?.signal) {
      const onAbort = () => {
        if (!settled) {
          child.kill('SIGTERM');
        }
      };
      options.signal.addEventListener('abort', onAbort, { once: true });
    }
    let lastProgressTime = 0;
    let settled = false;

    // Stall timeout — kill ffmpeg if no stdout activity for 60s
    let stallTimer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill('SIGTERM');
        reject(new Error(`ffmpeg stalled: no progress for ${FFMPEG_STALL_TIMEOUT_MS / 1000}s`));
      }
    }, FFMPEG_STALL_TIMEOUT_MS);

    const resetStallTimer = () => {
      if (stallTimer != null) clearTimeout(stallTimer);
      stallTimer = setTimeout(() => {
        if (!settled) {
          settled = true;
          child.kill('SIGTERM');
          reject(new Error(`ffmpeg stalled: no progress for ${FFMPEG_STALL_TIMEOUT_MS / 1000}s`));
        }
      }, FFMPEG_STALL_TIMEOUT_MS);
    };

    // Parse stdout for -progress pipe:1 key=value lines
    let stdoutBuffer = '';
    child.stdout.on('data', (data: Buffer) => {
      resetStallTimer();
      stdoutBuffer += data.toString();
      const lines = stdoutBuffer.split('\n');
      stdoutBuffer = lines.pop() || ''; // Keep incomplete line in buffer
      for (const line of lines) {
        const match = line.match(/^out_time_us=(-?\d+)/);
        if (match && options?.totalDuration && options.totalDuration > 0) {
          const now = Date.now();
          if (now - lastProgressTime >= 1000) {
            const outTimeUs = parseInt(match[1], 10);
            const percentage = Math.max(0, Math.min(1, outTimeUs / (options.totalDuration * 1_000_000)));
            options.onProgress?.('processing', percentage);
            lastProgressTime = now;
          }
        }
      }
    });

    // Stream stderr lines via callback
    let stderrBuffer = '';
    child.stderr.on('data', (data: Buffer) => {
      stderrBuffer += data.toString();
      const lines = stderrBuffer.split('\n');
      stderrBuffer = lines.pop() || '';
      for (const line of lines) {
        if (line.trim()) options?.onStderr?.(line);
      }
    });

    child.on('close', (code) => {
      if (stallTimer != null) clearTimeout(stallTimer);
      if (settled) return; // Already rejected by stall timeout
      settled = true;
      // Flush remaining stderr
      if (stderrBuffer.trim()) options?.onStderr?.(stderrBuffer.trim());
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited with code ${code}`));
    });

    child.on('error', (err) => {
      if (stallTimer != null) clearTimeout(stallTimer);
      if (settled) return;
      settled = true;
      reject(err);
    });
  });
}

/**
 * Merge multiple audio files into a single output file with chapter markers.
 */
async function mergeFiles(
  targetDir: string,
  chapterSources: ChapterSource[],
  config: ProcessingConfig,
  context: ProcessingContext,
  callbacks?: ProcessingCallbacks,
  signal?: AbortSignal,
): Promise<ProcessingResult> {
  const outputExt = config.outputFormat;
  const audioFiles = chapterSources.map(s => s.filePath);

  const baseTokens = {
    author: context.author,
    title: context.title,
    ...context.bookTokens,
  };

  const outputStem = context.fileFormat
    ? renderFilename(context.fileFormat, baseTokens, context.namingOptions)
    : `${context.author} - ${context.title}`;
  const outputName = `${outputStem}.${outputExt}`;
  const outputPath = join(targetDir, outputName);

  // Get durations for chapter markers and progress calculation
  const durations = await getFileDurations(config.ffmpegPath, chapterSources.map(s => s.filePath));
  const totalDuration = durations.reduce((sum, d) => sum + d, 0);

  // Build concat file
  const concatPath = join(targetDir, '_concat.txt');
  const concatContent = chapterSources
    .map(s => `file '${s.filePath.replace(/'/g, "'\\''")}'`)
    .join('\n');
  await writeFile(concatPath, concatContent, 'utf-8');

  const encodeFn = async (): Promise<string[]> => {
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
    }

    if (config.bitrate != null) {
      const effectiveBitrate = config.sourceBitrateKbps != null
        ? Math.min(config.sourceBitrateKbps, config.bitrate)
        : config.bitrate;
      args.push(
        '-c:a', outputExt === 'm4b' ? 'aac' : 'libmp3lame',
        '-b:a', `${effectiveBitrate}k`,
      );
    } else {
      args.push('-c:a', outputExt === 'm4b' ? 'aac' : 'libmp3lame');
    }

    args.push('-vn');
    args.push('-max_muxing_queue_size', '4096');

    if (outputExt === 'm4b') {
      args.push('-f', 'mp4');
    }

    args.push('-progress', 'pipe:1');
    args.push(outputPath);

    await spawnFfmpeg(config.ffmpegPath, args, {
      totalDuration,
      onProgress: callbacks?.onProgress,
      onStderr: callbacks?.onStderr,
      signal,
    });

    return [outputPath];
  };

  try {
    const result = await withCoverArtPipeline(
      config.ffmpegPath, audioFiles, targetDir, outputExt, encodeFn, spawnFfmpeg,
    );
    for (const w of result.warnings) callbacks?.onStderr?.(w);

    // Clean up: remove source files and temp files
    await cleanupTempFiles(concatPath, join(targetDir, '_metadata.txt'));
    await removeSourceFiles(audioFiles, outputPath);

    return {
      success: true,
      outputFiles: result.outputFiles,
      warnings: result.warnings.length > 0 ? result.warnings : undefined,
    };
  } catch (error: unknown) {
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
  context: ProcessingContext,
  chapterSources: ChapterSource[],
  callbacks?: ProcessingCallbacks,
  signal?: AbortSignal,
): Promise<ProcessingResult> {
  const trackTotal = audioFiles.length;

  // Build a map from filePath → ChapterSource for quick lookup
  const sourceMap = new Map(chapterSources.map(s => [s.filePath, s]));

  const encodeFn = async (): Promise<string[]> => {
    const results: string[] = [];
    for (let i = 0; i < audioFiles.length; i++) {
      const filePath = audioFiles[i];
      const source = sourceMap.get(filePath);

      const stem = context.fileFormat
        ? renderFilename(context.fileFormat, {
            author: context.author, title: context.title, ...context.bookTokens,
            trackNumber: i + 1, trackTotal,
            partName: source ? resolveChapterTitle(source, i) : undefined,
          }, context.namingOptions)
        : basename(filePath, extname(filePath));

      const outputPath = join(targetDir, `${stem}.${config.outputFormat}`);
      const sameFile = filePath === outputPath;
      const writePath = sameFile
        ? join(targetDir, `${stem}_tmp.${config.outputFormat}`)
        : outputPath;

      const args = ['-y', '-i', filePath, '-c:a', config.outputFormat === 'm4b' ? 'aac' : 'libmp3lame'];

      if (config.bitrate != null) {
        const effectiveBitrate = config.sourceBitrateKbps != null
          ? Math.min(config.sourceBitrateKbps, config.bitrate) : config.bitrate;
        args.push('-b:a', `${effectiveBitrate}k`);
      }

      args.push('-vn', '-max_muxing_queue_size', '4096');
      if (config.outputFormat === 'm4b') args.push('-f', 'mp4');
      args.push('-progress', 'pipe:1', writePath);

      await spawnFfmpeg(config.ffmpegPath, args, { onStderr: callbacks?.onStderr, signal });

      if (sameFile) { await unlink(filePath); await rename(writePath, outputPath); }
      else { await unlink(filePath); }

      results.push(outputPath);
    }
    return results;
  };

  const result = await withCoverArtPipeline(
    config.ffmpegPath, audioFiles, targetDir, config.outputFormat, encodeFn, spawnFfmpeg,
  );
  for (const w of result.warnings) callbacks?.onStderr?.(w);
  return {
    success: true,
    outputFiles: result.outputFiles,
    warnings: result.warnings.length > 0 ? result.warnings : undefined,
  };
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
  const ffprobePath = deriveFfprobePath(ffmpegPath);

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
  const files = await collectAudioFilePaths(dirPath);
  return files.sort();
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
