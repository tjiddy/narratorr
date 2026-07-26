import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { z } from 'zod';
import type { Db } from '../../db/index.js';
import { idParamSchema } from '../../shared/schemas/common.js';
import { isCompanionEbookExposed } from '../../shared/companion-ebook-exposure.js';
import type { CompanionEbookStatus } from '../../shared/schemas/companion-ebook.js';
import type { BookService, SettingsService } from '../services/index.js';
import { findCompanionEbook } from '../services/companion-ebook.repository.js';
import { isCompanionEbookEligible } from '../services/companion-ebook-eligibility.js';
import { findCompanionEbookCandidates } from '../services/companion-ebook-discovery.js';
import { openCompanionEbook, type CompanionOpenResult } from '../services/companion-ebook-open.js';
import type { CompanionEbookRow } from '../services/types.js';
import { serializeError } from '../utils/serialize-error.js';

type IdParam = z.infer<typeof idParamSchema>;

export interface CompanionEbookRouteDeps {
  bookService: BookService;
  settingsService: SettingsService;
}

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
 * Stream an open companion handle with exactly-once cleanup (#1974 AC18-AC22).
 *
 * The stream is created with **`autoClose: false`** and ONE idempotent application-owned
 * closer is wired to stream `end`, stream `error`, and response `close` (which covers a client
 * abort). Node 24 documents `autoClose: true` as the default for
 * `filehandle.createReadStream()`, so layering explicit close listeners on top of the default
 * is exactly how a double close appears; owning it here makes exactly-once a property of this
 * code rather than of a Node default that could change.
 */
function streamCompanionEbook(
  bookId: number,
  filename: string,
  opened: Extract<CompanionOpenResult, { outcome: 'ok' }>,
  request: FastifyRequest,
  reply: FastifyReply,
): FastifyReply {
  const stream = opened.handle.createReadStream({ autoClose: false });

  let closed = false;
  const closeHandle = (): void => {
    if (closed) return;
    closed = true;
    void opened.handle.close().catch((error: unknown) => {
      request.log.debug({ bookId, error: serializeError(error) }, 'Companion ebook handle close failed');
    });
  };

  stream.once('end', closeHandle);
  stream.once('error', (error: unknown) => {
    request.log.debug({ bookId, error: serializeError(error) }, 'Companion ebook stream error');
    logOutcome(request, bookId, 'stream_error', 'Companion ebook stream failed');
    if (!stream.destroyed) stream.destroy();
    closeHandle();
    // `error-handler.ts` ends in an unconditional `reply.status(500).send(...)` with no
    // `headersSent` check, so letting it run here would append a JSON body to a response that
    // already committed to `200` + `Content-Length` — a truncated body under a success status.
    // Contained locally: destroying the socket is the only honest signal left. Editing the
    // shared handler is out of scope (every route in the app is downstream of it).
    if (reply.raw.headersSent) reply.raw.socket?.destroy();
  });
  reply.raw.once('close', () => {
    if (!stream.destroyed) stream.destroy();
    closeHandle();
  });

  // The existing sanitize idiom (`routes/system.ts`), so a comma, a space, or a non-ASCII
  // character in the stored basename cannot break out of the quoted header value.
  const safeFilename = filename.replace(/[^a-zA-Z0-9._-]/g, '-');

  return reply
    .status(200)
    .header('Content-Type', 'application/epub+zip')
    // `fstat.size` from the OPEN handle, never `companion_ebooks.size_bytes` — the stored
    // value is a stale observation and a divergence would truncate or hang the response.
    .header('Content-Length', opened.sizeBytes)
    .header('Cache-Control', 'private, no-store')
    .header('Content-Disposition', `attachment; filename="${safeFilename}"`)
    .send(stream);
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
   * The gate is the SHARED `isCompanionEbookExposed` predicate plus a non-blank `books.path`;
   * re-deriving `enabled && imported && available` inline is the exact drift it exists to
   * prevent. `isCompanionEbookEligible` is deliberately NOT called: its filesystem term is a
   * `stat` of the book DIRECTORY, and the helper's containment check on the FILE is the
   * authority. That is a decision, not an oversight.
   */
  app.get<{ Params: IdParam }>(
    '/api/books/:id/companion-epub',
    { schema: { params: idParamSchema } },
    async (request, reply) => {
      const { id } = request.params;

      const { enabled } = await deps.settingsService.get('companionEpub');
      if (!enabled) return featureDisabled(reply);

      const book = await deps.bookService.getById(id);
      if (!book) return notFound(reply);

      const observation = await findCompanionEbook(db, id);
      if (!isCompanionEbookExposed({ enabled, bookStatus: book.status, observationStatus: observation?.status })) {
        return notFound(reply);
      }
      // Both narrow nullable columns that `ck_companion_ebooks_file_present` already makes
      // non-null for an `available` row — unreachable in practice, expressible in the type.
      const filename = observation?.filename;
      if (!filename) return notFound(reply);
      if (!book.path || book.path.trim() === '') return notFound(reply);

      const { path: libraryRoot } = await deps.settingsService.get('library');
      const opened = await openCompanionEbook(
        { bookId: id, bookPath: book.path, filename, libraryRoot },
        request.log,
      );
      if (opened.outcome !== 'ok') {
        logOutcome(request, id, opened.outcome, 'Companion ebook download unavailable');
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
        return await resolveAmbiguousState(id, book.path!, request, reply);
      }

      return reply.status(200).send(projectStoredState(row));
    },
  );
}
