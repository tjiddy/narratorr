/**
 * Bulk import pipeline — accepts user-confirmed items and queues them for the
 * import worker. Extracted for consistency with quality-gate helpers.
 */
import { mkdir, cp, rm, stat } from 'node:fs/promises';
import { relative, resolve, isAbsolute } from 'node:path';
import { streamCopyWithProgress } from './streaming-copy.helpers.js';
import { copyToLibrary as stageSourceAudio, stagedAudioReplace } from '../utils/import-steps.js';
import type { Db } from '../../db/index.js';
import type { FastifyBaseLogger } from 'fastify';
import type { BookService } from './book.service.js';
import type { BookImportService } from './book-import.service.js';
import type { SettingsService } from './settings.service.js';
import type { BookMetadata } from '../../core/metadata/index.js';
import { buildTargetPath, getAudioPathSize, assertCopyVerified, reconstructDiscGroup, copyDiscGroup } from '../utils/import-helpers.js';
import { prepareImportSiblings, assertMarkerPathWritable } from '../utils/import-staging.js';
import { toNamingOptions } from '../../core/utils/naming.js';
import { buildBookCreatePayload, type EnrichmentDeps } from './enrichment-orchestration.helpers.js';
import type { EventHistoryService } from './event-history.service.js';
import type { EventBroadcasterService } from './event-broadcaster.service.js';
import { snapshotBookForEvent } from '../utils/event-helpers.js';
import type { ImportConfirmItem, ImportMode } from './library-scan.service.js';
import { serializeError } from '../utils/serialize-error.js';
import type { ManualImportJobPayload } from './import-adapters/types.js';


export interface ImportPipelineDeps {
  db: Db;
  log: FastifyBaseLogger;
  bookService: BookService;
  bookImportService: BookImportService;
  settingsService: SettingsService;
  eventHistory: EventHistoryService;
  enrichmentDeps: EnrichmentDeps;
  broadcaster?: EventBroadcasterService | undefined;
}

/**
 * Audio bytes already present at the computed target, treating a non-existent
 * target (ENOENT) as empty. `> 0` routes the manual import through the staged
 * swap (#1287); `0`/missing keeps the simple direct-copy fast path (AC3).
 */
async function getTargetAudioSize(targetPath: string): Promise<number> {
  try {
    return await getAudioPathSize(targetPath);
  } catch (sizeError: unknown) {
    if ((sizeError as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw sizeError;
  }
}

/**
 * Run the marker-gated recovery the auto path runs unconditionally
 * (`prepareImportSiblings`) BEFORE the populated-target gate (#1337). A commit
 * killed after the backup-out renames but before the first move-in strands the
 * target audio-EMPTY with an armed `.import-commit-pending` marker + populated
 * `.import-bak`. Without this, `getTargetAudioSize` reads `0`, the direct-copy
 * fast path runs and orphans the armed marker/backup — a *later* import then
 * fires bogus recovery and restores the stale originals OVER the manual import
 * (backup-authoritative is actively wrong here), and a subsequent ordinary
 * failure can delete the backup + marker, silently regressing the library.
 *
 * Marker PRESENT → recovery restores the stranded originals into `targetPath`
 * and consumes the marker + backup; the populated-target gate below then sees
 * audio and routes the manual import through the staged swap (which re-runs
 * `prepareImportSiblings` itself — a no-op now the marker is gone). Marker
 * ABSENT → both siblings are disposable scratch and are strict-cleared (no
 * recovery, no behavior change), and the direct-copy fast path runs as today.
 *
 * Deliberately reuses `prepareImportSiblings` rather than re-checking the marker
 * inline: it is the single encapsulation of "marker present → recover; marker
 * absent → strict-clear" and fails toward preservation on stat errors (#1336).
 * The sibling paths mirror `stagedAudioReplace`'s derivation so the pre-gate
 * recovery and the staged swap operate on the same `.import-tmp` / `.import-bak`.
 */
async function recoverInterruptedCommit(
  targetPath: string,
  libraryRoot: string,
  log: FastifyBaseLogger,
): Promise<void> {
  // #1341 marker-path collision preflight — BEFORE `prepareImportSiblings`. This is the
  // FIRST destructive touch on the manual/staged path (it runs ahead of the populated-target
  // gate that later calls `stagedAudioReplace`). A directory occupying the marker path reads
  // as marker-absent under the #1341 `isFile` change, which would otherwise send
  // `prepareImportSiblings` down its strict-clear branch and destroy an adjacent `.import-bak`
  // before `stagedAudioReplace`'s own preflight could fire. Aborting here leaves siblings
  // untouched; `copyToLibrary` has no local try/catch around this call, so the throw
  // propagates cleanly to the import worker.
  await assertMarkerPathWritable(targetPath);
  await prepareImportSiblings({
    stagingPath: `${targetPath}.import-tmp`,
    backupPath: `${targetPath}.import-bak`,
    targetPath,
    libraryRoot,
    log,
  });
}

// eslint-disable-next-line complexity -- copy/move pipeline with verification and retry logic
export async function copyToLibrary(
  item: ImportConfirmItem,
  meta: BookMetadata | null,
  mode: ImportMode,
  deps: ImportPipelineDeps,
  onProgress?: (progress: number, byteCounter: { current: number; total: number }) => void,
): Promise<string> {
  const { log, settingsService } = deps;

  const librarySettings = await settingsService.get('library');
  const namingOptions = toNamingOptions(librarySettings);
  // Provider-truth precedence: accepted provider metadata wins over raw item/tag fields.
  // Prefer canonical `seriesPrimary` over `series[0]` (#1088 / #1097) — `series[0]`
  // on Audible can be a broader universe entry rather than the real book series.
  // When `meta` is null (no provider match accepted), fall back to item-derived values.
  const metaPrimarySeries = meta?.seriesPrimary ?? meta?.series?.[0];
  const targetPath = buildTargetPath(
    librarySettings.path,
    librarySettings.folderFormat,
    {
      title: item.title,
      seriesName: metaPrimarySeries?.name ?? item.seriesName ?? undefined,
      seriesPosition: metaPrimarySeries?.position ?? (item.seriesPosition !== undefined ? item.seriesPosition : undefined),
      narrators: item.narrators?.length
        ? item.narrators.map(name => ({ name }))
        : (meta?.narrators?.length ? meta.narrators.map(n => ({ name: n })) : undefined),
      publishedDate: meta?.publishedDate,
    },
    item.authorName ?? null,
    namingOptions,
  );

  if (resolve(item.path) === resolve(targetPath)) {
    log.info({ path: targetPath, mode }, 'Source and target are the same path — skipping file operation');
    return targetPath;
  }

  const rel = relative(resolve(librarySettings.path), resolve(item.path));
  if (!rel.startsWith('..') && !isAbsolute(rel)) {
    throw new Error('Source path is inside the library root — cannot import a path already managed by the library');
  }

  // Coalesced disc-group row: `item.path` is only the lowest-disc member. Reconstruct the full
  // member set from disk and flatten every disc into one target (AC7), instead of copying just one.
  const memberPaths = await reconstructDiscGroup(item.path);
  if (memberPaths.length >= 2) {
    return copyDiscGroupToLibrary(item, targetPath, memberPaths, mode, deps, librarySettings.path, onProgress);
  }

  // Recover any interrupted commit (#1337) BEFORE the populated-target gate: an
  // audio-empty target with an armed marker must restore its stranded originals
  // first, so the gate below routes through the staged swap instead of the
  // fast path orphaning the marker/backup. No-op when no commit was interrupted.
  await recoverInterruptedCommit(targetPath, librarySettings.path, log);

  // Populated-target guard (#1287): a manual import whose computed target already
  // contains audio must NOT merge-copy in place (that recreates the #1252
  // Frankenbook). Route through the staged audio swap, flattening the source's
  // audio to the staging top level so the commit moves every file. Empty/missing
  // target keeps the simple direct-copy fast path below (AC3).
  if (await getTargetAudioSize(targetPath) > 0) {
    const sourceStats = await stat(item.path);
    const sourceAudioSize = await getAudioPathSize(item.path);
    log.info({ source: item.path, target: targetPath, mode, sourceAudioSize }, 'Target already contains audio — routing manual import through staged swap');
    await stagedAudioReplace({
      targetPath,
      libraryRoot: librarySettings.path,
      log,
      sourceAudioSize,
      stage: (stagingPath) => stageSourceAudio({ sourcePath: item.path, targetPath: stagingPath, sourceStats, log, onProgress }),
    });
    if (mode === 'move') {
      // Post-commit cleanup: the staged swap has already committed the new audio
      // to the library, so a vanished/partial source (ENOENT) must not fail an
      // already-successful import. `force: true` suppresses ENOENT only — a
      // genuine EPERM/EBUSY still surfaces.
      await rm(item.path, { recursive: true, force: true });
      log.info({ source: item.path }, 'Source directory removed after move');
    }
    return targetPath;
  }

  await mkdir(targetPath, { recursive: true });
  log.info({ source: item.path, target: targetPath, mode }, 'Copying files to library');
  if (onProgress) {
    await streamCopyWithProgress(item.path, targetPath, onProgress);
  } else {
    await cp(item.path, targetPath, { recursive: true, errorOnExist: false });
  }

  const sourceSize = await getAudioPathSize(item.path);
  const targetSize = await getAudioPathSize(targetPath);
  log.debug({ source: item.path, sourceSize, targetSize, ratio: sourceSize > 0 ? (targetSize / sourceSize).toFixed(4) : 'N/A' }, 'Copy verification');
  assertCopyVerified(sourceSize, targetSize);

  if (mode === 'move') {
    await rm(item.path, { recursive: true });
    log.info({ source: item.path }, 'Source directory removed after move');
  }

  return targetPath;
}

/**
 * Flatten a reconstructed multi-disc set into the library target. Aggregates source size across
 * all member discs for copy verification and removes every member folder on `move`.
 */
async function copyDiscGroupToLibrary(
  item: ImportConfirmItem,
  targetPath: string,
  memberPaths: string[],
  mode: ImportMode,
  deps: ImportPipelineDeps,
  libraryRoot: string,
  onProgress?: (progress: number, byteCounter: { current: number; total: number }) => void,
): Promise<string> {
  const { log } = deps;
  log.info({ source: item.path, discMembers: memberPaths.length, target: targetPath, mode }, 'Flattening multi-disc group to library');

  // Recover any interrupted commit (#1337) BEFORE the populated-target gate — the
  // disc-group flatten has the identical marker-orphaning gap as the single-source
  // path. No-op when no commit was interrupted.
  await recoverInterruptedCommit(targetPath, libraryRoot, log);

  // Populated-target guard (#1287, AC5): the disc-group flatten has the identical
  // merge-into-target gap as the single-source path. When the target already holds
  // audio, stage the flattened discs and atomically swap rather than merging.
  if (await getTargetAudioSize(targetPath) > 0) {
    let sourceAudioSize = 0;
    for (const memberPath of memberPaths) {
      sourceAudioSize += await getAudioPathSize(memberPath);
    }
    log.info({ source: item.path, discMembers: memberPaths.length, target: targetPath, mode, sourceAudioSize }, 'Target already contains audio — routing multi-disc import through staged swap');
    await stagedAudioReplace({
      targetPath,
      libraryRoot,
      log,
      sourceAudioSize,
      stage: (stagingPath) => copyDiscGroup(memberPaths, stagingPath, onProgress),
    });
    if (mode === 'move') {
      // Post-commit cleanup: the staged swap has already committed all discs'
      // audio. A member whose source vanished (ENOENT) must not break the loop
      // and orphan later members or fail the import. `force: true` suppresses
      // ENOENT only — a genuine EPERM/EBUSY still surfaces.
      for (const memberPath of memberPaths) {
        await rm(memberPath, { recursive: true, force: true });
      }
      log.info({ discMembers: memberPaths.length }, 'Source disc folders removed after move');
    }
    return targetPath;
  }

  await copyDiscGroup(memberPaths, targetPath, onProgress);

  let sourceSize = 0;
  for (const memberPath of memberPaths) {
    sourceSize += await getAudioPathSize(memberPath);
  }
  const targetSize = await getAudioPathSize(targetPath);
  log.debug({ discMembers: memberPaths.length, sourceSize, targetSize, ratio: sourceSize > 0 ? (targetSize / sourceSize).toFixed(4) : 'N/A' }, 'Multi-disc copy verification');
  assertCopyVerified(sourceSize, targetSize);

  if (mode === 'move') {
    for (const memberPath of memberPaths) {
      await rm(memberPath, { recursive: true });
    }
    log.info({ discMembers: memberPaths.length }, 'Source disc folders removed after move');
  }

  return targetPath;
}

export async function confirmImport(
  items: ImportConfirmItem[],
  deps: ImportPipelineDeps,
  mode?: ImportMode,
  nudgeWorker?: () => void,
): Promise<{ accepted: number }> {
  const { log, bookService, bookImportService, eventHistory } = deps;

  log.info({ count: items.length, mode: mode ?? 'pointer' }, 'Accepting library import');

  const accepted: Array<{ bookId: number; item: ImportConfirmItem }> = [];

  for (const item of items) {
    try {
      if (!item.forceImport) {
        const existing = await bookService.findDuplicate(item.title, item.authorName ? [{ name: item.authorName }] : undefined);
        if (existing) {
          log.debug({ title: item.title }, 'Skipping duplicate during import');
          continue;
        }
      }

      log.debug(
        {
          title: item.title,
          author: item.authorName,
          hasMetadata: !!item.metadata,
          asin: item.asin || item.metadata?.asin,
        },
        'Creating import placeholder',
      );

      const book = await bookService.create(buildBookCreatePayload(item, item.metadata ?? null, 'importing'));

      // Build the persisted payload — mode omitted for pointer mode
      const payload: ManualImportJobPayload = { ...item };
      if (mode) {
        payload.mode = mode;
      }

      const enqueued = await bookImportService.enqueue({
        bookId: book.id,
        type: 'manual',
        metadata: JSON.stringify(payload),
      });

      if ('error' in enqueued) {
        // Rare: the placeholder bookId already has an active job. Skip this
        // item from `accepted` so the caller's count reflects reality.
        log.warn({ bookId: book.id, title: item.title }, 'Manual import skipped — active job already exists for book');
        continue;
      }

      eventHistory.create({
        bookId: book.id,
        ...snapshotBookForEvent(book),
        eventType: 'book_added',
        source: 'manual',
      }).catch(err => log.warn({ error: serializeError(err) }, 'Failed to record book_added event'));

      accepted.push({ bookId: book.id, item });
    } catch (error: unknown) {
      log.error({ error: serializeError(error), title: item.title }, 'Failed to create placeholder for import');
    }
  }

  log.info({ accepted: accepted.length }, 'Import jobs created, nudging worker');

  if (accepted.length > 0 && nudgeWorker) {
    nudgeWorker();
  }

  return { accepted: accepted.length };
}
