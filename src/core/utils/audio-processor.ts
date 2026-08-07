import { execFile, spawn } from 'node:child_process';
import { rename, unlink, writeFile, rm } from 'node:fs/promises';
import { join, extname, basename } from 'node:path';
import { promisify } from 'node:util';
import { collectSortedAudioFiles, compareAudioNames, disambiguateStems } from './collect-audio-files.js';
import { dotPrefixBasename } from './hidden-staging.js';
import { getErrorMessage } from '@shared/error-message.js';
import { readChapterSources, resolveChapterTitle } from './chapter-resolver.js';
import type { ChapterSource } from './chapter-resolver.js';
import { renderFilename } from './naming.js';
import type { NamingOptions } from './naming.js';
import { withCoverArtPipeline } from './cover-art.js';
import { deriveFfprobePath } from './ffprobe-path.js';
// Imported by path, not via the core/utils barrel — the barrel is excluded from
// the Vite client build, and sanitizedEnv is Node-only. Mirrors the script
// notifier / post-processing-script call sites.
import { sanitizedEnv } from './sanitized-env.js';
import { noticeMessages, resolveCodecArgs, resolveTargetBitrate } from './encode-strategy.js';

const execFileAsync = promisify(execFile);

/** Fixed stall timeout for ffmpeg processes — kills after this many ms with no stdout progress. */
const FFMPEG_STALL_TIMEOUT_MS = 60_000;

export interface ProcessingConfig {
  ffmpegPath: string;
  outputFormat: 'm4b' | 'mp3';
  /**
   * Target bitrate in **kbps** — never divided by this module. Two modes:
   *
   * - **Omitted (or present but unusable — see below): keep original.** A source set that
   *   already matches the output container is stream-copied (`-c:a copy`, no re-encode).
   *   Otherwise it is re-encoded at the highest target the source evidence supports that the
   *   selected encoder will *accept*; with no usable evidence, at a conservative default.
   * - **Present and usable: `min(source, target)`** — except where the encoder's lowest
   *   accepted rate is higher than that, which is the one case an emitted value exceeds the
   *   request.
   *
   * Both modes are legalized for the output encoder (MP3 snaps to a legal Layer III rate for
   * the source sample rate; AAC caps at the settings maximum), and every adjustment this
   * module makes is disclosed through `ProcessingResult.warnings`.
   *
   * The emitted value is a **request**, not a promise about the output: the encoder may
   * normalize it further without this module observing it, so no relationship is claimed
   * between the emitted bitrate and any source file's bitrate.
   *
   * An unusable value — non-integer, non-finite, or below the plausibility floor — is treated
   * as absent (keep-original semantics) and reported as a warning.
   */
  bitrate?: number | undefined;
  /** Source bitrate in kbps (converted from bps at the call site). When set, effective bitrate is min(source, target) to prevent upsampling. */
  sourceBitrateKbps?: number | undefined;
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
  // `warnings` is on BOTH variants on purpose: a run that adjusted a bitrate and then failed
  // for an unrelated reason must still report the adjustment.
  | { success: true; outputFiles: string[]; warnings?: string[] }
  | { success: false; error: string; warnings?: string[] };

/** Callbacks for streaming progress and stderr from ffmpeg. Keeps src/core/ adapter-agnostic. */
export interface ProcessingCallbacks {
  onProgress?: (phase: string, percentage?: number) => void;
  onStderr?: (line: string) => void;
}

// ffmpeg detection / probing / resolution live in ./ffmpeg-resolver.ts to keep this file under the
// max-lines cap. Re-exported so existing importers (merge/tagging/bulk services, boot, and the
// resolver's own test suite) keep importing them from audio-processor unchanged.
export { detectFfmpegPath, probeFfmpeg, resolveFfmpegPath, resetFfmpegPathCache } from './ffmpeg-resolver.js';

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

  // Skip processing for single m4b (already ABS-ready) — but only when the configured target
  // is also m4b AND no usable explicit bitrate is configured. With outputFormat 'mp3', or with
  // a usable target, the file must fall through to the convert path instead of being returned
  // unchanged; where the target is absent-or-unusable, returning it untouched IS the copy path
  // with zero ffmpeg work. The unusable-target notice still has to surface here.
  const target = resolveTargetBitrate(config.bitrate);
  if (
    audioFiles.length === 1 &&
    extname(audioFiles[0]!).toLowerCase() === '.m4b' &&
    config.outputFormat === 'm4b' &&
    target.targetKbps === undefined
  ) {
    const noOpWarnings = noticeMessages(target.notices);
    return { success: true, outputFiles: audioFiles, ...(noOpWarnings.length > 0 && { warnings: noOpWarnings }) };
  }

  const shouldMerge = config.mergeBehavior === 'always' ||
    (config.mergeBehavior === 'multi-file-only' && audioFiles.length > 1);

  // Resolver notices, accumulated in command order so a multi-file convert keeps every earlier
  // adjustment even when a later command fails.
  const warnings: string[] = [];

  try {
    // Read chapter sources once — needed for merge (chapter markers) and convert (file naming)
    const chapterSources = await readChapterSources(audioFiles);

    if (shouldMerge && audioFiles.length > 1) {
      return await mergeFiles(targetDir, chapterSources, config, context, warnings, callbacks, signal);
    }
    return await convertFiles(targetDir, audioFiles, config, context, chapterSources, warnings, callbacks, signal);
  } catch (error: unknown) {
    return {
      success: false,
      error: getErrorMessage(error),
      ...(warnings.length > 0 && { warnings }),
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

    const child = spawn(ffmpegPath, args, { env: sanitizedEnv() });

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
            const outTimeUs = parseInt(match[1]!, 10);
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
 * The ffmpeg input index of the most recently pushed `-i` operand.
 *
 * The merge command's input layout differs by output format (m4b opens a generated-chapter
 * input that mp3 does not), so every `-map*` operand is DERIVED from the argv being built
 * rather than written as a literal — a hardcoded index silently points at the wrong file the
 * moment an input is added or removed.
 */
function lastInputIndex(args: string[]): number {
  return args.filter((token) => token === '-i').length - 1;
}

/**
 * Merge multiple audio files into a single output file with chapter markers.
 */
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
    let chapterInput: number | undefined;
    if (outputExt === 'm4b') {
      metadataPath = join(targetDir, '_metadata.txt');
      const metadataContent = buildChapterMetadata(chapterSources, durations);
      await writeFile(metadataPath, metadataContent, 'utf-8');
      args.push('-i', metadataPath);
      chapterInput = lastInputIndex(args);
    }

    // #2078: open the first source purely as a metadata donor. The generated FFMETADATA1 file
    // carries ONLY [CHAPTER] blocks, so the pre-#2078 `-map_metadata 1` overrode ffmpeg's
    // default with an EMPTY global tag set — every merged output came out metadata-naked. The
    // concat demuxer's own propagation of format-level metadata is version-dependent, so this
    // maps the source explicitly rather than relying on `-map_metadata 0`.
    args.push('-i', audioFiles[0]!);
    const metadataInput = lastInputIndex(args);

    // Mandatory, not cosmetic: with a second audio-bearing input open, ffmpeg's automatic
    // stream selection is free to pick the donor's audio instead of the concat's — which
    // would emit the first part alone as a file that still probes as valid.
    args.push('-map', '0:a');
    args.push('-map_metadata', String(metadataInput));
    // Always emitted, on both formats and in both copy and encode modes — ffmpeg's DEFAULT
    // chapter mapping copies from the FIRST input that carries chapters, and since #2078 that
    // default is never the right answer:
    //
    //  - m4b: pin the GENERATED set (input 1) explicitly. Otherwise whatever the concat demuxer
    //    propagates from the source parts, or the metadata donor's own internal chapters, can
    //    be the first chapter-bearing input and win.
    //  - mp3: there IS no generated set to map, so the only correct answer is suppression. The
    //    concat input exposes no chapters, which makes the donor opened for `-map_metadata` the
    //    first chapter-bearing input — #2083: part 01's internal CHAP set landed verbatim on the
    //    merged output, spanning only its own first-part span of a whole-book file.
    //
    // `-1` is the ONE deliberately-literal map operand in this argv: it is ffmpeg's "copy no
    // chapters" sentinel, not an input index, so it is exempt from the derive-from-argv
    // discipline `lastInputIndex` enforces. Do not "fix" it into a computed index.
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
      // #2080: the same signal the encode above already gets. An abort during the cover phases
      // now throws past `removeSourceFiles` through the catch below, exactly as a main-encode
      // abort does — the operator cancelled, so the source parts stay on disk.
      { ...(signal !== undefined && { signal }) },
    );
    for (const w of result.warnings) callbacks?.onStderr?.(w);

    // Clean up: remove source files and temp files
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

/**
 * Compute the output stem for every convert source file, keyed by filePath.
 *
 * Honors `fileFormat` + book/per-file tokens and disambiguates colliding stems with a
 * zero-padded ordinal — byte-for-byte matching `planFileRenames` (same shared
 * `disambiguateStems` width/ordering) so a later Rename All Books is a no-op. Per-file
 * tokens/ordinals are assigned in `compareAudioNames` order (NOT the lexicographic order
 * the convert path collects with), matching the rename path's play-order numbering.
 * When `fileFormat` is empty, falls back to the original basename (already unique).
 */
function computeConvertStems(
  audioFiles: string[],
  sourceMap: Map<string, ChapterSource>,
  context: ProcessingContext,
): Map<string, string> {
  if (!context.fileFormat) {
    return new Map(audioFiles.map(f => [f, basename(f, extname(f))]));
  }

  const trackTotal = audioFiles.length;
  // Re-sort into play order so trackNumber + collision ordinals match planFileRenames,
  // which sorts with compareAudioNames rather than the lexicographic collect order.
  const ordered = [...audioFiles].sort(compareAudioNames);

  const baseTokens = { author: context.author, title: context.title, ...context.bookTokens };
  const stems = ordered.map((filePath, i) => {
    const source = sourceMap.get(filePath);
    return renderFilename(context.fileFormat!, {
      ...baseTokens,
      trackNumber: i + 1, trackTotal,
      partName: source ? resolveChapterTitle(source, i) : undefined,
    }, context.namingOptions);
  });

  const finalStems = disambiguateStems(stems);
  return new Map(ordered.map((filePath, i) => [filePath, finalStems[i]!]));
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
  warnings: string[],
  callbacks?: ProcessingCallbacks,
  signal?: AbortSignal,
): Promise<ProcessingResult> {
  // Build a map from filePath → ChapterSource for quick lookup
  const sourceMap = new Map(chapterSources.map(s => [s.filePath, s]));
  const stemFor = computeConvertStems(audioFiles, sourceMap, context);

  const encodeFn = async (): Promise<string[]> => {
    const results: string[] = [];
    for (const filePath of audioFiles) {
      const stem = stemFor.get(filePath)!;

      const outputPath = join(targetDir, `${stem}.${config.outputFormat}`);
      const sameFile = filePath === outputPath;
      // Defense-in-depth (AC12): the same-file convert temp is born hidden (`.<stem>_tmp.<ext>`) so a
      // concurrent scan/ABS never sees a half-written encode. `rename(writePath, outputPath)` below
      // still finalizes atomically over the original.
      const writePath = sameFile
        ? dotPrefixBasename(join(targetDir, `${stem}_tmp.${config.outputFormat}`))
        : outputPath;

      // One resolution per constructed command: this file's own evidence, never the directory's.
      const codecArgs = await resolveCodecArgs(config, [filePath], warnings, callbacks?.onStderr);

      const args = ['-y', '-i', filePath, ...codecArgs];
      args.push('-vn', '-max_muxing_queue_size', '4096');
      if (config.outputFormat === 'm4b') args.push('-f', 'mp4');
      args.push('-progress', 'pipe:1', writePath);

      await spawnFfmpeg(config.ffmpegPath, args, {
        ...(callbacks?.onStderr !== undefined && { onStderr: callbacks.onStderr }),
        ...(signal !== undefined && { signal }),
      });

      // rename() atomically replaces outputPath. Don't unlink first — that creates a data-loss
      // window if the rename fails. CLAUDE.md gotcha: "rename() is atomic — just rename over the target."
      if (sameFile) { await rename(writePath, outputPath); }
      else { await unlink(filePath); }

      results.push(outputPath);
    }
    return results;
  };

  const result = await withCoverArtPipeline(
    config.ffmpegPath, audioFiles, targetDir, config.outputFormat, encodeFn, spawnFfmpeg,
    { ...(signal !== undefined && { signal }) }, // #2080 — same signal as the per-file encodes
  );
  for (const w of result.warnings) callbacks?.onStderr?.(w);
  warnings.push(...result.warnings);
  return {
    success: true,
    outputFiles: result.outputFiles,
    ...(warnings.length > 0 && { warnings }),
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
      ], { env: sanitizedEnv() });
      durations.push(parseFloat(stdout.trim()) || 0);
    } catch {
      durations.push(0);
    }
  }
  return durations;
}

/** Collect audio files in a directory (non-recursive, lexicographic sort). */
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
