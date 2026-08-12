import { readdir, stat } from 'node:fs/promises';
import { join, extname, relative, basename } from 'node:path';
import { AUDIO_EXTENSIONS, isHiddenName } from './audio-constants.js';
import { IMPORT_SIBLING_SUFFIXES } from './import-sibling-suffixes.js';
import { classifyLeafFolder, hasStrongChapterSetEvidence } from './book-classifier.js';
import { readAlbumTag } from './audio-scanner.js';
import { parseEmbeddedDiscMarker, normalizeStem, discGroupGuardsPass, type EmbeddedDiscMarker } from './disc-marker.js';
import { comparePosixPath } from './path-order.js';

export { parseEmbeddedDiscMarker, normalizeStem, discGroupGuardsPass, type EmbeddedDiscMarker } from './disc-marker.js';

export interface DiscoveryLogger {
  debug(obj: Record<string, unknown>, msg: string): void;
}

/** Matches bare Audiobookshelf disc folders, but not Part 1 or titled folders. */
export const DISC_FOLDER_PATTERN = /^(cd|dis[ck]|d)\s*\d{1,3}$/i;

/** Parses titled disc folders; bare disc folders belong to DISC_FOLDER_PATTERN. */
export function parseTitledDiscFolder(name: string): { title: string; discNumber: number } | null {
  if (!name) return null;

  const discMatch = name.match(/^(.+?)\s*\((d|dis[ck])\s*(\d{1,3})\)$/i);
  if (discMatch) {
    const title = discMatch[1]!.trim();
    if (!title) return null;
    return { title, discNumber: parseInt(discMatch[3]!, 10) };
  }

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
  path: string;
  folderParts: string[];
  audioFileCount: number;
  totalSize: number;
  /** Why the import UI should flag content absorbed into this row. */
  reviewReason?: string;
}

/**
 * Discovers audiobook folders, merging two or more immediate disc children under
 * their audio-less parent. Stable path ordering is required because duplicate
 * classification is non-transitive and therefore order-dependent.
 */
export async function discoverBooks(rootPath: string, options?: DiscoverBooksOptions): Promise<DiscoveredFolder[]> {
  const results: DiscoveredFolder[] = [];
  const log = options?.log;
  log?.debug({ rootPath }, 'Starting book discovery');
  await walkDirectory(rootPath, rootPath, results, log);
  results.sort((x, y) => comparePosixPath(x.path, y.path));
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
    if (isHiddenName(entry.name)) continue;
    if (IMPORT_SIBLING_SUFFIXES.some((suffix) => entry.name.endsWith(suffix))) continue;
    const fullPath = join(dirPath, entry.name);

    if (entry.isFile() && AUDIO_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
      try {
        const s = await stat(fullPath);
        info.audioFiles.push({ path: fullPath, size: s.size });
      } catch {
        // An unreadable entry must not abort discovery.
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

function findMergeableDiscChildren(audioChildren: DirInfo[]): { discChildren: DirInfo[]; allSameTitle: boolean } {
  const discChildren = audioChildren.filter(c => {
    const folderName = c.path.split(/[\\/]/).pop() ?? '';
    return DISC_FOLDER_PATTERN.test(folderName) || parseTitledDiscFolder(folderName) !== null;
  });

  if (discChildren.length < 2) {
    return { discChildren, allSameTitle: true };
  }

  // Bare disc names do not vote on title compatibility.
  const titles = new Set<string>();
  for (const c of discChildren) {
    const folderName = c.path.split(/[\\/]/).pop() ?? '';
    const parsed = parseTitledDiscFolder(folderName);
    if (parsed) {
      titles.add(parsed.title.toLowerCase());
    }
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
    // In a multidisc folder, loose files are bonus tracks owned by the merge.
    log?.debug(
      { path: info.path, skippedFiles: info.audioFiles.map(f => f.path) },
      'Skipping loose bonus audio in disc-merge folder',
    );
    return { absorbedChildren: false };
  }

  // Leaf heuristics are too permissive here: a false positive swallows the subtree.
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

function folderNameOf(info: DirInfo): string {
  return info.path.split(/[\\/]/).pop() ?? '';
}

interface EmbeddedDiscGroup {
  stem: string;
  members: DirInfo[];
  /** Agreed explicit `of M` total, or undefined when none is supplied. */
  total?: number;
}

/** Uses import reconstruction's guards so persisted anchors resolve to the same group. */
function findEmbeddedDiscGroups(audioChildren: DirInfo[]): EmbeddedDiscGroup[] {
  const siblingNames = audioChildren.map(folderNameOf);
  const byStem = new Map<string, { info: DirInfo; marker: EmbeddedDiscMarker }[]>();
  for (const child of audioChildren) {
    const name = folderNameOf(child);
    // Bare and parenthesized disc names belong to existing merge paths.
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
    const group: EmbeddedDiscGroup = { stem: sorted[0]!.marker.stem, members: sorted.map(m => m.info) };
    // Use the first explicit total; guards ensure all supplied totals agree.
    const explicitTotal = sorted.find(m => m.marker.total !== undefined)?.marker.total;
    if (explicitTotal !== undefined) group.total = explicitTotal;
    groups.push(group);
  }
  return groups;
}

/**
 * Builds folder parts after removing a yEnc `<year> <category>` prefix. The year is
 * stripped only with the category lookahead so `2001 A Space Odyssey` retains it.
 */
function synthesizeStemParts(stem: string): string[] {
  const cleaned = stem
    .replace(/^(?:19|20)\d{2}\s+(?=(?:non[\s-]?fiction|fiction)\s+)/i, '')
    .replace(/^(?:non[\s-]?fiction|fiction)\s+/i, '')
    .trim();
  return [cleaned || stem];
}

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

async function mergeEmbeddedDiscGroup(
  group: EmbeddedDiscGroup,
  results: DiscoveredFolder[],
  log?: DiscoveryLogger,
): Promise<void> {
  const anchor = group.members[0]!; // Lowest disc is the stable path and reconstruction anchor.
  const mergedAudioFiles = group.members.flatMap(m => collectAllAudioFiles(m));

  // A synthetic parent makes member discs descendants for the shared bonus heuristic.
  const parentPath = anchor.path.split(/[\\/]/).slice(0, -1).join('/');
  const synthetic: DirInfo = { path: parentPath, audioFiles: [], children: group.members };
  const bonusReason = await detectBonusContent(synthetic, mergedAudioFiles);
  const incompleteReason = incompleteDiscSetMessage(group.members.length, group.total);
  const reviewReason = composeReviewReason(incompleteReason, bonusReason);

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

/**
 * Warns only when a known positive total exceeds member count. Unknown, complete,
 * or over-complete sets do not claim an `N of M` gap.
 */
function incompleteDiscSetMessage(memberCount: number, total: number | undefined): string | undefined {
  if (total === undefined || !Number.isFinite(total) || total <= 0) return undefined;
  if (memberCount >= total) return undefined;
  return `Incomplete disc set: ${memberCount} of ${total} discs`;
}

export function composeReviewReason(incomplete?: string, bonus?: string): string | undefined {
  const parts = [incomplete, bonus].filter((p): p is string => !!p);
  return parts.length > 0 ? parts.join('; ') : undefined;
}
const BONUS_SUBDIR_RE = /excerpt|bonus|behind[\s_-]*the[\s_-]*scenes|sample|preview|extra/i;

/**
 * Flags absorbed content when its directory name looks like bonus material or its
 * normalized album differs from top-level audio. Missing tags and tag-read failures
 * provide no signal rather than throwing.
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
 * Removes publisher disc/volume suffixes before album comparison so `(1 of 5)`
 * and `(3 of 5)` share one canonical value.
 */
export function normalizeAlbumForComparison(album: string): string {
  let s = album.trim();
  s = s.replace(/\s*\(\s*\d+\s+of\s+\d+\s*\)\s*$/i, '');
  s = s.replace(/\s*\(\s*(?:dis[ck]|cd|d|part|pt)[-_.\s]*\d+\s*\)\s*$/i, '');
  s = s.replace(/\s*[-_,]?\s*(?:dis[ck]|cd|d|part|pt)[-_.\s]*\d+\s*$/i, '');
  return s.replace(/[\s\W_]+/g, ' ').trim().toLowerCase();
}
