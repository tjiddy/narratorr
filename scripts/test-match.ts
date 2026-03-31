#!/usr/bin/env node
/**
 * Test harness for the folder-name → metadata match pipeline.
 *
 * Uses the real normalization pipeline (cleanName, parseFolderStructure)
 * and similarity scoring (diceCoefficient, scoreResult) to show how
 * folder names map to metadata matches.
 *
 * Usage:
 *   npx tsx scripts/test-match.ts "Ernest_Cline_-_Ready_Player_One__2017__MP3"
 *   npx tsx scripts/test-match.ts "Author/Series/Title"
 *   npx tsx scripts/test-match.ts --query "Ready Player One Ernest Cline"
 */

export {}; // Module marker for top-level await

// Dynamic imports — tsx handles the .js → .ts resolution
const { parseFolderStructure, extractYear } = await import('../src/server/services/library-scan.service.js');
const { AudibleProvider } = await import('../src/core/metadata/audible.js');
const { diceCoefficient, scoreResult } = await import('../src/core/utils/similarity.js');

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error('Usage: npx tsx scripts/test-match.ts <folder-name-or-path>');
  console.error('       npx tsx scripts/test-match.ts --query "search query"');
  process.exit(1);
}

function formatDuration(minutes: number | undefined | null): string {
  if (!minutes) return '—';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${h}h ${m}m`;
}

const filteredArgs = args.filter(a => a !== '--query');
const isDirectQuery = args.includes('--query');
let parsedTitle: string;
let parsedAuthor: string | null;
let parsedSeries: string | null;
let folderYear: number | undefined;

if (isDirectQuery) {
  const query = filteredArgs.join(' ');
  parsedTitle = query;
  parsedAuthor = null;
  parsedSeries = null;
  console.log(`\n  Direct query: "${query}"\n`);
} else {
  const input = filteredArgs.join(' ');
  // Split on / to simulate folder path parts — real pipeline normalizes via cleanName
  const parts = input.replace(/\\/g, '/').split('/').filter(Boolean);

  // Extract year from the leaf folder before parsing (for tiebreaker display)
  const leafFolder = parts[parts.length - 1] ?? '';
  folderYear = extractYear(leafFolder);

  const parsed = parseFolderStructure(parts);
  parsedTitle = parsed.title;
  parsedAuthor = parsed.author;
  parsedSeries = parsed.series;

  console.log(`\n  Input:    ${input}`);
  console.log(`  Parsed:   title="${parsedTitle}" author="${parsedAuthor ?? '(none)'}" series="${parsedSeries ?? '(none)'}"`);
  if (folderYear) console.log(`  Year:     ${folderYear}`);
  console.log();
}

const region = process.env.AUDIBLE_REGION ?? 'us';
const provider = new AudibleProvider({ region });

// Build search params matching real pipeline behavior
const query = parsedAuthor ? `${parsedTitle} ${parsedAuthor}` : parsedTitle;
const searchOptions = {
  title: parsedTitle,
  author: parsedAuthor ?? undefined,
};

console.log(`  Query:    "${query}" (structured: title="${searchOptions.title}"${searchOptions.author ? ` author="${searchOptions.author}"` : ''})`);
console.log(`  Searching Audible (${provider.name})...\n`);

try {
  const searchResult = await provider.searchBooks(query, searchOptions);
  const results = searchResult.books;

  if (results.length === 0) {
    console.log(`  No results found.${searchResult.rawCount ? ` (${searchResult.rawCount} raw results dropped by Zod parsing)` : ''}\n`);
    process.exit(0);
  }

  console.log(`  ${results.length} result(s)${searchResult.rawCount !== undefined && searchResult.rawCount !== results.length ? ` (${searchResult.rawCount} raw, ${searchResult.rawCount - results.length} dropped by Zod)` : ''}:\n`);
  const pad = (s: string, n: number) => s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length);

  // Show provider order
  console.log('  === Provider Order (Audible relevance) ===\n');
  console.log(`  ${pad('#', 4)}${pad('Title', 50)}${pad('Author', 25)}${pad('Duration', 10)}${pad('Title %', 10)}${pad('Author %', 10)}${pad('Score', 8)}`);
  console.log('  ' + '─'.repeat(120));

  const context = { title: parsedTitle, author: parsedAuthor ?? undefined };
  const scored = results.map(r => ({
    result: r,
    score: scoreResult(
      { title: r.title, author: r.authors?.[0]?.name },
      context,
    ),
    titleSim: diceCoefficient(parsedTitle, r.title),
  }));

  for (let i = 0; i < scored.length; i++) {
    const { result: r, score, titleSim } = scored[i];
    const titleSimStr = (titleSim * 100).toFixed(0) + '%';
    const authorName = r.authors?.[0]?.name ?? '(unknown)';
    const authorSim = parsedAuthor
      ? (diceCoefficient(parsedAuthor, authorName) * 100).toFixed(0) + '%'
      : '—';
    const duration = formatDuration(r.duration);
    const title = r.title.length > 48 ? r.title.slice(0, 45) + '...' : r.title;
    const author = authorName.length > 23 ? authorName.slice(0, 20) + '...' : authorName;

    console.log(`  ${pad(String(i + 1), 4)}${pad(title, 50)}${pad(author, 25)}${pad(duration, 10)}${pad(titleSimStr, 10)}${pad(authorSim, 10)}${pad(score.toFixed(2), 8)}`);
  }

  // Show similarity-reranked order
  const reranked = [...scored].sort((a, b) => b.score - a.score);
  console.log('\n  === Similarity-Reranked Order ===\n');
  console.log(`  ${pad('#', 4)}${pad('Title', 50)}${pad('Author', 25)}${pad('Score', 8)}${pad('Year', 8)}`);
  console.log('  ' + '─'.repeat(100));

  for (let i = 0; i < reranked.length; i++) {
    const { result: r, score } = reranked[i];
    const authorName = r.authors?.[0]?.name ?? '(unknown)';
    const title = r.title.length > 48 ? r.title.slice(0, 45) + '...' : r.title;
    const author = authorName.length > 23 ? authorName.slice(0, 20) + '...' : authorName;
    const year = r.publishedDate?.slice(0, 4) ?? '—';
    const yearMatch = folderYear && year === String(folderYear) ? ' ✓' : '';

    console.log(`  ${pad(String(i + 1), 4)}${pad(title, 50)}${pad(author, 25)}${pad(score.toFixed(2), 8)}${pad(year + yearMatch, 8)}`);
  }

  console.log();

  // Show what the pipeline would pick
  const picked = reranked[0];
  const pickedSim = (picked.titleSim * 100).toFixed(0);
  console.log(`  Pipeline picks: "${picked.result.title}" by ${picked.result.authors?.[0]?.name ?? '?'} (title: ${pickedSim}%, score: ${picked.score.toFixed(2)})`);

  if (picked.titleSim < 0.5) {
    console.log(`  ⚠  LOW TITLE SIMILARITY — confidence would be 'none'\n`);
  } else {
    console.log(`  ✓  Match looks reasonable\n`);
  }
} catch (error: unknown) {
  console.error('  Search failed:', error instanceof Error ? error.message : error);
  process.exit(1);
}
