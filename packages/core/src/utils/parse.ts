export interface ParsedTitle {
  title: string;
  author?: string;
  narrator?: string;
  series?: string;
  seriesPosition?: string;
  year?: number;
  isUnabridged?: boolean;
  format?: string;
}

/**
 * Parses an audiobook release name into structured components.
 *
 * Handles common release name formats from Torznab/Newznab indexers:
 * - `Author - Title` (most common torrent/NZB convention)
 * - `Author - Series ## - Title` (series with position)
 * - `Title By Author` (MAM-style)
 * - Dot-separated scene: `Author.Name.Title.2022.Audiobook.MP3`
 * - Dash scene: `Author-Title-AUDiOBOOK-WEB-DK-2023-GROUP`
 * - NZB wrappers with inner quoted filenames
 */
export function parseAudiobookTitle(rawTitle: string): ParsedTitle {
  let working = rawTitle.trim();
  if (!working) return { title: '' };
  if (/^[a-f0-9]{32,}$/i.test(working)) return { title: working };

  const result: ParsedTitle = { title: '' };

  working = resolveInnerQuote(working);
  working = stripFileArtifacts(working);
  working = stripNzbPrefixes(working);
  working = extractNarrator(working, result);
  working = extractAbridged(working, result);
  extractFormat(working, result);
  working = stripSceneSuffix(working, result);
  working = extractYear(working, result);
  working = normalizeWhitespace(working);
  working = stripNoise(working);

  return matchPattern(working, result);
}

/** Resolve inner quoted filenames from NZB wrappers */
function resolveInnerQuote(working: string): string {
  const innerQuoted = working.match(/"([^"]+)"/);
  if (!innerQuoted) return working;

  let inner = innerQuoted[1];
  inner = stripFileArtifacts(inner);
  inner = inner.trim();

  if (/\s-\s|_-_/.test(inner)) return inner;

  // Try outer parenthesized text: (Author - Title) [01/21] - "..."
  const outerParenMatch = working.match(/^\(([^)]+)\)/);
  if (outerParenMatch && /\s-\s/.test(outerParenMatch[1])) return outerParenMatch[1];

  return working.replace(/"[^"]*"/, '').trim();
}

/** Strip file extensions, volume/part suffixes, track numbers */
function stripFileArtifacts(s: string): string {
  s = s.replace(/\.(par2|rar|nzb|nfo|sfv|zip|r\d{2}|mp3|m4b|m4a|flac|aac|ogg)$/i, '');
  s = s.replace(/\.vol\d+[+]\d+(?:\.par2)?$/i, '');
  s = s.replace(/\.part\d+$/i, '');
  s = s.replace(/\s+-\s+\d{1,3}$/i, '');
  s = s.replace(/\s+Ch\d+\s+of\s+\d+$/i, '');
  s = s.replace(/\s+\d{1,3}\s*of\s*\d+$/i, '');
  s = s.replace(/\s+D?\d{1,2}[.-]\d{1,2}(?:-\d{1,2})?$/i, '');
  s = s.replace(/\s+Part\d+-Track\s+\d+$/i, '');
  return s;
}

/** Strip NZB-specific prefixes and suffixes */
function stripNzbPrefixes(s: string): string {
  s = s.replace(/^\(\d+\/\d+\)\s*-?\s*(Description\s*-?\s*)?/i, '');
  s = s.replace(/^Re:\s*REQ:?\s*/i, '');
  s = s.replace(/^(?:NMR|NR):?\s*/i, '');
  s = s.replace(/^\[NMR]\s*/i, '');
  s = s.replace(/\s*\[?\d{1,3}\/\d{1,3}]?\s*/g, ' ');
  s = s.replace(/\s+yEnc$/i, '');
  s = s.replace(/\s*-\s*\d+[.,]\d+\s*[KMGT]B$/i, '');
  s = s.replace(/\(\d+\s*k(?:b(?:ps)?|hz)\)/gi, '');
  s = s.replace(/^\[(M4B|MP3|FLAC|AAC)]\s*/i, '');
  s = s.replace(/^\(NMR\)\s*/i, '');
  return s;
}

/** Extract narrator and update result, returning cleaned string */
function extractNarrator(working: string, result: ParsedTitle): string {
  const writtenMatch = working.match(/,?\s*written\s+(?:and\s+)?narrated\s+by\s+([A-Z][a-zA-ZÀ-ÿ.]+(?:\s+[A-Za-zÀ-ÿ.]+){0,4})/i);
  if (writtenMatch) {
    result.narrator = cleanField(writtenMatch[1]);
    result.author = result.narrator;
    return working.replace(writtenMatch[0], '').trim();
  }

  const narratorMatch = working.match(/[,\s-]*(?:[Nn]arrated|[Rr]ead)\s+by\s+([A-Z][a-zA-ZÀ-ÿ.]+(?:\s+[A-Za-zÀ-ÿ.]+){0,4})/);
  if (narratorMatch) {
    result.narrator = cleanField(narratorMatch[1]);
    working = working.replace(narratorMatch[0], '').trim();
  }

  return working.replace(/\b(?:narrated|read)\s+by\b/gi, '').trim();
}

/** Extract unabridged/abridged flag */
function extractAbridged(working: string, result: ParsedTitle): string {
  if (/\b(?:unabridged|ungek(?:ue|ü)rzt)\b/i.test(working)) {
    result.isUnabridged = true;
    return working.replace(/[[(]?(?:unabridged|ungek(?:ue|ü)rzt)[)\]]?/gi, '').trim();
  }
  if (/\babridged\b/i.test(working)) {
    result.isUnabridged = false;
    return working.replace(/[[(]?abridged[)\]]?/gi, '').trim();
  }
  return working;
}

/** Extract audio format (M4B, MP3, etc.) */
function extractFormat(working: string, result: ParsedTitle): void {
  const formatMatch = working.match(/\b(M4B|MP3|FLAC|AAC|OGG)\b/i);
  if (formatMatch) result.format = formatMatch[1].toUpperCase();
}

/** Strip scene release suffixes and extract year from scene tags */
function stripSceneSuffix(working: string, result: ParsedTitle): string {
  const sceneMatch = working.match(/-(?:AUDiOBOOK|AUDIOBOOK|Audiobook)-(?:WEB|CD|DVD)-[A-Z]{2}-\d{4}-\w+(?:\s+iNT)?$/i);
  if (sceneMatch) {
    const sceneYear = sceneMatch[0].match(/(\d{4})/);
    if (sceneYear) result.year = parseInt(sceneYear[1], 10);
    working = working.slice(0, -sceneMatch[0].length).trim();
  }

  working = working.replace(/-(?:AUDiOBOOK|AUDIOBOOK|Audiobook)\b.*$/i, '').trim();
  working = working.replace(/[[(]?(?:Audiobook|AudioBook|AUDIOBOOK|Audio\s*Book)[)\]]?/gi, '').trim();
  working = working.replace(/[[(]?(?:M4B|MP3|FLAC|AAC|OGG|mp3|m4b|flac)[)\]]?/gi, '').trim();
  return working;
}

/** Extract year from bracketed or standalone positions */
function extractYear(working: string, result: ParsedTitle): string {
  // Bracketed years: [2010] or (2010) — always metadata
  const bracketYear = working.match(/[[(]((?:19|20)\d{2})[)\]]/);
  if (bracketYear && !result.year) {
    result.year = parseInt(bracketYear[1], 10);
    working = working.replace(bracketYear[0], '').trim();
  }

  // Standalone years between separators
  if (!result.year) {
    const yearMatch = working.match(/(?:^|[\s\-.])((19|20)\d{2})(?:[\s\-.]|$)/);
    if (yearMatch) {
      result.year = parseInt(yearMatch[1], 10);
      if (/[-.\s]\d{4}$/.test(working) || /\d{4}[-.\s]/.test(working.slice(working.indexOf(yearMatch[1])))) {
        working = working.replace(new RegExp(`[-.\\s]*${yearMatch[1]}[-.\\s]*`), ' ').trim();
      }
    }
  }

  // Clean double dashes from year stripping
  return working.replace(/\s+-\s+-\s+/g, ' - ').trim();
}

/** Normalize whitespace: dots to spaces, underscores, parens */
function normalizeWhitespace(working: string): string {
  // Dot-separated scene format (3+ dots, few/no spaces)
  const dotCount = (working.match(/\./g) || []).length;
  const spaceCount = (working.match(/ /g) || []).length;
  if (dotCount >= 3 && spaceCount <= 1) {
    working = working.replace(/\./g, ' ').trim();
  }

  working = working.replace(/_/g, ' ').trim();

  // Strip wrapping parens
  if (/^\([^)]+\)\s*$/.test(working)) {
    working = working.replace(/^\(([^)]+)\)\s*$/, '$1').trim();
  } else {
    working = working.replace(/^\(([^)]+)\)\s/, '$1 ').trim();
  }

  // Strip trailing noise in parens
  working = working.replace(/\s*\([^)]*(?:kbps|NMR|AMZN|CD|read by|clear sound)[^)]*\)\s*$/i, '').trim();
  return working;
}

/** Strip remaining noise: bitrates, CD refs, bracketed metadata, etc. */
function stripNoise(working: string): string {
  // Strip bracketed metadata tags: [MP3], [ENG], [128kbps], [Unabridged], (64kbps), etc.
  working = working.replace(/[[(](?:MP3|M4B|FLAC|AAC|OGG|ENG|GER|FRE|SPA|DEU|Eng|eng|\d+\s*k(?:b(?:ps)?|hz)|VBR|CBR|NMR|Unabridged|Abridged|Audiobook|Audio\s*Book)[)\]]/gi, '').trim();
  working = working.replace(/\b(?:\d+\s*k(?:b(?:ps)?|hz)|VBR|NMR|CBR)\b/gi, '').trim();
  working = working.replace(/[-\s]*\d*(?:MP3)?CDs?\b/gi, '').trim();
  working = working.replace(/^\{req\}\s*/i, '');
  return working.replace(/\s+/g, ' ').replace(/^[-–—:,.\s]+|[-–—:,.\s]+$/g, '').trim();
}

/** Try structured patterns against cleaned string */
function matchPattern(working: string, result: ParsedTitle): ParsedTitle {
  // Pattern A: "Author's 'Series', Bk N - Title"
  const possessiveMatch = working.match(/^(.+?)(?:'s?|s)\s+'?([^',]+)'?,?\s*(?:Bk|Book|Vol)\s*(\d+)\s*-\s*(.+)$/i);
  if (possessiveMatch) {
    result.author = cleanField(possessiveMatch[1]);
    result.series = cleanField(possessiveMatch[2]);
    result.seriesPosition = possessiveMatch[3];
    result.title = cleanField(possessiveMatch[4]);
    return finalClean(result);
  }

  // Pattern B: "Author - Series ## - Title"
  const twoPartDash = working.match(
    /^(.+?)\s+-\s+(.+?(?:\d+|(?:Bk|Book|Vol|Part|Day|Band|Tome)\s*\d+).*?)\s+-\s+(.+)$/i,
  );
  if (twoPartDash) {
    result.author = cleanField(twoPartDash[1]);
    result.title = cleanField(twoPartDash[3]);
    const seriesPart = twoPartDash[2].trim();
    const seriesNum = seriesPart.match(/^(.+?)\s*(?:Bk|Book|Vol|Part|Day|Band|Tome)?\s*(\d+)\s*$/i)
      || seriesPart.match(/^(.+?)\s+(\d+)$/);
    result.series = seriesNum ? cleanField(seriesNum[1]) : cleanField(seriesPart);
    if (seriesNum) result.seriesPosition = seriesNum[2];
    return finalClean(result);
  }

  // Pattern C: "Author - Title"
  const singleDash = working.match(/^(.+?)\s+-\s+(.+)$/);
  if (singleDash) {
    const left = cleanField(singleDash[1]);
    if (left.length > 2) {
      result.author = left;
      result.title = cleanField(singleDash[2]);
      return finalClean(result);
    }
  }

  // Pattern D: "Author-Title" (no space)
  const tightDash = working.match(/^([A-Z][a-zA-ZÀ-ÿ]+(?:\s+[A-Za-zÀ-ÿ.]+)+)-([A-Z].+)$/);
  if (tightDash) {
    result.author = cleanField(tightDash[1]);
    result.title = cleanField(tightDash[2]);
    return finalClean(result);
  }

  // Pattern E: "Title by Author"
  const byMatch = working.match(/^(.+)\s+[Bb]y\s+([A-Z][^,[\]()]+?)$/);
  if (byMatch && cleanField(byMatch[2]).length > 2) {
    result.title = cleanField(byMatch[1]);
    result.author = cleanField(byMatch[2]);
    return finalClean(result);
  }

  result.title = cleanField(working);
  return finalClean(result);
}

/** Clean a single field: collapse whitespace, strip leading/trailing punctuation */
function cleanField(s: string): string {
  return s
    .replace(/\s+/g, ' ')
    .replace(/^[-–—:,.'"\s]+|[-–—:,.'"\s]+$/g, '')
    .trim();
}

/** Final cleanup on the parsed result */
function finalClean(result: ParsedTitle): ParsedTitle {
  result.title = cleanField(result.title);
  if (result.author) result.author = cleanField(result.author);
  if (result.narrator) result.narrator = cleanField(result.narrator);
  if (result.series) result.series = cleanField(result.series);

  if (result.author === '') delete result.author;
  if (result.narrator === '') delete result.narrator;
  if (result.series === '') delete result.series;
  if (result.seriesPosition === '') delete result.seriesPosition;

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
