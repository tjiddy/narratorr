import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  readOutbox,
  putOutbox,
  markOutboxFinalized,
  evictOutbox,
  __resetOutboxCache,
  type OutboxRecord,
} from './outbox.js';

const UUID = '11111111-2222-4333-8444-555555555555';
const DIGEST = 'a'.repeat(64);

const record = (overrides: Partial<OutboxRecord> = {}): OutboxRecord => ({
  version: 1,
  clientSubmissionId: UUID,
  source: 'library',
  status: 'submitting',
  payloadDigest: DIGEST,
  expectedCount: 3,
  ...overrides,
});

beforeEach(() => {
  localStorage.clear();
  __resetOutboxCache();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('outbox — round-trip and lifecycle', () => {
  it('persists and reads back a record', () => {
    putOutbox(record());
    __resetOutboxCache(); // force a fresh storage read
    expect(readOutbox('library')).toEqual(record());
  });

  it('advances submitting → finalized and stamps the durable id', () => {
    putOutbox(record());
    markOutboxFinalized('library', 42);
    expect(readOutbox('library')).toEqual(record({ status: 'finalized', submissionId: 42 }));
  });

  it('markOutboxFinalized is a no-op when nothing is stored', () => {
    markOutboxFinalized('library');
    expect(readOutbox('library')).toBeNull();
  });

  it('evicts a record', () => {
    putOutbox(record());
    evictOutbox('library');
    expect(readOutbox('library')).toBeNull();
  });
});

describe('outbox — source isolation (F69)', () => {
  it('a Manual record is not consumed by the Library page', () => {
    putOutbox(record({ source: 'manual' }));
    expect(readOutbox('library')).toBeNull();
    expect(readOutbox('manual')).toEqual(record({ source: 'manual' }));
  });
});

describe('outbox — corrupt / invalid reads are ignored + evicted (F69)', () => {
  it('ignores and evicts corrupt JSON without throwing', () => {
    localStorage.setItem('narratorr:import-outbox:library', '{not json');
    expect(() => readOutbox('library')).not.toThrow();
    expect(readOutbox('library')).toBeNull();
    __resetOutboxCache();
    expect(localStorage.getItem('narratorr:import-outbox:library')).toBeNull(); // evicted
  });

  it('ignores and evicts an unknown version', () => {
    localStorage.setItem('narratorr:import-outbox:library', JSON.stringify({ ...record(), version: 99 }));
    expect(readOutbox('library')).toBeNull();
  });

  it('ignores and evicts an invalid uuid / digest / status', () => {
    localStorage.setItem('narratorr:import-outbox:library', JSON.stringify({ ...record(), clientSubmissionId: 'not-a-uuid' }));
    expect(readOutbox('library')).toBeNull();
    __resetOutboxCache();
    localStorage.setItem('narratorr:import-outbox:library', JSON.stringify({ ...record(), payloadDigest: 'short' }));
    expect(readOutbox('library')).toBeNull();
    __resetOutboxCache();
    localStorage.setItem('narratorr:import-outbox:library', JSON.stringify({ ...record(), status: 'bogus' }));
    expect(readOutbox('library')).toBeNull();
  });
});

describe('outbox — throwing storage access is non-fatal (F12)', () => {
  it('a throwing getItem yields null, not a render crash', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('SecurityError'); });
    expect(() => readOutbox('library')).not.toThrow();
    expect(readOutbox('library')).toBeNull();
  });

  it('a throwing setItem does not block the in-memory snapshot from updating', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('QuotaExceeded'); });
    expect(() => putOutbox(record())).not.toThrow();
    expect(readOutbox('library')).toEqual(record()); // snapshot coherent despite failed write
  });

  it('a throwing removeItem still nulls the snapshot — a failed evict does not resurrect the record', () => {
    putOutbox(record());
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => { throw new Error('SecurityError'); });
    expect(() => evictOutbox('library')).not.toThrow();
    expect(readOutbox('library')).toBeNull(); // stays evicted in-session
  });
});
