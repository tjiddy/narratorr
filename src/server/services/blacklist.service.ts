import { eq, inArray, and, or, gt, lte, desc, count as countFn, sql } from 'drizzle-orm';
import type { Db } from '../../db/index.js';
import type { FastifyBaseLogger } from 'fastify';
import { blacklist } from '../../db/schema.js';
import type { SettingsService } from './settings.service.js';
import type { BlacklistRow } from './types.js';
import { chunkArray } from '../utils/batch.js';

type NewBlacklist = typeof blacklist.$inferInsert;

export class BlacklistService {
  constructor(private db: Db, private log: FastifyBaseLogger, private settingsService?: SettingsService) {}

  async getAll(
    pagination?: { limit?: number; offset?: number },
  ): Promise<{ data: BlacklistRow[]; total: number }> {
    // Get total count
    const [{ value: total } = { value: 0 }] = await this.db
      .select({ value: countFn() })
      .from(blacklist);

    // Get data with optional pagination and stable ordering
    let query = this.db
      .select()
      .from(blacklist)
      .orderBy(desc(blacklist.blacklistedAt), desc(blacklist.id));

    if (pagination?.limit !== undefined) {
      query = query.limit(pagination.limit) as typeof query;
    }
    if (pagination?.offset !== undefined) {
      query = query.offset(pagination.offset) as typeof query;
    }

    const data = await query;
    return { data, total };
  }

  async getById(id: number): Promise<BlacklistRow | null> {
    const results = await this.db.select().from(blacklist).where(eq(blacklist.id, id)).limit(1);
    return results[0] || null;
  }

  async create(data: Omit<NewBlacklist, 'id' | 'blacklistedAt'>): Promise<BlacklistRow> {
    if (!data.infoHash && !data.guid) {
      throw new Error('Blacklist entry requires at least one identifier (infoHash or guid)');
    }

    // Normalize every optional field so the upsert SET clause writes deterministic values.
    // Drizzle drops `undefined` from SET, which would let stale row values leak through on conflict.
    const normalized = {
      bookId: data.bookId ?? null,
      infoHash: data.infoHash ?? null,
      guid: data.guid ?? null,
      title: data.title,
      reason: data.reason,
      note: data.note ?? null,
      blacklistType: data.blacklistType ?? 'permanent',
      expiresAt: data.expiresAt ?? null,
    };

    if (normalized.blacklistType === 'temporary' && !normalized.expiresAt && this.settingsService) {
      const searchSettings = await this.settingsService.get('search');
      const ttlDays = searchSettings.blacklistTtlDays ?? 7;
      normalized.expiresAt = new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000);
    }
    if (normalized.blacklistType !== 'temporary') {
      normalized.expiresAt = null;
    }

    const conflict = normalized.infoHash
      ? { target: blacklist.infoHash, targetWhere: sql`info_hash IS NOT NULL` }
      : { target: blacklist.guid, targetWhere: sql`guid IS NOT NULL` };

    const result = await this.db
      .insert(blacklist)
      .values(normalized)
      .onConflictDoUpdate({
        ...conflict,
        set: {
          bookId: normalized.bookId,
          infoHash: normalized.infoHash,
          guid: normalized.guid,
          title: normalized.title,
          reason: normalized.reason,
          note: normalized.note,
          blacklistType: normalized.blacklistType,
          expiresAt: normalized.expiresAt,
          blacklistedAt: new Date(),
        },
      })
      .returning();
    this.log.info({ title: data.title, infoHash: data.infoHash, guid: data.guid, blacklistType: normalized.blacklistType }, 'Added to blacklist');
    return result[0]!;
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
    return result[0] ?? null;
  }

  async isBlacklisted(infoHash?: string, guid?: string): Promise<boolean> {
    if (!infoHash && !guid) return false;
    const { blacklistedHashes, blacklistedGuids } = await this.getBlacklistedIdentifiers(
      infoHash ? [infoHash] : undefined,
      guid ? [guid] : undefined,
    );
    return (!!infoHash && blacklistedHashes.has(infoHash)) ||
           (!!guid && blacklistedGuids.has(guid));
  }

  async getBlacklistedIdentifiers(
    hashes?: string[],
    guids?: string[],
  ): Promise<{ blacklistedHashes: Set<string>; blacklistedGuids: Set<string> }> {
    const now = new Date();
    const expiryFilter = or(
      eq(blacklist.blacklistType, 'permanent'),
      gt(blacklist.expiresAt, now),
    );

    const blacklistedHashes = new Set<string>();
    const blacklistedGuids = new Set<string>();
    const hashList = hashes ?? [];
    const guidList = guids ?? [];

    // Empty/omitted input: the expiry-only query returns every active row's
    // identifiers (relied on by getBlacklistedHashes/isBlacklisted). chunkArray([])
    // yields no chunks, so this branch must stay explicit — not folded into the
    // chunk loops below, which would issue zero queries and return empty Sets.
    if (hashList.length === 0 && guidList.length === 0) {
      const rows: BlacklistRow[] = await this.db
        .select()
        .from(blacklist)
        .where(expiryFilter);
      for (const row of rows) {
        if (row.infoHash) blacklistedHashes.add(row.infoHash);
        if (row.guid) blacklistedGuids.add(row.guid);
      }
      return { blacklistedHashes, blacklistedGuids };
    }

    // Chunk each identifier list's inArray query (SQLite bind-param limit is 999),
    // applying the expiry predicate per chunk and unioning every returned row's
    // identifiers into both Sets — so a row matched via one identifier still
    // contributes the other (preserving the old combined-query cross-population).
    if (hashList.length > 0) {
      await this.accumulateBlacklisted(blacklist.infoHash, hashList, expiryFilter, blacklistedHashes, blacklistedGuids);
    }
    if (guidList.length > 0) {
      await this.accumulateBlacklisted(blacklist.guid, guidList, expiryFilter, blacklistedHashes, blacklistedGuids);
    }
    return { blacklistedHashes, blacklistedGuids };
  }

  // The expiry predicate adds 2 fixed binds per chunk query; 480 leaves ample
  // headroom under the 999 limit (in-repo convention ceiling is 998).
  private static readonly IDENTIFIER_CHUNK_SIZE = 480;

  private async accumulateBlacklisted(
    column: Parameters<typeof inArray>[0],
    values: string[],
    expiryFilter: ReturnType<typeof or>,
    blacklistedHashes: Set<string>,
    blacklistedGuids: Set<string>,
  ): Promise<void> {
    for (const chunk of chunkArray(values, BlacklistService.IDENTIFIER_CHUNK_SIZE)) {
      const rows: BlacklistRow[] = await this.db
        .select()
        .from(blacklist)
        .where(and(inArray(column, chunk), expiryFilter));
      for (const row of rows) {
        if (row.infoHash) blacklistedHashes.add(row.infoHash);
        if (row.guid) blacklistedGuids.add(row.guid);
      }
    }
  }

  /** Backward-compatible wrapper — returns only blacklisted infoHashes. */
  async getBlacklistedHashes(hashes?: string[]): Promise<Set<string>> {
    const { blacklistedHashes } = await this.getBlacklistedIdentifiers(hashes);
    return blacklistedHashes;
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
