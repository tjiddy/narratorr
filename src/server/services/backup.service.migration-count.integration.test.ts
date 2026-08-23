import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import { createDb, runMigrations, type Db } from '@db/index.js';
import { BackupService } from './backup.service.js';
import { createMockSettingsService } from '../__tests__/helpers.js';
import { spyStatements } from '../__tests__/statement-spy.js';

/**
 * The unit suite mocks `@libsql/client` wholesale, so it cannot tell a migration count read through
 * the shared connection from one read through a private client, nor prove the drizzle query returns
 * the shape production reads. This file runs both against a real migrated database (#2595 AC9/AC10).
 */
describe('BackupService app migration count — real DB', () => {
  let dir: string;
  let dbPath: string;
  let db: Db;
  let log: FastifyBaseLogger;

  const service = (target: Db) =>
    new BackupService(dir, dbPath, createMockSettingsService(), log, target);

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'backup-migration-count-'));
    dbPath = join(dir, 'narratorr.db');
    await runMigrations(dbPath);
    db = createDb(dbPath);
    log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as FastifyBaseLogger;
  });

  afterEach(() => {
    // libSQL may retain the directory handle on Windows.
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch (error) {
      if (process.platform !== 'win32') throw error;
    }
  });

  it('reads the real migration row count through the shared connection instead of opening its own', async () => {
    const expected = Number((await db.all(sql`SELECT COUNT(*) as count FROM __drizzle_migrations`) as { count: number }[])[0]!.count);
    expect(expected).toBeGreaterThan(0);

    const backupPath = join(dir, 'backup-copy.db');
    await fs.copyFile(dbPath, backupPath);

    const spy = spyStatements(db);
    let result;
    try {
      result = await service(db).validateRestore(backupPath);
    } finally {
      spy.restore();
    }

    expect(result).toEqual({ valid: true, backupMigrationCount: expected, appMigrationCount: expected });
    // The observation point that discriminates: before the change this query ran on a private
    // client and the shared connection saw nothing.
    expect(spy.executed.filter((statement) => /__drizzle_migrations/.test(statement.sql) && statement.scope === 'client')).toHaveLength(1);
  });

  it('leaves the shared connection open — nothing in the backup path may close it', async () => {
    const close = vi.spyOn(db.$client, 'close');
    const backupPath = join(dir, 'backup-copy.db');
    await fs.copyFile(dbPath, backupPath);

    await service(db).validateRestore(backupPath);

    expect(close).not.toHaveBeenCalled();
    // Not just "not called": the connection is still usable afterwards.
    await expect(db.all(sql`SELECT 1 as ok`)).resolves.toEqual([{ ok: 1 }]);
  });

  it('warns and assumes zero when the shared connection has no __drizzle_migrations table', async () => {
    const bareFile = join(dir, 'bare.db');
    const bare = createDb(bareFile);

    const backupPath = join(dir, 'backup-copy.db');
    await fs.copyFile(dbPath, backupPath);

    const result = await service(bare).validateRestore(backupPath);

    expect(log.warn).toHaveBeenCalledWith('Could not query app migration count, assuming 0');
    // Every migrated backup then looks newer than the app, which is the pre-existing safe refusal.
    expect(result.valid).toBe(false);
    expect(result.appMigrationCount).toBe(0);
    expect(result.error).toContain('newer version');
  });
});
