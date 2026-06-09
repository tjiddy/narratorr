import { readdir, stat } from 'node:fs/promises';
import { join, extname, relative, basename } from 'node:path';
import { AUDIO_EXTENSIONS } from './audio-constants.js';
import { classifyLeafFolder, hasStrongChapterSetEvidence } from './book-classifier.js';
import { readAlbumTag } from './audio-scanner.js';
import { parseEmbeddedDiscMarker, normalizeStem, discGroupGuardsPass, type EmbeddedDiscMarker } from './disc-marker.js';

// Re-exported so existing importers (import-helpers.ts, tests) keep a single entry point.
export { parseEmbeddedDiscMarker, normalizeStem, discGroupGuardsPass, type EmbeddedDiscMarker } from './disc-marker.js';

/** Minimal logger interface — matches Pino/Fastify logger shape */
export interface DiscoveryLogger {
  debug(obj: Record<string, unknown>, msg: string): void;
}

/**
 * Disc folder naming pattern — matches Audiobookshelf's convention.
 * Matches: CD1, CD 1, Disc 1, Disc1, Disk 03, DISC 004, etc.
 * Does NOT match: "01 - Harry Potter", "Part 1", book titles, etc.
 */
export const DISC_FOLDER_PATTERN = /^(cd|dis[ck]|d)\s*\d{1,3}$/i;

/**
 * Titled-disc pattern — matches torrent naming conventions where the book title
 * precedes a parenthetical disc indicator:
 *   "BookTitle (Disc 01)", "BookTitle (Disk 3)", "BookTitle (1 of 5)"
 *
 * Returns the extracted title and disc number, or null if no match.
 * Bare disc folders ("Disc 01", "CD1") return null — use DISC_FOLDER_PATTERN for those.
 */
export function parseTitledDiscFolder(name: string): { title: string; discNumber: number } | null {
  if (!name) return null;

  // Pattern 1: "Title (Disc NN)", "Title (Disk NN)", or "Title (D NN)"
  const discMatch = name.match(/^(.+?)\s*\((d|dis[ck])\s*(\d{1,3})\)$/i);
  if (discMatch) {
    const title = discMatch[1]!.trim();
    // Bare disc folders like "Disc 01" would have empty title — reject
    if (!title) return null;
    return { title, discNumber: parseInt(discMatch[3]!, 10) };
  }

  // Pattern 2: "Title (N of M)"
  const nOfMMatch = name.match(/^(.+?)\s*\((\d{1,3})\s+of\s+\d{1,3}\)$/i);
  if (nOfMMatch) {
    const title = nOfMMatch[1]!.trim();
    if (!title) return null;
    return { title, discNumber: parseInt(nOfMMatch[2]!, 10) };
  }

  return null;
}

export interface DiscoverBooksOptions {
  log?: DiscoveryLogger;
}

export interface DiscoveredFolder {
  /** Absolute path to the book folder */
  path: string;
  /** Path segments from root (e.g. ['Author', 'Series', 'Book']) */
  folderParts: string[];
  /** Number of audio files found */
  audioFileCount: number;
  /** Total size of audio files in bytes */
  totalSize: number;
  /**
   * Set when discovery absorbed bonus-shaped content into a parent row (e.g.
   * a top-level chapter book that swept up an `Excerpt-...` subdir). Surfaces
   * to the import UI as a tooltip so the user is informed *before* import
   * that a heuristic flagged the absorption as worth a second look.
   */
  reviewReason?: string;
}

/**
 * Walk a root directory and discover audiobook folders.
 *
 * Disc folder merging: if a parent directory has 2+ immediate children
 * that each contain audio files (and no audio of its own), those children
 * are merged into a single book entry using the parent path.
 */
export async function discoverBooks(rootPath: string, options?: DiscoverBooksOptions): Promise<DiscoveredFolder[]> {
  const results: DiscoveredFolder[] = [];
  const log = options?.log;
  log?.debug({ rootPath }, 'Starting book discovery');
  await walkDirectory(rootPath, rootPath, results, log);
  log?.debug({ rootPath, discovered: results.length }, 'Book discovery complete');
  return results;
}

interface DirInfo {
  path: string;
  audioFiles: { path: string; size: number }[];
  children: DirInfo[];
}

async function scanDir(dirPath: string): Promise<DirInfo> {
  const info: DirInfo = { path: dirPath, audioFiles: [], children: [] };

  let entries;
  try {
    entries = await readdir(dirPath, { withFileTypes: true });
  } catch {
    return info;
  }

  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const fullPath = join(dirPath, entry.name);

    if (entry.isFile() && AUDIO_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
      try {
        const s = await stat(fullPath);
        info.audioFiles.push({ path: fullPath, size: s.size });
      } catch {
        // skip unreadable files
      }
    } else if (entry.isDirectory()) {
      const child = await scanDir(fullPath);
      info.children.push(child);
    }
  }

  return info;
}

async function walkDirectory(
  currentPath: string,
  rootPath: string,
  results: DiscoveredFolder[],
  log?: DiscoveryLogger,
): Promise<void> {
  const info = await scanDir(currentPath);
  await collectBooks(info, rootPath, results, log);
}

/** Identify disc-pattern children and verify titled-disc folders share the same title. */
function findMergeableDiscChildren(audioChildren: DirInfo[]): { discChildren: DirInfo[]; allSameTitle: boolean } {
  const discChildren = audioChildren.filter(c => {
    const folderName = c.path.split(/[\\/]/).pop() ?? '';
    return DISC_FOLDER_PATTERN.test(folderName) || parseTitledDiscFolder(folderName) !== null;
  });

  if (discChildren.length < 2) {
    return { discChildren, allSameTitle: true };
  }

  // For titled-disc folders, verify all share the same title prefix before merging
  const titles = new Set<string>();
  for (const c of discChildren) {
    const folderName = c.path.split(/[\\/]/).pop() ?? '';
    const parsed = parseTitledDiscFolder(folderName);
    if (parsed) {
      titles.add(parsed.title.toLowerCase());
    }
    // Bare disc folders (no title) are compatible with any single title group
  }
  return { discChildren, allSameTitle: titles.size <= 1 };
}

async function collectBooks(
  info: DirInfo,
  rootPath: string,
  results: DiscoveredFolder[],
  log?: DiscoveryLogger,
): Promise<void> {
  const hasOwnAudio = info.audioFiles.length > 0;
  const audioChildren = info.children.filter(c => countAudioFilesDeep(c) > 0);

  // Pre-evaluate disc-merge eligibility — used to decide whether loose files in
  // a mixed-content folder are bonus tracks (skip) or standalone books (emit).
  const immediateAudioChildren = info.children.filter(c => c.audioFiles.length > 0);
  const { discChildren, allSameTitle } = findMergeableDiscChildren(immediateAudioChildren);
  const willDiscMerge = isDiscMergeable(discChildren, immediateAudioChildren, allSameTitle);

  if (hasOwnAudio && audioChildren.length > 0) {
    const result = await handleMixedContentLooseAudio(info, rootPath, results, willDiscMerge, log);
    if (result.absorbedChildren) return;
  } else if (hasOwnAudio) {
    handleLeafFolder(info, rootPath, results, log);
    return;
  }

  if (willDiscMerge) {
    await mergeDiscChildren(info, rootPath, results, discChildren, log);
    for (const child of info.children) {
      if (!discChildren.includes(child)) {
        await collectBooks(child, rootPath, results, log);
      }
    }
    return;
  }

  // Sibling-stem coalescing: per-disc usenet folder sets share a common stem with the
  // disc marker embedded in a longer release string (e.g. "… 1776 Disc 1 of 10 - yEnc …").
  if (await coalesceEmbeddedDiscGroups(info, audioChildren, rootPath, results, log)) return;

  for (const child of audioChildren) {
    await collectBooks(child, rootPath, results, log);
  }
  for (const child of info.children) {
    if (!audioChildren.includes(child)) {
      await collectBooks(child, rootPath, results, log);
    }
  }
}

function isDiscMergeable(discChildren: DirInfo[], immediateAudioChildren: DirInfo[], allSameTitle: boolean): boolean {
  return discChildren.length >= 2
    && discChildren.length === immediateAudioChildren.length
    && allSameTitle;
}

function handleLeafFolder(
  info: DirInfo,
  rootPath: string,
  results: DiscoveredFolder[],
  log?: DiscoveryLogger,
): void {
  const classification = classifyLeafFolder(info.audioFiles);
  log?.debug(
    {
      path: info.path,
      fileCount: info.audioFiles.length,
      decision: classification.decision,
      reason: classification.reason,
      stems: info.audioFiles.map(f => basename(f.path, extname(f.path))),
      ...(classification.sizeEvidence
        ? {
            largeCount: classification.sizeEvidence.largeCount,
            largeRatio: classification.sizeEvidence.largeRatio,
          }
        : {}),
    },
    'Leaf folder classified',
  );
  if (classification.decision === 'split') {
    for (const file of info.audioFiles) {
      const fileInfo: DirInfo = { path: file.path, audioFiles: [file], children: [] };
      results.push(makeFolderEntry(fileInfo, rootPath, [file]));
    }
    return;
  }
  results.push(makeFolderEntry(info, rootPath, info.audioFiles));
}

async function handleMixedContentLooseAudio(
  info: DirInfo,
  rootPath: string,
  results: DiscoveredFolder[],
  willDiscMerge: boolean,
  log?: DiscoveryLogger,
): Promise<{ absorbedChildren: boolean }> {
  if (willDiscMerge) {
    // Multi-disc book; loose files are bonus tracks. Skip and fall through to disc-merge.
    log?.debug(
      { path: info.path, skippedFiles: info.audioFiles.map(f => f.path) },
      'Skipping loose bonus audio in disc-merge folder',
    );
    return { absorbedChildren: false };
  }

  // Mixed-content absorption requires STRONG evidence the loose files are a
  // single chapter-encoded book. The leaf classifier's merge bias (count caps,
  // size heuristics, subset-duplicate signals) is correct for leaf folders
  // where false-merges produce 1 row to fix, but catastrophic here where a
  // false-merge triggers recursive absorption of the entire subtree (#1048).
  if (info.audioFiles.length >= 2) {
    const strongEvidence = hasStrongChapterSetEvidence(info.audioFiles);
    log?.debug(
      {
        path: info.path,
        strongEvidence,
        stems: info.audioFiles.map(f => basename(f.path, extname(f.path))),
        branch: 'mixed-content',
      },
      'Mixed-content loose audio classified',
    );

    if (strongEvidence) {
      const absorbedAudioFiles = collectAllAudioFiles(info);
      const reviewReason = await detectBonusContent(info, absorbedAudioFiles);
      results.push(makeFolderEntry(info, rootPath, absorbedAudioFiles, { reviewReason }));
      return { absorbedChildren: true };
    }
  }

  // Mixed library: each loose file is its own single-file book.
  for (const file of info.audioFiles) {
    const fileInfo: DirInfo = { path: file.path, audioFiles: [file], children: [] };
    results.push(makeFolderEntry(fileInfo, rootPath, [file]));
  }
  return { absorbedChildren: false };
}

async function mergeDiscChildren(
  info: DirInfo,
  rootPath: string,
  results: DiscoveredFolder[],
  discChildren: DirInfo[],
  log?: DiscoveryLogger,
): Promise<void> {
  const mergedAudioFiles = [
    ...info.audioFiles,
    ...discChildren.flatMap(c => collectAllAudioFiles(c)),
  ];
  log?.debug(
    { path: info.path, discFolders: discChildren.map(c => c.path), mergedAudioFiles: mergedAudioFiles.length },
    'Disc folder merge',
  );
  const reviewReason = await detectBonusContent(info, mergedAudioFiles);
  results.push(makeFolderEntry(info, rootPath, mergedAudioFiles, { reviewReason }));
}

/** Folder name (final path segment) of a scanned directory — separator-agnostic. */
function folderNameOf(info: DirInfo): string {
  return info.path.split(/[\\/]/).pop() ?? '';
}

interface EmbeddedDiscGroup {
  /** Raw common stem of the lowest-disc member, used to synthesize folderParts. */
  stem: string;
  /** Member disc folders, ordered by parsed disc number ascending. */
  members: DirInfo[];
}

/**
 * Group sibling audio folders that carry an embedded disc marker by their common stem.
 *
 * A group is collapsible only when ≥2 members share an identical normalized stem AND the
 * shared `discGroupGuardsPass` consistency (`of M` totals agree) + all-or-nothing (every
 * stem-sharing sibling carries a marker) guards hold. Bare-token names (empty stem) are
 * excluded so the DISC_FOLDER_PATTERN path is untouched. Import-time reconstruction replays
 * the same `discGroupGuardsPass` guards so both sides coalesce identical sets.
 */
function findEmbeddedDiscGroups(audioChildren: DirInfo[]): EmbeddedDiscGroup[] {
  const siblingNames = audioChildren.map(folderNameOf);
  const byStem = new Map<string, { info: DirInfo; marker: EmbeddedDiscMarker }[]>();
  for (const child of audioChildren) {
    const name = folderNameOf(child);
    // Bare tokens (DISC_FOLDER_PATTERN) and parenthesized titled-disc folders are owned by
    // the existing merge paths — the embedded path is strictly for markers in longer strings.
    if (DISC_FOLDER_PATTERN.test(name) || parseTitledDiscFolder(name) !== null) continue;
    const marker = parseEmbeddedDiscMarker(name);
    if (!marker || !marker.stem) continue;
    const key = normalizeStem(marker.stem);
    const members = byStem.get(key) ?? [];
    members.push({ info: child, marker });
    byStem.set(key, members);
  }

  const groups: EmbeddedDiscGroup[] = [];
  for (const [key, members] of byStem) {
    if (members.length < 2) continue;
    if (!discGroupGuardsPass(siblingNames, key)) continue;

    const sorted = members.slice().sort((a, b) => a.marker.discNumber - b.marker.discNumber);
    groups.push({ stem: sorted[0]!.marker.stem, members: sorted.map(m => m.info) });
  }
  return groups;
}

/**
 * Synthesize folderParts from a coalesced group's cleaned common stem. Strips a leading
 * 4-digit year token and a leading release-category run (Fiction / Non Fiction / Nonfiction)
 * so the dash parser resolves the author rather than the yEnc release prefix.
 */
function synthesizeStemParts(stem: string): string[] {
  const cleaned = stem
    .replace(/^(?:19|20)\d{2}\s+/, '')
    .replace(/^(?:non[\s-]?fiction|fiction)\s+/i, '')
    .trim();
  return [cleaned || stem];
}

/**
 * Coalesce every embedded-disc sibling group under `info`, then recurse into the remaining
 * (non-grouped) children. Returns true when at least one group was found and handled.
 */
async function coalesceEmbeddedDiscGroups(
  info: DirInfo,
  audioChildren: DirInfo[],
  rootPath: string,
  results: DiscoveredFolder[],
  log?: DiscoveryLogger,
): Promise<boolean> {
  const discGroups = findEmbeddedDiscGroups(audioChildren);
  if (discGroups.length === 0) return false;

  const grouped = new Set<DirInfo>();
  for (const group of discGroups) {
    await mergeEmbeddedDiscGroup(group, results, log);
    for (const member of group.members) grouped.add(member);
  }
  for (const child of info.children) {
    if (!grouped.has(child)) {
      await collectBooks(child, rootPath, results, log);
    }
  }
  return true;
}

/** Coalesce an embedded-disc group into a single discovery row (AC2 contract). */
async function mergeEmbeddedDiscGroup(
  group: EmbeddedDiscGroup,
  results: DiscoveredFolder[],
  log?: DiscoveryLogger,
): Promise<void> {
  const anchor = group.members[0]!; // lowest-disc member — stable path identity + reconstruction anchor
  const mergedAudioFiles = group.members.flatMap(m => collectAllAudioFiles(m));

  // detectBonusContent over a synthetic parent so the member discs read as descendants,
  // mirroring the bare-token merge's review-reason flow.
  const parentPath = anchor.path.split(/[\\/]/).slice(0, -1).join('/');
  const synthetic: DirInfo = { path: parentPath, audioFiles: [], children: group.members };
  const reviewReason = await detectBonusContent(synthetic, mergedAudioFiles);

  log?.debug(
    { path: anchor.path, stem: group.stem, members: group.members.map(m => m.path), mergedAudioFiles: mergedAudioFiles.length },
    'Embedded disc-marker group coalesced',
  );

  const entry: DiscoveredFolder = {
    path: anchor.path,
    folderParts: synthesizeStemParts(group.stem),
    audioFileCount: mergedAudioFiles.length,
    totalSize: mergedAudioFiles.reduce((sum, f) => sum + f.size, 0),
  };
  if (reviewReason) entry.reviewReason = reviewReason;
  results.push(entry);
}

function countAudioFilesDeep(info: DirInfo): number {
  let count = info.audioFiles.length;
  for (const child of info.children) {
    count += countAudioFilesDeep(child);
  }
  return count;
}

function collectAllAudioFiles(info: DirInfo): { path: string; size: number }[] {
  const files = [...info.audioFiles];
  for (const child of info.children) {
    files.push(...collectAllAudioFiles(child));
  }
  return files;
}

function makeFolderEntry(
  info: DirInfo,
  rootPath: string,
  audioFiles: { path: string; size: number }[],
  options?: { reviewReason?: string | undefined },
): DiscoveredFolder {
  const relativePath = relative(rootPath, info.path);
  const folderParts = relativePath ? relativePath.split(/[\\/]/) : [basename(rootPath)];

  const entry: DiscoveredFolder = {
    path: info.path,
    folderParts,
    audioFileCount: audioFiles.length,
    totalSize: audioFiles.reduce((sum, f) => sum + f.size, 0),
  };
  if (options?.reviewReason) entry.reviewReason = options.reviewReason;
  return entry;
}

const BONUS_REVIEW_REASON = 'Additional non-book content possibly merged';
const BONUS_SUBDIR_RE = /excerpt|bonus|behind[\s_-]*the[\s_-]*scenes|sample|preview|extra/i;

/**
 * Heuristic: was the absorbed subdirectory likely bonus / non-book content?
 *
 * Returns a review-reason string when ANY of these signals fires; undefined
 * otherwise. Tag-read failures inside `readAlbumTag` already swallow errors
 * and return undefined, so a missing-album signal never throws.
 *
 * 1. Subdirectory name matches a bonus/excerpt/sample/extra pattern.
 * 2. Top-level audio's normalized album differs from any absorbed-descendant
 *    audio's normalized album. Missing/empty album on either side is treated
 *    as "no album signal" rather than mismatch (AC14).
 */
async function detectBonusContent(
  info: DirInfo,
  absorbedAudioFiles: { path: string; size: number }[],
): Promise<string | undefined> {
  const topLevelPaths = new Set(info.audioFiles.map(f => f.path));
  const descendantFiles = absorbedAudioFiles.filter(f => !topLevelPaths.has(f.path));

  for (const file of descendantFiles) {
    const rel = relative(info.path, file.path);
    const segments = rel.split(/[\\/]/);
    if (segments.length >= 2 && BONUS_SUBDIR_RE.test(segments[0]!)) {
      return BONUS_REVIEW_REASON;
    }
  }

  const topAlbum = await readFirstAlbum(info.audioFiles);
  if (!topAlbum) return undefined;

  const descendantAlbum = await readFirstAlbum(descendantFiles);
  if (!descendantAlbum) return undefined;

  if (normalizeAlbumForComparison(topAlbum) !== normalizeAlbumForComparison(descendantAlbum)) {
    return BONUS_REVIEW_REASON;
  }
  return undefined;
}

async function readFirstAlbum(files: { path: string }[]): Promise<string | undefined> {
  for (const f of files) {
    const album = await readAlbumTag(f.path);
    if (album) return album;
  }
  return undefined;
}

/**
 * Normalize an album value for cross-group comparison. Strips the publisher
 * suffixes that normally indicate "same album, different volume/disc" so
 * "Stormlight (1 of 5)" and "Stormlight (3 of 5)" collapse to one canonical
 * form. Anything left that differs is a real distinct-album signal.
 */
export function normalizeAlbumForComparison(album: string): string {
  let s = album.trim();
  // "(N of M)" suffix
  s = s.replace(/\s*\(\s*\d+\s+of\s+\d+\s*\)\s*$/i, '');
  // Parenthesized disc/cd/d/part suffix: "(Disc 2)", "(CD 03)", "(D1)", "(Part 1)"
  s = s.replace(/\s*\(\s*(?:dis[ck]|cd|d|part|pt)[-_.\s]*\d+\s*\)\s*$/i, '');
  // Trailing "Disc N" / "CD N" / "D N" / "Part N" / "Pt N" with optional separators
  // around BOTH the keyword (Album-Part) AND the digit run (Part-01).
  s = s.replace(/\s*[-_,]?\s*(?:dis[ck]|cd|d|part|pt)[-_.\s]*\d+\s*$/i, '');
  // Collapse remaining punctuation/whitespace runs and lowercase
  return s.replace(/[\s\W_]+/g, ' ').trim().toLowerCase();
}
