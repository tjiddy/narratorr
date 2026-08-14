import { describe, it, expect, vi } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';
import type { IndexerAdapter } from '@core/index.js';
import { createMockLogger, inject } from '../__tests__/helpers.js';
import { createMockDbIndexer } from '../__tests__/factories.js';
import { preSearchRefresh } from './indexer-pre-search-refresh.js';

type RefreshStatus = Awaited<ReturnType<NonNullable<IndexerAdapter['refreshStatus']>>>;

const mamIndexer = createMockDbIndexer({
  id: 10, name: 'MAM', type: 'myanonamouse',
  settings: { mamId: 'test', isVip: true, classname: 'VIP' },
});

function makeDeps() {
  const update = vi.fn().mockResolvedValue(undefined);
  return { log: inject<FastifyBaseLogger>(createMockLogger()), update };
}

function adapterReturning(status: RefreshStatus): IndexerAdapter {
  return {
    type: 'myanonamouse', name: 'MAM',
    search: vi.fn(),
    test: vi.fn(),
    refreshStatus: vi.fn().mockResolvedValue(status),
  } as unknown as IndexerAdapter;
}

describe('preSearchRefresh — #2322 independently observed status groups', () => {
  it('persists the class change and returns the observation when both groups are reported', async () => {
    const deps = makeDeps();
    const adapter = adapterReturning({ isVip: false, classname: 'Power User', unsatisfied: { count: 150, limit: 150 } });

    const result = await preSearchRefresh(adapter, mamIndexer, deps);

    expect(result).toEqual({ skip: false, unsatisfied: { count: 150, limit: 150 } });
    expect(deps.update).toHaveBeenCalledWith(10, {
      settings: expect.objectContaining({ isVip: false, classname: 'Power User' }),
    });
  });

  it('persists the class change and returns no observation when only the class group is reported', async () => {
    const deps = makeDeps();
    const adapter = adapterReturning({ isVip: false, classname: 'Power User' });

    const result = await preSearchRefresh(adapter, mamIndexer, deps);

    expect(result).toEqual({ skip: false });
    expect(deps.update).toHaveBeenCalledWith(10, {
      settings: expect.objectContaining({ isVip: false, classname: 'Power User' }),
    });
  });

  it('leaves stored class fields untouched and returns the observation when only unsatisfied is reported', async () => {
    const deps = makeDeps();
    const adapter = adapterReturning({ unsatisfied: { count: 139, limit: 150 } });

    const result = await preSearchRefresh(adapter, mamIndexer, deps);

    expect(result).toEqual({ skip: false, unsatisfied: { count: 139, limit: 150 } });
    expect(deps.update).not.toHaveBeenCalled();
  });

  it('persists nothing and returns no observation when neither group is reported', async () => {
    const deps = makeDeps();
    const adapter = adapterReturning(null);

    const result = await preSearchRefresh(adapter, mamIndexer, deps);

    expect(result).toEqual({ skip: false });
    expect(deps.update).not.toHaveBeenCalled();
  });

  it('still skips and persists on the Mouse class when a pair was also observed', async () => {
    const deps = makeDeps();
    const adapter = adapterReturning({ isVip: false, classname: 'Mouse', unsatisfied: { count: 150, limit: 150 } });

    const result = await preSearchRefresh(adapter, mamIndexer, deps);

    expect(result).toEqual({ skip: true, error: 'Searches disabled — Mouse class' });
    expect(deps.update).toHaveBeenCalledWith(10, {
      settings: expect.objectContaining({ isVip: false, classname: 'Mouse' }),
    });
  });

  it('returns the observation even when persisting the class change rejects', async () => {
    const deps = makeDeps();
    deps.update.mockRejectedValue(new Error('db down'));
    const adapter = adapterReturning({ isVip: false, classname: 'Power User', unsatisfied: { count: 150, limit: 150 } });

    const result = await preSearchRefresh(adapter, mamIndexer, deps);

    expect(result).toEqual({ skip: false, unsatisfied: { count: 150, limit: 150 } });
    expect(deps.log.warn).toHaveBeenCalled();
  });

  it('reports no observation when the refresh throws', async () => {
    const deps = makeDeps();
    const adapter = {
      type: 'myanonamouse', name: 'MAM', search: vi.fn(), test: vi.fn(),
      refreshStatus: vi.fn().mockRejectedValue(new Error('Network error')),
    } as unknown as IndexerAdapter;

    expect(await preSearchRefresh(adapter, mamIndexer, deps)).toEqual({ skip: false });
  });

  it('reports no observation for an adapter with no refreshStatus hook', async () => {
    const deps = makeDeps();
    const adapter = { type: 'newznab', name: 'Newznab', search: vi.fn(), test: vi.fn() } as unknown as IndexerAdapter;

    expect(await preSearchRefresh(adapter, mamIndexer, deps)).toEqual({ skip: false });
  });

  it('does not persist a class-field pair when only unsatisfied changed', async () => {
    const deps = makeDeps();
    const adapter = adapterReturning({ isVip: true, classname: 'VIP', unsatisfied: { count: 1, limit: 150 } });

    await preSearchRefresh(adapter, mamIndexer, deps);

    expect(deps.update).not.toHaveBeenCalled();
  });

  it('never writes the observation into the indexer settings', async () => {
    const deps = makeDeps();
    const adapter = adapterReturning({ isVip: false, classname: 'Power User', unsatisfied: { count: 150, limit: 150 } });

    await preSearchRefresh(adapter, mamIndexer, deps);

    const settings = deps.update.mock.calls[0]?.[1].settings as Record<string, unknown>;
    expect(Object.keys(settings)).not.toContain('unsatisfied');
    expect(Object.keys(settings)).not.toContain('unsat');
  });
});
