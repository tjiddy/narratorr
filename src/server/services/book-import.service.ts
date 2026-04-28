import { eq, and, inArray, desc, type SQL } from 'drizzle-orm';
import type { Db } from '../../db/index.js';
import type { FastifyBaseLogger } from 'fastify';
import { books, importJobs, bookAuthors, authors } from '../../db/schema.js';
import type {
  ImportJobStatus,
  ImportJobType,
  ImportJobPhase,
  PhaseHistoryEntry,
} from '../../shared/schemas/import-job.js';

export interface ImportJobListing {
  id: number;
  bookId: number | null;
  type: ImportJobType;
  status: ImportJobStatus;
  phase: ImportJobPhase | null;
  phaseHistory: PhaseHistoryEntry[];
  createdAt: Date;
  updatedAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  book: {
    title: string;
    coverUrl: string | null;
    primaryAuthorName: string | null;
  };
}

export type RetryImportResult =
  | { jobId: number }
  | { error: string; status: 404 | 409 | 400 };

export class BookImportService {
  constructor(
    private db: Db,
    private log: FastifyBaseLogger,
  ) {}

  async retryImport(
    bookId: number,
    nudgeImportWorker: () => void,
  ): Promise<RetryImportResult> {
    const [book] = await this.db
      .select({ id: books.id, status: books.status })
      .from(books)
      .where(eq(books.id, bookId))
      .limit(1);

    if (!book) return { error: 'Book not found', status: 404 };
    if (book.status === 'importing') {
      return { error: 'Import already in progress', status: 409 };
    }

    const [activeJob] = await this.db
      .select({ id: importJobs.id })
      .from(importJobs)
      .where(and(eq(importJobs.bookId, bookId), eq(importJobs.status, 'processing')))
      .limit(1);

    if (activeJob) return { error: 'Import already in progress', status: 409 };

    const [failedJob] = await this.db
      .select()
      .from(importJobs)
      .where(and(eq(importJobs.bookId, bookId), eq(importJobs.status, 'failed')))
      .orderBy(desc(importJobs.createdAt), desc(importJobs.id))
      .limit(1);

    if (!failedJob) return { error: 'No failed import job found for this book', status: 400 };

    const [newJob] = await this.db
      .insert(importJobs)
      .values({
        bookId,
        type: failedJob.type,
        status: 'pending',
        phase: 'queued',
        metadata: failedJob.metadata,
      })
      .returning({ id: importJobs.id });

    await this.db
      .update(books)
      .set({ status: 'importing', updatedAt: new Date() })
      .where(eq(books.id, bookId));

    nudgeImportWorker();

    this.log.info(
      { bookId, jobId: newJob.id, originalJobId: failedJob.id },
      'Retry import job created',
    );

    return { jobId: newJob.id };
  }

  async getRetryAvailability(
    bookId: number,
  ): Promise<{ retryable: boolean; lastFailedJobId?: number }> {
    const [failedJob] = await this.db
      .select({ id: importJobs.id })
      .from(importJobs)
      .where(and(eq(importJobs.bookId, bookId), eq(importJobs.status, 'failed')))
      .orderBy(desc(importJobs.createdAt), desc(importJobs.id))
      .limit(1);

    if (!failedJob) return { retryable: false };
    return { retryable: true, lastFailedJobId: failedJob.id };
  }

  async listImportJobs(
    filters: { status?: ImportJobStatus[] } = {},
  ): Promise<ImportJobListing[]> {
    const conditions: SQL[] = [];
    if (filters.status && filters.status.length > 0) {
      conditions.push(inArray(importJobs.status, filters.status));
    }

    const rows = await this.db
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

    return rows.map((row) => ({
      id: row.job.id,
      bookId: row.job.bookId,
      type: row.job.type,
      status: row.job.status,
      phase: row.job.phase,
      phaseHistory: row.job.phaseHistory
        ? (JSON.parse(row.job.phaseHistory) as PhaseHistoryEntry[])
        : [],
      createdAt: row.job.createdAt,
      updatedAt: row.job.updatedAt,
      startedAt: row.job.startedAt,
      completedAt: row.job.completedAt,
      book: {
        title: row.bookTitle ?? 'Unknown',
        coverUrl: row.bookCoverUrl ?? null,
        primaryAuthorName: row.primaryAuthorName ?? null,
      },
    }));
  }
}
