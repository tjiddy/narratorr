import { readdir, stat } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { parseFile, type ICommonTagsResult } from 'music-metadata';
import { AUDIO_EXTENSIONS } from './audio-constants.js';

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
}

/** Scan a directory of audio files and extract metadata + technical info. */
export async function scanAudioDirectory(
  dirPath: string,
  options?: AudioScanOptions,
): Promise<AudioScanResult | null> {
  const audioFiles = await collectAudioFiles(dirPath);
  if (audioFiles.length === 0) return null;

  const skipCover = options?.skipCover ?? false;

  let result: AudioScanResult = {
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

      // Accumulate duration
      if (metadata.format.duration) {
        result.totalDuration += metadata.format.duration;
      }

      // Extract technical info from first file
      if (!technicalExtracted && metadata.format.codec) {
        result.codec = metadata.format.codec;
        result.bitrate = metadata.format.bitrate ?? 0;
        result.sampleRate = metadata.format.sampleRate ?? 0;
        result.channels = metadata.format.numberOfChannels ?? 0;
        result.fileFormat = extname(filePath).slice(1).toLowerCase();

        if (metadata.format.codec?.toLowerCase().includes('vbr') ||
            metadata.format.codecProfile?.toLowerCase().includes('vbr')) {
          result.bitrateMode = 'vbr';
        } else if (metadata.format.bitrate) {
          result.bitrateMode = 'cbr';
        }

        technicalExtracted = true;
      }

      // Extract tags from first file that has them
      if (!tagsExtracted && (metadata.common.title || metadata.common.album || metadata.common.artist)) {
        result.tagTitle = metadata.common.title || metadata.common.album;
        result.tagAuthor = metadata.common.albumartist || metadata.common.artist;

        // Narrator: check custom tags, composer, comment patterns, artist fallback
        result.tagNarrator = extractNarrator(metadata.common, metadata.native);

        result.tagSeries = metadata.common.grouping;
        result.tagYear = metadata.common.year?.toString();
        result.tagPublisher = metadata.common.label?.[0];

        // Track number as series position
        if (metadata.common.track?.no && metadata.common.grouping) {
          result.tagSeriesPosition = metadata.common.track.no;
        }

        tagsExtracted = true;
      }

      // Extract cover art from first file that has it
      if (!result.hasCoverArt && metadata.common.picture?.length) {
        result.hasCoverArt = true;
        if (!skipCover) {
          const pic = metadata.common.picture[0];
          result.coverImage = Buffer.from(pic.data);
          result.coverMimeType = pic.format;
        }
      }

      // Chapter count (M4B files)
      if (metadata.native?.['iTunes']?.some(t => t.id === 'chpl') ||
          (metadata.format.container === 'MPEG-4' && metadata.format.codec === 'AAC')) {
        // M4B chapter markers are in the chapter list if available
        const chapters = metadata.native?.['iTunes']?.filter(t => t.id === 'chpl');
        if (chapters?.length) {
          result.chapterCount = chapters.length;
        }
      }
    } catch {
      // Skip files that can't be parsed (corrupt, not actually audio, etc.)
      continue;
    }
  }

  // If no technical info could be extracted, return null
  if (!result.codec) return null;

  return result;
}

/** Recursively collect all audio files in a directory, sorted by name. */
async function collectAudioFiles(dirPath: string): Promise<string[]> {
  const files: string[] = [];

  try {
    const entries = await readdir(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dirPath, entry.name);
      if (entry.isFile() && AUDIO_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
        files.push(fullPath);
      } else if (entry.isDirectory() && !entry.name.startsWith('.')) {
        const subFiles = await collectAudioFiles(fullPath);
        files.push(...subFiles);
      }
    }
  } catch {
    // Directory read error — return whatever we have
  }

  return files.sort();
}

/** Extract narrator from metadata tags with broad fallback chain. */
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
