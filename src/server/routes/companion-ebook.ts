import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Db } from '@db/index.js';
import { idParamSchema } from '@shared/schemas/common.js';
import { isCompanionEbookOwnerReadable } from '@shared/companion-ebook-exposure.js';
import type { CompanionEbookStatus } from '@shared/schemas/companion-ebook.js';
// Deep path, never a `core/index.js` barrel — the same rule `companion-ebook-observe.ts` follows.
import { inspectEpub } from '@core/epub/validate.js';
import type { EpubInspection } from '@core/epub/result.js';
import type { BookService, SettingsService } from '../services/index.js';
import { findCompanionEbook } from '../services/companion-ebook.repository.js';
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
  /** #1976 — the selection `PUT` delegates the whole mutation to the reconciler. */
  reconciler: CompanionEbookReconciler;
}

/**
 * The selection `PUT` body (#1976 AC18). `.strict()` so an extra key is a `400` from the
 * schema, before the handler runs — and the route accepts NO filename and NO path on any
 * field. The index is 0-based, matching what `/state` issues.
 */
const selectionBodySchema = z.object({ index: z.number().int().min(0) }).strict();

type SelectionBody = z.infer<typeof selectionBodySchema>;

/** The one inspection arm that carries a payload; the other two are pure verdicts. */
type EpubInspectionAvailable = Extract<EpubInspection, { status: 'available' }>;

/** The `/state` payload (#1974 AC24). The route encodes NO rendering policy — §7 decides
 *  which fields each state displays, and duplicating that judgement here is how the two drift. */
export interface CompanionEbookStateResponse {
  status: CompanionEbookStatus;
  filename: string | null;
  sizeBytes: number | null;
  validationCode: string | null;
  candidateCount: number;
  selectedFilename: string | null;
  candidates: Array<{ index: number; filename: string }>;
}

/** The owner-route body convention — NOT the v1 `{ error: { code, message } }` envelope. */
function notFound(reply: FastifyReply): FastifyReply {
  return reply.status(404).send({ error: 'Companion ebook not found' });
}

function featureDisabled(reply: FastifyReply): FastifyReply {
  return reply.status(409).send({ error: 'Companion ebooks are disabled' });
}

/**
 * The route-boundary log record (#1974 AC7, second half): `{ bookId, outcome }` and nothing
 * else — no path, no filename, no library root. Not because these routes are key-reachable
 * (they are not; the API key authenticates `/api/v*` only), but because these are the records
 * that survive at default log level and get pasted into bug reports — and #1975 reuses the
 * same helper behind a genuinely key-reachable route, so the boundary has to already hold.
 */
function logOutcome(request: FastifyRequest, bookId: number, outcome: string, message: string): void {
  request.log.warn({ bookId, outcome }, message);
}

/**
 * Self-healing when a read path cannot serve the file (#1960 AC26–AC29). In a watcherless
 * design this request IS the only signal that the stored observation may be stale, so it
 * enqueues a reconcile for that book before returning its error.
 *
 * **Not strictly a stored/live MISMATCH since #2038**, which is why the name and this docstring
 * say "read unavailable" instead. A stored `drm_protected` row now passes the owner gate, so a
 * genuinely DRM'd file reaches the inspection term and re-enqueues here while the stored row and
 * the live file AGREE. The re-observation is still the right response — it is what confirms the
 * verdict is current, and it is the only way a stale DRM verdict on a since-replaced file gets
 * corrected — but nothing here may be read as "the two disagreed".
 *
 * **Sited at the CALLERS, never inside `resolveCompanionEbookPath` / `openCompanionEbook`
 * (AC29).** `CompanionEbookReconciler` calls the resolver itself from inside
 * `withBookAdmissionLock`, which is non-reentrant — a hook in the shared helper would re-enter
 * the reconciler from within its own lock.
 *
 * Fire-and-forget and never awaited, so HTTP behaviour is byte-identical: same status, same
 * body, same latency, and a rejecting reconciler cannot turn a 404 into a 500 (AC28).
 *
 * **Accepted characteristic (AC31):** every such request enqueues its OWN book run —
 * `reconcileBook` registers a fresh run per call and `withBookAdmissionLock` only SERIALIZES
 * those runs; nothing merges them. Only `reconcileAll()` coalesces and it is not on this path.
 * The taxonomy is two buckets. Cases that write a status this gate does NOT admit self-limit
 * (the owner gate closes before the next request reaches the opener); the ones that skip, retain,
 * or write a status the gate DOES admit re-enqueue on every request, bounded by one eligibility
 * probe each — zero filesystem calls when containment rejects lexically, one `stat` when the
 * directory probe rejects, and a bounded `readdir` only for books that are actually eligible.
 *
 * `drm_protected` moved buckets in #2038: a stored-DRM row over a genuinely DRM'd file used to
 * self-limit and now sits in the second bucket, re-enqueueing per read-route request under the
 * same bound. The shipped panel drives this since #2022 — it fetches `/metadata` while the
 * `/state` value it renders is `available`, so a request it started can reach the gate after a
 * commit to `drm_protected` and take that branch. Reachable, transient, and accepted: the
 * request enqueues one reconcile and the panel stops initiating once `/state` catches up.
 */
function enqueueReadUnavailableReconcile(deps: CompanionEbookRouteDeps, bookId: number, request: FastifyRequest): void {
  triggerCompanionReconcile(deps.reconciler, bookId, request.log, 'Companion ebook reconcile failed after an unavailable read');
}

/** Project a stored row (or the absence of one) as the display-only payload — no `readdir`. */
function projectStoredState(row: CompanionEbookRow | null): CompanionEbookStateResponse {
  if (!row) {
    // AC27: an eligible book that has never been reconciled is indistinguishable from one
    // observed as empty, and both are §7's `unavailable` panel. `none` is not an error.
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

/**
 * The stored-`ambiguous` branch (#1974 AC25/AC26): discovery is the SOLE authority for
 * `status`, `candidateCount`, and `candidates`. This is the one status whose payload drives an
 * action, so it cannot be served from a cache that may have drifted.
 */
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

  // Total over the live count N. `filename`/`sizeBytes`/`validationCode`/`selectedFilename`
  // are null throughout — `ck_companion_ebooks_file_absent` already guarantees it for a stored
  // `ambiguous` row. N = 1 is deliberately NOT widened back to the storage CHECK's
  // `candidateCount >= 2`: this is a view, not a row, and the live listing legitimately shrank.
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

// ---------------------------------------------------------------------------
// The owner-readable gate, and the two owner READS (#1976 AC4-AC17)
// ---------------------------------------------------------------------------

/** Everything a companion file needs to be opened, once the row is known owner-readable. */
interface ExposedCompanionContext {
  bookPath: string;
  filename: string;
  libraryRoot: string;
}

/**
 * **The** owner-readable decision, at one site (PR #2010 F2).
 *
 * `companionEpub.enabled` false → `409` · `bookService.getById` null → `404` ·
 * `isCompanionEbookOwnerReadable` false → `404` · `observation.filename` null → `404` ·
 * blank `books.path` → `404`. Then the library root, which every opener needs.
 *
 * **The owner gate, not the advertisement gate (#2038).** `isCompanionEbookOwnerReadable` admits
 * a stored `drm_protected` row as well as an `available` one; `isCompanionEbookExposed` — which
 * this module no longer calls at all — keeps `available` only for the public producers and the
 * public stream, because a DRM'd EPUB genuinely fails Kindle conversion. Serving the owner their
 * own bytes removes no DRM, and the classifier has been wrong about a real book, so the block
 * only ever converted a misclassification into denied access. The live term is unaffected: a
 * genuinely encrypted file still fails `inspectEpub` on both read routes below.
 *
 * All three companion-file routes run this and only this: download applies
 * `openCompanionEbook` to the result, metadata and cover apply the resolver plus
 * `inspectEpub`. AC5's *"mirrors the shipped download route term for term"* is satisfied by
 * construction here rather than by two copies staying in agreement — the ladder is literally
 * the same code, so a later change to the exposure terms or the blank-path check cannot make
 * download and the reads disagree about whether the same row is owner-readable.
 *
 * `isCompanionEbookEligible` is deliberately NOT called: its filesystem term is a `stat` of
 * the book DIRECTORY, and the opener's containment check on the FILE is the authority. That is
 * a decision, not an oversight. Neither gate is ever re-spelled inline — re-deriving
 * `enabled && imported && <status set>` is the exact drift they exist to prevent, and with two
 * of them an inline copy would also silently pick a status set.
 */
async function loadExposedCompanionContext(
  deps: CompanionEbookRouteDeps,
  db: Db,
  reply: FastifyReply,
  id: number,
): Promise<{ context: ExposedCompanionContext } | { reply: FastifyReply }> {
  const { enabled } = await deps.settingsService.get('companionEpub');
  if (!enabled) return { reply: featureDisabled(reply) };

  const book = await deps.bookService.getById(id);
  if (!book) return { reply: notFound(reply) };

  const observation = await findCompanionEbook(db, id);
  if (!isCompanionEbookOwnerReadable({ enabled, bookStatus: book.status, observationStatus: observation?.status })) {
    return { reply: notFound(reply) };
  }
  // Both narrow nullable columns that `ck_companion_ebooks_file_present` already makes non-null
  // for every status this gate admits — it covers `available`, `invalid`, and `drm_protected`
  // (`src/db/schema.ts`), so the DRM row #2038 added is as non-null as the `available` one.
  // Unreachable in practice, expressible in the type.
  const filename = observation?.filename;
  if (!filename) return { reply: notFound(reply) };
  if (!book.path || book.path.trim() === '') return { reply: notFound(reply) };

  const { path: libraryRoot } = await deps.settingsService.get('library');
  return { context: { bookPath: book.path, filename, libraryRoot } };
}

/**
 * The shared prefix both read routes run: the owner-readable gate above, then the §5 resolver,
 * then one `inspectEpub`.
 *
 * Returns the available inspection **and the stored basename that gated it**, or the `reply` it
 * already sent. Every negative is a `404` except the feature gate's `409`, and every one of them
 * is logged through `logOutcome` — so the boundary record stays `{ bookId, outcome }` and nothing
 * else, whatever the cause.
 *
 * The `filename` comes straight back out of `loadExposedCompanionContext`, so exactly ONE
 * filename value exists per request (#2022 AC3). `/metadata` emits it; `/cover` ignores it. It
 * is never re-derived from `resolved.path` and never `basename()`d — a second derivation site is
 * what would let the emitted name drift from the row the gate actually read.
 *
 * **`resolveCompanionEbookPath`, not `openCompanionEbook`**: `inspectEpub` opens the archive by
 * pathname itself, so taking a descriptor solely to close it before that re-open buys nothing
 * (AC3). The route never builds `join(bookPath, filename)` — a second path-construction site
 * is exactly what can drift from the verified one.
 *
 * **One full inspection per HTTP attempt is accepted.** `inspectEpub` is documented as *"one
 * call is one open is one budget"*, so every request that reaches here opens the archive again.
 * That is the design's stated cost model, bounded by `MAX_ARCHIVE_BYTES` and
 * `MAX_INSPECTION_BYTES`; there is no response cache and no combined route. The shipped panel
 * fetches `/metadata` only — it never requests `/cover` — so a book page pays for one inspection
 * per metadata attempt, not two.
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
    // NOT a 500. `inspectEpub` propagates filesystem failures by design — `preOpenRejection`'s
    // `lstat` has no catch and optional TOC/cover read errors propagate — so a file that
    // vanishes or faults between the resolver and the inspection arrives here. Without this
    // catch it would reach the global handler's `request.log.error(error, …)`, whose raw error
    // message and stack embed the library path. The resolver already proved regular-file and
    // containment, so anything arriving here is transient, and §4's accepted answer for the
    // stale window is a clean 404.
    logOutcome(request, id, 'inspect_failed', 'Companion ebook inspection failed');
    enqueueReadUnavailableReconcile(deps, id, request);
    // Logged ONCE at debug, in the established helper shape, so the failure stays diagnosable
    // under `LOG_LEVEL=debug` while the default-level boundary record stays path-free.
    // `serializeError` is mandatory — `narratorr/no-raw-error-logging` traces catch bindings.
    request.log.debug(
      { bookId: id, path: resolved.path, error: serializeError(error) },
      'Companion ebook inspection threw',
    );
    return { reply: notFound(reply) };
  }

  if (inspection.status !== 'available') {
    // The live file cannot be served, whatever the stored row says — the §4 stale-window
    // outcome, not an error class of its own.
    //
    // Two shapes reach here, and only the first is a disagreement (#2038). A stored `available`
    // row over a file that has since gone bad is the original case. A stored `drm_protected` row
    // over a genuinely DRM'd file is the case the owner gate now admits: the row and the live
    // file AGREE, and the request still 404s — because the read routes serve DECRYPTED content
    // (parsed metadata, extracted cover bytes) and there is none to serve. The download route
    // has no such term and streams the file, which is the whole point of the split.
    logOutcome(request, id, inspection.status, 'Companion ebook inspection did not yield a readable file');
    enqueueReadUnavailableReconcile(deps, id, request);
    return { reply: notFound(reply) };
  }

  return { inspection, filename };
}

/**
 * `GET /api/books/:id/companion-epub/metadata` — the stored basename this request read, plus
 * OPF title/author/language and a plain-text table of contents. Feeds the `available` panel's
 * chapter count.
 *
 * The payload is THREE parts — `filename`, `metadata`, `toc`. The three metadata fields and the
 * two TOC fields are surfaced exactly as `EpubMetadata` and `EpubTocEntry` declare them —
 * nothing renamed, defaulted, or coalesced — and `filename` is the stored basename the gate
 * resolved, described below.
 *
 * **`filename` is the STORED basename the gate resolved** (#2022) — the value
 * `loadExposedCompanionContext` read off the `companion_ebooks` row, handed through
 * `loadCompanionInspection`, never re-derived from the resolved path. It is what lets the panel
 * discard a response that does not describe the `/state` row rendered beside it: the two routes
 * read that row independently and a reconcile can commit between them, so without the route
 * declaring what it read, one file's size renders beside another file's chapter count with both
 * requests succeeding. It is the same value `/state` already ships to the same authenticated
 * owner, so no new information class reaches the wire.
 *
 * **No `chapterCount` field**, deliberately: the panel derives the count from `toc.length`. A
 * second field computed from the array beside it in the same payload is a drift seam for no
 * gain, and `toc: null` — an unreadable NCX/nav, or one that lost the shared inspection budget
 * to nothing left — is not `0` chapters and must not be reported as one.
 *
 * No EPUB HTML is rendered here, so there is no sanitiser, no iframe, and no CSP question.
 */
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

/**
 * `GET /api/books/:id/companion-epub/cover` — the validated embedded cover.
 *
 * `Content-Type` is `EpubCover.mediaType`, the BYTE-SNIFFED value; the manifest's declared
 * `media-type` is never read here. The four literals `result.ts` names are the only values
 * emittable, so `image/svg+xml` is unreachable by construction rather than by a route check.
 *
 * `Cache-Control` is `private, no-store` — deliberately NOT the `public, max-age=86400` that
 * `routes/book-files.ts` uses for `/api/books/:id/cover`. These bytes are library content
 * behind owner auth and change whenever the file does. The asymmetry is intentional; do not
 * "fix" it later.
 *
 * `Content-Disposition` is `inline`: it renders in an `<img>`, and `attachment` is the download
 * route's disposition. No `X-Content-Type-Options` is set here — `@fastify/helmet` applies
 * `nosniff` globally.
 */
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
  // `null` covers every discovery and read failure `extract.ts` documents: no declared cover, a
  // `content` naming no manifest item, a read over `MAX_EPUB_COVER_BYTES`, a budget-exhausted
  // skip, and bytes whose signature matched none of the four accepted formats.
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

// ---------------------------------------------------------------------------
// The selection PUT (#1976 AC18-AC21, AC31-AC34)
// ---------------------------------------------------------------------------

function selectionUnavailable(reply: FastifyReply): FastifyReply {
  return reply.status(503).send({ error: 'Companion ebook selection could not be completed' });
}

type SelectionFailure = Exclude<CompanionSelectionResult, { outcome: 'selected' }>['outcome'];

/**
 * AC31's map, total over the eleven non-2xx outcomes — `Record<SelectionFailure, …>` means a
 * new outcome that is not mapped fails typecheck rather than falling through to a default.
 *
 * `disabled` and `conflicted` share a status but not a body: the first reuses the route's own
 * disabled sentence, so a feature flip mid-request reads identically to one caught a moment
 * earlier at the gate. Every body is the owner-route flat `{ error: '<sentence>' }` convention
 * — NOT the v1 `{ error: { code, message } }` envelope — and none carries a path, a filename,
 * or the library root.
 */
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
 * `PUT /api/books/:id/companion-epub/selection` — the `ambiguous` picker.
 *
 * The route's own gate is exactly TWO terms: feature disabled → `409`, unknown book → `404`.
 * It then delegates to `selectCompanionEbook`, which re-reads both settings itself because it
 * — not the route — owns the inputs `isCompanionEbookEligible` and the resolver require. The
 * route gate is a cheap early-out, not the authority.
 *
 * **Neither exposure gate is deliberately consulted.** An `ambiguous` row is by definition
 * neither `available` nor `drm_protected`, so both `isCompanionEbookExposed` and
 * `isCompanionEbookOwnerReadable` are false for every row this route exists to act on; a handler
 * copied from the read ladder would make the picker permanently 404. Widening the owner gate in
 * #2038 did not change that — `ambiguous` is outside both status sets. Eligibility is evaluated
 * once, inside the lock, never here.
 *
 * CSRF is ambient: `enforceCsrf` requires `X-Requested-With: XMLHttpRequest` on every non-safe
 * method and `fetchApi` already sends it, so there is no per-route CSRF wiring.
 *
 * Index drift between the `GET /state` that issued the index and this `PUT` is ACCEPTED — no
 * precondition token, no ETag, no nonce. The owner may pick the wrong candidate once and
 * re-pick.
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

  // The row the commit transaction returned, rendered by the SAME projector `GET /state` uses,
  // so the two cannot render differently for the same row and the panel needs no follow-up
  // fetch. This payload carries `filename` and `selectedFilename` deliberately — they are
  // stored basenames the owner already sees on `/state`, and the leak rule that governs the
  // error bodies does not apply to it. A success emits no boundary record, matching the
  // shipped routes, which log only on negatives.
  return reply.status(200).send(projectStoredState(result.row));
}

// ---------------------------------------------------------------------------
// The forced-refresh POST (#2034 AC9-AC14)
// ---------------------------------------------------------------------------

/**
 * `POST /api/books/:id/companion-epub/refresh` — re-judge this book's companion ebook NOW.
 *
 * **Why a panel-local endpoint rather than only Refresh & Scan.** Both force, but the full
 * refresh ffprobes every audio file in the book (58 of them, for the case that prompted this) to
 * re-check a 1 MB epub. This one touches nothing but the companion observation.
 *
 * The gate is exactly the TWO terms `handleCompanionEpubSelection` opens with: feature disabled →
 * `409`, unknown book → `404`. `isCompanionEbookEligible` is deliberately NOT called — the
 * reconciler re-evaluates it inside the admission lock, which is the authority; a second answer
 * here would cost a `stat` and could already have drifted by the time the lock is taken.
 * Neither exposure gate is consulted either, and for a different reason than the selection `PUT`'s:
 * this endpoint is status-AGNOSTIC. The panel renders its re-check control in every state, so it
 * must be able to re-judge any current verdict — `available` included, which is the false-DRM
 * incident in reverse.
 *
 * `202`, not `200`: the reconcile is fire-and-forget and never awaited, so the response says
 * "accepted", not "done". There is deliberately no completion token — a client learns the outcome
 * by re-reading `GET /api/books/:id/companion-epub/state`. The repo's other 202s hand back a
 * `{ jobId }`; this one has no job identity to give, so `{ status: 'queued' }` keeps the body
 * non-empty without inventing a token the client cannot spend.
 *
 * CSRF is ambient: `enforceCsrf` requires `X-Requested-With: XMLHttpRequest` on every non-safe
 * method and `fetchApi` already sends it, so there is no per-route CSRF wiring — and this route is
 * not added to `BASE_PUBLIC_ROUTES`, so the `/api/*` `onRequest` hook authenticates it.
 */
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

  // FORCED — the reason this route exists. Never awaited, and `triggerCompanionReconcile` absorbs
  // both a rejection and a synchronous throw, so the status, the body, and the latency below are
  // all independent of the reconcile (fire-and-forget-preflight).
  triggerCompanionReconcile(
    deps.reconciler,
    id,
    request.log,
    'Companion ebook forced reconcile failed after an owner refresh',
    true,
  );

  return reply.status(202).send({ status: 'queued' });
}

/**
 * Owner-facing companion-ebook routes (#1974, plan §5 and §7) — the download and the one
 * owner observation read.
 *
 * Its **own** route module, not `routes/books.ts` (measured 360 of its 400 permitted lines).
 * #1975 and #1976 extend this module; #1976 will add its own service dependency to the deps
 * object when it lands the selection `PUT`.
 *
 * **Authorization is ambient.** `src/server/plugins/auth.ts` authenticates every `/api/*` path
 * outside `BASE_PUBLIC_ROUTES` in an `onRequest` hook, so neither route wires auth and neither
 * is added to that list. Both are `GET`, so `enforceCsrf` short-circuits on them.
 */
export async function companionEbookRoutes(
  app: FastifyInstance,
  deps: CompanionEbookRouteDeps,
  db: Db,
): Promise<void> {
  /**
   * `GET /api/books/:id/companion-epub` — owner download.
   *
   * The gate is `loadExposedCompanionContext` — the SAME code metadata and cover run, not a
   * mirror of it (PR #2010 F2). Only the tail differs: this route opens a descriptor and
   * streams it, where the reads resolve a path and inspect it.
   */
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

  /**
   * `GET /api/books/:id/companion-epub/state` — the one owner read.
   *
   * A `404` is the panel's "this feature does not apply here" signal (§7's *"the section is
   * simply absent"*), which is why no `ineligible` state exists in the payload.
   *
   * Exactly one authority per response, decided by the STORED status: the four display-only
   * statuses are projected from the row with no `readdir` at all, and only `ambiguous` — the
   * one status that drives an action — is served live.
   */
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
        // Eligibility already proved the path is a non-blank directory inside the root.
        return resolveAmbiguousState(id, book.path!, request, reply);
      }

      return reply.status(200).send(projectStoredState(row));
    },
  );

  /**
   * The three #1976 routes. Each handler is a MODULE-LEVEL named function, deliberately:
   * written inline they would push this factory near or past its 150-line cap, which is the
   * binding limit here rather than the file's 400.
   *
   * All three declare `params` only and NO `response` map — these handlers `reply.status(…)
   * .send(…)` inline for four different statuses, and declaring a success schema would make
   * every one of those fail typecheck under the zod type provider
   * (zod-type-provider-send-union-narrowing).
   *
   * Auth is ambient via the `/api/*` `onRequest` hook; none of the three is added to
   * `BASE_PUBLIC_ROUTES`.
   */
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

  /**
   * #2034 — the forced refresh. `params` only: it takes no body, and no `response` map for the
   * same reason the three #1976 routes declare none (zod-type-provider-send-union-narrowing).
   *
   * No `routeRegistry` entry, no `src/server/routes/index.ts` change, and no v1 OpenAPI surface —
   * this is an owner route and it uses the `reconciler` dep this module already receives.
   */
  app.post<{ Params: IdParam }>(
    '/api/books/:id/companion-epub/refresh',
    { schema: { params: idParamSchema } },
    async (request, reply) => handleCompanionEpubRefresh(deps, request, reply),
  );
}
