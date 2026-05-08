import { stat } from 'node:fs/promises';
import { extname } from 'node:path';
import { execFile } from 'node:child_process';
import { parseFile, type ICommonTagsResult } from 'music-metadata';
import { AUDIO_EXTENSIONS } from './audio-constants.js';
import { collectAudioFilePaths } from './collect-audio-files.js';

export interface AudioScanResult {
  // From tags (first file with tags wins, except tagTitle for multi-file scans —
  // see resolveMultiFileAlbum for the cross-file album-consistency rule)
  tagNarrator?: string;
  tagTitle?: string;
  tagAuthor?: string;
  /**
   * Remaining tokens from a comma/semicolon/ampersand-split `albumartist`
   * after the first segment (which becomes `tagAuthor`). Independent of
   * `tagNarrator`. Joined with `, ` for caller convenience.
   */
  tagAdditionalArtists?: string;
  tagSeries?: string;
  tagSeriesPosition?: number;
  tagYear?: string;
  tagPublisher?: string;
  /**
   * Raw album from native tags. Multi-file: cross-file consensus (all agree,
   * non-empty, non-disc-pattern). Single-file: `common.album.trim()` when
   * non-empty and not a disc-pattern. Stored independently of `tagTitle` so
   * the tag-search planner can use it as a recovery candidate when the
   * tag title carries annotation noise.
   */
  tagAlbum?: string;
  /**
   * Audible ASIN extracted from native tags (iTunes :ASIN/cnID atoms, ID3v2
   * comment frames, or `common.podcastIdentifier`). Uppercase-normalized.
   */
  tagAsin?: string;
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
  skipCover?: boolean | undefined;
  /** Path to ffprobe binary — when provided, duration is sourced from ffprobe instead of music-metadata */
  ffprobePath?: string | undefined;
  /** Diagnostic warning callback (e.g. ffprobe/music-metadata duration mismatch). Caller maps to its logger. */
  onWarn?: ((msg: string, payload?: Record<string, unknown>) => void) | undefined;
  /** Diagnostic debug callback (e.g. ffprobe failure → music-metadata fallback). Caller maps to its logger. */
  onDebug?: ((msg: string, payload?: Record<string, unknown>) => void) | undefined;
}

/**
 * Read the trimmed album tag from a single audio file.
 * Used by mixed-content bonus detection (book-discovery) to compare albums
 * across the top-level vs. absorbed-descendant audio groups. Whole-directory
 * helpers (`scanAudioDirectory` / `resolveMultiFileAlbum`) have consensus
 * semantics that don't fit the per-file two-group comparison this requires.
 * Any read failure returns `undefined` so callers can treat it as "no album
 * signal" without try/catch on each call.
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
  onWarn: AudioScanOptions['onWarn'],
  onDebug: AudioScanOptions['onDebug'],
): Promise<number | undefined> {
  if (!ffprobePath) return metadataDuration ?? undefined;

  const ffprobeDuration = await getFFprobeDuration(ffprobePath, filePath);
  if (ffprobeDuration === null) {
    onDebug?.('ffprobe failed for file, falling back to music-metadata duration', { filePath });
    return metadataDuration ?? undefined;
  }

  // Warn if ffprobe and music-metadata differ significantly
  if (metadataDuration && metadataDuration > 0) {
    const diff = Math.abs(ffprobeDuration - metadataDuration) / metadataDuration;
    if (diff > 0.1) {
      onWarn?.('ffprobe/music-metadata duration mismatch (>10%)', { filePath, ffprobeDuration, metadataDuration });
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

  const { skipCover = false, ffprobePath, onWarn, onDebug } = options ?? {};

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
  const fileAlbums: Array<string | undefined> = [];
  let firstTaggedCommon: ICommonTagsResult | null = null;
  let firstTaggedNative: Record<string, Array<{ id: string; value: unknown }>> | undefined;
  let technicalExtracted = false;

  for (const filePath of audioFiles) {
    const metadata = await processOneFile(filePath, result, { skipCover, ffprobePath, onWarn, onDebug });
    if (!metadata) {
      if (isMultiFile) fileAlbums.push(undefined);
      continue;
    }

    if (!technicalExtracted && metadata.format.codec) {
      extractTechnicalInfo(result, metadata.format, filePath);
      technicalExtracted = true;
    }

    if (isMultiFile) recordFileAlbum(metadata.common.album, fileAlbums);

    if (firstTaggedCommon === null && hasTagSignal(metadata.common)) {
      firstTaggedCommon = metadata.common;
      firstTaggedNative = metadata.native;
    }
  }

  if (firstTaggedCommon !== null) {
    const multiFileTagAlbum = isMultiFile ? resolveMultiFileAlbum(fileAlbums) : undefined;
    extractTagInfo(result, firstTaggedCommon, firstTaggedNative, isMultiFile, multiFileTagAlbum);
  }

  if (!result.codec) return null;

  return result;
}

/** Per-file scan: parses metadata, accumulates totals, extracts cover+chapters. Returns null on failure. */
async function processOneFile(
  filePath: string,
  result: AudioScanResult,
  options: { skipCover: boolean; ffprobePath?: string | undefined; onWarn?: AudioScanOptions['onWarn']; onDebug?: AudioScanOptions['onDebug'] },
): Promise<Awaited<ReturnType<typeof parseFile>> | null> {
  try {
    const fileStat = await stat(filePath);
    result.totalSize += fileStat.size;

    const metadata = await parseFile(filePath);

    const fileDuration = await resolveFileDuration(filePath, metadata.format.duration, options.ffprobePath, options.onWarn, options.onDebug);
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
 * For multi-file scans, accept the cross-file `tag.album` as the book title
 * only when every file has a non-empty album value, all values match, and the
 * value is not a disc-pattern (e.g. "Disc 1", "CD 02"). Returns undefined
 * otherwise — multi-file scans NEVER fall back to common.title because that is
 * chapter-level by convention for chapter-encoded audiobooks.
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

  if (common.track?.no && common.grouping) {
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
 * Extract an Audible ASIN (B0 + 8 alphanumeric, uppercase-normalized) from
 * native tags. Checks MP4 atoms (`iTunes:ASIN`, `cnID`), ID3v2 comment frames,
 * and `common.podcastIdentifier`. Returns the first match found. Empty/missing
 * → undefined.
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
 * Native tag IDs that carry an ASIN (per AC3): MP4 iTunes:ASIN atom, MP4 cnID
 * atom, and ID3v2 COMM (comment) frames. Other native fields (TIT2, TPE1, ©nam,
 * etc.) MUST NOT be scanned — an unrelated string field that happens to contain
 * a B[A-Z0-9]{9} substring would otherwise produce a false-positive ASIN that
 * runTagSearch promotes to a high-confidence kill-shot.
 *
 * Match shapes (case-insensitive, anchored at end of id):
 *   - iTunes:ASIN     →  `----:com.apple.iTunes:ASIN` or bare `ASIN`
 *   - cnID            →  `cnID`
 *   - ID3 comment     →  `COMM`, `COMM:description`
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

/** Split an albumartist string on commas/semicolons/ampersands. First non-empty token = primary author. */
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
    const commentText = commentEntries[0]!.text ?? String(commentEntries[0]!);
    const match = commentText.match(/(?:narrated|read|performed|voiced?)\s*(?:by\s*)?[:.]?\s*([^,.\n]+)/i);
    if (match) return match[1]!.trim();
  }

  // 4. Artist fallback — only if different from albumartist (author)
  if (common.artist && common.albumartist && common.artist !== common.albumartist) {
    return common.artist;
  }

  return undefined;
}
