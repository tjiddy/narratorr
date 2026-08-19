import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Db } from '@db/index.js';
import { books } from '@db/schema.js';
import { isCompanionEbookExposed } from '@shared/companion-ebook-exposure.js';
import { v1PublicIdParamSchema, type V1PublicIdParam } from '@shared/schemas/v1/common.js';
import type { BookService } from '../../services/book.service.js';
import type { SettingsService } from '../../services/settings.service.js';
import { findCompanionEbook } from '../../services/companion-ebook.repository.js';
import { evaluateCompanionEbookGate } from '../../services/companion-ebook-gate.js';
import { openCompanionEbook } from '../../services/companion-ebook-open.js';
import { resolveByPublicId } from '../../utils/public-id.js';
import { BoundedSemaphore } from '@core/utils/bounded-semaphore.js';
import { streamCompanionEbook } from '../../utils/companion-ebook-stream.js';
import { triggerCompanionReconcile, type CompanionBookReconcileTrigger } from '../../services/companion-ebook-trigger.js';
import { v1ErrorHandler } from './_helpers.js';

export interface V1CompanionEbookRouteDeps {
  bookService: BookService;
  settingsService: SettingsService;
  // Required self-healing hook for stale observations; triggering remains fire-and-forget.
  reconciler: CompanionBookReconcileTrigger;
  // Test seam; production omits it and uses MAX_CONCURRENT_COMPANION_STREAMS.
  maxConcurrentStreams?: number;
}

// Fixed EMFILE/bandwidth guard; saturation status is part of the public contract.
export const MAX_CONCURRENT_COMPANION_STREAMS = 4;

// Static bodies prevent filesystem-path leaks by construction.
// Lowercase companion_epub_* codes are a frozen consumer contract; do not normalize them.
const DISABLED_BODY = {
  error: { code: 'companion_epub_disabled', message: 'Companion ebooks are disabled' },
} as const;

// Collapse every book/file negative to one 404 to avoid an existence oracle.
const UNAVAILABLE_BODY = {
  error: { code: 'companion_epub_unavailable', message: 'Companion ebook is unavailable' },
} as const;

const BUSY_BODY = {
  error: { code: 'companion_epub_busy', message: 'Too many concurrent companion ebook downloads' },
} as const;

function unavailable(reply: FastifyReply): FastifyReply {
  return reply.status(404).send(UNAVAILABLE_BODY);
}

// Clamp the test seam: fractions over-admit and NaN makes BoundedSemaphore reject every acquisition.
function resolveStreamLimit(supplied: number | undefined): number {
  if (supplied === undefined || !Number.isFinite(supplied)) return MAX_CONCURRENT_COMPANION_STREAMS;
  return Math.max(1, Math.trunc(supplied));
}

// Encapsulate v1ErrorHandler so it cannot leak onto internal /api routes.
// Authentication comes from the global /api/v* hook; this path must stay out of BASE_PUBLIC_ROUTES.
// Do not add response schemas/type providers: Zod reply serialization cannot represent the raw stream.
// The shared params schema rejects whitespace as 400 before identity resolution.
export async function v1CompanionEbookRoutes(
  app: FastifyInstance,
  deps: V1CompanionEbookRouteDeps,
  db: Db,
): Promise<void> {
  // Per registration: module-global state would leak saturation across app instances.
  const semaphore = new BoundedSemaphore(resolveStreamLimit(deps.maxConcurrentStreams));

  await app.register(
    async (v1) => {
      v1.setErrorHandler(v1ErrorHandler);

      v1.get<{ Params: V1PublicIdParam }>(
        '/books/:publicId/companion-epub',
        { schema: { params: v1PublicIdParamSchema } },
        async (request, reply) => {
          const { publicId } = request.params;

          // Keep identity resolution lazy so the feature flag precedes every book-existence read.
          // fetchByPublicId would emit the generic NOT_FOUND envelope, violating this route's contract.
          // Advertisement exposure rejects DRM; file containment/open remains authoritative.
          // Complete all gate/library reads before acquiring, or a rejected read can strand a slot.
          // Gate read failures reach v1ErrorHandler as 500 because no degraded file response exists.
          const gated = await evaluateCompanionEbookGate({
            settingsService: deps.settingsService,
            bookService: deps.bookService,
            resolveBookId: () => resolveByPublicId(db, books, publicId),
            findObservation: (id) => findCompanionEbook(db, id),
            isExposed: isCompanionEbookExposed,
          });

          if ('rejection' in gated) {
            // Only disabled is distinct; every book-shaped rejection uses the oracle-safe 404.
            if (gated.rejection === 'disabled') return reply.status(409).send(DISABLED_BODY);
            return unavailable(reply);
          }

          const { bookId, bookPath, filename, libraryRoot } = gated.context;

          // Never queue saturated streams; tryAcquire's single-use releaser tolerates close/error races.
          const releaseSlot = semaphore.tryAcquire();
          if (!releaseSlot) return reply.status(503).send(BUSY_BODY);

          // Register before open: a disconnect during await would otherwise fire before teardown attaches and leak the slot.
          reply.raw.once('close', releaseSlot);

          // open absorbs errno into outcomes. Do not finally-release: handler completion precedes stream teardown.
          const opened = await openCompanionEbook(
            { bookId, bookPath, filename, libraryRoot },
            request.log,
          );
          if (opened.outcome !== 'ok') {
            releaseSlot();
            // Fire-and-forget stale-observation repair stays here, outside open's non-reentrant book lock.
            triggerCompanionReconcile(deps.reconciler, bookId, request.log, 'Companion ebook reconcile failed after a read-path mismatch');
            // API-key-reachable logs must remain limited to numeric bookId and outcome.
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
