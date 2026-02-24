import { eq } from 'drizzle-orm';
import type { Db } from '@narratorr/db';
import type { FastifyBaseLogger } from 'fastify';
import { remotePathMappings } from '@narratorr/db/schema';

type RemotePathMappingRow = typeof remotePathMappings.$inferSelect;
type NewRemotePathMapping = typeof remotePathMappings.$inferInsert;

export class RemotePathMappingService {
  constructor(private db: Db, private log: FastifyBaseLogger) {}

  async getAll(): Promise<RemotePathMappingRow[]> {
    return this.db.select().from(remotePathMappings).orderBy(remotePathMappings.downloadClientId);
  }

  async getById(id: number): Promise<RemotePathMappingRow | null> {
    const results = await this.db
      .select()
      .from(remotePathMappings)
      .where(eq(remotePathMappings.id, id))
      .limit(1);
    return results[0] || null;
  }

  async getByClientId(downloadClientId: number): Promise<RemotePathMappingRow[]> {
    return this.db
      .select()
      .from(remotePathMappings)
      .where(eq(remotePathMappings.downloadClientId, downloadClientId));
  }

  async create(data: Omit<NewRemotePathMapping, 'id' | 'createdAt' | 'updatedAt'>): Promise<RemotePathMappingRow> {
    const result = await this.db.insert(remotePathMappings).values(data).returning();
    this.log.info({ downloadClientId: data.downloadClientId, remotePath: data.remotePath }, 'Remote path mapping created');
    return result[0];
  }

  async update(id: number, data: Partial<Omit<NewRemotePathMapping, 'id' | 'createdAt'>>): Promise<RemotePathMappingRow | null> {
    const result = await this.db
      .update(remotePathMappings)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(remotePathMappings.id, id))
      .returning();

    this.log.info({ id }, 'Remote path mapping updated');
    return result[0] || null;
  }

  async delete(id: number): Promise<boolean> {
    const existing = await this.getById(id);
    if (!existing) return false;

    await this.db.delete(remotePathMappings).where(eq(remotePathMappings.id, id));
    this.log.info({ id }, 'Remote path mapping deleted');
    return true;
  }
}
