import { eq, inArray, and, or, gt, lte } from 'drizzle-orm';
import type { Db } from '../../db/index.js';
import type { FastifyBaseLogger } from 'fastify';
import { blacklist } from '../../db/schema.js';
import type { SettingsService } from './settings.service.js';

type BlacklistRow = typeof blacklist.$inferSelect;
type NewBlacklist = typeof blacklist.$inferInsert;

export class BlacklistService {
  constructor(private db: Db, private log: FastifyBaseLogger, private settingsService?: SettingsService) {}

  async getAll(): Promise<BlacklistRow[]> {
    return this.db.select().from(blacklist);
  }

  async getById(id: number): Promise<BlacklistRow | null> {
    const results = await this.db.select().from(blacklist).where(eq(blacklist.id, id)).limit(1);
    return results[0] || null;
  }

  async create(data: Omit<NewBlacklist, 'id' | 'blacklistedAt'>): Promise<BlacklistRow> {
    const values = { ...data };

    // Auto-fill expiresAt for temporary entries from TTL setting
    if (values.blacklistType === 'temporary' && !values.expiresAt && this.settingsService) {
      const searchSettings = await this.settingsService.get('search');
      const ttlDays = searchSettings.blacklistTtlDays ?? 7;
      values.expiresAt = new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000);
    }

    // Ensure permanent entries have no expiresAt
    if (values.blacklistType !== 'temporary') {
      values.expiresAt = null;
    }

    const result = await this.db.insert(blacklist).values(values).returning();
    this.log.info({ title: data.title, infoHash: data.infoHash, blacklistType: values.blacklistType ?? 'permanent' }, 'Added to blacklist');
    return result[0];
  }

  async delete(id: number): Promise<boolean> {
    const existing = await this.getById(id);
    if (!existing) return false;

    await this.db.delete(blacklist).where(eq(blacklist.id, id));
    this.log.info({ id, title: existing.title }, 'Removed from blacklist');
    return true;
  }

  async toggleType(id: number, blacklistType: 'temporary' | 'permanent'): Promise<BlacklistRow | null> {
    const existing = await this.getById(id);
    if (!existing) return null;

    let expiresAt: Date | null = null;
    if (blacklistType === 'temporary' && this.settingsService) {
      const searchSettings = await this.settingsService.get('search');
      const ttlDays = searchSettings.blacklistTtlDays ?? 7;
      expiresAt = new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000);
    }

    const result = await this.db
      .update(blacklist)
      .set({ blacklistType, expiresAt })
      .where(eq(blacklist.id, id))
      .returning();

    this.log.info({ id, blacklistType, expiresAt }, 'Blacklist entry type toggled');
    return result[0];
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
    const now = new Date();
    // Only return hashes that are permanent OR temporary with future expiry
    const expiryFilter = or(
      eq(blacklist.blacklistType, 'permanent'),
      gt(blacklist.expiresAt, now),
    );

    let rows: BlacklistRow[];
    if (hashes && hashes.length > 0) {
      rows = await this.db
        .select()
        .from(blacklist)
        .where(and(inArray(blacklist.infoHash, hashes), expiryFilter));
    } else {
      rows = await this.db
        .select()
        .from(blacklist)
        .where(expiryFilter);
    }
    return new Set(rows.map((r) => r.infoHash));
  }

  async deleteExpired(): Promise<number> {
    const now = new Date();
    const result = await this.db
      .delete(blacklist)
      .where(and(
        eq(blacklist.blacklistType, 'temporary'),
        lte(blacklist.expiresAt, now),
      ))
      .returning();

    const count = result.length;
    if (count > 0) {
      this.log.info({ count }, 'Cleaned up expired temporary blacklist entries');
    }
    return count;
  }
}
