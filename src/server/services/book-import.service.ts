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
import { parsePhaseHistory } from '../utils/parse-phase-history.js';

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
  | { error: 'active-job-exists'; status: 409 }
  | { error: string; status: 404 | 409 | 400 };

export interface EnqueueImportInput {
  bookId: number;
  type: ImportJobType;
  metadata: string;
  phase?: ImportJobPhase;
}

export type EnqueueImportResult =
  | { jobId: number }
  | { error: 'active-job-exists'; status: 409 };

// Both the index-name and column-message forms are matched — SQLite surfaces
// either depending on whether the conflict is detected via the named index or
// the underlying column unique check (pattern from blacklist.service.test.ts).
const ACTIVE_JOB_UNIQUE_VIOLATION =
  /UNIQUE constraint failed.*(?:idx_import_jobs_book_active|import_jobs\.book_id|book_id)/;

function isActiveJobUniqueViolation(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const causeMsg = (error as Error & { cause?: { message?: string } }).cause?.message ?? '';
  if (ACTIVE_JOB_UNIQUE_VIOLATION.test(causeMsg)) return true;
  return ACTIVE_JOB_UNIQUE_VIOLATION.test(error.message ?? '');
}

export class BookImportService {
  constructor(
    private db: Db,
    private log: FastifyBaseLogger,
  ) {}

  /**
   * Centralized active-job check + insert. All three insert sites (retry, auto, manual)
   * route through here so the transactional logic lives in exactly one place.
   *
   * Returns `{ jobId }` on success or `{ error: 'active-job-exists', status: 409 }`
   * when an active job already exists for the same bookId — either detected by
   * the in-tx pre-check or caught from the partial unique-index defensive backstop.
   */
  async enqueue(input: EnqueueImportInput): Promise<EnqueueImportResult> {
    try {
      return await this.db.transaction(async (tx) => {
        const [existing] = await tx
          .select({ id: importJobs.id })
          .from(importJobs)
          .where(and(
            eq(importJobs.bookId, input.bookId),
            inArray(importJobs.status, ['pending', 'processing']),
          ))
          .limit(1);

        if (existing) {
          return { error: 'active-job-exists' as const, status: 409 as const };
        }

        const [newJob] = await tx
          .insert(importJobs)
          .values({
            bookId: input.bookId,
            type: input.type,
            status: 'pending',
            phase: input.phase ?? 'queued',
            metadata: input.metadata,
          })
          .returning({ id: importJobs.id });

        return { jobId: newJob.id };
      });
    } catch (error: unknown) {
      if (isActiveJobUniqueViolation(error)) {
        this.log.info(
          { bookId: input.bookId, type: input.type },
          'Active import job unique-index conflict (defensive backstop)',
        );
        return { error: 'active-job-exists', status: 409 };
      }
      throw error;
    }
  }

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

    const [failedJob] = await this.db
      .select()
      .from(importJobs)
      .where(and(eq(importJobs.bookId, bookId), eq(importJobs.status, 'failed')))
      .orderBy(desc(importJobs.createdAt), desc(importJobs.id))
      .limit(1);

    if (!failedJob) return { error: 'No failed import job found for this book', status: 400 };

    const enqueued = await this.enqueue({
      bookId,
      type: failedJob.type,
      metadata: failedJob.metadata,
    });

    if ('error' in enqueued) {
      return enqueued;
    }

    await this.db
      .update(books)
      .set({ status: 'importing', updatedAt: new Date() })
      .where(eq(books.id, bookId));

    nudgeImportWorker();

    this.log.info(
      { bookId, jobId: enqueued.jobId, originalJobId: failedJob.id },
      'Retry import job created',
    );

    return { jobId: enqueued.jobId };
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
      phaseHistory: parsePhaseHistory(row.job.phaseHistory, this.log, row.job.id),
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
