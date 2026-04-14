import { basename, extname, dirname } from 'node:path';
import { parseFile } from 'music-metadata';

export interface ChapterSource {
  filePath: string;
  /** ID3 title tag (if available) */
  title?: string;
  /** ID3 track number (if available) */
  trackNumber?: number;
  /** ID3 disc number (if available) */
  discNumber?: number;
}

export interface ResolvedChapter {
  title: string;
  filePath: string;
  /** Duration in seconds */
  duration: number;
}

/**
 * Read ID3 metadata from audio files and return chapter sources
 * sorted by disc number then track number (falling back to alpha sort).
 */
export async function readChapterSources(filePaths: string[]): Promise<ChapterSource[]> {
  const sources: ChapterSource[] = [];

  for (const filePath of filePaths) {
    const source: ChapterSource = { filePath };
    try {
      const metadata = await parseFile(filePath);
      if (metadata.common.title) source.title = metadata.common.title;
      if (metadata.common.track?.no) source.trackNumber = metadata.common.track.no;
      if (metadata.common.disk?.no) source.discNumber = metadata.common.disk.no;
    } catch {
      // No metadata — will use filename fallback
    }
    sources.push(source);
  }

  return sortChapterSources(sources);
}

/**
 * Sort chapter sources by disc number then track number.
 * Falls back to alphabetical filename sort when ID3 track numbers are missing.
 */
export function sortChapterSources(sources: ChapterSource[]): ChapterSource[] {
  const hasTrackNumbers = sources.some(s => s.trackNumber != null);

  if (hasTrackNumbers) {
    return [...sources].sort((a, b) => {
      const discA = a.discNumber ?? 1;
      const discB = b.discNumber ?? 1;
      if (discA !== discB) return discA - discB;

      const trackA = a.trackNumber ?? Number.MAX_SAFE_INTEGER;
      const trackB = b.trackNumber ?? Number.MAX_SAFE_INTEGER;
      return trackA - trackB;
    });
  }

  // Fallback: alphabetical by filename
  return [...sources].sort((a, b) =>
    basename(a.filePath).localeCompare(basename(b.filePath)),
  );
}

/**
 * Resolve a chapter title from a chapter source.
 * Priority: (1) ID3 title tag, (2) parsed filename, (3) "Chapter N" fallback.
 */
export function resolveChapterTitle(source: ChapterSource, index: number): string {
  // 1. ID3 title tag
  if (source.title?.trim()) {
    return source.title.trim();
  }

  // 2. Parse filename
  const parsed = parseFilenameForTitle(source.filePath);
  if (parsed) return parsed;

  // 3. Fallback
  return `Chapter ${index + 1}`;
}

/**
 * Parse a filename to extract a chapter title.
 * Strips extension, leading track numbers, and common prefixes like "Chapter XX - ".
 */
function parseFilenameForTitle(filePath: string): string | null {
  const name = basename(filePath, extname(filePath));

  // Strip leading track numbers and separators: "01 - Title", "01. Title", "01 Title"
  const stripped = name.replace(/^\d+[\s._-]+/, '');

  // Strip "Chapter XX - " prefix: "Chapter 01 - Title" -> "Title"
  const chapterStripped = stripped.replace(/^chapter\s*\d+\s*[-–—:.]\s*/i, '');

  // Strip "Part XX - " prefix
  const partStripped = chapterStripped.replace(/^part\s*\d+\s*[-–—:.]\s*/i, '');

  const result = partStripped.trim();

  // If nothing meaningful remains (just numbers or empty), return null for fallback
  if (!result || /^\d+$/.test(result)) {
    return null;
  }

  return result;
}

