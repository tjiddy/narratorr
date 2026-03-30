#!/usr/bin/env node
/**
 * Test harness for the folder-name → metadata match pipeline.
 *
 * Usage:
 *   npx tsx scripts/test-match.ts "Ernest_Cline_-_Ready_Player_One__2017__MP3"
 *   npx tsx scripts/test-match.ts "Author/Series/Title"
 *   npx tsx scripts/test-match.ts --query "Ready Player One Ernest Cline"
 */

// Dynamic imports — tsx handles the .js → .ts resolution

const { parseFolderStructure } = await import('../src/server/services/library-scan.service.js');
const { AudibleProvider } = await import('../src/core/metadata/audible.js');

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error('Usage: npx tsx scripts/test-match.ts <folder-name-or-path>');
  console.error('       npx tsx scripts/test-match.ts --query "search query"');
  process.exit(1);
}

// Simple string similarity (Dice coefficient)
function similarity(a: string, b: string): number {
  const al = a.toLowerCase();
  const bl = b.toLowerCase();
  if (al === bl) return 1;
  if (al.length < 2 || bl.length < 2) return 0;

  const bigrams = new Map<string, number>();
  for (let i = 0; i < al.length - 1; i++) {
    const bigram = al.substring(i, i + 2);
    bigrams.set(bigram, (bigrams.get(bigram) ?? 0) + 1);
  }

  let intersections = 0;
  for (let i = 0; i < bl.length - 1; i++) {
    const bigram = bl.substring(i, i + 2);
    const count = bigrams.get(bigram) ?? 0;
    if (count > 0) {
      bigrams.set(bigram, count - 1);
      intersections++;
    }
  }

  return (2 * intersections) / (al.length - 1 + bl.length - 1);
}

function formatDuration(minutes: number | undefined | null): string {
  if (!minutes) return '—';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${h}h ${m}m`;
}

const rawMode = args.includes('--raw');
const filteredArgs = args.filter(a => a !== '--raw' && a !== '--query');
const isDirectQuery = args.includes('--query');
let parsedTitle: string;
let parsedAuthor: string | null;
let parsedSeries: string | null;
let query: string;

/**
 * Normalize folder names: underscores/dots → spaces, strip codec/format tags, collapse whitespace.
 * NOTE: The real pipeline does NOT do this — parseFolderStructure receives raw folder names.
 * Use --raw to skip normalization and match the real pipeline behavior exactly.
 */
function normalizeFolderName(name: string): string {
  return name
    .replace(/[_.]/g, ' ')       // underscores and dots → spaces
    .replace(/\b(MP3|M4B|M4A|FLAC|OGG|AAC|Unabridged|Abridged)\b/gi, '') // strip format/codec tags
    .replace(/\s{2,}/g, ' ')     // collapse multiple spaces
    .trim();
}

if (isDirectQuery) {
  query = filteredArgs.join(' ');
  parsedTitle = query;
  parsedAuthor = null;
  parsedSeries = null;
  console.log(`\n  Direct query: "${query}"\n`);
} else {
  const input = filteredArgs.join(' ');
  // Split on / to simulate folder path parts
  const rawParts = input.replace(/\\/g, '/').split('/').filter(Boolean);
  const parts = rawMode ? rawParts : rawParts.map(normalizeFolderName);
  if (!rawMode) {
    console.log(`\n  (Normalization ON — use --raw to match real pipeline behavior)`);
  } else {
    console.log(`\n  (RAW mode — matching real pipeline behavior exactly)`);
  }

  const parsed = parseFolderStructure(parts);
  parsedTitle = parsed.title;
  parsedAuthor = parsed.author;
  parsedSeries = parsed.series;
  query = parsedAuthor ? `${parsedTitle} ${parsedAuthor}` : parsedTitle;

  console.log(`\n  Input:    ${input}`);
  console.log(`  Parsed:   title="${parsedTitle}" author="${parsedAuthor ?? '(none)'}" series="${parsedSeries ?? '(none)'}"`);
  console.log(`  Query:    "${query}"\n`);
}

const region = process.env.AUDIBLE_REGION ?? 'us';
const provider = new AudibleProvider({ region });

console.log(`  Searching Audible (${provider.name})...\n`);

try {
  const results = await provider.searchBooks(query);

  if (results.length === 0) {
    console.log('  No results found.\n');
    process.exit(0);
  }

  console.log(`  ${results.length} result(s):\n`);
  const pad = (s: string, n: number) => s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length);
  console.log(`  ${pad('#', 4)}${pad('Title', 50)}${pad('Author', 25)}${pad('Duration', 10)}${pad('Title %', 10)}${pad('Author %', 10)}`);
  console.log('  ' + '─'.repeat(115));

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const titleSim = (similarity(parsedTitle, r.title) * 100).toFixed(0) + '%';
    const authorName = r.authors?.[0]?.name ?? '(unknown)';
    const authorSim = parsedAuthor
      ? (similarity(parsedAuthor, authorName) * 100).toFixed(0) + '%'
      : '—';
    const duration = formatDuration(r.duration);
    const title = r.title.length > 48 ? r.title.slice(0, 45) + '...' : r.title;
    const author = authorName.length > 23 ? authorName.slice(0, 20) + '...' : authorName;

    console.log(`  ${pad(String(i + 1), 4)}${pad(title, 50)}${pad(author, 25)}${pad(duration, 10)}${pad(titleSim, 10)}${pad(authorSim, 10)}`);
  }

  console.log();

  // Show what the current system would pick (first result, no validation)
  const picked = results[0];
  const pickedSim = (similarity(parsedTitle, picked.title) * 100).toFixed(0);
  console.log(`  Current system picks: "${picked.title}" by ${picked.authors?.[0]?.name ?? '?'} (title similarity: ${pickedSim}%)`);

  if (Number(pickedSim) < 50) {
    console.log(`  ⚠  LOW SIMILARITY — this match would be wrong!\n`);
  } else {
    console.log(`  ✓  Match looks reasonable\n`);
  }
} catch (error: unknown) {
  console.error('  Search failed:', error instanceof Error ? error.message : error);
  process.exit(1);
}
