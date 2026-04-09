import { stat } from 'node:fs/promises';
import { extname } from 'node:path';
import { execFile } from 'node:child_process';
import { parseFile, type ICommonTagsResult } from 'music-metadata';
import type { FastifyBaseLogger } from 'fastify';
import { AUDIO_EXTENSIONS } from './audio-constants.js';
import { collectAudioFilePaths } from './collect-audio-files.js';

export interface AudioScanResult {
  // From tags (first file with tags wins)
  tagNarrator?: string;
  tagTitle?: string;
  tagAuthor?: string;
  tagSeries?: string;
  tagSeriesPosition?: number;
  tagYear?: string;
  tagPublisher?: string;
  coverImage?: Buffer;
  coverMimeType?: string;
  /** Whether any audio file contains embedded cover art */
  hasCoverArt: boolean;

  // Technical (from first audio file)
  codec: string;
  bitrate: number;
  sampleRate: number;
  channels: number;
  bitrateMode: 'cbr' | 'vbr' | 'unknown';
  fileFormat: string;

  // Aggregated
  totalDuration: number; // seconds
  totalSize: number;     // bytes
  fileCount: number;
  chapterCount?: number;
}

export interface AudioScanOptions {
  /** When true, detect cover art presence but skip buffer extraction */
  skipCover?: boolean;
  /** Path to ffprobe binary — when provided, duration is sourced from ffprobe instead of music-metadata */
  ffprobePath?: string;
  /** Optional logger for diagnostics (ffprobe fallback debug, duration mismatch warnings) */
  log?: FastifyBaseLogger;
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
        { timeout: 10_000 },
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
 * Resolve the duration for a single file: ffprobe if available, music-metadata fallback.
 * Logs diagnostics when the two sources disagree or ffprobe fails.
 */
async function resolveFileDuration(
  filePath: string,
  metadataDuration: number | undefined,
  ffprobePath: string | undefined,
  log: FastifyBaseLogger | undefined,
): Promise<number | undefined> {
  if (!ffprobePath) return metadataDuration ?? undefined;

  const ffprobeDuration = await getFFprobeDuration(ffprobePath, filePath);
  if (ffprobeDuration === null) {
    log?.debug({ filePath }, 'ffprobe failed for file, falling back to music-metadata duration');
    return metadataDuration ?? undefined;
  }

  // Warn if ffprobe and music-metadata differ significantly
  if (metadataDuration && metadataDuration > 0) {
    const diff = Math.abs(ffprobeDuration - metadataDuration) / metadataDuration;
    if (diff > 0.1) {
      log?.warn({ filePath, ffprobeDuration, metadataDuration }, 'ffprobe/music-metadata duration mismatch (>10%)');
    }
  }
  return ffprobeDuration;
}

/** Scan a directory of audio files and extract metadata + technical info. */
export async function scanAudioDirectory(
  dirPath: string,
  options?: AudioScanOptions,
): Promise<AudioScanResult | null> {
  const audioFiles = await collectAudioFiles(dirPath);
  if (audioFiles.length === 0) return null;

  const { skipCover = false, ffprobePath, log } = options ?? {};

  const result: AudioScanResult = {
    codec: '',
    bitrate: 0,
    sampleRate: 0,
    channels: 0,
    bitrateMode: 'unknown',
    fileFormat: '',
    totalDuration: 0,
    totalSize: 0,
    fileCount: audioFiles.length,
    hasCoverArt: false,
  };

  let tagsExtracted = false;
  let technicalExtracted = false;

  for (const filePath of audioFiles) {
    try {
      const fileStat = await stat(filePath);
      result.totalSize += fileStat.size;

      const metadata = await parseFile(filePath);

      const fileDuration = await resolveFileDuration(filePath, metadata.format.duration, ffprobePath, log);
      if (fileDuration) {
        result.totalDuration += fileDuration;
      }

      if (!technicalExtracted && metadata.format.codec) {
        extractTechnicalInfo(result, metadata.format, filePath);
        technicalExtracted = true;
      }

      if (!tagsExtracted && (metadata.common.title || metadata.common.album || metadata.common.artist)) {
        extractTagInfo(result, metadata.common, metadata.native);
        tagsExtracted = true;
      }

      extractCoverArt(result, metadata.common, skipCover);
      extractChapterCount(result, metadata);
    } catch {
      continue;
    }
  }

  if (!result.codec) return null;

  return result;
}

function extractTechnicalInfo(
  result: AudioScanResult,
  format: { codec?: string; bitrate?: number; sampleRate?: number; numberOfChannels?: number; codecProfile?: string },
  filePath: string,
): void {
  result.codec = format.codec!;
  result.bitrate = format.bitrate ?? 0;
  result.sampleRate = format.sampleRate ?? 0;
  result.channels = format.numberOfChannels ?? 0;
  result.fileFormat = extname(filePath).slice(1).toLowerCase();

  if (format.codec?.toLowerCase().includes('vbr') ||
      format.codecProfile?.toLowerCase().includes('vbr')) {
    result.bitrateMode = 'vbr';
  } else if (format.bitrate) {
    result.bitrateMode = 'cbr';
  }
}

function extractTagInfo(
  result: AudioScanResult,
  common: ICommonTagsResult,
  native?: Record<string, Array<{ id: string; value: unknown }>>,
): void {
  result.tagTitle = common.title || common.album;
  result.tagAuthor = common.albumartist || common.artist;
  result.tagNarrator = extractNarrator(common, native);
  result.tagSeries = common.grouping;
  result.tagYear = common.year?.toString();
  result.tagPublisher = common.label?.[0];

  if (common.track?.no && common.grouping) {
    result.tagSeriesPosition = common.track.no;
  }
}

function extractCoverArt(result: AudioScanResult, common: ICommonTagsResult, skipCover: boolean): void {
  if (result.hasCoverArt || !common.picture?.length) return;
  result.hasCoverArt = true;
  if (!skipCover) {
    const pic = common.picture[0];
    result.coverImage = Buffer.from(pic.data);
    result.coverMimeType = pic.format;
  }
}

function extractChapterCount(
  result: AudioScanResult,
  metadata: { format: { container?: string; codec?: string }; native?: Record<string, Array<{ id: string; value: unknown }>> },
): void {
  if (result.chapterCount) return;
  const isM4B = metadata.native?.['iTunes']?.some(t => t.id === 'chpl') ||
    (metadata.format.container === 'MPEG-4' && metadata.format.codec === 'AAC');
  if (!isM4B) return;
  const chapters = metadata.native?.['iTunes']?.filter(t => t.id === 'chpl');
  if (chapters?.length) {
    result.chapterCount = chapters.length;
  }
}

/** Recursively collect all audio files in a directory, sorted by name. */
async function collectAudioFiles(dirPath: string): Promise<string[]> {
  try {
    const pathStat = await stat(dirPath);
    if (pathStat.isFile()) {
      return AUDIO_EXTENSIONS.has(extname(dirPath).toLowerCase()) ? [dirPath] : [];
    }
    const files = await collectAudioFilePaths(dirPath, { recursive: true, skipHidden: true });
    return files.sort();
  } catch {
    // stat or readdir error — return whatever we have
    return [];
  }
}

/** Extract narrator from metadata tags with broad fallback chain. */
// eslint-disable-next-line complexity -- 4-tier fallback chain: native tags → composer → comment regex → artist
function extractNarrator(
  common: ICommonTagsResult,
  native?: Record<string, Array<{ id: string; value: unknown }>>,
): string | undefined {
  // 1. Check native tags for explicit narrator fields (Audible M4B: ©nrt, NARR)
  if (native) {
    for (const format of Object.values(native)) {
      for (const tag of format) {
        if (/^(©nrt|NARR|narrator)$/i.test(tag.id) && typeof tag.value === 'string' && tag.value.trim()) {
          return tag.value.trim();
        }
      }
    }
  }

  // 2. Composer (many audiobook taggers use this for narrator)
  if (common.composer && common.composer.length > 0) {
    return common.composer[0];
  }

  // 3. Comment patterns: "narrated by", "read by", "performed by", "voice:"
  const commentEntries = common.comment;
  if (commentEntries && commentEntries.length > 0) {
    const commentText = commentEntries[0].text ?? String(commentEntries[0]);
    const match = commentText.match(/(?:narrated|read|performed|voiced?)\s*(?:by\s*)?[:.]?\s*([^,.\n]+)/i);
    if (match) return match[1].trim();
  }

  // 4. Artist fallback — only if different from albumartist (author)
  if (common.artist && common.albumartist && common.artist !== common.albumartist) {
    return common.artist;
  }

  return undefined;
}
