import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Db } from '@db/index.js';
import { idParamSchema } from '@shared/schemas/common.js';
import { isCompanionEbookOwnerReadable } from '@shared/companion-ebook-exposure.js';
import type { CompanionEbookStatus } from '@shared/schemas/companion-ebook.js';
import { inspectEpub } from '@core/epub/validate.js';
import type { EpubInspection } from '@core/epub/result.js';
import type { BookService, SettingsService } from '../services/index.js';
import { findCompanionEbook } from '../services/companion-ebook.repository.js';
import { evaluateCompanionEbookGate } from '../services/companion-ebook-gate.js';
import { isCompanionEbookEligible } from '../services/companion-ebook-eligibility.js';
import { findCompanionEbookCandidates } from '../services/companion-ebook-discovery.js';
import { openCompanionEbook, resolveCompanionEbookPath } from '../services/companion-ebook-open.js';
import type {
  CompanionEbookReconciler,
  CompanionSelectionResult,
} from '../services/companion-ebook-reconciler.js';
import type { CompanionEbookRow } from '../services/types.js';
import { triggerCompanionReconcile } from '../services/companion-ebook-trigger.js';
import { serializeError } from '../utils/serialize-error.js';
import { streamCompanionEbook } from '../utils/companion-ebook-stream.js';

type IdParam = z.infer<typeof idParamSchema>;

export interface CompanionEbookRouteDeps {
  bookService: BookService;
  settingsService: SettingsService;
  reconciler: CompanionEbookReconciler;
}

// Strict and index-only: clients never submit a path or filename.
const selectionBodySchema = z.object({ index: z.number().int().min(0) }).strict();

type SelectionBody = z.infer<typeof selectionBodySchema>;

type EpubInspectionAvailable = Extract<EpubInspection, { status: 'available' }>;

export interface CompanionEbookStateResponse {
  status: CompanionEbookStatus;
  filename: string | null;
  sizeBytes: number | null;
  validationCode: string | null;
  candidateCount: number;
  selectedFilename: string | null;
  candidates: Array<{ index: number; filename: string }>;
}

function notFound(reply: FastifyReply): FastifyReply {
  return reply.status(404).send({ error: 'Companion ebook not found' });
}

function featureDisabled(reply: FastifyReply): FastifyReply {
  return reply.status(409).send({ error: 'Companion ebooks are disabled' });
}

// Default-level boundary logs must not expose filenames or library paths.
function logOutcome(request: FastifyRequest, bookId: number, outcome: string, message: string): void {
  request.log.warn({ bookId, outcome }, message);
}

// Keep this at route callers: the reconciler invokes the resolver under a non-reentrant lock.
// Each unavailable request intentionally queues its own fire-and-forget recheck.
function enqueueReadUnavailableReconcile(deps: CompanionEbookRouteDeps, bookId: number, request: FastifyRequest): void {
  triggerCompanionReconcile(deps.reconciler, bookId, request.log, 'Companion ebook reconcile failed after an unavailable read');
}

/** Project display-only state without filesystem reads. */
function projectStoredState(row: CompanionEbookRow | null): CompanionEbookStateResponse {
  if (!row) {
    return {
      status: 'none',
      filename: null,
      sizeBytes: null,
      validationCode: null,
      candidateCount: 0,
      selectedFilename: null,
      candidates: [],
    };
  }
  return {
    status: row.status,
    filename: row.filename,
    sizeBytes: row.sizeBytes,
    validationCode: row.validationCode,
    candidateCount: row.candidateCount,
    selectedFilename: row.selectedFilename,
    candidates: [],
  };
}

/** Ambiguous candidates are live because their indexes drive a user action. */
async function resolveAmbiguousState(
  bookId: number,
  bookPath: string,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<FastifyReply> {
  const result = await findCompanionEbookCandidates({ bookId, bookPath }, request.log);

  if (result.outcome === 'gone') {
    logOutcome(request, bookId, 'gone', 'Companion ebook candidate directory is gone');
    return notFound(reply);
  }
  if (result.outcome === 'undetermined') {
    logOutcome(request, bookId, 'undetermined', 'Companion ebook candidate listing was undetermined');
    return reply.status(503).send({ error: 'Companion ebook candidates could not be listed' });
  }

  // Live listings may shrink below the stored `ambiguous` invariant of two candidates.
  const candidates = result.candidates;
  return reply.status(200).send({
    status: candidates.length === 0 ? 'none' : 'ambiguous',
    filename: null,
    sizeBytes: null,
    validationCode: null,
    candidateCount: candidates.length,
    selectedFilename: null,
    candidates: candidates.map((filename, index) => ({ index, filename })),
  } satisfies CompanionEbookStateResponse);
}

interface ExposedCompanionContext {
  bookPath: string;
  filename: string;
  libraryRoot: string;
}

/**
 * Use the shared owner gate, which admits DRM-protected downloads unlike the public exposure gate.
 * File containment in open/resolve is authoritative; a directory eligibility probe here would be racy.
 */
async function loadExposedCompanionContext(
  deps: CompanionEbookRouteDeps,
  db: Db,
  reply: FastifyReply,
  id: number,
): Promise<{ context: ExposedCompanionContext } | { reply: FastifyReply }> {
  const gated = await evaluateCompanionEbookGate({
    settingsService: deps.settingsService,
    bookService: deps.bookService,
    resolveBookId: async () => id,
    findObservation: (bookId) => findCompanionEbook(db, bookId),
    isExposed: isCompanionEbookOwnerReadable,
  });

  if ('rejection' in gated) {
    return { reply: gated.rejection === 'disabled' ? featureDisabled(reply) : notFound(reply) };
  }

  const { bookPath, filename, libraryRoot } = gated.context;
  return { context: { bookPath, filename, libraryRoot } };
}

/**
 * Resolve rather than open because `inspectEpub` owns the file open. Return the stored filename
 * so independently fetched state and metadata can reject responses from different reconciles.
 */
async function loadCompanionInspection(
  deps: CompanionEbookRouteDeps,
  db: Db,
  request: FastifyRequest,
  reply: FastifyReply,
  id: number,
): Promise<{ inspection: EpubInspectionAvailable; filename: string } | { reply: FastifyReply }> {
  const gated = await loadExposedCompanionContext(deps, db, reply, id);
  if ('reply' in gated) return gated;
  const { bookPath, filename, libraryRoot } = gated.context;

  const resolved = await resolveCompanionEbookPath(
    { bookId: id, bookPath, filename, libraryRoot },
    request.log,
  );
  if (resolved.outcome !== 'ok') {
    logOutcome(request, id, resolved.outcome, 'Companion ebook read unavailable');
    enqueueReadUnavailableReconcile(deps, id, request);
    return { reply: notFound(reply) };
  }

  let inspection: EpubInspection;
  try {
    inspection = await inspectEpub(resolved.path);
  } catch (error: unknown) {
    // File removal can race resolution; collapse path-bearing inspection errors to a clean 404.
    logOutcome(request, id, 'inspect_failed', 'Companion ebook inspection failed');
    enqueueReadUnavailableReconcile(deps, id, request);
    request.log.debug(
      { bookId: id, path: resolved.path, error: serializeError(error) },
      'Companion ebook inspection threw',
    );
    return { reply: notFound(reply) };
  }

  if (inspection.status !== 'available') {
    // Owner downloads may stream DRM-protected bytes; metadata and cover require readable content.
    logOutcome(request, id, inspection.status, 'Companion ebook inspection did not yield a readable file');
    enqueueReadUnavailableReconcile(deps, id, request);
    return { reply: notFound(reply) };
  }

  return { inspection, filename };
}

/** Return the stored filename for response correlation; a null TOC must not become zero chapters. */
async function handleCompanionEpubMetadata(
  deps: CompanionEbookRouteDeps,
  db: Db,
  request: FastifyRequest<{ Params: IdParam }>,
  reply: FastifyReply,
): Promise<FastifyReply> {
  const { id } = request.params;
  const loaded = await loadCompanionInspection(deps, db, request, reply, id);
  if ('reply' in loaded) return loaded.reply;

  const { metadata, toc } = loaded.inspection;
  return reply
    .status(200)
    .header('Cache-Control', 'private, no-store')
    .send({ filename: loaded.filename, metadata, toc });
}

/** Use the byte-sniffed media type and no-store caching for mutable, authenticated library bytes. */
async function handleCompanionEpubCover(
  deps: CompanionEbookRouteDeps,
  db: Db,
  request: FastifyRequest<{ Params: IdParam }>,
  reply: FastifyReply,
): Promise<FastifyReply> {
  const { id } = request.params;
  const loaded = await loadCompanionInspection(deps, db, request, reply, id);
  if ('reply' in loaded) return loaded.reply;

  const { cover } = loaded.inspection;
  if (cover === null) {
    logOutcome(request, id, 'no_cover', 'Companion ebook has no readable embedded cover');
    return notFound(reply);
  }

  return reply
    .status(200)
    .header('Content-Type', cover.mediaType)
    .header('Content-Length', cover.bytes.length)
    .header('Content-Disposition', 'inline')
    .header('Cache-Control', 'private, no-store')
    .send(cover.bytes);
}

function selectionUnavailable(reply: FastifyReply): FastifyReply {
  return reply.status(503).send({ error: 'Companion ebook selection could not be completed' });
}

type SelectionFailure = Exclude<CompanionSelectionResult, { outcome: 'selected' }>['outcome'];

/** Total over every non-2xx outcome; owner-route bodies never carry a path or filename. */
const SELECTION_FAILURE_RESPONSES: Record<SelectionFailure, (reply: FastifyReply) => FastifyReply> = {
  out_of_range: (reply) => reply.status(400).send({ error: 'Candidate index is out of range' }),
  book_missing: notFound,
  ineligible: notFound,
  gone: notFound,
  unresolvable: notFound,
  disabled: featureDisabled,
  conflicted: (reply) =>
    reply.status(409).send({ error: 'Companion ebook selection conflicted with a concurrent change' }),
  undetermined: selectionUnavailable,
  retained: selectionUnavailable,
  stopped: selectionUnavailable,
  failed: selectionUnavailable,
};

/**
 * Do not apply an exposure gate: `ambiguous` is outside both exposure sets. Eligibility is
 * rechecked under the reconciler lock, and index drift is accepted without a precondition token.
 */
async function handleCompanionEpubSelection(
  deps: CompanionEbookRouteDeps,
  request: FastifyRequest<{ Params: IdParam; Body: SelectionBody }>,
  reply: FastifyReply,
): Promise<FastifyReply> {
  const { id } = request.params;

  const { enabled } = await deps.settingsService.get('companionEpub');
  if (!enabled) return featureDisabled(reply);

  const book = await deps.bookService.getById(id);
  if (!book) return notFound(reply);

  const result = await deps.reconciler.selectCompanionEbook(id, request.body.index);

  if (result.outcome !== 'selected') {
    logOutcome(request, id, result.outcome, 'Companion ebook selection unavailable');
    return SELECTION_FAILURE_RESPONSES[result.outcome](reply);
  }

  // Reuse the state projector so success describes the committed row without another read.
  return reply.status(200).send(projectStoredState(result.row));
}

/** Queue only a companion recheck; eligibility is decided under its lock and clients poll `/state`. */
async function handleCompanionEpubRefresh(
  deps: CompanionEbookRouteDeps,
  request: FastifyRequest<{ Params: IdParam }>,
  reply: FastifyReply,
): Promise<FastifyReply> {
  const { id } = request.params;

  const { enabled } = await deps.settingsService.get('companionEpub');
  if (!enabled) return featureDisabled(reply);

  const book = await deps.bookService.getById(id);
  if (!book) return notFound(reply);

  // The trigger absorbs synchronous throws and rejections so the accepted response stays fire-and-forget.
  triggerCompanionReconcile(
    deps.reconciler,
    id,
    request.log,
    'Companion ebook forced reconcile failed after an owner refresh',
    true,
  );

  return reply.status(202).send({ status: 'queued' });
}

export async function companionEbookRoutes(
  app: FastifyInstance,
  deps: CompanionEbookRouteDeps,
  db: Db,
): Promise<void> {
  // All owner reads share one gate; download opens a descriptor while metadata and cover inspect by path.
  app.get<{ Params: IdParam }>(
    '/api/books/:id/companion-epub',
    { schema: { params: idParamSchema } },
    async (request, reply) => {
      const { id } = request.params;

      const gated = await loadExposedCompanionContext(deps, db, reply, id);
      if ('reply' in gated) return gated.reply;
      const { bookPath, filename, libraryRoot } = gated.context;

      const opened = await openCompanionEbook(
        { bookId: id, bookPath, filename, libraryRoot },
        request.log,
      );
      if (opened.outcome !== 'ok') {
        logOutcome(request, id, opened.outcome, 'Companion ebook download unavailable');
        enqueueReadUnavailableReconcile(deps, id, request);
        return notFound(reply);
      }

      return streamCompanionEbook(id, filename, opened, request, reply);
    },
  );

  /** Display-only statuses come from the stored row; only ambiguous candidates are served live. */
  app.get<{ Params: IdParam }>(
    '/api/books/:id/companion-epub/state',
    { schema: { params: idParamSchema } },
    async (request, reply) => {
      const { id } = request.params;

      const { enabled } = await deps.settingsService.get('companionEpub');
      if (!enabled) return featureDisabled(reply);

      const book = await deps.bookService.getById(id);
      if (!book) return notFound(reply);

      const { path: libraryRoot } = await deps.settingsService.get('library');
      const eligible = await isCompanionEbookEligible(
        { enabled, book: { id, status: book.status, path: book.path }, libraryRoot },
        request.log,
      );
      if (!eligible) return notFound(reply);

      const row = await findCompanionEbook(db, id);
      if (row?.status === 'ambiguous') {
        return resolveAmbiguousState(id, book.path!, request, reply);
      }

      return reply.status(200).send(projectStoredState(row));
    },
  );

  // Response schemas are omitted because the zod provider cannot narrow these multi-status sends.
  app.get<{ Params: IdParam }>(
    '/api/books/:id/companion-epub/metadata',
    { schema: { params: idParamSchema } },
    async (request, reply) => handleCompanionEpubMetadata(deps, db, request, reply),
  );

  app.get<{ Params: IdParam }>(
    '/api/books/:id/companion-epub/cover',
    { schema: { params: idParamSchema } },
    async (request, reply) => handleCompanionEpubCover(deps, db, request, reply),
  );

  app.put<{ Params: IdParam; Body: SelectionBody }>(
    '/api/books/:id/companion-epub/selection',
    { schema: { params: idParamSchema, body: selectionBodySchema } },
    async (request, reply) => handleCompanionEpubSelection(deps, request, reply),
  );

  app.post<{ Params: IdParam }>(
    '/api/books/:id/companion-epub/refresh',
    { schema: { params: idParamSchema } },
    async (request, reply) => handleCompanionEpubRefresh(deps, request, reply),
  );
}
