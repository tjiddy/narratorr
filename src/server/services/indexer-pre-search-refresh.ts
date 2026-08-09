import type { FastifyBaseLogger } from 'fastify';
import type { IndexerAdapter } from '@core/index.js';
import { serializeError } from '../utils/serialize-error.js';
import type { IndexerRow } from './types.js';

export interface PreSearchRefreshDeps {
  log: FastifyBaseLogger;
  update: (id: number, data: { settings: Record<string, unknown> }) => Promise<unknown>;
}

export async function preSearchRefresh(
  adapter: IndexerAdapter,
  indexer: IndexerRow,
  deps: PreSearchRefreshDeps,
): Promise<{ skip: boolean; error?: string }> {
  const { log, update } = deps;

  if (!adapter.refreshStatus) {
    return { skip: false };
  }

  let status: { isVip: boolean; classname: string } | null;
  try {
    status = await adapter.refreshStatus();
  } catch (error: unknown) {
    log.debug({ indexer: indexer.name, error: serializeError(error) }, 'Pre-search status refresh failed, proceeding with stored status');
    return { skip: false };
  }

  if (!status) {
    return { skip: false };
  }

  const existingSettings = (indexer.settings ?? {}) as Record<string, unknown>;

  if (status.classname === 'Mouse') {
    try {
      await update(indexer.id, { settings: { ...existingSettings, isVip: status.isVip, classname: status.classname } });
      log.info({ id: indexer.id, classname: status.classname }, 'Persisted Mouse status from pre-search refresh');
    } catch (error: unknown) {
      log.warn({ id: indexer.id, error: serializeError(error) }, 'Failed to persist status from pre-search refresh');
    }
    return { skip: true, error: 'Searches disabled — Mouse class' };
  }

  if (existingSettings.isVip !== status.isVip || existingSettings.classname !== status.classname) {
    try {
      await update(indexer.id, { settings: { ...existingSettings, isVip: status.isVip, classname: status.classname } });
      log.info({ id: indexer.id, isVip: status.isVip, classname: status.classname }, 'Persisted class change from pre-search refresh');
    } catch (error: unknown) {
      log.warn({ id: indexer.id, error: serializeError(error) }, 'Failed to persist class change from pre-search refresh');
    }
  }

  return { skip: false };
}
