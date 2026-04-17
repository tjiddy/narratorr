import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq, and, desc } from 'drizzle-orm';
import type { Db } from '../../db/index.js';
import { books, importJobs } from '../../db/schema.js';
import type { ImportQueueWorker } from '../services/import-queue-worker.js';

const paramsSchema = z.object({
  id: z.coerce.number().int().positive(),
});

export async function retryImportRoute(
  app: FastifyInstance,
  db: Db,
  worker: ImportQueueWorker,
): Promise<void> {
  app.post<{ Params: z.infer<typeof paramsSchema> }>(
    '/api/books/:id/retry-import',
    { schema: { params: paramsSchema } },
    async (request, reply) => {
      const bookId = request.params.id;

      // Verify book exists
      const [book] = await db.select({ id: books.id, status: books.status })
        .from(books)
        .where(eq(books.id, bookId))
        .limit(1);

      if (!book) {
        return reply.status(404).send({ error: 'Book not found' });
      }

      // Check if book is currently importing or has active processing job
      if (book.status === 'importing') {
        return reply.status(409).send({ error: 'Import already in progress' });
      }

      const [activeJob] = await db.select({ id: importJobs.id })
        .from(importJobs)
        .where(and(
          eq(importJobs.bookId, bookId),
          eq(importJobs.status, 'processing'),
        ))
        .limit(1);

      if (activeJob) {
        return reply.status(409).send({ error: 'Import already in progress' });
      }

      // Find most recent failed import job
      const [failedJob] = await db.select()
        .from(importJobs)
        .where(and(
          eq(importJobs.bookId, bookId),
          eq(importJobs.status, 'failed'),
        ))
        .orderBy(desc(importJobs.createdAt))
        .limit(1);

      if (!failedJob) {
        return reply.status(400).send({ error: 'No failed import job found for this book' });
      }

      // Insert new pending job with same metadata (preserve history)
      const [newJob] = await db.insert(importJobs).values({
        bookId,
        type: failedJob.type,
        status: 'pending',
        phase: 'queued',
        metadata: failedJob.metadata,
      }).returning({ id: importJobs.id });

      // Set book back to importing
      await db.update(books).set({
        status: 'importing',
        updatedAt: new Date(),
      }).where(eq(books.id, bookId));

      // Nudge worker
      worker.nudge();

      request.log.info({ bookId, jobId: newJob.id, originalJobId: failedJob.id }, 'Retry import job created');

      return reply.status(202).send({ jobId: newJob.id });
    },
  );
}
