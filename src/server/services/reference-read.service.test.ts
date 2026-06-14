import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ReferenceReadService } from './reference-read.service.js';
import { createMockDb, mockDbChain, inject } from '../__tests__/helpers.js';
import type { Db } from '../../db/index.js';

const db = createMockDb();
const service = new ReferenceReadService(inject<Db>(db));

beforeEach(() => {
  vi.clearAllMocks();
});

describe('ReferenceReadService.list* (paginated, deterministic)', () => {
  it('returns the page rows plus the full unpaginated total', async () => {
    const rows = [
      { id: 1, publicId: 'au_a', name: 'Alpha' },
      { id: 2, publicId: 'au_b', name: 'Beta' },
    ];
    db.select
      .mockReturnValueOnce(mockDbChain(rows))
      .mockReturnValueOnce(mockDbChain([{ value: 17 }]));

    const result = await service.listAuthors({ limit: 2, offset: 0 });

    expect(result).toEqual({ data: rows, total: 17 });
  });

  it('orders by name asc with id as a stable tiebreak and applies limit/offset', async () => {
    const chain = mockDbChain([]);
    db.select
      .mockReturnValueOnce(chain)
      .mockReturnValueOnce(mockDbChain([{ value: 0 }]));

    await service.listSeries({ limit: 25, offset: 50 });

    expect(chain.orderBy).toHaveBeenCalledTimes(1);
    expect(chain.orderBy.mock.calls[0]).toHaveLength(2); // name asc, id asc
    expect(chain.limit).toHaveBeenCalledWith(25);
    expect(chain.offset).toHaveBeenCalledWith(50);
  });

  it('falls back to a default limit and offset 0 when pagination is omitted', async () => {
    const chain = mockDbChain([]);
    db.select
      .mockReturnValueOnce(chain)
      .mockReturnValueOnce(mockDbChain([{ value: 0 }]));

    await service.listNarrators({});

    expect(chain.limit).toHaveBeenCalledWith(120);
    expect(chain.offset).toHaveBeenCalledWith(0);
  });

  it('coerces a missing count row to total 0', async () => {
    db.select
      .mockReturnValueOnce(mockDbChain([]))
      .mockReturnValueOnce(mockDbChain([]));

    const result = await service.listAuthors({});
    expect(result.total).toBe(0);
  });
});

describe('ReferenceReadService.getById', () => {
  it('returns the row when found', async () => {
    const row = { id: 5, publicId: 'nr_x', name: 'Kate Reading' };
    db.select.mockReturnValue(mockDbChain([row]));

    expect(await service.getNarratorById(5)).toEqual(row);
  });

  it('returns null when no row matches', async () => {
    db.select.mockReturnValue(mockDbChain([]));
    expect(await service.getSeriesById(999)).toBeNull();
  });
});
