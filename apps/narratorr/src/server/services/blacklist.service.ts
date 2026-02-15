import { eq, inArray } from 'drizzle-orm';
import type { Db } from '@narratorr/db';
import type { FastifyBaseLogger } from 'fastify';
import { blacklist } from '@narratorr/db/schema';

type BlacklistRow = typeof blacklist.$inferSelect;
type NewBlacklist = typeof blacklist.$inferInsert;

export class BlacklistService {
  constructor(private db: Db, private log: FastifyBaseLogger) {}

  async getAll(): Promise<BlacklistRow[]> {
    return this.db.select().from(blacklist);
  }

  async getById(id: number): Promise<BlacklistRow | null> {
    const results = await this.db.select().from(blacklist).where(eq(blacklist.id, id)).limit(1);
    return results[0] || null;
  }

  async create(data: Omit<NewBlacklist, 'id' | 'blacklistedAt'>): Promise<BlacklistRow> {
    const result = await this.db.insert(blacklist).values(data).returning();
    this.log.info({ title: data.title, infoHash: data.infoHash }, 'Added to blacklist');
    return result[0];
  }

  async delete(id: number): Promise<boolean> {
    const existing = await this.getById(id);
    if (!existing) return false;

    await this.db.delete(blacklist).where(eq(blacklist.id, id));
    this.log.info({ id, title: existing.title }, 'Removed from blacklist');
    return true;
  }

  async isBlacklisted(infoHash: string): Promise<boolean> {
    const results = await this.db
      .select()
      .from(blacklist)
      .where(eq(blacklist.infoHash, infoHash))
      .limit(1);
    return results.length > 0;
  }

  async getBlacklistedHashes(hashes?: string[]): Promise<Set<string>> {
    let rows: BlacklistRow[];
    if (hashes && hashes.length > 0) {
      rows = await this.db
        .select()
        .from(blacklist)
        .where(inArray(blacklist.infoHash, hashes));
    } else {
      rows = await this.db.select().from(blacklist);
    }
    return new Set(rows.map((r) => r.infoHash));
  }
}
