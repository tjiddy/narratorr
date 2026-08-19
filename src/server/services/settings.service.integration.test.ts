import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { eq } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import { createDb, runMigrations, type Db } from '@db/index.js';
import { settings } from '@db/schema.js';
import { SettingsService } from './settings.service.js';
import { createMockLogger, inject } from '../__tests__/helpers.js';
import { initializeKey, _resetKey } from '../utils/secret-codec.js';
import { SETTINGS_CATEGORIES } from '@shared/schemas/settings/registry.js';
import { createMockSettings } from '@shared/schemas/settings/create-mock-settings.fixtures.js';

const TEST_KEY = Buffer.from('a'.repeat(64), 'hex');

/**
 * The production shape #2451 diagnosed — a restore-from-backup or migration backfill writing the
 * `settings` row that a boot-time reader already missed — needs two genuinely separate connections,
 * which the chain mock cannot model. File-backed, never `:memory:`: two libSQL clients pointed at
 * `:memory:` are two different databases, so every case here would pass vacuously.
 */
describe('SettingsService — a row written by another connection (DB-backed, #2451)', () => {
  let dir: string;
  let dbFile: string;
  let reader: Db;
  let writer: Db;
  let service: SettingsService;

  beforeEach(async () => {
    initializeKey(TEST_KEY);
    dir = mkdtempSync(join(tmpdir(), 'settings-cache-'));
    dbFile = join(dir, 'narratorr.db');
    await runMigrations(dbFile);
    reader = createDb(dbFile);
    writer = createDb(dbFile);
    service = new SettingsService(reader, inject<FastifyBaseLogger>(createMockLogger()));
  });

  afterEach(() => {
    _resetKey();
    reader.$client.close();
    writer.$client.close();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // libsql can retain Windows handles; cleanup is best-effort.
    }
  });

  it('get() picks up an insert made after it returned defaults, with no invalidation call', async () => {
    expect((await service.get('library')).path).toBe('/audiobooks');

    await writer.insert(settings).values({ key: 'library', value: { path: '/real-library' } });

    expect((await service.get('library')).path).toBe('/real-library');
  });

  it('getAll() picks up an insert made after it composed defaults, with no invalidation call', async () => {
    expect((await service.getAll()).library.path).toBe('/audiobooks');

    await writer.insert(settings).values({ key: 'library', value: { path: '/real-library' } });

    expect((await service.getAll()).library.path).toBe('/real-library');
  });

  it('getAll() caches a complete row set, so a later insert is the only thing that could not have been seen', async () => {
    const all = createMockSettings({ library: { path: '/seeded' } });
    await writer.insert(settings).values(SETTINGS_CATEGORIES.map((key) => ({ key, value: all[key] })));

    expect((await service.getAll()).library.path).toBe('/seeded');

    await writer.update(settings).set({ value: { path: '/updated' } }).where(eq(settings.key, 'library'));

    // Documents the scope fence: this fix covers absent rows, not general cross-connection invalidation.
    expect((await service.getAll()).library.path).toBe('/seeded');
  });

  it('leaves an already-present row cached for the TTL — an external UPDATE is still not observed', async () => {
    await writer.insert(settings).values({ key: 'library', value: { path: '/original' } });

    expect((await service.get('library')).path).toBe('/original');

    await writer.update(settings).set({ value: { path: '/changed' } }).where(eq(settings.key, 'library'));

    expect((await service.get('library')).path).toBe('/original');
  });
});
