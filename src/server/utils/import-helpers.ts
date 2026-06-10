import { stat, readdir, mkdir, cp } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { join, extname, basename, dirname } from 'node:path';
import { renderTemplate, toLastFirst, toSortTitle, AUDIO_EXTENSIONS } from '../../core/utils/index.js';
import { collectSortedAudioFiles } from '../../core/utils/collect-audio-files.js';
import {
  DISC_FOLDER_PATTERN, parseTitledDiscFolder, parseEmbeddedDiscMarker, normalizeStem, discGroupGuardsPass,
  type EmbeddedDiscMarker,
} from '../../core/utils/book-discovery.js';
import type { NamingOptions } from '../../core/utils/naming.js';

import type { authors } from '../../db/schema.js';

/** Minimum ratio of target/source file size for copy verification to pass. */
export const COPY_VERIFICATION_THRESHOLD = 0.99;

/**
 * Typed marker for import failures caused by bad release content (not host/environment).
 * `isContentFailure` recognizes this via `instanceof` so the failure classification no longer
 * depends on substring-matching the message text. Mirrors the existing custom-error convention
 * (`BackupRecoveryError`): extend `Error`, set `this.name`, preserve a descriptive message.
 */
export class ContentFailureError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ContentFailureError';
  }
}

/**
 * Single source of truth for the copy-verification check shared by all four copy paths
 * (`verifyCopy`, `stagedAudioReplace`, `copyToLibrary`, `copyDiscGroupToLibrary`). Throws a
 * `ContentFailureError` — whose message retains the source/target byte sizes for diagnostics —
 * when the copied target is smaller than `sourceSize * COPY_VERIFICATION_THRESHOLD`.
 */
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

/** Extract a 4-digit year from a date string like "2010-11-02" or "2010". */
export function extractYear(publishedDate: string | null | undefined): string | undefined {
  if (!publishedDate) return undefined;
  const match = publishedDate.match(/(\d{4})/);
  return match ? match[1] : undefined;
}

/** Build the target directory from a folder format string and book metadata. */
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
): string {
  const author = authorName || 'Unknown Author';
  const narratorNames = book.narrators?.map(n => n.name) ?? [];
  const primaryNarrator = narratorNames[0];
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
  };

  const rendered = renderTemplate(folderFormat, tokens, options);
  // Always use POSIX separators — paths are stored in DB and consumed inside Docker (Linux)
  return join(libraryPath, ...rendered.split('/')).split('\\').join('/');
}

/** Recursively get total size of a path (file or directory). */
export async function getPathSize(path: string): Promise<number> {
  const stats = await stat(path);
  if (stats.isFile()) return stats.size;

  let total = 0;
  const entries = await readdir(path, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = join(path, entry.name);
    if (entry.isFile()) {
      const s = await stat(entryPath);
      total += s.size;
    } else if (entry.isDirectory()) {
      total += await getPathSize(entryPath);
    }
  }
  return total;
}

/** Recursively get total size of audio files only (filtered by AUDIO_EXTENSIONS). */
export async function getAudioPathSize(path: string): Promise<number> {
  const stats = await stat(path);
  if (stats.isFile()) {
    return AUDIO_EXTENSIONS.has(extname(path).toLowerCase()) ? stats.size : 0;
  }

  let total = 0;
  const entries = await readdir(path, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = join(path, entry.name);
    if (entry.isFile() && AUDIO_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
      const s = await stat(entryPath);
      total += s.size;
    } else if (entry.isDirectory()) {
      total += await getAudioPathSize(entryPath);
    }
  }
  return total;
}

/** Check if a path contains audio files (recursively). */
export async function containsAudioFiles(dirPath: string): Promise<boolean> {
  const entries = await readdir(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isFile() && AUDIO_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
      return true;
    }
    if (entry.isDirectory()) {
      if (await containsAudioFiles(join(dirPath, entry.name))) return true;
    }
  }
  return false;
}

/**
 * Audio-bearing check for disc-group reconstruction. Mirrors discovery's `scanDir`, which
 * catches `readdir` failures and treats an unreadable subtree as zero-audio
 * (`book-discovery.ts` scanDir) — so an unreadable sibling is excluded from the member set
 * rather than failing the whole import.
 */
async function isAudioBearingDir(dirPath: string): Promise<boolean> {
  try {
    return await containsAudioFiles(dirPath);
  } catch {
    return false;
  }
}

/** Recursively collect all audio file paths from a source directory. */
async function collectAudioFiles(
  dir: string,
): Promise<Array<{ srcPath: string; name: string }>> {
  // locale-numeric so unpadded source filenames (Track1…Track10) order numerically
  // before collectMultiDiscFiles assigns sequential padded names — 'locale' alone
  // would mis-order Track10 ahead of Track2 (#1192).
  const paths = await collectSortedAudioFiles(dir, { recursive: true, sort: 'locale-numeric' });
  return paths.map(p => ({ srcPath: p, name: basename(p) }));
}

type AudioFile = { srcPath: string; name: string };

/** Extract disc number from a folder name — works for bare, titled, and embedded-marker patterns. */
function extractDiscNumber(name: string): number {
  const titled = parseTitledDiscFolder(name);
  if (titled) return titled.discNumber;
  const embedded = parseEmbeddedDiscMarker(name);
  if (embedded) return embedded.discNumber;
  // Bare disc pattern (CD1, Disc 2, etc.) — first digits in name. Guard the no-digit
  // case so a marker keyword without a number ("Disc of 10") can't crash the sort.
  const match = name.match(/\d+/);
  return match ? parseInt(match[0], 10) : 0;
}

/** Collect audio from disc subfolders with sequential renaming, plus non-disc entries. */
async function collectMultiDiscFiles(
  discFolders: Array<{ name: string; path: string }>,
  otherDirs: Array<{ path: string }>,
  looseFiles: AudioFile[],
): Promise<AudioFile[]> {
  // Sort discs by extracted disc number (handles bare, titled, and mixed patterns)
  discFolders.sort((a, b) => extractDiscNumber(a.name) - extractDiscNumber(b.name));

  // Collect audio files from each disc in order
  const discFiles: AudioFile[] = [];
  for (const disc of discFolders) {
    discFiles.push(...await collectAudioFiles(disc.path));
  }

  // Assign sequential filenames to disc files
  const padWidth = String(discFiles.length).length;
  const sequentialFiles = discFiles.map((file, i) => ({
    srcPath: file.srcPath,
    name: `${String(i + 1).padStart(padWidth, '0')}${extname(file.name)}`,
  }));

  // Collect non-disc entries (loose root files + non-disc subfolders)
  const nonDiscFiles: AudioFile[] = [...looseFiles];
  for (const dir of otherDirs) {
    nonDiscFiles.push(...await collectAudioFiles(dir.path));
  }
  nonDiscFiles.sort((a, b) => a.name.localeCompare(b.name));

  // Check for duplicate basenames within non-disc files
  const seenNonDisc = new Map<string, string>();
  for (const file of nonDiscFiles) {
    const existing = seenNonDisc.get(file.name);
    if (existing) {
      throw new Error(
        `Duplicate filename "${file.name}" found during import flattening: "${existing}" and "${file.srcPath}"`,
      );
    }
    seenNonDisc.set(file.name, file.srcPath);
  }

  // Check for collisions between non-disc files and sequential disc files
  const sequentialNames = new Set(sequentialFiles.map(f => f.name));
  for (const file of nonDiscFiles) {
    if (sequentialNames.has(file.name)) {
      throw new Error(
        `Duplicate filename "${file.name}" found during import flattening: non-disc file "${file.srcPath}" collides with sequential disc numbering`,
      );
    }
  }

  return [...nonDiscFiles, ...sequentialFiles];
}

/** Collect audio from pre-classified entries with collision check (standard non-disc path). */
async function collectFlatFiles(
  dirs: Array<{ path: string }>,
  looseFiles: AudioFile[],
): Promise<AudioFile[]> {
  const results: AudioFile[] = [...looseFiles];
  for (const dir of dirs) {
    results.push(...await collectAudioFiles(dir.path));
  }
  const files = results.sort((a, b) => a.name.localeCompare(b.name));

  // Check for basename collisions before returning
  const seen = new Map<string, string>();
  for (const file of files) {
    const existing = seen.get(file.name);
    if (existing) {
      throw new Error(
        `Duplicate filename "${file.name}" found during import flattening: "${existing}" and "${file.srcPath}"`,
      );
    }
    seen.set(file.name, file.srcPath);
  }
  return files;
}

type ProgressFn = (progress: number, byteCounter: { current: number; total: number }) => void;

/** True when a source subfolder is a disc folder — bare, parenthesized, or embedded-marker. */
function isDiscFolderName(name: string): boolean {
  return DISC_FOLDER_PATTERN.test(name)
    || parseTitledDiscFolder(name) !== null
    || parseEmbeddedDiscMarker(name) !== null;
}

/** Write a resolved {srcPath, name} file list into target, optionally tracking byte progress. */
async function writeCollectedFiles(files: AudioFile[], target: string, onProgress?: ProgressFn): Promise<void> {
  await mkdir(target, { recursive: true });

  if (!onProgress) {
    for (const file of files) {
      await cp(file.srcPath, join(target, file.name), { errorOnExist: false });
    }
    return;
  }

  // Stream-copy with byte-level progress tracking
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

/** Copy audio files from source to target, flattening all subdirectories. */
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

/**
 * Reconstruct the ordered member-disc folders of a coalesced disc-group row.
 *
 * Discovery stores only the lowest-disc member as the row `path`; at import time the full
 * set is re-derived server-side from `dirname(path)` — siblings whose normalized stem matches
 * and that carry a disc marker, ordered by disc number. Returns `[memberPath]` unchanged when
 * the path is not an embedded-marker disc member (so callers gate on `length >= 2`).
 *
 * Replays discovery's `discGroupGuardsPass` consistency + all-or-nothing guards so a row that
 * discovery intentionally left ungrouped (inconsistent `of M` totals, or a markerless stem-sharing
 * sibling) is NOT flattened/rejected as a coalesced set here.
 *
 * Both the guard input AND the member collection run over **audio-bearing sibling directories
 * only**, exactly mirroring discovery, which groups over `audioChildren` (children with
 * `countAudioFilesDeep > 0`). Without this filter, an audioless stem-sharing sibling — a usenet
 * pack's `<stem> Artwork`/`Sample`/NFO folder — is invisible to discovery's all-or-nothing guard
 * (passes, coalesces) but seen by import's guard (fails, refuses), silently dropping discs 2..N
 * (#1280). Filtering to audio-bearing dirs gives true parity: a markerless-audioless sibling is
 * excluded before the guard, and a marker-carrying audioless sibling (a stray zero-file
 * `<stem> Disc 11 of 10`) is excluded from `memberPaths` so reconstructed members are exactly the
 * audio-bearing disc directories discovery persisted.
 */
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

  // Filter siblings to audio-bearing dirs once, before BOTH the guard and the member map,
  // so the set fed to discGroupGuardsPass matches discovery's audio-bearing `audioChildren`.
  const audioBearingNames: string[] = [];
  for (const entry of entries) {
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

/**
 * Flatten an explicit, ordered set of disc-member folders into one target directory,
 * sequentially renaming across discs. Used by the manual/scan-confirm import path where
 * the reconstructed member discs are siblings (not children of a single source dir).
 */
export async function copyDiscGroup(
  memberDiscPaths: string[],
  target: string,
  onProgress?: ProgressFn,
): Promise<void> {
  const discFolders = memberDiscPaths.map(p => ({ name: basename(p), path: p }));
  const files = await collectMultiDiscFiles(discFolders, [], []);
  await writeCollectedFiles(files, target, onProgress);
}

/** Recursively count audio files in a directory. */
export async function countAudioFiles(dirPath: string): Promise<number> {
  let count = 0;
  const entries = await readdir(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isFile() && AUDIO_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
      count++;
    } else if (entry.isDirectory()) {
      count += await countAudioFiles(join(dirPath, entry.name));
    }
  }
  return count;
}
