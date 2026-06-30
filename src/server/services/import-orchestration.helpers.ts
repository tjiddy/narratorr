/**
 * Bulk import pipeline — accepts user-confirmed items and queues them for the
 * import worker. Extracted for consistency with quality-gate helpers.
 */
import { stat } from 'node:fs/promises';
import { relative, resolve, isAbsolute, normalize } from 'node:path';
import { copyToLibrary as stageSourceAudio, stagedAudioReplace } from '../utils/import-steps.js';
import type { Db } from '../../db/index.js';
import type { FastifyBaseLogger } from 'fastify';
import { OwnedRecordingError, type BookService, type BookWithAuthor } from './book.service.js';
import type { HeldReviewItem } from '../../shared/schemas/library-scan.js';
import { resolveRecordingIdentity, deriveEditionLabel, type RecordingCandidate, type LibraryRecording } from '../../core/utils/recording-identity.js';
import { sanitizeEditionDiscriminator } from '../../core/utils/naming.js';
import { normalizeProductionType } from '../../core/metadata/production-type.js';
import { slugify } from '../../core/index.js';
import type { BookImportService } from './book-import.service.js';
import type { SettingsService } from './settings.service.js';
import type { BookMetadata } from '../../core/metadata/index.js';
import { buildTargetPath, getAudioPathSize, assertCopyVerified, reconstructDiscGroup, copyDiscGroup } from '../utils/import-helpers.js';
import { recoverInterruptedCommit } from '../utils/recover-interrupted-commit.js';
import { deleteManagedBookFiles } from '../utils/delete-managed-files.js';
import { toNamingOptions } from '../../core/utils/naming.js';
import { buildBookCreatePayload, type EnrichmentDeps } from './enrichment-orchestration.helpers.js';
import type { EventHistoryService } from './event-history.service.js';
import type { EventBroadcasterService } from './event-broadcaster.service.js';
import type { ConnectorService } from './connector.service.js';
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
  connectorService?: ConnectorService | undefined;
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
 * Per-site logging contract for the nonfatal post-commit source cleanup. The `context` carries
 * the success log LEVEL and message plus the warn-on-failure message so the four call sites keep
 * their distinct, test-asserted log behavior (#1591) while sharing one cleanup body.
 */
interface SourceCleanupContext {
  successLevel: 'info' | 'debug';
  successMessage: string;
  errorMessage: string;
}

// Single-source (`copyToLibrary`) sites: success at `info`, the single-source warn message.
const SINGLE_SOURCE_CLEANUP: SourceCleanupContext = {
  successLevel: 'info',
  successMessage: 'Source managed files removed after move (foreign files preserved)',
  errorMessage: 'Failed to clean source after committed move — import already succeeded, continuing',
};

// Per-disc (`copyDiscGroupToLibrary`) sites: success at `debug`, the disc-specific warn message.
const DISC_SOURCE_CLEANUP: SourceCleanupContext = {
  successLevel: 'debug',
  successMessage: 'Disc source managed files removed after move',
  errorMessage: 'Failed to clean disc source after committed move — import already succeeded, continuing',
};

/**
 * Post-commit cleanup of a single source folder/disc member after a committed move. Deletes only
 * MANAGED files (#1589), preserving co-located foreign files; the source is OUTSIDE the library
 * root so containment is opted out (`{ assertInsideLibrary: false }`) — classification still
 * protects foreign files, and the helper's #1598 `lstat` hardening keeps a top-level symlinked
 * source unfollowed.
 *
 * NONFATAL by contract (#1591): this runs AFTER the commit, so a cleanup throw — a source that
 * vanished between stat and readdir (ENOENT) OR any non-ENOENT failure (EACCES/EPERM/EBUSY) — must
 * not fail the already-committed import. The throw is swallowed into a `log.warn`. At the disc
 * sites this is called per member inside the loop so one failing disc doesn't skip the rest.
 */
async function cleanupSourceManagedFilesNonfatal(
  sourcePath: string,
  libraryRoot: string,
  log: FastifyBaseLogger,
  context: SourceCleanupContext,
): Promise<void> {
  try {
    const cleanup = await deleteManagedBookFiles(sourcePath, libraryRoot, log, { assertInsideLibrary: false });
    log[context.successLevel]({ source: sourcePath, deleted: cleanup.deletedManaged.length, preservedForeign: cleanup.preservedForeign.length }, context.successMessage);
  } catch (cleanupError: unknown) {
    log.warn({ error: serializeError(cleanupError), source: sourcePath }, context.errorMessage);
  }
}

// `recoverInterruptedCommit` (the marker-gated recovery sequence run before the
// populated-target gate, #1337) now lives in `utils/recover-interrupted-commit.ts` so the
// rename and merge writers can share the same `assertMarkerPathWritable` +
// `prepareImportSiblings` sequence (#1418). Imported above.

// ── Cross-row collision fence (#1711) ─────────────────────────────────────
//
// The Manual/Library copy path routes an occupied target through the staged swap
// with NO owner check, so a DIFFERENT recording colliding on the same computed
// folder would overwrite the incumbent's audio. The fence below resolves the
// occupied target's owner(s), runs the recording resolver, and gates the swap:
// a staged swap is permitted ONLY for exactly-one-owner + same-recording; a
// different recording is disambiguated into a new `(edition)` folder (keep-both);
// every uncertain case (review / 0 owners with no disambiguator / 2+ owners)
// throws `OwnedRecordingError` so the import fails LOUDLY rather than overwriting.

/** Decision for an occupied target: either swap in place, or copy into a disambiguated folder. */
interface OccupiedResolution {
  targetPath: string;
  editionLabel?: string | undefined;
  /** true → staged swap permitted (same recording); false → copy into a fresh disambiguated folder. */
  swap: boolean;
}

/** Build the recording candidate (#1711) from the confirm item + accepted provider metadata. */
function buildRecordingCandidate(item: ImportConfirmItem, meta: BookMetadata | null): RecordingCandidate {
  const narrators = item.narrators?.length ? item.narrators : (meta?.narrators ?? []);
  return {
    title: item.title,
    authors: item.authorName ? [item.authorName] : (meta?.authors?.map((a) => a.name) ?? []),
    narrators,
    asin: item.asin ?? meta?.asin ?? null,
    duration: meta?.duration ?? null,
  };
}

/** Adapt a hydrated owner row into the resolver's library-recording shape. */
function ownerToLibraryRecording(owner: BookWithAuthor): LibraryRecording {
  return {
    title: owner.title,
    primaryAuthorSlug: slugify(owner.authors[0]?.name ?? ''),
    narrators: owner.narrators.map((n) => n.name),
    asin: owner.asin ?? null,
    duration: owner.duration ?? null,
  };
}

/**
 * Disambiguate a different-recording (or unidentifiable) collision into a new
 * `(edition)` folder. Derives a deterministic label from stable recording
 * metadata; throws `OwnedRecordingError` (review disposition) when no label can
 * be derived. The disambiguated path is re-checked: if it is itself occupied by
 * the SAME recording (a re-import) a staged swap is permitted; any other occupied
 * outcome throws rather than overwrite.
 */
async function disambiguateTarget(
  candidate: RecordingCandidate,
  productionType: string | undefined,
  owner: BookWithAuthor | null,
  deps: ImportPipelineDeps,
  rebuild: (label: string) => string,
): Promise<OccupiedResolution> {
  // Sanitize the derived label into a path-safe discriminator BEFORE the no-disambiguator guard
  // (#1739, F5): `deriveEditionLabel` returns the raw trimmed narrator name, so a label like `:::`
  // or control chars is truthy yet path-empty. Gating on the sanitized discriminator makes a
  // distinct recording whose label sanitizes to nothing deterministically held for review rather
  // than collapsed onto the occupied base folder.
  const discriminator = sanitizeEditionDiscriminator(deriveEditionLabel(candidate.narrators, productionType));
  if (!discriminator) {
    throw new OwnedRecordingError({
      existingBookId: owner?.id ?? -1,
      title: owner?.title ?? candidate.title,
      reason: 'recording-review-no-disambiguator',
    });
  }
  const newTarget = rebuild(discriminator);
  if (await getTargetAudioSize(newTarget) === 0) {
    return { targetPath: newTarget, editionLabel: discriminator, swap: false };
  }
  // The disambiguated folder is itself occupied — only a same-recording re-import may swap.
  const newOwners = await deps.bookService.findPathOwners(normalize(resolve(newTarget)));
  if (newOwners.length === 1 && resolveRecordingIdentity(candidate, ownerToLibraryRecording(newOwners[0]!)) === 'same-recording') {
    return { targetPath: newTarget, editionLabel: discriminator, swap: true };
  }
  throw new OwnedRecordingError({
    existingBookId: newOwners[0]?.id ?? -1,
    title: newOwners[0]?.title ?? candidate.title,
    reason: 'recording-review-disambiguated-collision',
  });
}

/**
 * Resolve how to place a candidate onto an OCCUPIED target (#1711). Branches on
 * path-owner cardinality, then the recording verdict — see the Disposition
 * Contract. Never permits a staged swap except for exactly-one-owner +
 * same-recording.
 */
async function resolveOccupiedTarget(
  baseTargetPath: string,
  candidate: RecordingCandidate,
  productionType: string | undefined,
  deps: ImportPipelineDeps,
  rebuild: (label: string) => string,
): Promise<OccupiedResolution> {
  const owners = await deps.bookService.findPathOwners(normalize(resolve(baseTargetPath)));
  if (owners.length === 1) {
    const verdict = resolveRecordingIdentity(candidate, ownerToLibraryRecording(owners[0]!));
    if (verdict === 'same-recording') return { targetPath: baseTargetPath, swap: true };
    if (verdict === 'different-recording') {
      return disambiguateTarget(candidate, productionType, owners[0]!, deps, rebuild);
    }
    // review / no-signal → never overwrite.
    throw new OwnedRecordingError({ existingBookId: owners[0]!.id, title: owners[0]!.title, reason: 'recording-review' });
  }
  if (owners.length === 0) {
    // Audio on disk but no row claims this exact path: cannot identify a recording
    // to compare — disambiguate to a new folder when possible, else review.
    return disambiguateTarget(candidate, productionType, null, deps, rebuild);
  }
  // 2+ owners (data anomaly) → never staged-swap.
  throw new OwnedRecordingError({ existingBookId: owners[0]!.id, title: owners[0]!.title, reason: 'recording-review-ambiguous-owner' });
}

// eslint-disable-next-line complexity -- copy/move pipeline with verification and retry logic
export async function copyToLibrary(
  item: ImportConfirmItem,
  meta: BookMetadata | null,
  mode: ImportMode,
  deps: ImportPipelineDeps,
  onProgress?: (progress: number, byteCounter: { current: number; total: number }) => void,
): Promise<{ targetPath: string; editionLabel?: string }> {
  const { log, settingsService } = deps;

  const librarySettings = await settingsService.get('library');
  const namingOptions = toNamingOptions(librarySettings);
  // Provider-truth precedence: accepted provider metadata wins over raw item/tag fields.
  // Prefer canonical `seriesPrimary` over `series[0]` (#1088 / #1097) — `series[0]`
  // on Audible can be a broader universe entry rather than the real book series.
  // When `meta` is null (no provider match accepted), fall back to item-derived values.
  const metaPrimarySeries = meta?.seriesPrimary ?? meta?.series?.[0];
  const targetBook = {
    title: item.title,
    seriesName: metaPrimarySeries?.name ?? item.seriesName ?? undefined,
    seriesPosition: metaPrimarySeries?.position ?? (item.seriesPosition !== undefined ? item.seriesPosition : undefined),
    narrators: item.narrators?.length
      ? item.narrators.map(name => ({ name }))
      : (meta?.narrators?.length ? meta.narrators.map(n => ({ name: n })) : undefined),
    publishedDate: meta?.publishedDate,
  };
  // Rebuild closure (#1711): re-render the SAME path with an edition-label suffix
  // when a different-recording collision needs disambiguating.
  const rebuild = (label: string): string =>
    buildTargetPath(librarySettings.path, librarySettings.folderFormat, targetBook, item.authorName ?? null, namingOptions, label);
  let targetPath = rebuild('');
  let editionLabel: string | undefined;

  if (resolve(item.path) === resolve(targetPath)) {
    log.info({ path: targetPath, mode }, 'Source and target are the same path — skipping file operation');
    return { targetPath };
  }

  const rel = relative(resolve(librarySettings.path), resolve(item.path));
  if (!rel.startsWith('..') && !isAbsolute(rel)) {
    throw new Error('Source path is inside the library root — cannot import a path already managed by the library');
  }

  // Coalesced disc-group row: `item.path` is only the lowest-disc member. Reconstruct the full
  // member set from disk and flatten every disc into one target (AC7), instead of copying just one.
  const memberPaths = await reconstructDiscGroup(item.path);
  if (memberPaths.length >= 2) {
    return copyDiscGroupToLibrary(item, meta, targetPath, memberPaths, mode, deps, librarySettings.path, rebuild, onProgress);
  }

  // Recover any interrupted commit (#1337) BEFORE the populated-target gate: an
  // audio-empty target with an armed marker must restore its stranded originals
  // first, so the gate below routes through the staged swap instead of the
  // fast path orphaning the marker/backup. No-op when no commit was interrupted.
  await recoverInterruptedCommit(targetPath, librarySettings.path, log);

  // Populated-target guard (#1287) + cross-row collision fence (#1711): a manual
  // import whose computed target already contains audio must NOT merge-copy in
  // place. Resolve the occupied target's owner(s) and the recording verdict — a
  // staged swap is permitted ONLY for exactly-one-owner + same-recording; a
  // different recording disambiguates into a new `(edition)` folder (keep-both),
  // and every uncertain case throws (never overwrite). Empty/missing target keeps
  // the simple direct-copy fast path below (AC3).
  if (await getTargetAudioSize(targetPath) > 0) {
    const candidate = buildRecordingCandidate(item, meta);
    const productionType = meta?.formatType ? normalizeProductionType(meta.formatType) : undefined;
    const occ = await resolveOccupiedTarget(targetPath, candidate, productionType, deps, rebuild);
    if (occ.swap) {
      const sourceStats = await stat(item.path);
      const sourceAudioSize = await getAudioPathSize(item.path);
      log.info({ source: item.path, target: occ.targetPath, mode, sourceAudioSize }, 'Occupied target is the same recording — routing manual import through staged swap');
      await stagedAudioReplace({
        targetPath: occ.targetPath,
        libraryRoot: librarySettings.path,
        log,
        sourceAudioSize,
        stage: (stagingPath) => stageSourceAudio({ sourcePath: item.path, targetPath: stagingPath, sourceStats, log, onProgress }),
      });
      if (mode === 'move') {
        // Post-commit cleanup: the staged swap has already committed the new audio to the library.
        await cleanupSourceManagedFilesNonfatal(item.path, librarySettings.path, log, SINGLE_SOURCE_CLEANUP);
      }
      return { targetPath: occ.targetPath };
    }
    // Different recording (or 0-owner) → keep-both: copy into the disambiguated,
    // freshly-empty folder; the incumbent's audio is never touched. Fall through
    // to the empty-target copy on the new path.
    log.info({ source: item.path, base: targetPath, disambiguated: occ.targetPath, editionLabel: occ.editionLabel }, 'Different recording on occupied target — copying into a disambiguated folder (keep-both)');
    targetPath = occ.targetPath;
    editionLabel = occ.editionLabel;
    await recoverInterruptedCommit(targetPath, librarySettings.path, log);
  }

  // Empty-target fast path (#1602): import AUDIO ONLY by reusing the SAME copier the populated-target
  // staged swap uses (`stageSourceAudio`/`copyToLibrary`), so the foreign-file outcome can no longer
  // diverge between the two paths. It branches directory-vs-file internally: a directory source drops
  // non-audio members (co-located `.epub`/`.pdf`/`.nfo`/images), an audio single-file source is copied
  // (file-path manual imports stay supported), and a non-audio single-file source is rejected with
  // `ContentFailureError`. It also mkdir's the target itself, so the standalone `mkdir` + whole-tree
  // `cp`/`streamCopyWithProgress` (which copied foreign files verbatim) are gone.
  const sourceStats = await stat(item.path);
  log.info({ source: item.path, target: targetPath, mode }, 'Copying files to library');
  await stageSourceAudio({ sourcePath: item.path, targetPath, sourceStats, log, onProgress });

  const sourceSize = await getAudioPathSize(item.path);
  const targetSize = await getAudioPathSize(targetPath);
  log.debug({ source: item.path, sourceSize, targetSize, ratio: sourceSize > 0 ? (targetSize / sourceSize).toFixed(4) : 'N/A' }, 'Copy verification');
  assertCopyVerified(sourceSize, targetSize);

  if (mode === 'move') {
    // Empty-target move cleanup (#1598): route source removal through the managed-file helper
    // instead of a blanket `rm(item.path, { recursive: true })`, so a co-located foreign file
    // (e.g. a bundled .epub/.pdf) is preserved (#1589) AND a top-level symlinked source is not
    // followed. The copy above is already verified, so this matches the populated-target cleanup.
    await cleanupSourceManagedFilesNonfatal(item.path, librarySettings.path, log, SINGLE_SOURCE_CLEANUP);
  }

  return { targetPath, ...(editionLabel !== undefined && { editionLabel }) };
}

/**
 * Flatten a reconstructed multi-disc set into the library target. Aggregates source size across
 * all member discs for copy verification and removes every member folder on `move`.
 */
async function copyDiscGroupToLibrary(
  item: ImportConfirmItem,
  meta: BookMetadata | null,
  baseTargetPath: string,
  memberPaths: string[],
  mode: ImportMode,
  deps: ImportPipelineDeps,
  libraryRoot: string,
  rebuild: (label: string) => string,
  onProgress?: (progress: number, byteCounter: { current: number; total: number }) => void,
): Promise<{ targetPath: string; editionLabel?: string }> {
  const { log } = deps;
  let targetPath = baseTargetPath;
  let editionLabel: string | undefined;
  log.info({ source: item.path, discMembers: memberPaths.length, target: targetPath, mode }, 'Flattening multi-disc group to library');

  // Recover any interrupted commit (#1337) BEFORE the populated-target gate — the
  // disc-group flatten has the identical marker-orphaning gap as the single-source
  // path. No-op when no commit was interrupted.
  await recoverInterruptedCommit(targetPath, libraryRoot, log);

  // Populated-target guard (#1287, AC5) + cross-row collision fence (#1711): the
  // disc-group flatten has the identical merge-into-target gap as the single-source
  // path. Resolve the occupied target's owner(s) and verdict — staged swap ONLY for
  // exactly-one-owner + same-recording; a different recording disambiguates; every
  // uncertain case throws (never overwrite).
  if (await getTargetAudioSize(targetPath) > 0) {
    const candidate = buildRecordingCandidate(item, meta);
    const productionType = meta?.formatType ? normalizeProductionType(meta.formatType) : undefined;
    const occ = await resolveOccupiedTarget(targetPath, candidate, productionType, deps, rebuild);
    if (!occ.swap) {
      log.info({ source: item.path, base: targetPath, disambiguated: occ.targetPath, editionLabel: occ.editionLabel }, 'Different recording on occupied disc-group target — copying into a disambiguated folder (keep-both)');
      targetPath = occ.targetPath;
      editionLabel = occ.editionLabel;
      await recoverInterruptedCommit(targetPath, libraryRoot, log);
      // fall through to the empty-target disc copy on the new path.
    } else {
    let sourceAudioSize = 0;
    for (const memberPath of memberPaths) {
      sourceAudioSize += await getAudioPathSize(memberPath);
    }
    log.info({ source: item.path, discMembers: memberPaths.length, target: occ.targetPath, mode, sourceAudioSize }, 'Occupied disc-group target is the same recording — routing through staged swap');
    await stagedAudioReplace({
      targetPath: occ.targetPath,
      libraryRoot,
      log,
      sourceAudioSize,
      stage: (stagingPath) => copyDiscGroup(memberPaths, stagingPath, onProgress),
    });
    if (mode === 'move') {
      // Post-commit cleanup: the staged swap has already committed all discs' audio. Delete only
      // MANAGED files from each source disc folder (#1589) so a bundled e-book/PDF is preserved.
      // Sources are OUTSIDE the library root → containment guard opted out. Nonfatal — a vanished
      // member (ENOENT) is a no-op and a locked managed file is recorded, not thrown.
      // Per-member (#1591): post-commit cleanup must not fail the already-committed import, and one
      // failing disc must not skip the rest — `cleanupSourceManagedFilesNonfatal` swallows per call.
      for (const memberPath of memberPaths) {
        await cleanupSourceManagedFilesNonfatal(memberPath, libraryRoot, log, DISC_SOURCE_CLEANUP);
      }
      log.info({ discMembers: memberPaths.length }, 'Source disc folders cleaned after move (foreign files preserved)');
    }
    return { targetPath: occ.targetPath };
    }
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
    // Empty-target multi-disc move cleanup (#1598): route each member through the managed-file
    // helper instead of a blanket `rm(memberPath, { recursive: true })`, mirroring the single-source
    // empty-target path above so the two stay consistent. Per-member nonfatal (matching the
    // populated-target multi-disc cleanup): one failing disc must not fail the committed import or
    // skip the remaining members.
    for (const memberPath of memberPaths) {
      await cleanupSourceManagedFilesNonfatal(memberPath, libraryRoot, log, DISC_SOURCE_CLEANUP);
    }
    log.info({ discMembers: memberPaths.length }, 'Source disc folders cleaned after move (foreign files preserved)');
  }

  return { targetPath, ...(editionLabel !== undefined && { editionLabel }) };
}

/** The matched ASIN to dedupe on (#1662): the top-level field, else the metadata's. */
function resolveDedupeAsin(item: ImportConfirmItem): string | undefined {
  return item.asin ?? item.metadata?.asin;
}

/**
 * Pre-copy recording-identity classification for a confirm item (#1711). Threads
 * candidate narrators + matched ASIN + duration into the three-way `findDuplicate`:
 *  - `same-recording` → `'skip'` (owned, plain not-accepted skip — NOT held).
 *  - `review`/no-signal → a `HeldReviewItem` (not copied, not enqueued).
 *  - `different-recording` (or `forceImport`) → `'proceed'`.
 */
async function classifyConfirmItem(
  item: ImportConfirmItem,
  bookService: BookService,
  log: FastifyBaseLogger,
): Promise<'skip' | 'proceed' | HeldReviewItem> {
  if (item.forceImport) return 'proceed';
  const dedupeAsin = resolveDedupeAsin(item);
  const resolution = await bookService.findDuplicate({
    title: item.title,
    ...(item.authorName ? { authors: [{ name: item.authorName }] } : {}),
    ...(dedupeAsin !== undefined && { asin: dedupeAsin }),
    ...(item.narrators !== undefined && { narrators: item.narrators }),
    ...(item.metadata?.duration !== undefined && { duration: item.metadata.duration }),
  });
  if (resolution.verdict === 'same-recording') {
    log.debug({ title: item.title }, 'Skipping owned duplicate during import (same recording)');
    return 'skip';
  }
  if (resolution.verdict === 'review') {
    log.info({ title: item.title, existingBookId: resolution.book?.id }, 'Holding import item for recording review');
    return {
      path: item.path,
      title: item.title,
      reason: 'recording-review-required',
      ...(resolution.book ? { existingBookId: resolution.book.id } : {}),
    };
  }
  return 'proceed';
}

export async function confirmImport(
  items: ImportConfirmItem[],
  deps: ImportPipelineDeps,
  mode?: ImportMode,
  nudgeWorker?: () => void,
): Promise<{ accepted: number; heldReview: HeldReviewItem[] }> {
  const { log, bookService, bookImportService, eventHistory } = deps;

  log.info({ count: items.length, mode: mode ?? 'pointer' }, 'Accepting library import');

  const accepted: Array<{ bookId: number; item: ImportConfirmItem }> = [];
  const heldReview: HeldReviewItem[] = [];

  for (const item of items) {
    try {
      const classification = await classifyConfirmItem(item, bookService, log);
      if (classification === 'skip') continue;
      if (classification !== 'proceed') {
        heldReview.push(classification);
        continue;
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
      // Same-ASIN create-time race (#1711): the recording is already owned — a
      // plain not-accepted skip (NOT held, NOT enqueued), never a hard failure.
      if (error instanceof OwnedRecordingError) {
        log.debug({ title: item.title, existingBookId: error.existingBookId }, 'Skipping owned duplicate during import (ASIN race)');
        continue;
      }
      log.error({ error: serializeError(error), title: item.title }, 'Failed to create placeholder for import');
    }
  }

  log.info({ accepted: accepted.length, held: heldReview.length }, 'Import jobs created, nudging worker');

  if (accepted.length > 0 && nudgeWorker) {
    nudgeWorker();
  }

  return { accepted: accepted.length, heldReview };
}
