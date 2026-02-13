import { eq, and, like, desc } from 'drizzle-orm';
import type { Db } from '@narratorr/db';
import type { FastifyBaseLogger } from 'fastify';
import { books, authors } from '@narratorr/db/schema';
import { slugify } from '@narratorr/core';

type BookRow = typeof books.$inferSelect;
type NewBook = typeof books.$inferInsert;
type AuthorRow = typeof authors.$inferSelect;

export interface BookWithAuthor extends BookRow {
  author?: AuthorRow;
}

export class BookService {
  constructor(private db: Db, private log: FastifyBaseLogger) {}

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
  }): Promise<BookWithAuthor> {
    let authorId: number | undefined;

    if (data.authorName) {
      // Find or create author
      const slug = slugify(data.authorName);
      const existingAuthor = await this.db
        .select()
        .from(authors)
        .where(eq(authors.slug, slug))
        .limit(1);

      if (existingAuthor.length > 0) {
        authorId = existingAuthor[0].id;
      } else {
        const newAuthor = await this.db
          .insert(authors)
          .values({ name: data.authorName, slug, asin: data.authorAsin })
          .returning();
        authorId = newAuthor[0].id;
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
        asin: data.asin,
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
}
