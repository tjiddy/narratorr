import { execFile, spawn } from 'node:child_process';
import { unlink, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { collectSortedAudioFiles } from './collect-audio-files.js';
import { getErrorMessage } from '@shared/error-message.js';
import { readChapterSources, resolveChapterTitle } from './chapter-resolver.js';
import type { ChapterSource } from './chapter-resolver.js';
import { renderFilename } from './naming.js';
import type { NamingOptions } from './naming.js';
import { withCoverArtPipeline } from './cover-art.js';
import { deriveFfprobePath } from './ffprobe-path.js';
// Import the Node-only module directly; the core/utils barrel is excluded from client builds.
import { sanitizedEnv } from './sanitized-env.js';
import { resolveCodecArgs } from './encode-strategy.js';

const execFileAsync = promisify(execFile);

const FFMPEG_STALL_TIMEOUT_MS = 60_000;

// Server eligibility owns this threshold, but core cannot import server code.
const MERGE_MINIMUM_FILES = 2;

/** A sub-minimum merge must fail because callers delete sources after success. */
export class InsufficientAudioFilesError extends Error {
  constructor(
    readonly count: number,
  ) {
    super(`Merge requires at least ${MERGE_MINIMUM_FILES} audio files, found ${count}`);
    this.name = 'InsufficientAudioFilesError';
  }
}

export interface ProcessingConfig {
  ffmpegPath: string;
  outputFormat: 'm4b' | 'mp3';
  /**
   * Target kbps; this module never converts it. A usable value requests min(source, target),
   * except when the encoder's legal minimum is higher. Missing or invalid values use
   * keep-original semantics: copy compatible inputs, otherwise encode at a legal rate supported
   * by source evidence or a conservative default. Adjustments emit warnings. The encoder may
   * clamp the request further, so this is not a promise about the probed output bitrate.
   */
  bitrate?: number | undefined;
  /** Source kbps used to avoid an explicit bitrate upsample. */
  sourceBitrateKbps?: number | undefined;
}

export interface ProcessingContext {
  author: string;
  title: string;
  /** Output template; defaults to `{author} - {title}`. */
  fileFormat?: string;
  /** Extra renderFilename tokens such as series, year, and narrator. */
  bookTokens?: Record<string, string | number | undefined | null>;
  namingOptions?: NamingOptions;
}

export type ProcessingResult =
  // Failed runs retain warnings emitted before the failure.
  | { success: true; outputFiles: string[]; warnings?: string[] }
  | { success: false; error: string; warnings?: string[] };

/** Streams ffmpeg events without coupling core to an adapter. */
export interface ProcessingCallbacks {
  onProgress?: (phase: string, percentage?: number) => void;
  onStderr?: (line: string) => void;
}

// Preserve audio-processor as the public import path for resolver APIs.
export { detectFfmpegPath, probeFfmpeg, resolveFfmpegPath, resetFfmpegPathCache } from './ffmpeg-resolver.js';

/** Merges every audio file in a directory into one chaptered output. */
export async function processAudioFiles(
  targetDir: string,
  config: ProcessingConfig,
  context: ProcessingContext,
  callbacks?: ProcessingCallbacks,
  signal?: AbortSignal,
): Promise<ProcessingResult> {
  // Preserve resolver warnings even if a later command fails.
  const warnings: string[] = [];

  try {
    // Collection and minimum failures belong in ProcessingResult rather than rejected promises.
    const audioFiles = await collectAudioFiles(targetDir);
    if (audioFiles.length < MERGE_MINIMUM_FILES) {
      throw new InsufficientAudioFilesError(audioFiles.length);
    }

    const chapterSources = await readChapterSources(audioFiles);
    return await mergeFiles(targetDir, chapterSources, config, context, warnings, callbacks, signal);
  } catch (error: unknown) {
    return {
      success: false,
      error: getErrorMessage(error),
      ...(warnings.length > 0 && { warnings }),
    };
  }
}

/** Runs ffmpeg with streamed progress, stall detection, and cancellation. */
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

    const child = spawn(ffmpegPath, args, { env: sanitizedEnv() });

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

    // ffmpeg's `-progress` stream uses key=value records.
    let stdoutBuffer = '';
    child.stdout.on('data', (data: Buffer) => {
      resetStallTimer();
      stdoutBuffer += data.toString();
      const lines = stdoutBuffer.split('\n');
      stdoutBuffer = lines.pop() || ''; // Keep the incomplete line buffered across chunks.
      for (const line of lines) {
        const match = line.match(/^out_time_us=(-?\d+)/);
        if (match && options?.totalDuration && options.totalDuration > 0) {
          const now = Date.now();
          if (now - lastProgressTime >= 1000) {
            const outTimeUs = parseInt(match[1]!, 10);
            const percentage = Math.max(0, Math.min(1, outTimeUs / (options.totalDuration * 1_000_000)));
            options.onProgress?.('processing', percentage);
            lastProgressTime = now;
          }
        }
      }
    });

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
      if (settled) return; // The stall timer already rejected.
      settled = true;
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

/** Derives map indices from argv because m4b and mp3 open different inputs. */
function lastInputIndex(args: string[]): number {
  return args.filter((token) => token === '-i').length - 1;
}

async function mergeFiles(
  targetDir: string,
  chapterSources: ChapterSource[],
  config: ProcessingConfig,
  context: ProcessingContext,
  warnings: string[],
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

  const durations = await getFileDurations(config.ffmpegPath, chapterSources.map(s => s.filePath));
  const totalDuration = durations.reduce((sum, d) => sum + d, 0);

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

    let metadataPath: string | undefined;
    let chapterInput: number | undefined;
    if (outputExt === 'm4b') {
      metadataPath = join(targetDir, '_metadata.txt');
      const metadataContent = buildChapterMetadata(chapterSources, durations);
      await writeFile(metadataPath, metadataContent, 'utf-8');
      args.push('-i', metadataPath);
      chapterInput = lastInputIndex(args);
    }

    // Chapter metadata has no global tags, and concat propagation varies by ffmpeg version.
    // Use the first source as the explicit metadata donor.
    args.push('-i', audioFiles[0]!);
    const metadataInput = lastInputIndex(args);

    // The donor also has audio; pin the concat input or ffmpeg may emit only the first part.
    args.push('-map', '0:a');
    args.push('-map_metadata', String(metadataInput));
    // m4b maps generated chapters; mp3 has none and must suppress donor chapters.
    // `-1` is ffmpeg's "copy no chapters" sentinel, not an input index.
    args.push('-map_chapters', chapterInput !== undefined ? String(chapterInput) : '-1');

    args.push(...await resolveCodecArgs(config, audioFiles, warnings, callbacks?.onStderr));

    args.push('-vn');
    args.push('-max_muxing_queue_size', '4096');

    if (outputExt === 'm4b') {
      args.push('-f', 'mp4');
    }

    args.push('-progress', 'pipe:1');
    args.push(outputPath);

    await spawnFfmpeg(config.ffmpegPath, args, {
      totalDuration,
      ...(callbacks?.onProgress !== undefined && { onProgress: callbacks.onProgress }),
      ...(callbacks?.onStderr !== undefined && { onStderr: callbacks.onStderr }),
      ...(signal !== undefined && { signal }),
    });

    return [outputPath];
  };

  try {
    const result = await withCoverArtPipeline(
      config.ffmpegPath, audioFiles, targetDir, outputExt, encodeFn, spawnFfmpeg,
      // Cover-phase aborts must prevent source deletion just like encode aborts.
      { ...(signal !== undefined && { signal }) },
    );
    for (const w of result.warnings) callbacks?.onStderr?.(w);

    await cleanupTempFiles(concatPath, join(targetDir, '_metadata.txt'));
    await removeSourceFiles(audioFiles, outputPath);

    warnings.push(...result.warnings);
    return {
      success: true,
      outputFiles: result.outputFiles,
      ...(warnings.length > 0 && { warnings }),
    };
  } catch (error: unknown) {
    await cleanupTempFiles(concatPath, join(targetDir, '_metadata.txt')).catch(() => {});
    throw error;
  }
}

/** Builds ffmpeg chapter metadata in FFMETADATA1 format from cumulative durations. */
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
      ], { env: sanitizedEnv() });
      durations.push(parseFloat(stdout.trim()) || 0);
    } catch {
      durations.push(0);
    }
  }
  return durations;
}

async function collectAudioFiles(dirPath: string): Promise<string[]> {
  return collectSortedAudioFiles(dirPath, { sort: 'lexicographic' });
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
