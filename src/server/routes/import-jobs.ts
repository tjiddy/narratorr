import type { FastifyInstance } from 'fastify';
import type { Db } from '../../db/index.js';
import { importJobs, books, bookAuthors, authors } from '../../db/schema.js';
import { eq, and, inArray, type SQL } from 'drizzle-orm';
import type { ImportJobStatus, PhaseHistoryEntry } from '../../shared/schemas/import-job.js';
import { z } from 'zod';

const importJobsQuerySchema = z.object({
  status: z.string().optional(),
});

type ImportJobsQuery = z.infer<typeof importJobsQuerySchema>;

export async function importJobsRoutes(app: FastifyInstance, db: Db) {
  app.get<{ Querystring: ImportJobsQuery }>(
    '/api/import-jobs',
    { schema: { querystring: importJobsQuerySchema } },
    async (request) => {
      const { status } = request.query;

      const conditions: SQL[] = [];
      if (status) {
        const statuses = status.split(',') as ImportJobStatus[];
        conditions.push(inArray(importJobs.status, statuses));
      }

      const rows = await db
        .select({
          job: importJobs,
          bookTitle: books.title,
          bookCoverUrl: books.coverUrl,
          primaryAuthorName: authors.name,
        })
        .from(importJobs)
        .leftJoin(books, eq(importJobs.bookId, books.id))
        .leftJoin(bookAuthors, and(eq(bookAuthors.bookId, books.id), eq(bookAuthors.position, 0)))
        .leftJoin(authors, eq(bookAuthors.authorId, authors.id))
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(importJobs.updatedAt);

      return rows.map((row) => {
        const phaseHistory: PhaseHistoryEntry[] = row.job.phaseHistory
          ? JSON.parse(row.job.phaseHistory)
          : [];

        return {
          id: row.job.id,
          bookId: row.job.bookId,
          type: row.job.type,
          status: row.job.status,
          phase: row.job.phase,
          phaseHistory,
          createdAt: row.job.createdAt,
          updatedAt: row.job.updatedAt,
          startedAt: row.job.startedAt,
          completedAt: row.job.completedAt,
          book: {
            title: row.bookTitle ?? 'Unknown',
            coverUrl: row.bookCoverUrl ?? null,
            primaryAuthorName: row.primaryAuthorName ?? null,
          },
        };
      });
    },
  );
}
