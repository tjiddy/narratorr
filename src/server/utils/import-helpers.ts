import { stat, readdir, mkdir, cp } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { join, extname, basename, dirname } from 'node:path';
import {
  renderTemplate, templateHasToken, toLastFirst, toSortTitle, AUDIO_EXTENSIONS, isHiddenName,
  sanitizeEditionDiscriminator, composeEditionSuffixLeaf, PATH_SEGMENT_LIMIT,
} from '@core/utils/index.js';
import { collectSortedAudioFiles } from '@core/utils/collect-audio-files.js';
import {
  DISC_FOLDER_PATTERN, parseTitledDiscFolder, parseEmbeddedDiscMarker, normalizeStem, discGroupGuardsPass,
  type EmbeddedDiscMarker,
} from '@core/utils/book-discovery.js';
import type { NamingOptions } from '@core/utils/naming.js';

import type { authors } from '@db/schema.js';

export const COPY_VERIFICATION_THRESHOLD = 0.99;

// Typed content fault keeps retry policy independent of message text.
export class ContentFailureError extends Error {
  /** Survives prototype loss across process/JSON boundaries. */
  readonly code = 'CONTENT_FAILURE' as const;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ContentFailureError';
  }
}

export function assertCopyVerified(sourceSize: number, targetSize: number): void {
  if (targetSize < sourceSize * COPY_VERIFICATION_THRESHOLD) {
    throw new ContentFailureError(`Copy verification failed: source ${sourceSize} bytes, target ${targetSize} bytes`);
  }
}

export type { BookRow } from '../services/types.js';
export type AuthorRow = typeof authors.$inferSelect;

export interface ImportResult {
  downloadId: number;
  bookId: number;
  targetPath: string;
  fileCount: number;
  totalSize: number;
}

export function extractYear(publishedDate: string | null | undefined): string | undefined {
  if (!publishedDate) return undefined;
  const match = publishedDate.match(/(\d{4})/);
  return match ? match[1] : undefined;
}

// Budget title tokens so an in-place edition discriminator survives the segment cap.
// Short Y/E probes reveal token multiplicities without saturating; allocate the remaining
// literal-adjusted space per title occurrence, with a one-character floor (#1739).
function budgetTitleTokensForEdition(
  folderFormat: string,
  tokens: Record<string, string | number | undefined>,
  options: NamingOptions | undefined,
): void {
  const titleKeys = (['title', 'titleSort'] as const).filter((k) => typeof tokens[k] === 'string');
  if (titleKeys.length === 0) return;

  const leafLen = (titleStandIn: string, editionStandIn: string): number => {
    const probe: Record<string, string | number | undefined> = { ...tokens };
    for (const k of titleKeys) probe[k] = titleStandIn;
    probe.edition = editionStandIn;
    const segments = renderTemplate(folderFormat, probe, options).split('/');
    return (segments[segments.length - 1] ?? '').length;
  };
  // Probe deltas reveal title and edition occurrence counts.
  const baseLen = leafLen('Y', 'E');
  const titleCount = leafLen('YY', 'E') - baseLen;
  if (titleCount <= 0) return;
  const editionCount = leafLen('Y', 'EE') - baseLen;

  // Remove stand-ins to recover literal/wrapper length, then add the real discriminator.
  const structureLen = baseLen - titleCount - editionCount;
  const discriminatorLen = String(tokens.edition ?? '').length;
  const fixedLen = structureLen + editionCount * discriminatorLen;
  const perTokenBudget = Math.max(1, Math.floor((PATH_SEGMENT_LIMIT - fixedLen) / titleCount));
  for (const key of titleKeys) {
    const value = tokens[key];
    if (typeof value === 'string' && value.length > perTokenBudget) {
      tokens[key] = value.slice(0, perTokenBudget).trim();
    }
  }
}

// A sanitized edition renders through {edition} when present; otherwise it becomes a
// collision suffix. Empty labels preserve the old path, and the token branch budgets title.
export function buildTargetPath(
  libraryPath: string,
  folderFormat: string,
  book: {
    title: string;
    seriesName?: string | null | undefined;
    seriesPosition?: number | null | undefined;
    narrators?: Array<{ name: string }> | null | undefined;
    publishedDate?: string | null | undefined;
  },
  authorName: string | null,
  options?: NamingOptions,
  editionLabel?: string | null | undefined,
): string {
  const author = authorName || 'Unknown Author';
  const narratorNames = book.narrators?.map(n => n.name) ?? [];
  const primaryNarrator = narratorNames[0];
  const discriminator = sanitizeEditionDiscriminator(editionLabel);
  const hasEditionToken = templateHasToken(folderFormat, 'edition');
  const tokens: Record<string, string | number | undefined> = {
    author,
    authorLastFirst: toLastFirst(author),
    title: book.title,
    titleSort: toSortTitle(book.title),
    series: book.seriesName || undefined,
    seriesPosition: book.seriesPosition ?? undefined,
    narrator: primaryNarrator || undefined,
    narratorLastFirst: primaryNarrator ? toLastFirst(primaryNarrator) : undefined,
    year: extractYear(book.publishedDate),
    edition: discriminator ?? undefined,
  };

  if (discriminator && hasEditionToken) {
    budgetTitleTokensForEdition(folderFormat, tokens, options);
  }

  let rendered = renderTemplate(folderFormat, tokens, options);
  if (discriminator && !hasEditionToken) {
    const segments = rendered.split('/');
    segments[segments.length - 1] = composeEditionSuffixLeaf(segments[segments.length - 1] ?? '', discriminator);
    rendered = segments.join('/');
  }
  // Persist POSIX separators for Linux containers, even when built on Windows.
  return join(libraryPath, ...rendered.split('/')).split('\\').join('/');
}

// Keep private so wrappers retain the local binding and tests mock node:fs/promises.
// Hidden children are rejected before I/O, but a hidden directory root is still walked;
// audio-only direct hidden files return zero. Dirent controls child traversal and errors propagate.
async function walkSize(path: string, { includeHidden, audioOnly }: { includeHidden: boolean; audioOnly: boolean }): Promise<number> {
  const stats = await stat(path);
  if (stats.isFile()) {
    if (!audioOnly) return stats.size;
    return !isHiddenName(basename(path)) && AUDIO_EXTENSIONS.has(extname(path).toLowerCase()) ? stats.size : 0;
  }

  let total = 0;
  const entries = await readdir(path, { withFileTypes: true });
  for (const entry of entries) {
    if (!includeHidden && isHiddenName(entry.name)) continue;
    if (entry.isFile()) {
      if (audioOnly && !AUDIO_EXTENSIONS.has(extname(entry.name).toLowerCase())) continue;
      const s = await stat(join(path, entry.name));
      total += s.size;
    } else if (entry.isDirectory()) {
      total += await walkSize(join(path, entry.name), { includeHidden, audioOnly });
    }
  }
  return total;
}

export async function getPathSize(path: string): Promise<number> {
  return walkSize(path, { includeHidden: true, audioOnly: false });
}

export async function getAudioPathSize(path: string): Promise<number> {
  return walkSize(path, { includeHidden: false, audioOnly: true });
}

export async function getVisiblePathSize(path: string): Promise<number> {
  return walkSize(path, { includeHidden: false, audioOnly: false });
}

export async function containsAudioFiles(dirPath: string): Promise<boolean> {
  const entries = await readdir(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    if (isHiddenName(entry.name)) continue;
    if (entry.isFile() && AUDIO_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
      return true;
    }
    if (entry.isDirectory()) {
      if (await containsAudioFiles(join(dirPath, entry.name))) return true;
    }
  }
  return false;
}

// Discovery treats unreadable siblings as audio-empty; reconstruction must match.
async function isAudioBearingDir(dirPath: string): Promise<boolean> {
  try {
    return await containsAudioFiles(dirPath);
  } catch {
    return false;
  }
}

async function collectAudioFiles(
  dir: string,
): Promise<Array<{ srcPath: string; name: string }>> {
  // Numeric sort fixes Track10/Track2 order; recursive hidden filtering matches discovery.
  const paths = await collectSortedAudioFiles(dir, { recursive: true, skipHidden: true, sort: 'locale-numeric' });
  return paths.map(p => ({ srcPath: p, name: basename(p) }));
}

type AudioFile = { srcPath: string; name: string };

function extractDiscNumber(name: string): number {
  const titled = parseTitledDiscFolder(name);
  if (titled) return titled.discNumber;
  const embedded = parseEmbeddedDiscMarker(name);
  if (embedded) return embedded.discNumber;
  // Marker text without digits sorts first instead of throwing.
  const match = name.match(/\d+/);
  return match ? parseInt(match[0], 10) : 0;
}

async function collectMultiDiscFiles(
  discFolders: Array<{ name: string; path: string }>,
  otherDirs: Array<{ path: string }>,
  looseFiles: AudioFile[],
): Promise<AudioFile[]> {
  discFolders.sort((a, b) => extractDiscNumber(a.name) - extractDiscNumber(b.name));

  const discFiles: AudioFile[] = [];
  for (const disc of discFolders) {
    discFiles.push(...await collectAudioFiles(disc.path));
  }

  const padWidth = String(discFiles.length).length;
  const sequentialFiles = discFiles.map((file, i) => ({
    srcPath: file.srcPath,
    name: `${String(i + 1).padStart(padWidth, '0')}${extname(file.name)}`,
  }));

  const nonDiscFiles: AudioFile[] = [...looseFiles];
  for (const dir of otherDirs) {
    nonDiscFiles.push(...await collectAudioFiles(dir.path));
  }
  nonDiscFiles.sort((a, b) => a.name.localeCompare(b.name));

  const seenNonDisc = new Map<string, string>();
  for (const file of nonDiscFiles) {
    const existing = seenNonDisc.get(file.name);
    if (existing) {
      throw new ContentFailureError(
        `Duplicate filename "${file.name}" found during import flattening: "${existing}" and "${file.srcPath}"`,
      );
    }
    seenNonDisc.set(file.name, file.srcPath);
  }

  const sequentialNames = new Set(sequentialFiles.map(f => f.name));
  for (const file of nonDiscFiles) {
    if (sequentialNames.has(file.name)) {
      throw new ContentFailureError(
        `Duplicate filename "${file.name}" found during import flattening: non-disc file "${file.srcPath}" collides with sequential disc numbering`,
      );
    }
  }

  return [...nonDiscFiles, ...sequentialFiles];
}

async function collectFlatFiles(
  dirs: Array<{ path: string }>,
  looseFiles: AudioFile[],
): Promise<AudioFile[]> {
  const results: AudioFile[] = [...looseFiles];
  for (const dir of dirs) {
    results.push(...await collectAudioFiles(dir.path));
  }
  const files = results.sort((a, b) => a.name.localeCompare(b.name));

  const seen = new Map<string, string>();
  for (const file of files) {
    const existing = seen.get(file.name);
    if (existing) {
      throw new ContentFailureError(
        `Duplicate filename "${file.name}" found during import flattening: "${existing}" and "${file.srcPath}"`,
      );
    }
    seen.set(file.name, file.srcPath);
  }
  return files;
}

type ProgressFn = (progress: number, byteCounter: { current: number; total: number }) => void;

function isDiscFolderName(name: string): boolean {
  return DISC_FOLDER_PATTERN.test(name)
    || parseTitledDiscFolder(name) !== null
    || parseEmbeddedDiscMarker(name) !== null;
}

async function writeCollectedFiles(files: AudioFile[], target: string, onProgress?: ProgressFn): Promise<void> {
  await mkdir(target, { recursive: true });

  if (!onProgress) {
    for (const file of files) {
      await cp(file.srcPath, join(target, file.name), { errorOnExist: false });
    }
    return;
  }

  const sizes = await Promise.all(files.map(f => stat(f.srcPath).then(s => s.size)));
  const totalSize = sizes.reduce((sum, n) => sum + n, 0);
  let bytesCopied = 0;

  for (let i = 0; i < files.length; i++) {
    const srcPath = files[i]!.srcPath;
    const destPath = join(target, files[i]!.name);

    const tracker = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        bytesCopied += chunk.length;
        const progress = totalSize > 0 ? bytesCopied / totalSize : 1;
        onProgress(progress, { current: bytesCopied, total: totalSize });
        callback(null, chunk);
      },
    });

    await pipeline(createReadStream(srcPath), tracker, createWriteStream(destPath));
  }
}

export async function copyAudioFiles(
  source: string,
  target: string,
  onProgress?: ProgressFn,
): Promise<void> {
  const rootEntries = await readdir(source, { withFileTypes: true });

  const discFolders: Array<{ name: string; path: string }> = [];
  const otherDirs: Array<{ path: string }> = [];
  const looseFiles: AudioFile[] = [];

  for (const entry of rootEntries) {
    if (isHiddenName(entry.name)) continue;
    const fullPath = join(source, entry.name);
    if (entry.isDirectory() && isDiscFolderName(entry.name)) {
      discFolders.push({ name: entry.name, path: fullPath });
    } else if (entry.isDirectory()) {
      otherDirs.push({ path: fullPath });
    } else if (entry.isFile() && AUDIO_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
      looseFiles.push({ srcPath: fullPath, name: entry.name });
    }
  }

  const allDirs = [...otherDirs];
  if (discFolders.length < 2) {
    allDirs.push(...discFolders.map(d => ({ path: d.path })));
  }

  const files = discFolders.length >= 2
    ? await collectMultiDiscFiles(discFolders, otherDirs, looseFiles)
    : await collectFlatFiles(allDirs, looseFiles);

  await writeCollectedFiles(files, target, onProgress);
}

// Discovery stores only the lowest disc; reconstruct matching siblings at import. Reapply
// its all-or-nothing guards over visible, audio-bearing dirs only, or artwork/empty siblings
// make discovery and import disagree. Non-groups return the original singleton (#1280).
export async function reconstructDiscGroup(memberPath: string): Promise<string[]> {
  const marker = parseEmbeddedDiscMarker(basename(memberPath));
  if (!marker || !marker.stem) return [memberPath];

  const parent = dirname(memberPath);
  const key = normalizeStem(marker.stem);

  let entries;
  try {
    entries = await readdir(parent, { withFileTypes: true });
  } catch {
    return [memberPath];
  }

  const audioBearingNames: string[] = [];
  for (const entry of entries) {
    if (isHiddenName(entry.name)) continue;
    if (entry.isDirectory() && await isAudioBearingDir(join(parent, entry.name))) {
      audioBearingNames.push(entry.name);
    }
  }

  if (!discGroupGuardsPass(audioBearingNames, key)) return [memberPath];

  return audioBearingNames
    .map(name => ({ path: join(parent, name), marker: parseEmbeddedDiscMarker(name) }))
    .filter((e): e is { path: string; marker: EmbeddedDiscMarker } =>
      e.marker !== null && e.marker.stem !== '' && normalizeStem(e.marker.stem) === key)
    .sort((a, b) => a.marker.discNumber - b.marker.discNumber)
    .map(e => e.path);
}

// Flatten ordered sibling discs for the manual/scan-confirm path.
export async function copyDiscGroup(
  memberDiscPaths: string[],
  target: string,
  onProgress?: ProgressFn,
): Promise<void> {
  const discFolders = memberDiscPaths.map(p => ({ name: basename(p), path: p }));
  const files = await collectMultiDiscFiles(discFolders, [], []);
  await writeCollectedFiles(files, target, onProgress);
}

export async function countAudioFiles(dirPath: string): Promise<number> {
  let count = 0;
  const entries = await readdir(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    if (isHiddenName(entry.name)) continue;
    if (entry.isFile() && AUDIO_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
      count++;
    } else if (entry.isDirectory()) {
      count += await countAudioFiles(join(dirPath, entry.name));
    }
  }
  return count;
}
