import type { FastifyInstance } from 'fastify';
import { and, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import type { Db, DbOrTx } from '@db/index.js';
import { importJobs } from '@db/schema.js';
import { bookHoldsFile } from '@shared/book-holds-file.js';
import { isAttachableStatus } from '@shared/attach-eligibility.js';
import type { BookService } from '../services/book.service.js';
import type { BookImportService } from '../services/book-import.service.js';
import type { SettingsService } from '../services/settings.service.js';
import type { ManualImportJobPayload } from '../services/import-adapters/types.js';
import {
  attachTransitionAndEnqueue,
  AttachGuardMissed,
  isAttachActiveJobConflict,
} from '../services/attach-enqueue.js';
import { admitAttachSource } from '../utils/attach-source.js';
import { classifyImportSource } from '../utils/import-source-containment.js';

const paramsSchema = z.object({
  id: z.coerce.number().int().positive(),
});

const bodySchema = z.object({
  path: z.string().trim().min(1),
  // Required, not defaulted: with `mode` omitted the adapter records the EXTERNAL source path as
  // `books.path` and never builds the library folder this action exists to create — and since the
  // source is refused inside the library root, that would place every path outside it by
  // construction, breaking the containment rename, delete and companion-ebook eligibility rely on.
  mode: z.enum(['copy', 'move']),
});

/** Both the pre-check and the lost-race catch answer this; the operator reads it, so they must agree. */
const ALREADY_IMPORTING = 'An import is already in progress for this book';

async function hasActiveJob(db: DbOrTx, bookId: number): Promise<boolean> {
  const [row] = await db
    .select({ id: importJobs.id })
    .from(importJobs)
    .where(and(eq(importJobs.bookId, bookId), inArray(importJobs.status, ['pending', 'processing'])))
    .limit(1);
  return row !== undefined;
}

export interface BookImportFilesDeps {
  db: Db;
  bookService: BookService;
  bookImportService: BookImportService;
  settingsService: SettingsService;
  nudgeImportWorker: () => void;
}

/**
 * #2435 AC15–AC18 — register a manually-obtained file against an existing fileless book.
 *
 * Deliberately bypasses the staging pipeline: submissions exist for multi-item batches with
 * digests, ordinals and gap reports, none of which a single book-scoped import needs. It builds the
 * job payload directly, which also keeps `stagedImportItemSchema` (`.strict()`, and persisted)
 * untouched.
 *
 * Naming does NOT travel through the payload — the adapter renders it from the incumbent row under
 * AC23's override. Of the request, only the source path and the chosen mode influence anything.
 */
export async function bookImportFilesRoute(
  app: FastifyInstance,
  deps: BookImportFilesDeps,
): Promise<void> {
  app.post<{ Params: z.infer<typeof paramsSchema>; Body: z.infer<typeof bodySchema> }>(
    '/api/books/:id/import-files',
    { schema: { params: paramsSchema, body: bodySchema } },
    async (request, reply) => {
      const { id } = request.params;
      const { path: sourcePath, mode } = request.body;

      // Checks run in this order and the first failure is the response, so a book that trips two
      // at once answers deterministically. Every refusal below leaves status and path untouched.
      const book = await deps.bookService.getById(id);
      if (!book) {
        return reply.status(404).send({ error: 'Book not found', code: 'book_not_found' });
      }
      if (bookHoldsFile(book.path)) {
        return reply.status(409).send({ error: 'This book already has a library folder', code: 'book_has_file' });
      }
      if (!isAttachableStatus(book.status)) {
        return reply.status(409).send({
          // An active acquisition owns the book; an `import_jobs` row is a SEPARATE condition, and
          // a `downloading` book need not have one at all — which is how it would otherwise slip through.
          error: `A book with status "${book.status}" cannot receive a manually-obtained file`,
          code: 'status_not_attachable',
        });
      }
      if (await hasActiveJob(deps.db, id)) {
        return reply.status(409).send({ error: ALREADY_IMPORTING, code: 'already_importing' });
      }

      // Ahead of admission on purpose (#2478): `admitAttachSource('/')` would recurse the whole
      // filesystem looking for one audio file before anything refused it.
      const librarySettings = await deps.settingsService.get('library');
      const containment = classifyImportSource(sourcePath, librarySettings.path);
      if (!containment.admissible) {
        return reply.status(400).send({ error: containment.message, code: containment.reason });
      }

      const admission = await admitAttachSource(sourcePath);
      if (!admission.ok) {
        return reply.status(400).send({ error: admission.reason, code: 'source_invalid' });
      }

      const payload: ManualImportJobPayload = { path: sourcePath, title: book.title, mode, attach: true };
      let jobId: number;
      try {
        jobId = await deps.db.transaction(async (tx) =>
          attachTransitionAndEnqueue(tx, deps.bookImportService, {
            bookId: id,
            expectedStatus: book.status,
            metadata: JSON.stringify(payload),
          }),
        );
      } catch (error: unknown) {
        // Both shapes of "someone else got there first" answer the same 409; the rolled-back
        // transaction leaves status and path exactly as found. Anything else propagates unchanged —
        // an over-broad catch that labelled an unrelated conflict `already_importing` would hide it.
        if (error instanceof AttachGuardMissed || isAttachActiveJobConflict(error)) {
          return reply.status(409).send({ error: ALREADY_IMPORTING, code: 'already_importing' });
        }
        throw error;
      }

      // Post-commit, exactly once, and on no rollback path.
      deps.nudgeImportWorker();
      request.log.info({ bookId: id, jobId, mode }, 'Queued manual file attach for an existing book');
      return reply.status(202).send({ jobId });
    },
  );
}
