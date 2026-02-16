import { eq, and, like, desc, sql } from 'drizzle-orm';
import type { Db } from '@narratorr/db';
import type { FastifyBaseLogger } from 'fastify';
import { books, authors, unmatchedGenres } from '@narratorr/db/schema';
import { slugify, findUnmatchedGenres } from '@narratorr/core';
import { type MetadataService } from './metadata.service.js';

type BookRow = typeof books.$inferSelect;
type NewBook = typeof books.$inferInsert;
type AuthorRow = typeof authors.$inferSelect;

export interface BookWithAuthor extends BookRow {
  author?: AuthorRow;
}

export class BookService {
  constructor(
    private db: Db,
    private log: FastifyBaseLogger,
    private metadataService?: MetadataService,
  ) {}

  async getAll(status?: string): Promise<BookWithAuthor[]> {
    let query = this.db
      .select({
        book: books,
        author: authors,
      })
      .from(books)
      .leftJoin(authors, eq(books.authorId, authors.id))
      .orderBy(desc(books.createdAt));

    if (status) {
      query = query.where(eq(books.status, status as BookRow['status'])) as typeof query;
    }

    const results = await query;

    return results.map((r) => ({
      ...r.book,
      author: r.author || undefined,
    }));
  }

  async getById(id: number): Promise<BookWithAuthor | null> {
    const results = await this.db
      .select({
        book: books,
        author: authors,
      })
      .from(books)
      .leftJoin(authors, eq(books.authorId, authors.id))
      .where(eq(books.id, id))
      .limit(1);

    if (results.length === 0) return null;

    return {
      ...results[0].book,
      author: results[0].author || undefined,
    };
  }

  async findDuplicate(title: string, authorName?: string, asin?: string): Promise<BookWithAuthor | null> {
    // Check by ASIN first if available (opportunistic)
    if (asin) {
      const byAsin = await this.db
        .select({ book: books, author: authors })
        .from(books)
        .leftJoin(authors, eq(books.authorId, authors.id))
        .where(eq(books.asin, asin))
        .limit(1);

      if (byAsin.length > 0) {
        return { ...byAsin[0].book, author: byAsin[0].author || undefined };
      }
    }

    // Check by title + author slug
    if (authorName) {
      const authorSlug = slugify(authorName);
      const byTitleAuthor = await this.db
        .select({ book: books, author: authors })
        .from(books)
        .leftJoin(authors, eq(books.authorId, authors.id))
        .where(and(eq(books.title, title), eq(authors.slug, authorSlug)))
        .limit(1);

      if (byTitleAuthor.length > 0) {
        return { ...byTitleAuthor[0].book, author: byTitleAuthor[0].author || undefined };
      }
    }

    return null;
  }

  async create(data: {
    title: string;
    authorName?: string;
    authorAsin?: string;
    narrator?: string;
    description?: string;
    coverUrl?: string;
    asin?: string;
    isbn?: string;
    seriesName?: string;
    seriesPosition?: number;
    duration?: number;
    publishedDate?: string;
    genres?: string[];
    status?: BookRow['status'];
    providerId?: string;
  }): Promise<BookWithAuthor> {
    // Enrich with ASIN from metadata provider if missing
    let enrichedAsin = data.asin;
    if (!enrichedAsin && data.providerId && this.metadataService) {
      try {
        const detail = await this.metadataService.getBook(data.providerId);
        if (detail?.asin) {
          enrichedAsin = detail.asin;
          this.log.info({ title: data.title, providerId: data.providerId, asin: enrichedAsin }, 'Enriched book with ASIN from provider');
        }
      } catch (error) {
        this.log.warn({ error, providerId: data.providerId }, 'ASIN enrichment failed');
      }
    }

    let authorId: number | undefined;

    if (data.authorName) {
      // Find or create author (upsert to avoid TOCTOU race on unique slug)
      const slug = slugify(data.authorName);
      const existingAuthor = await this.db
        .select()
        .from(authors)
        .where(eq(authors.slug, slug))
        .limit(1);

      if (existingAuthor.length > 0) {
        authorId = existingAuthor[0].id;
      } else {
        try {
          const newAuthor = await this.db
            .insert(authors)
            .values({ name: data.authorName, slug, asin: data.authorAsin })
            .returning();
          authorId = newAuthor[0].id;
        } catch {
          // Unique constraint violation — another request created the author concurrently
          const retryAuthor = await this.db
            .select()
            .from(authors)
            .where(eq(authors.slug, slug))
            .limit(1);
          if (retryAuthor.length > 0) {
            authorId = retryAuthor[0].id;
          } else {
            throw new Error(`Failed to find or create author: ${data.authorName}`);
          }
        }
      }
    }

    const result = await this.db
      .insert(books)
      .values({
        title: data.title,
        authorId,
        narrator: data.narrator,
        description: data.description,
        coverUrl: data.coverUrl,
        asin: enrichedAsin,
        isbn: data.isbn,
        seriesName: data.seriesName,
        seriesPosition: data.seriesPosition,
        duration: data.duration,
        publishedDate: data.publishedDate,
        genres: data.genres,
        status: data.status || 'wanted',
      })
      .returning();

    this.log.info({ title: data.title }, 'Book added to library');
    this.trackUnmatchedGenres(data.genres).catch((error) => {
      this.log.debug({ error }, 'Failed to track unmatched genres');
    });
    return this.getById(result[0].id) as Promise<BookWithAuthor>;
  }

  async update(id: number, data: Partial<NewBook>): Promise<BookWithAuthor | null> {
    const result = await this.db
      .update(books)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(books.id, id))
      .returning();

    if (result.length === 0) return null;

    this.log.info({ id }, 'Book updated');
    return this.getById(id);
  }

  async updateStatus(id: number, status: BookRow['status']): Promise<BookWithAuthor | null> {
    this.log.info({ id, status }, 'Book status changed');
    return this.update(id, { status });
  }

  async delete(id: number): Promise<boolean> {
    const existing = await this.getById(id);
    if (!existing) return false;

    await this.db.delete(books).where(eq(books.id, id));
    this.log.info({ id }, 'Book removed');
    return true;
  }

  async search(query: string): Promise<BookWithAuthor[]> {
    const results = await this.db
      .select({
        book: books,
        author: authors,
      })
      .from(books)
      .leftJoin(authors, eq(books.authorId, authors.id))
      .where(like(books.title, `%${query}%`))
      .orderBy(desc(books.createdAt))
      .limit(50);

    return results.map((r) => ({
      ...r.book,
      author: r.author || undefined,
    }));
  }

  /** Fire-and-forget: track genres not in the synonym/known lists for future analysis */
  private async trackUnmatchedGenres(genres: string[] | undefined): Promise<void> {
    const unmatched = findUnmatchedGenres(genres, genres);
    if (unmatched.length === 0) return;

    for (const genre of unmatched) {
      await this.db
        .insert(unmatchedGenres)
        .values({ genre, count: 1 })
        .onConflictDoUpdate({
          target: unmatchedGenres.genre,
          set: {
            count: sql`${unmatchedGenres.count} + 1`,
            lastSeen: sql`(unixepoch())`,
          },
        });
    }
    this.log.debug({ genres: unmatched }, 'Tracked unmatched genres');
  }
}
