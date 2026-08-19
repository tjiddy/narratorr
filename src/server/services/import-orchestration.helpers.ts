import { stat } from 'node:fs/promises';
import { relative, resolve, isAbsolute, normalize } from 'node:path';
import { copyToLibrary as stageSourceAudio, stagedAudioReplace } from '../utils/import-steps.js';
import type { Db } from '@db/index.js';
import type { FastifyBaseLogger } from 'fastify';
import { OwnedRecordingError, type BookService, type BookWithAuthor } from './book.service.js';
import { resolveRecordingIdentity, deriveEditionLabel, type RecordingCandidate } from '@core/utils/recording-identity.js';
import { sanitizeEditionDiscriminator } from '@core/utils/naming.js';
import { normalizeProductionType } from '@core/metadata/production-type.js';
import { toLibraryRecording } from './book-dedup.js';
import type { BookImportService } from './book-import.service.js';
import type { SettingsService } from './settings.service.js';
import type { BookMetadata } from '@core/metadata/index.js';
import type { AppSettings } from '@shared/schemas/settings/registry.js';
import { buildTargetPath, getAudioPathSize, assertCopyVerified, reconstructDiscGroup, copyDiscGroup } from '../utils/import-helpers.js';
import { recoverInterruptedCommit } from '../utils/recover-interrupted-commit.js';
import { deleteManagedBookFiles } from '../utils/delete-managed-files.js';
import { toNamingOptions } from '@core/utils/naming.js';
import type { EnrichmentDeps } from './enrichment-orchestration.helpers.js';
import type { EventHistoryService } from './event-history.service.js';
import type { EventBroadcasterService } from './event-broadcaster.service.js';
import type { ConnectorService } from './connector.service.js';
import type { ImportConfirmItem, ImportMode } from './library-scan.service.js';
import { serializeError } from '../utils/serialize-error.js';
import { pickPrimarySeries } from '@shared/pick-primary-series.js';
import { resolveImportSeries } from './resolve-import-series.js';
import type { AttachNaming } from './attach-naming.js';


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

// Treat ENOENT as empty; positive audio size enters occupied-target handling.
async function getTargetAudioSize(targetPath: string): Promise<number> {
  try {
    return await getAudioPathSize(targetPath);
  } catch (sizeError: unknown) {
    if ((sizeError as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw sizeError;
  }
}

// Preserve per-site log level/messages while sharing nonfatal cleanup.
interface SourceCleanupContext {
  successLevel: 'info' | 'debug';
  successMessage: string;
  errorMessage: string;
}

const SINGLE_SOURCE_CLEANUP: SourceCleanupContext = {
  successLevel: 'info',
  successMessage: 'Source managed files removed after move (foreign files preserved)',
  errorMessage: 'Failed to clean source after committed move — import already succeeded, continuing',
};

const DISC_SOURCE_CLEANUP: SourceCleanupContext = {
  successLevel: 'debug',
  successMessage: 'Disc source managed files removed after move',
  errorMessage: 'Failed to clean disc source after committed move — import already succeeded, continuing',
};

// Post-commit and nonfatal: delete only managed source files, preserving foreign files and symlinks.
// Sources lie outside the library root, so containment is intentionally disabled; failures become warnings.
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

// Occupied audio may be replaced only for exactly one owner of the same recording.
// Different recordings disambiguate; uncertain ownership or verdicts fail rather than overwrite.
interface OccupiedResolution {
  targetPath: string;
  editionLabel?: string | undefined;
  // swap=true is the sole permission to replace occupied audio.
  swap: boolean;
}

function buildRecordingCandidate(item: ImportConfirmItem, meta: BookMetadata | null): RecordingCandidate {
  const narrators = item.narrators?.length ? item.narrators : (meta?.narrators ?? []);
  return {
    title: item.title,
    authors: item.authorName ? [item.authorName] : (meta?.authors?.map((a) => a.name) ?? []),
    narrators,
    asin: item.asin ?? meta?.asin ?? null,
    duration: meta?.duration ?? null,
    // unknown production type is deliberately no signal to the collision veto.
    productionType: normalizeProductionType(meta?.formatType),
  };
}

/** The second naming consumer: what the keep-both edition label is derived FROM (#2435 AC23). */
function resolveCollisionIdentity(
  item: ImportConfirmItem,
  meta: BookMetadata | null,
  naming: AttachNaming | undefined,
): { candidate: RecordingCandidate; productionType: string | undefined } {
  if (naming) return { candidate: naming.candidate, productionType: naming.productionType };
  return {
    candidate: buildRecordingCandidate(item, meta),
    productionType: meta?.formatType ? normalizeProductionType(meta.formatType) : undefined,
  };
}

// Build a deterministic safe edition folder; an unusable label or conflicting destination requires review.
async function disambiguateTarget(
  candidate: RecordingCandidate,
  productionType: string | undefined,
  owner: BookWithAuthor | null,
  deps: ImportPipelineDeps,
  rebuild: (label: string) => string,
): Promise<OccupiedResolution> {
  // Gate on sanitized output: a truthy raw label like `:::` can still become path-empty.
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
  // An occupied edition folder may swap only for a same-recording re-import.
  const newOwners = await deps.bookService.findPathOwners(normalize(resolve(newTarget)));
  if (newOwners.length === 1 && resolveRecordingIdentity(candidate, toLibraryRecording(newOwners[0]!)).verdict === 'same-recording') {
    return { targetPath: newTarget, editionLabel: discriminator, swap: true };
  }
  throw new OwnedRecordingError({
    existingBookId: newOwners[0]?.id ?? -1,
    title: newOwners[0]?.title ?? candidate.title,
    reason: 'recording-review-disambiguated-collision',
  });
}

// forceImport bypasses bibliographic dedup only; it never relaxes occupied-path overwrite protection.
async function resolveOccupiedTarget(
  baseTargetPath: string,
  candidate: RecordingCandidate,
  productionType: string | undefined,
  deps: ImportPipelineDeps,
  rebuild: (label: string) => string,
): Promise<OccupiedResolution> {
  const owners = await deps.bookService.findPathOwners(normalize(resolve(baseTargetPath)));
  if (owners.length === 1) {
    const { verdict } = resolveRecordingIdentity(candidate, toLibraryRecording(owners[0]!));
    if (verdict === 'same-recording') return { targetPath: baseTargetPath, swap: true };
    if (verdict === 'different-recording') {
      return disambiguateTarget(candidate, productionType, owners[0]!, deps, rebuild);
    }
    throw new OwnedRecordingError({ existingBookId: owners[0]!.id, title: owners[0]!.title, reason: 'recording-review' });
  }
  if (owners.length === 0) {
    // Unowned on-disk audio cannot be compared; disambiguate or fail review.
    return disambiguateTarget(candidate, productionType, null, deps, rebuild);
  }
  // Ambiguous ownership never permits a staged swap.
  throw new OwnedRecordingError({ existingBookId: owners[0]!.id, title: owners[0]!.title, reason: 'recording-review-ambiguous-owner' });
}

/**
 * `librarySettings` is the caller's root-commit registration snapshot (#2369 AC3/AC15), never a
 * read of its own: the gate is the single sequencing point for the canonical root, so a second
 * `settingsService.get('library')` here would make the target derivation answer to a read the
 * registration does not cover.
 */
// eslint-disable-next-line complexity -- copy/move pipeline with verification and retry logic
export async function copyToLibrary(
  item: ImportConfirmItem,
  meta: BookMetadata | null,
  mode: ImportMode,
  deps: ImportPipelineDeps,
  librarySettings: AppSettings['library'],
  onProgress?: (progress: number, byteCounter: { current: number; total: number }) => void,
  naming?: AttachNaming,
): Promise<{ targetPath: string; editionLabel?: string }> {
  const { log } = deps;

  const namingOptions = toNamingOptions(librarySettings);
  // Match DB creation: explicit item series wins, otherwise use metadata primary; only path building normalizes it.
  const series = resolveImportSeries(item, pickPrimarySeries(meta));
  // #2435: on an attach the incumbent row supersedes item/meta wherever naming is derived.
  const targetBook = naming?.targetBook ?? {
    title: item.title,
    seriesName: series.name,
    seriesPosition: series.position,
    narrators: item.narrators?.length
      ? item.narrators.map(name => ({ name }))
      : (meta?.narrators?.length ? meta.narrators.map(n => ({ name: n })) : undefined),
    publishedDate: meta?.publishedDate,
  };
  const authorName = naming ? naming.authorName : (item.authorName ?? null);
  const rebuild = (label: string): string =>
    buildTargetPath(librarySettings.path, librarySettings.folderFormat, targetBook, authorName, namingOptions, label);
  // A stored editionLabel seeds the base target, so the folder and any `{edition}` token agree.
  let targetPath = rebuild(naming?.seedEditionLabel ?? '');
  let editionLabel: string | undefined;

  if (resolve(item.path) === resolve(targetPath)) {
    log.info({ path: targetPath, mode }, 'Source and target are the same path — skipping file operation');
    return { targetPath };
  }

  const rel = relative(resolve(librarySettings.path), resolve(item.path));
  if (!rel.startsWith('..') && !isAbsolute(rel)) {
    throw new Error('Source path is inside the library root — cannot import a path already managed by the library');
  }

  // A coalesced row points only at the lowest disc; reconstruct every member before flattening.
  const memberPaths = await reconstructDiscGroup(item.path);
  if (memberPaths.length >= 2) {
    return copyDiscGroupToLibrary(item, meta, targetPath, memberPaths, mode, deps, librarySettings.path, rebuild, onProgress, naming);
  }

  // Recover marker-armed commits before occupancy checks, or an audio-empty target takes the orphaning fast path.
  await recoverInterruptedCommit(targetPath, librarySettings.path, log);

  // Occupied audio swaps only for one same-recording owner; differences disambiguate and uncertainty throws.
  if (await getTargetAudioSize(targetPath) > 0) {
    const { candidate, productionType } = resolveCollisionIdentity(item, meta, naming);
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
        await cleanupSourceManagedFilesNonfatal(item.path, librarySettings.path, log, SINGLE_SOURCE_CLEANUP);
      }
      return { targetPath: occ.targetPath };
    }
    // Keep both: switch to the empty disambiguated target and fall through.
    log.info({ source: item.path, base: targetPath, disambiguated: occ.targetPath, editionLabel: occ.editionLabel }, 'Different recording on occupied target — copying into a disambiguated folder (keep-both)');
    targetPath = occ.targetPath;
    editionLabel = occ.editionLabel;
    await recoverInterruptedCommit(targetPath, librarySettings.path, log);
  }

  // Reuse the audio-only copier: directories drop foreign files, audio files work, and non-audio files fail.
  const sourceStats = await stat(item.path);
  log.info({ source: item.path, target: targetPath, mode }, 'Copying files to library');
  await stageSourceAudio({ sourcePath: item.path, targetPath, sourceStats, log, onProgress });

  const sourceSize = await getAudioPathSize(item.path);
  const targetSize = await getAudioPathSize(targetPath);
  log.debug({ source: item.path, sourceSize, targetSize, ratio: sourceSize > 0 ? (targetSize / sourceSize).toFixed(4) : 'N/A' }, 'Copy verification');
  assertCopyVerified(sourceSize, targetSize);

  if (mode === 'move') {
    await cleanupSourceManagedFilesNonfatal(item.path, librarySettings.path, log, SINGLE_SOURCE_CLEANUP);
  }

  return { targetPath, ...(editionLabel !== undefined && { editionLabel }) };
}

// Flatten all disc members and verify against their aggregate source bytes.
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
  naming?: AttachNaming,
): Promise<{ targetPath: string; editionLabel?: string }> {
  const { log } = deps;
  let targetPath = baseTargetPath;
  let editionLabel: string | undefined;
  log.info({ source: item.path, discMembers: memberPaths.length, target: targetPath, mode }, 'Flattening multi-disc group to library');

  // Preserve the single-source path's pre-occupancy recovery ordering.
  await recoverInterruptedCommit(targetPath, libraryRoot, log);

  // Disc groups use the same collision fence as single-source imports.
  if (await getTargetAudioSize(targetPath) > 0) {
    const { candidate, productionType } = resolveCollisionIdentity(item, meta, naming);
    const occ = await resolveOccupiedTarget(targetPath, candidate, productionType, deps, rebuild);
    if (!occ.swap) {
      log.info({ source: item.path, base: targetPath, disambiguated: occ.targetPath, editionLabel: occ.editionLabel }, 'Different recording on occupied disc-group target — copying into a disambiguated folder (keep-both)');
      targetPath = occ.targetPath;
      editionLabel = occ.editionLabel;
      await recoverInterruptedCommit(targetPath, libraryRoot, log);
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
      // Per-member cleanup is nonfatal after commit, so one bad disc cannot skip the rest.
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
    for (const memberPath of memberPaths) {
      await cleanupSourceManagedFilesNonfatal(memberPath, libraryRoot, log, DISC_SOURCE_CLEANUP);
    }
    log.info({ discMembers: memberPaths.length }, 'Source disc folders cleaned after move (foreign files preserved)');
  }

  return { targetPath, ...(editionLabel !== undefined && { editionLabel }) };
}

