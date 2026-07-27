import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Db } from '../../../db/index.js';
import { books } from '../../../db/schema.js';
import { isCompanionEbookExposed } from '../../../shared/companion-ebook-exposure.js';
import { v1PublicIdParamSchema, type V1PublicIdParam } from '../../../shared/schemas/v1/common.js';
import type { BookService } from '../../services/book.service.js';
import type { SettingsService } from '../../services/settings.service.js';
import { findCompanionEbook } from '../../services/companion-ebook.repository.js';
import { openCompanionEbook } from '../../services/companion-ebook-open.js';
import { resolveByPublicId } from '../../utils/public-id.js';
import { Semaphore } from '../../utils/semaphore.js';
import { streamCompanionEbook } from '../../utils/companion-ebook-stream.js';
import { v1ErrorHandler } from './_helpers.js';

// ============================================================================
// Public API v1 — the companion-ebook stream (#1975, plan §8)
// ============================================================================
//
// The ONE endpoint Narratorr Requests consumes for both "Download" and "Send to
// Kindle". It never accepts or returns a filesystem path, and it resolves the
// file through the shared `openCompanionEbook` helper rather than opening
// anything itself.

export interface V1CompanionEbookRouteDeps {
  bookService: BookService;
  settingsService: SettingsService;
  /**
   * TEST SEAM ONLY (#1975 AC18). Production wiring in `routes/index.ts` omits it, so the
   * effective bound is `MAX_CONCURRENT_COMPANION_STREAMS`. It exists so a test can drive
   * saturation with a limit of 1 instead of holding four real sockets open.
   */
  maxConcurrentStreams?: number;
}

/**
 * The default concurrent-stream bound. Deliberately a module constant rather than a setting:
 * this is an EMFILE/bandwidth guard, not a tunable policy, and a v1 consumer keys saturation
 * on the status code.
 */
export const MAX_CONCURRENT_COMPANION_STREAMS = 4;

// ----------------------------------------------------------------------------
// The three error bodies (#1975 AC9)
// ----------------------------------------------------------------------------
//
// Module-level constants — no interpolation, no template literal, no variable substring — so
// "never a filesystem path in an error body" holds BY CONSTRUCTION rather than by review.
//
// The lowercase `companion_epub_*` codes sit beside `v1ErrorHandler`'s uppercase
// `NOT_FOUND`/`BAD_REQUEST`/`INTERNAL_ERROR` (#1975 AC10). That asymmetry is the plan's FROZEN
// contract, not an oversight — the Requests consumer already branches on these literals. Do
// not "fix" the casing.

/** `409` — the feature is off. The owner route's existing literal, verbatim, so the two
 *  surfaces read identically (`routes/companion-ebook.ts`, `featureDisabled`). */
const DISABLED_BODY = {
  error: { code: 'companion_epub_disabled', message: 'Companion ebooks are disabled' },
} as const;

/**
 * `404` — EVERY other negative, without exception: no such book, book present but not
 * exposed, no observation, open failed. The route never distinguishes them, because that
 * distinction is precisely the existence oracle this endpoint must not become. It says
 * *unavailable*, not the owner route's *"not found"*: this status also covers a book that
 * exists but whose file failed the live open.
 */
const UNAVAILABLE_BODY = {
  error: { code: 'companion_epub_unavailable', message: 'Companion ebook is unavailable' },
} as const;

/** `503` — every stream slot is in use. */
const BUSY_BODY = {
  error: { code: 'companion_epub_busy', message: 'Too many concurrent companion ebook downloads' },
} as const;

function unavailable(reply: FastifyReply): FastifyReply {
  return reply.status(404).send(UNAVAILABLE_BODY);
}

/**
 * Resolve the effective concurrency bound from the optional test seam.
 *
 * The seam is CLAMPED, never validated (#1975 AC18): a rejected value would make the route a
 * silently dead endpoint answering `503` unconditionally, which is a worse failure than a
 * clamped one. `Semaphore` compares `active < max` directly and accepts any `number`, so a
 * fractional `1.5` would admit two streams and a `NaN` would reject every acquisition —
 * normalise to a finite integer BEFORE applying the floor so the effective capacity is
 * deterministic for any input the type permits.
 */
function resolveStreamLimit(supplied: number | undefined): number {
  if (supplied === undefined || !Number.isFinite(supplied)) return MAX_CONCURRENT_COMPANION_STREAMS;
  return Math.max(1, Math.trunc(supplied));
}

/**
 * Native public API v1 — the companion-ebook stream (#1975, plan §8). Registers
 * `GET /api/v1/books/:publicId/companion-epub` inside an ENCAPSULATED plugin so the v1-scoped
 * `v1ErrorHandler` (v1 error envelope) does not leak onto internal `/api/*` routes. Mirrors
 * `v1CapabilitiesRoutes`; `v1ActionsRoutes` already mounts `/books/:publicId/*` from a
 * separate plugin, so co-registration alongside `v1/books.ts` is proven.
 *
 * **Authorization is ambient.** The global `/api/v*` `onRequest` hook in
 * `src/server/plugins/auth.ts` authenticates this path — no per-route auth wiring, and the
 * path is NOT added to `BASE_PUBLIC_ROUTES`.
 *
 * **No `response` map, and no `withTypeProvider`.** `fastify-type-provider-zod` narrows
 * `reply.send()` to the union of the declared response schemas, so declaring the error
 * envelopes would make `reply.send(stream)` fail typecheck and declaring a `200` schema would
 * push the stream through the Zod serializer (`zod-type-provider-send-union-narrowing`). The
 * app-level `validatorCompiler` still validates the Zod `params` either way — the shipped
 * owner route solves it identically.
 *
 * The params validator is the SHARED `v1PublicIdParamSchema`, not a private copy (#1983 F2):
 * a malformed public id must fail identically on every v1 detail route, and a whitespace-only
 * id is a `400 BAD_REQUEST` from the validator rather than a `404` from the resolver.
 */
export async function v1CompanionEbookRoutes(
  app: FastifyInstance,
  deps: V1CompanionEbookRouteDeps,
  db: Db,
): Promise<void> {
  /**
   * PER REGISTRATION, never a module-level singleton (#1975 AC17) — a singleton would leak
   * saturation state across the many `createTestApp()` instances a suite builds, and across
   * any future multi-app composition.
   *
   * **The threat-model shift this bound answers.** `src/shared/schemas/v1/common.ts` scopes v1
   * rate limiting out of scope under a SINGLE-USER self-hosted model. This route is the first
   * to break that premise: it puts N family browsers behind ONE API key, each able to start a
   * multi-megabyte file stream. Bounded concurrency is the mechanism; `@fastify/rate-limit` is
   * deliberately NOT opted into here (per-key request-rate limiting stays out of scope). A
   * later reviewer should read the asymmetry as intentional, not as an unrelated bug.
   */
  const semaphore = new Semaphore(resolveStreamLimit(deps.maxConcurrentStreams));

  await app.register(
    async (v1) => {
      v1.setErrorHandler(v1ErrorHandler);

      v1.get<{ Params: V1PublicIdParam }>(
        '/books/:publicId/companion-epub',
        { schema: { params: v1PublicIdParamSchema } },
        async (request, reply) => {
          const { publicId } = request.params;

          // AC6 — the flag is read FIRST, before the publicId is resolved. When the feature
          // is off, NONE of the three book-existence reads runs (`resolveByPublicId`,
          // `bookService.getById`, `findCompanionEbook`), so a disabled server cannot be used
          // to probe whether a given publicId exists. `SettingsService.get` may itself hit the
          // `settings` table on a cold cache — "no DB read at all" is not satisfiable and is
          // not what the no-oracle property needs.
          //
          // AC11 — a REJECTION here propagates to `v1ErrorHandler`'s catch-all `500`. That is
          // deliberately unlike `v1/capabilities.ts` (fail-closed to `enabled: false`) and
          // `v1/books.ts`'s `loadCompanionContext` (degrade to `companionEbook: null`): both
          // of those guard an ADDITIVE ENRICHMENT of a read that already worked, whereas this
          // route's entire answer is the file. There is no degraded answer to give.
          const { enabled } = await deps.settingsService.get('companionEpub');
          if (!enabled) return reply.status(409).send(DISABLED_BODY);

          // `resolveByPublicId` directly, NOT `fetchByPublicId`: the latter throws
          // `V1NotFoundError`, which the handler maps to `404 { code: 'NOT_FOUND' }` — the
          // wrong code for this route's frozen contract.
          const bookId = await resolveByPublicId(db, books, publicId);
          if (bookId === null) return unavailable(reply);

          const book = await deps.bookService.getById(bookId);
          if (!book) return unavailable(reply);

          // The SHARED predicate. The three terms (`enabled && imported && available`) are
          // never re-spelled here — that drift is exactly what the helper exists to prevent.
          // `isCompanionEbookEligible` is deliberately NOT called: its filesystem term stats
          // the book DIRECTORY, while the open helper's containment check on the FILE is the
          // authority. Same decision as the owner download route.
          const observation = await findCompanionEbook(db, bookId);
          if (!isCompanionEbookExposed({
            enabled,
            bookStatus: book.status,
            observationStatus: observation?.status,
          })) {
            return unavailable(reply);
          }

          // Both narrow nullable columns that `ck_companion_ebooks_file_present` already makes
          // non-null for an `available` row — unreachable in practice, expressible in the type.
          const filename = observation?.filename;
          if (!filename) return unavailable(reply);
          if (!book.path || book.path.trim() === '') return unavailable(reply);

          // AC20 — the library read happens BEFORE the acquire. Ordered the other way, a
          // rejecting `get('library')` strands a slot permanently and the route answers `503`
          // forever after N rejections, repairable only by a restart. Hoisting the read
          // removes that failure window instead of guarding it with a `catch`, and reading the
          // root has no bearing on concurrency, so nothing is lost.
          const { path: libraryRoot } = await deps.settingsService.get('library');

          // `tryAcquire()`, never `acquire()` (AC19): saturation must answer immediately
          // rather than queue behind a multi-megabyte transfer.
          if (!semaphore.tryAcquire()) return reply.status(503).send(BUSY_BODY);

          /**
           * ONE idempotent releaser (AC21), mirroring `release()` in the stream helper.
           * `Semaphore.release()` decrements `active` unconditionally with NO FLOOR, so a
           * double release permanently raises the effective cap for the process — and the
           * teardown path can be reached by more than one signal (stream `error` plus response
           * `close`). The guard is what makes "exactly one slot back" true by construction.
           */
          let slotReleased = false;
          const releaseSlot = (): void => {
            if (slotReleased) return;
            slotReleased = true;
            semaphore.release();
          };

          // The ONLY statement inside the acquired window, and it is documented never to throw
          // — every errno is absorbed into its outcome union. It therefore needs no `try`.
          //
          // And it must NOT be wrapped in `try`/`finally`: a `finally` around
          // `streamCompanionEbook` releases the slot when the HANDLER returns, which is before
          // the stream has finished, so the bound would land on handler invocations rather
          // than on concurrent streams — the one thing the semaphore exists for. The release
          // rides the stream's teardown instead.
          const opened = await openCompanionEbook(
            { bookId, bookPath: book.path, filename, libraryRoot },
            request.log,
          );
          if (opened.outcome !== 'ok') {
            releaseSlot();
            // `{ bookId, outcome }` and nothing else — no path, no filename, no library root.
            // `bookId` is the numeric rowid, matching the owner route's boundary shape. These
            // records survive at default level and get pasted into bug reports, and unlike the
            // owner routes this one IS API-key reachable.
            request.log.warn({ bookId, outcome: opened.outcome }, 'Companion ebook download unavailable');
            return unavailable(reply);
          }

          return streamCompanionEbook(bookId, filename, opened, request, reply, {
            onTeardown: releaseSlot,
          });
        },
      );
    },
    { prefix: '/api/v1' },
  );
}
