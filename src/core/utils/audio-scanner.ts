import { stat } from 'node:fs/promises';
import { extname, basename } from 'node:path';
import { parseFile, type ICommonTagsResult } from 'music-metadata';
import { AUDIO_EXTENSIONS, isHiddenName } from './audio-constants.js';
import { collectAudioFilePaths } from './collect-audio-files.js';
import { resolveFileDuration, fillTechnicalViaFFprobe, getFFprobeStreamDuration } from './audio-probe.js';
export { getFFprobeDuration, getFFprobeStreamInfo, getFFprobeStreamDuration } from './audio-probe.js';

export interface AudioScanResult {
  // From tags (first file with tags wins, except tagTitle for multi-file scans —
  // see resolveMultiFileAlbum for the cross-file album-consistency rule)
  tagNarrator?: string;
  tagTitle?: string;
  tagAuthor?: string;
  /** Remaining split `albumartist` tokens after `tagAuthor`; independent of `tagNarrator`. */
  tagAdditionalArtists?: string;
  tagSeries?: string;
  tagSeriesPosition?: number;
  tagYear?: string;
  tagPublisher?: string;
  /**
   * Raw non-disc album: trimmed for one file, consensus across multiple files. Kept separate
   * from `tagTitle` so tag search can recover when the title contains annotation noise.
   */
  tagAlbum?: string;
  /** Uppercase Audible ASIN from allowlisted native tags, comments, or `podcastIdentifier`. */
  tagAsin?: string;
  coverImage?: Buffer;
  coverMimeType?: string;
  hasCoverArt: boolean;

  // Technical (from first audio file)
  codec: string;
  bitrate: number;
  sampleRate: number;
  channels: number;
  bitrateMode: 'cbr' | 'vbr' | 'unknown';
  fileFormat: string;

  totalDuration: number; // seconds
  totalSize: number;     // bytes
  fileCount: number;
  chapterCount?: number;
}

export interface AudioScanOptions {
  /** When true, detect cover art presence but skip buffer extraction */
  skipCover?: boolean | undefined;
  /** Enables ffprobe arbitration for missing or implausible music-metadata durations. */
  ffprobePath?: string | undefined;
  /** Receives duration mismatches and fully rejected durations. */
  onWarn?: ((msg: string, payload?: Record<string, unknown>) => void) | undefined;
  /** Receives cases where neither duration source produced a value. */
  onDebug?: ((msg: string, payload?: Record<string, unknown>) => void) | undefined;
  /**
   * Called when files parsed but neither parser found a codec. Not called for an empty directory
   * or when every parse failed, preserving the distinction between unreadable codecs and probe failure.
   */
  onFilesWithoutCodec?: (() => void) | undefined;
}

/** Loose music-metadata `format` shape used for the codec-fallback merge. */
export interface MetadataFormat {
  codec?: string;
  bitrate?: number;
  sampleRate?: number;
  numberOfChannels?: number;
  codecProfile?: string;
}

/**
 * Reads one file's album for mixed-content comparison; directory consensus semantics do not apply.
 * Parse failure is deliberately indistinguishable from a missing album signal.
 */
export async function readAlbumTag(filePath: string): Promise<string | undefined> {
  try {
    const metadata = await parseFile(filePath);
    const album = metadata.common.album?.trim();
    return album && album.length > 0 ? album : undefined;
  } catch {
    return undefined;
  }
}

export async function scanAudioDirectory(
  dirPath: string,
  options?: AudioScanOptions,
): Promise<AudioScanResult | null> {
  const audioFiles = await collectAudioFiles(dirPath);
  if (audioFiles.length === 0) return null;

  const { skipCover = false, ffprobePath, onWarn, onDebug, onFilesWithoutCodec } = options ?? {};

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

  const isMultiFile = audioFiles.length > 1;
  const loop = await scanFiles(audioFiles, result, isMultiFile, { skipCover, ffprobePath, onWarn, onDebug });

  if (loop.firstTaggedCommon !== null) {
    const multiFileTagAlbum = isMultiFile ? resolveMultiFileAlbum(loop.fileAlbums) : undefined;
    extractTagInfo(result, loop.firstTaggedCommon, loop.firstTaggedNative, isMultiFile, multiFileTagAlbum);
  }

  const codecCandidatePath = await applyCodecFallback(result, loop.parsedCandidates, ffprobePath, onDebug);

  if (!result.codec) {
    // Only a successful parse can establish an unreadable codec; all parse failures remain a probe failure.
    if (loop.parsedCandidates.length > 0) onFilesWithoutCodec?.();
    return null;
  }

  // Recover duration from the same file that supplied the fallback codec; an honest miss stays zero.
  if (codecCandidatePath && ffprobePath && result.totalDuration === 0) {
    const streamDuration = await getFFprobeStreamDuration(ffprobePath, codecCandidatePath);
    if (streamDuration && streamDuration > 0) result.totalDuration += streamDuration;
  }

  return result;
}

interface ScanLoopState {
  firstTaggedCommon: ICommonTagsResult | null;
  firstTaggedNative: Record<string, Array<{ id: string; value: unknown }>> | undefined;
  /** Successfully parsed codec misses, in scan order; empty also distinguishes total parse failure. */
  parsedCandidates: Array<{ format: MetadataFormat; filePath: string }>;
  fileAlbums: Array<string | undefined>;
}

async function scanFiles(
  audioFiles: string[],
  result: AudioScanResult,
  isMultiFile: boolean,
  options: { skipCover: boolean; ffprobePath?: string | undefined; onWarn?: AudioScanOptions['onWarn']; onDebug?: AudioScanOptions['onDebug'] },
): Promise<ScanLoopState> {
  const fileAlbums: Array<string | undefined> = [];
  let firstTaggedCommon: ICommonTagsResult | null = null;
  let firstTaggedNative: Record<string, Array<{ id: string; value: unknown }>> | undefined;
  const parsedCandidates: ScanLoopState['parsedCandidates'] = [];
  let technicalExtracted = false;

  for (const filePath of audioFiles) {
    const metadata = await processOneFile(filePath, result, options);
    if (!metadata) {
      if (isMultiFile) fileAlbums.push(undefined);
      continue;
    }

    if (metadata.format.codec) {
      if (!technicalExtracted) {
        extractTechnicalInfo(result, metadata.format, filePath);
        technicalExtracted = true;
      }
    } else {
      // Retain only parsed codec misses; fallback must never run on a file that did not parse.
      parsedCandidates.push({ format: metadata.format, filePath });
    }

    if (isMultiFile) recordFileAlbum(metadata.common.album, fileAlbums);

    if (firstTaggedCommon === null && hasTagSignal(metadata.common)) {
      firstTaggedCommon = metadata.common;
      firstTaggedNative = metadata.native;
    }
  }

  return { firstTaggedCommon, firstTaggedNative, parsedCandidates, fileAlbums };
}

/**
 * xHE-AAC/USAC fallback for files music-metadata parsed without a codec. Probe in scan order,
 * merge partial fields, and return the winning path for same-file duration recovery. Never probe
 * an unparsed file: that could mask an all-file access failure as a codec-only success.
 */
async function applyCodecFallback(
  result: AudioScanResult,
  parsedCandidates: ScanLoopState['parsedCandidates'],
  ffprobePath: string | undefined,
  onDebug: AudioScanOptions['onDebug'],
): Promise<string | null> {
  if (result.codec || !ffprobePath || parsedCandidates.length === 0) return null;
  for (const candidate of parsedCandidates) {
    await fillTechnicalViaFFprobe(result, candidate.format, candidate.filePath, ffprobePath, onDebug);
    if (result.codec) return candidate.filePath;
  }
  return null;
}

async function processOneFile(
  filePath: string,
  result: AudioScanResult,
  options: { skipCover: boolean; ffprobePath?: string | undefined; onWarn?: AudioScanOptions['onWarn']; onDebug?: AudioScanOptions['onDebug'] },
): Promise<Awaited<ReturnType<typeof parseFile>> | null> {
  try {
    const fileStat = await stat(filePath);
    result.totalSize += fileStat.size;

    const metadata = await parseFile(filePath);

    const fileDuration = await resolveFileDuration(filePath, metadata.format.duration, fileStat.size, options.ffprobePath, options.onWarn, options.onDebug);
    if (fileDuration) result.totalDuration += fileDuration;

    extractCoverArt(result, metadata.common, options.skipCover);
    extractChapterCount(result, metadata);
    return metadata;
  } catch {
    return null;
  }
}

function recordFileAlbum(album: string | undefined, fileAlbums: Array<string | undefined>): void {
  const trimmed = album?.trim();
  fileAlbums.push(trimmed && trimmed.length > 0 ? trimmed : undefined);
}

function hasTagSignal(common: ICommonTagsResult): boolean {
  return Boolean(common.title || common.album || common.artist);
}

/**
 * A multi-file album is usable only when every file has the same non-disc value. Never fall back
 * to `common.title`; chapter-encoded books conventionally store chapter names there.
 */
function resolveMultiFileAlbum(fileAlbums: Array<string | undefined>): string | undefined {
  if (fileAlbums.length === 0) return undefined;
  if (fileAlbums.some(a => !a)) return undefined;
  const first = fileAlbums[0]!;
  if (!fileAlbums.every(a => a === first)) return undefined;
  if (/^(disc|cd)\s*\d+$/i.test(first)) return undefined;
  return first;
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
  native: Record<string, Array<{ id: string; value: unknown }>> | undefined,
  isMultiFile: boolean,
  multiFileTagAlbum: string | undefined,
): void {
  const tagTitle = pickTagTitle(common, isMultiFile, multiFileTagAlbum);
  if (tagTitle !== undefined) result.tagTitle = tagTitle;

  const tagAlbum = pickTagAlbum(common, isMultiFile, multiFileTagAlbum);
  if (tagAlbum !== undefined) result.tagAlbum = tagAlbum;

  const tagAsin = extractAsin(common, native);
  if (tagAsin !== undefined) result.tagAsin = tagAsin;

  assignTagFields(result, common, native);
}

function assignTagFields(
  result: AudioScanResult,
  common: ICommonTagsResult,
  native: Record<string, Array<{ id: string; value: unknown }>> | undefined,
): void {
  const authors = parseAuthors(common.albumartist || common.artist);
  if (authors.tagAuthor !== undefined) result.tagAuthor = authors.tagAuthor;
  if (authors.tagAdditionalArtists !== undefined) result.tagAdditionalArtists = authors.tagAdditionalArtists;

  const tagNarrator = extractNarrator(common, native);
  if (tagNarrator !== undefined) result.tagNarrator = tagNarrator;
  if (common.grouping !== undefined) result.tagSeries = common.grouping;
  const tagYear = common.year?.toString();
  if (tagYear !== undefined) result.tagYear = tagYear;
  const tagPublisher = common.label?.[0];
  if (tagPublisher !== undefined) result.tagPublisher = tagPublisher;

  // Position zero is a valid tag value; do not replace this null check with a truthy gate.
  if (common.track?.no != null && common.grouping) {
    result.tagSeriesPosition = common.track.no;
  }
}

function pickTagTitle(common: ICommonTagsResult, isMultiFile: boolean, multiFileTagAlbum: string | undefined): string | undefined {
  if (isMultiFile) return multiFileTagAlbum;
  return common.title || common.album;
}

const DISC_PATTERN_REGEX = /^(disc|cd)\s*\d+$/i;

function pickTagAlbum(
  common: ICommonTagsResult,
  isMultiFile: boolean,
  multiFileTagAlbum: string | undefined,
): string | undefined {
  if (isMultiFile) return multiFileTagAlbum;
  const album = common.album?.trim();
  if (!album) return undefined;
  if (DISC_PATTERN_REGEX.test(album)) return undefined;
  return album;
}

const ASIN_REGEX = /\bB[A-Z0-9]{9}\b/;

/**
 * Extracts the first uppercase Audible ASIN from allowlisted MP4/ID3 tags, comments, or
 * `podcastIdentifier`.
 */
function extractAsin(
  common: ICommonTagsResult,
  native: Record<string, Array<{ id: string; value: unknown }>> | undefined,
): string | undefined {
  const fromNative = scanNativeForAsin(native);
  if (fromNative !== undefined) return fromNative;
  const fromComment = scanCommentForAsin(common.comment);
  if (fromComment !== undefined) return fromComment;
  const podcastId = (common as { podcastIdentifier?: string }).podcastIdentifier;
  if (typeof podcastId === 'string') {
    const match = podcastId.toUpperCase().match(ASIN_REGEX);
    if (match) return match[0];
  }
  return undefined;
}

/**
 * Only ASIN-bearing MP4 atoms and ID3 comment frames are eligible. Scanning arbitrary native
 * values can promote an incidental token to a false high-confidence ASIN.
 */
const ASIN_TAG_ID_REGEX = /(?::|^)(?:asin|cnID)$|^COMM(?::|$)/i;

function scanNativeForAsin(
  native: Record<string, Array<{ id: string; value: unknown }>> | undefined,
): string | undefined {
  if (!native) return undefined;
  for (const tags of Object.values(native)) {
    for (const tag of tags) {
      if (!ASIN_TAG_ID_REGEX.test(tag.id)) continue;
      const match = matchAsinFromTagValue(tag.value);
      if (match) return match;
    }
  }
  return undefined;
}

function matchAsinFromTagValue(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value.toUpperCase().match(ASIN_REGEX)?.[0];
  }
  if (value && typeof value === 'object') {
    // ID3v2 COMM frames carry { description, text } objects
    const text = (value as { text?: unknown }).text;
    if (typeof text === 'string') {
      return text.toUpperCase().match(ASIN_REGEX)?.[0];
    }
  }
  return undefined;
}

function scanCommentForAsin(comment: ICommonTagsResult['comment']): string | undefined {
  if (!comment || comment.length === 0) return undefined;
  for (const entry of comment) {
    const text = entry?.text ?? (typeof entry === 'string' ? entry : undefined);
    if (typeof text === 'string') {
      const match = text.toUpperCase().match(ASIN_REGEX);
      if (match) return match[0];
    }
  }
  return undefined;
}

function parseAuthors(rawAuthor: string | undefined): { tagAuthor?: string; tagAdditionalArtists?: string } {
  if (!rawAuthor) return {};
  const parts = rawAuthor.split(/[,;&]/).map(s => s.trim()).filter(s => s.length > 0);
  if (parts.length === 0) return {};
  if (parts.length === 1) return { tagAuthor: parts[0]! };
  return { tagAuthor: parts[0]!, tagAdditionalArtists: parts.slice(1).join(', ') };
}

function extractCoverArt(result: AudioScanResult, common: ICommonTagsResult, skipCover: boolean): void {
  if (result.hasCoverArt || !common.picture?.length) return;
  result.hasCoverArt = true;
  if (!skipCover) {
    const pic = common.picture[0]!;
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

async function collectAudioFiles(dirPath: string): Promise<string[]> {
  try {
    const pathStat = await stat(dirPath);
    if (pathStat.isFile()) {
      // Direct-file branch: a hidden file (`.foo.mp3`) is a born-hidden transient, never scanned.
      return !isHiddenName(basename(dirPath)) && AUDIO_EXTENSIONS.has(extname(dirPath).toLowerCase()) ? [dirPath] : [];
    }
    const files = await collectAudioFilePaths(dirPath, { recursive: true, skipHidden: true });
    return files.sort();
  } catch {
    return [];
  }
}

// eslint-disable-next-line complexity -- 4-tier fallback chain: native tags → composer → comment regex → artist
function extractNarrator(
  common: ICommonTagsResult,
  native?: Record<string, Array<{ id: string; value: unknown }>>,
): string | undefined {
  // Audible M4B and common narrator fields.
  if (native) {
    for (const format of Object.values(native)) {
      for (const tag of format) {
        if (/^(©nrt|NARR|narrator)$/i.test(tag.id) && typeof tag.value === 'string' && tag.value.trim()) {
          return tag.value.trim();
        }
      }
    }
  }

  // Many audiobook taggers use composer for narrator.
  if (common.composer && common.composer.length > 0) {
    return common.composer[0];
  }

  const commentEntries = common.comment;
  if (commentEntries && commentEntries.length > 0) {
    const commentText = commentEntries[0]!.text ?? String(commentEntries[0]!);
    const match = commentText.match(/(?:narrated|read|performed|voiced?)\s*(?:by\s*)?[:.]?\s*([^,.\n]+)/i);
    if (match) return match[1]!.trim();
  }

  if (common.artist && common.albumartist && common.artist !== common.albumartist) {
    return common.artist;
  }

  return undefined;
}
