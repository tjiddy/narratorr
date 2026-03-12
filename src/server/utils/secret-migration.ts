import { eq } from 'drizzle-orm';
import type { Db } from '../../db/index.js';
import type { FastifyBaseLogger } from 'fastify';
import { indexers, downloadClients, settings } from '../../db/schema.js';
import { isEncrypted, encryptFields, type SecretEntity } from './secret-codec.js';

/** Settings categories that contain secret fields. */
const SECRET_SETTINGS_CATEGORIES: { key: string; entity: SecretEntity }[] = [
  { key: 'prowlarr', entity: 'prowlarr' },
  { key: 'auth', entity: 'auth' },
  { key: 'network', entity: 'network' },
];

/** Check if a settings object has any plaintext (non-encrypted) secret fields. */
function hasPlaintextSecrets(entity: SecretEntity, obj: Record<string, unknown>): boolean {
  const FIELD_MAP: Record<SecretEntity, readonly string[]> = {
    indexer: ['apiKey', 'flareSolverrUrl', 'mamId'],
    downloadClient: ['password', 'apiKey'],
    prowlarr: ['apiKey'],
    auth: ['sessionSecret', 'apiKey'],
    network: ['proxyUrl'],
    importList: ['apiKey'],
  };
  const fields = FIELD_MAP[entity] ?? [];
  for (const field of fields) {
    const value = obj[field];
    if (typeof value === 'string' && value.length > 0 && !isEncrypted(value)) {
      return true;
    }
  }
  return false;
}

/**
 * Migrate all plaintext secrets to encrypted form.
 * Idempotent — skips values already prefixed with $ENC$.
 */
export async function migrateSecretsToEncrypted(
  db: Db,
  key: Buffer,
  log: FastifyBaseLogger,
): Promise<void> {
  let migratedCount = 0;

  // 1. Indexers
  const allIndexers = await db.select().from(indexers);
  for (const row of allIndexers) {
    const s = (row.settings ?? {}) as Record<string, unknown>;
    if (!hasPlaintextSecrets('indexer', s)) continue;
    const encrypted = encryptFields('indexer', { ...s }, key);
    await db.update(indexers).set({ settings: encrypted }).where(eq(indexers.id, row.id));
    migratedCount++;
  }

  // 2. Download clients
  const allClients = await db.select().from(downloadClients);
  for (const row of allClients) {
    const s = (row.settings ?? {}) as Record<string, unknown>;
    if (!hasPlaintextSecrets('downloadClient', s)) continue;
    const encrypted = encryptFields('downloadClient', { ...s }, key);
    await db.update(downloadClients).set({ settings: encrypted }).where(eq(downloadClients.id, row.id));
    migratedCount++;
  }

  // 3. Settings rows (prowlarr, auth, network)
  const allSettings = await db.select().from(settings);
  for (const category of SECRET_SETTINGS_CATEGORIES) {
    const row = allSettings.find((r) => r.key === category.key);
    if (!row) continue;
    const value = (row.value ?? {}) as Record<string, unknown>;
    if (!hasPlaintextSecrets(category.entity, value)) continue;
    const encrypted = encryptFields(category.entity, { ...value }, key);
    await db
      .insert(settings)
      .values({ key: category.key, value: encrypted as unknown })
      .onConflictDoUpdate({
        target: settings.key,
        set: { value: encrypted as unknown },
      });
    migratedCount++;
  }

  log.info({ migrated: migratedCount }, 'Secret migration complete');
}
