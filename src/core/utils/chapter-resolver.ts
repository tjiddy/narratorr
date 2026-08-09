import { basename, extname } from 'node:path';
import { parseFile } from 'music-metadata';

export interface ChapterSource {
  filePath: string;
  /** ID3 title tag. */
  title?: string;
  /** ID3 track number. */
  trackNumber?: number;
  /** ID3 disc number. */
  discNumber?: number;
}

export interface ResolvedChapter {
  title: string;
  filePath: string;
  /** Seconds. */
  duration: number;
}

/** Reads ID3 chapter data in disc/track order, falling back to filename order. */
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
      // Missing metadata is expected; title resolution falls back to the filename.
    }
    sources.push(source);
  }

  return sortChapterSources(sources);
}

/** Uses disc/track order when any track number exists; otherwise sorts filenames. */
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

  return [...sources].sort((a, b) =>
    basename(a.filePath).localeCompare(basename(b.filePath)),
  );
}

/** Prefers the ID3 title, then a parsed filename, then `Chapter N`. */
export function resolveChapterTitle(source: ChapterSource, index: number): string {
  if (source.title?.trim()) {
    return source.title.trim();
  }

  const parsed = parseFilenameForTitle(source.filePath);
  if (parsed) return parsed;

  return `Chapter ${index + 1}`;
}

function parseFilenameForTitle(filePath: string): string | null {
  const name = basename(filePath, extname(filePath));

  const stripped = name.replace(/^\d+[\s._-]+/, '');

  const chapterStripped = stripped.replace(/^chapter\s*\d+\s*[-–—:.]\s*/i, '');

  const partStripped = chapterStripped.replace(/^part\s*\d+\s*[-–—:.]\s*/i, '');

  const result = partStripped.trim();

  if (!result || /^\d+$/.test(result)) {
    return null;
  }

  return result;
}

