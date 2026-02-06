export interface ParsedTitle {
  title: string;
  author?: string;
  narrator?: string;
  year?: number;
  isUnabridged?: boolean;
  format?: string;
}

export function parseAudiobookTitle(rawTitle: string): ParsedTitle {
  let title = rawTitle.trim();
  const result: ParsedTitle = { title };

  // Extract [Unabridged] or [Abridged]
  if (/\[?unabridged]?/i.test(title)) {
    result.isUnabridged = true;
    title = title.replace(/\[?unabridged]?/gi, '').trim();
  } else if (/\[?abridged]?/i.test(title)) {
    result.isUnabridged = false;
    title = title.replace(/\[?abridged]?/gi, '').trim();
  }

  // Extract year in parentheses or brackets
  const yearMatch = title.match(/[[(]?(19|20)\d{2}[\])]?/);
  if (yearMatch) {
    result.year = parseInt(yearMatch[0].replace(/[[\]()]/g, ''), 10);
    title = title.replace(/[[(]?(19|20)\d{2}[\])]?/, '').trim();
  }

  // Extract format (M4B, MP3, etc.)
  const formatMatch = title.match(/\b(M4B|MP3|FLAC|AAC|OGG)\b/i);
  if (formatMatch) {
    result.format = formatMatch[1].toUpperCase();
    title = title.replace(/\b(M4B|MP3|FLAC|AAC|OGG)\b/gi, '').trim();
  }

  // Try to extract author using common patterns
  // Pattern: "Title - Author"
  const dashMatch = title.match(/^(.+?)\s*-\s*(.+)$/);
  if (dashMatch) {
    // Check if second part looks like an author (no common audiobook keywords)
    const possibleAuthor = dashMatch[2].trim();
    if (!/(narrat|read\s+by|audiobook|unabridged)/i.test(possibleAuthor)) {
      result.title = dashMatch[1].trim();
      result.author = possibleAuthor;
    }
  }

  // Pattern: "Title by Author"
  const byMatch = title.match(/^(.+?)\s+by\s+([^,[]+)/i);
  if (byMatch && !result.author) {
    result.title = byMatch[1].trim();
    result.author = byMatch[2].trim();
  }

  // Pattern: "narrated by Narrator" or "read by Narrator"
  const narratorMatch = rawTitle.match(/(?:narrated|read)\s+by\s+([^,[\]()]+)/i);
  if (narratorMatch) {
    result.narrator = narratorMatch[1].trim();
  }

  // Clean up extra whitespace and punctuation
  result.title = result.title
    .replace(/\s+/g, ' ')
    .replace(/^[-–—:,\s]+|[-–—:,\s]+$/g, '')
    .trim();

  if (result.author) {
    result.author = result.author
      .replace(/\s+/g, ' ')
      .replace(/^[-–—:,\s]+|[-–—:,\s]+$/g, '')
      .trim();
  }

  if (result.narrator) {
    result.narrator = result.narrator
      .replace(/\s+/g, ' ')
      .replace(/^[-–—:,\s]+|[-–—:,\s]+$/g, '')
      .trim();
  }

  return result;
}

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
}
