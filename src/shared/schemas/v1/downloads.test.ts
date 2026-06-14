import { describe, it, expect } from 'vitest';
import {
  downloadV1Schema,
  downloadV1ListQuerySchema,
  toDownloadV1,
} from './downloads.js';
import * as barrel from '../../schemas.js';

// A fully-hydrated, deliberately leaky source row: numeric rowid, FK columns,
// grab/info-hash/url internals, output path, cleanup/grab snapshots, the derived
// `status`/`indexerName` seam fields, and a leaky linked `book` carrying its
// numeric rowid + every internal column. Typed wide (no explicit annotation) so
// the extra internal fields model what the real `DownloadWithBook` row carries —
// `toDownloadV1` must strip them all.
function makeLeakyRow() {
  return {
    id: 42,
    publicId: 'dl_test000000000000000',
    bookId: 7,
    indexerId: 3,
    downloadClientId: 2,
    title: 'Wool (Unabridged)',
    protocol: 'torrent' as const,
    infoHash: 'hash-leak',
    downloadUrl: 'http://leak.example/torrent',
    size: 123456,
    seeders: 12,
    clientStatus: 'completed' as const,
    pipelineStage: 'idle' as const,
    progress: 1,
    externalId: 'ext-leak',
    errorMessage: null,
    guid: 'guid-leak',
    outputPath: '/downloads/wool',
    bookStatusAtGrab: 'importing' as const,
    addedAt: new Date('2024-01-02T03:04:05.000Z'),
    completedAt: new Date('2024-01-02T04:05:06.000Z'),
    progressUpdatedAt: new Date('2024-01-02T03:30:00.000Z'),
    pendingCleanup: null,
    // Derived display status + indexer name (the service's compatibility seam).
    status: 'completed' as const,
    indexerName: 'AudioBookBay',
    book: {
      id: 7,
      publicId: 'bk_test000000000000000',
      title: 'Wool',
      status: 'imported',
      slug: 'wool',
      asin: 'B00LEAK',
      lastGrabInfoHash: 'book-hash-leak',
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  };
}

const DTO_KEYS = [
  'addedAt',
  'book',
  'clientStatus',
  'completedAt',
  'errorMessage',
  'id',
  'pipelineStage',
  'progress',
  'protocol',
  'status',
  'title',
].sort();

describe('toDownloadV1 projection (zero-leak)', () => {
  it('emits exactly the documented key set — no internal fields', () => {
    const dto = toDownloadV1(makeLeakyRow());
    expect(Object.keys(dto).sort()).toEqual(DTO_KEYS);
  });

  it('maps id to the opaque dl_ publicId (string), not the numeric rowid', () => {
    const dto = toDownloadV1(makeLeakyRow());
    expect(dto.id).toBe('dl_test000000000000000');
    expect(dto.id).not.toBe(42);
  });

  it('maps book to the bk_ publicId cross-ref, never the numeric book.id', () => {
    const dto = toDownloadV1(makeLeakyRow());
    expect(dto.book).toEqual({ id: 'bk_test000000000000000' });
    expect(Object.keys(dto.book!).sort()).toEqual(['id']);
  });

  it('is book: null when the source book is absent (bookId null / deleted)', () => {
    const { book, ...noBook } = makeLeakyRow();
    void book;
    expect(toDownloadV1(noBook).book).toBeNull();
  });

  describe('date wire type (ISO 8601 strings)', () => {
    it('emits addedAt as the exact ISO string, never a Date', () => {
      const dto = toDownloadV1(makeLeakyRow());
      expect(typeof dto.addedAt).toBe('string');
      expect(dto.addedAt).toBe('2024-01-02T03:04:05.000Z');
      expect(dto.addedAt).not.toBeInstanceOf(Date);
    });

    it('emits completedAt as the exact ISO string when present', () => {
      const dto = toDownloadV1(makeLeakyRow());
      expect(typeof dto.completedAt).toBe('string');
      expect(dto.completedAt).toBe('2024-01-02T04:05:06.000Z');
    });

    it('emits completedAt as null when the source is null (never a Date)', () => {
      const dto = toDownloadV1({ ...makeLeakyRow(), completedAt: null });
      expect(dto.completedAt).toBeNull();
    });
  });

  describe('status derivation across representative tuples', () => {
    it.each([
      ['completed', 'idle', 'completed'],
      ['completed', 'importing', 'importing'],
      ['completed', 'pending_review', 'pending_review'],
      ['failed', 'idle', 'failed'],
      ['downloading', 'idle', 'downloading'],
    ] as const)('(%s, %s) -> %s', (clientStatus, pipelineStage, expected) => {
      const dto = toDownloadV1({ ...makeLeakyRow(), clientStatus, pipelineStage });
      expect(dto.status).toBe(expected);
      // The canonical axes are exposed alongside the derived status.
      expect(dto.clientStatus).toBe(clientStatus);
      expect(dto.pipelineStage).toBe(pipelineStage);
    });
  });

  describe('explicit leak guards', () => {
    it.each([
      'infoHash',
      'downloadUrl',
      'guid',
      'externalId',
      'outputPath',
      'bookStatusAtGrab',
      'pendingCleanup',
      'bookId',
      'indexerId',
      'downloadClientId',
      'indexerName',
      'progressUpdatedAt',
      'size',
      'seeders',
    ])('does not emit %s', (field) => {
      expect(toDownloadV1(makeLeakyRow())).not.toHaveProperty(field);
    });
  });

  it('copies title, protocol, progress, and errorMessage through', () => {
    const dto = toDownloadV1({ ...makeLeakyRow(), errorMessage: 'boom', progress: 0.5, protocol: 'usenet' });
    expect(dto.title).toBe('Wool (Unabridged)');
    expect(dto.protocol).toBe('usenet');
    expect(dto.progress).toBe(0.5);
    expect(dto.errorMessage).toBe('boom');
  });
});

describe('downloadV1Schema (fail-closed, .strict())', () => {
  const valid = {
    id: 'dl_1',
    title: 'Wool',
    status: 'completed',
    clientStatus: 'completed',
    pipelineStage: 'idle',
    book: { id: 'bk_1' },
    protocol: 'torrent',
    progress: 1,
    addedAt: '2024-01-02T03:04:05.000Z',
    completedAt: '2024-01-02T04:05:06.000Z',
    errorMessage: null,
  };

  it('round-trips a projected DTO', () => {
    expect(downloadV1Schema.safeParse(valid).success).toBe(true);
  });

  it('round-trips with book: null and completedAt: null', () => {
    expect(downloadV1Schema.safeParse({ ...valid, book: null, completedAt: null }).success).toBe(true);
  });

  it.each(['infoHash', 'bookId', 'downloadUrl', 'externalId', 'guid', 'outputPath'])(
    'rejects (does NOT strip) an injected internal field: %s',
    (field) => {
      const result = downloadV1Schema.safeParse({ ...valid, [field]: 'leak' });
      expect(result.success).toBe(false);
    },
  );

  it('rejects a numeric-rowid leak on the book cross-ref (nested strict)', () => {
    const result = downloadV1Schema.safeParse({ ...valid, book: { id: 'bk_1', bookId: 7 } });
    expect(result.success).toBe(false);
  });

  it('rejects a non-canonical status / clientStatus / pipelineStage', () => {
    expect(downloadV1Schema.safeParse({ ...valid, status: 'bogus' }).success).toBe(false);
    expect(downloadV1Schema.safeParse({ ...valid, clientStatus: 'importing' }).success).toBe(false);
    expect(downloadV1Schema.safeParse({ ...valid, pipelineStage: 'queued' }).success).toBe(false);
  });

  it('rejects a Date for addedAt (wire type must be an ISO string)', () => {
    expect(downloadV1Schema.safeParse({ ...valid, addedAt: new Date() }).success).toBe(false);
  });
});

describe('downloadV1ListQuerySchema (pagination-only, strict)', () => {
  it('accepts limit/offset and coerces to numbers', () => {
    const result = downloadV1ListQuerySchema.safeParse({ limit: '50', offset: '10' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.limit).toBe(50);
      expect(result.data.offset).toBe(10);
    }
  });

  it('rejects unknown query params (cursor / snake_case sort_by)', () => {
    expect(downloadV1ListQuerySchema.safeParse({ cursor: 'abc' }).success).toBe(false);
    expect(downloadV1ListQuerySchema.safeParse({ sort_by: 'title' }).success).toBe(false);
  });

  it('enforces pagination bounds', () => {
    expect(downloadV1ListQuerySchema.safeParse({ limit: '500' }).success).toBe(true);
    expect(downloadV1ListQuerySchema.safeParse({ limit: '0' }).success).toBe(false);
    expect(downloadV1ListQuerySchema.safeParse({ limit: '501' }).success).toBe(false);
    expect(downloadV1ListQuerySchema.safeParse({ offset: '-1' }).success).toBe(false);
  });
});

// The v1 schema module is re-exported from the top-level `src/shared/schemas.ts`
// barrel; consumers import from there, not the domain file.
describe('barrel re-export', () => {
  it('exposes downloadV1Schema, toDownloadV1, and downloadV1ListQuerySchema from the schemas barrel', () => {
    expect(barrel.downloadV1Schema).toBe(downloadV1Schema);
    expect(barrel.toDownloadV1).toBe(toDownloadV1);
    expect(barrel.downloadV1ListQuerySchema).toBe(downloadV1ListQuerySchema);
  });
});
