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

describe('outbox — supersession guard by clientSubmissionId (F1)', () => {
  const NEWER = '99999999-8888-4777-8666-555555555555';

  it('evictOutbox with a stale clientId does NOT delete a newer submission’s hint', () => {
    // A new submit has already replaced the single slot with NEWER; a late callback from the
    // old run must not evict it.
    putOutbox(record({ clientSubmissionId: NEWER }));
    evictOutbox('library', UUID); // stale id from the superseded run
    expect(readOutbox('library')).toEqual(record({ clientSubmissionId: NEWER })); // untouched
  });

  it('evictOutbox with the matching clientId evicts', () => {
    putOutbox(record());
    evictOutbox('library', UUID);
    expect(readOutbox('library')).toBeNull();
  });

  it('an unguarded evictOutbox always clears the slot (mount receiving/never-landed arm)', () => {
    putOutbox(record({ clientSubmissionId: NEWER }));
    evictOutbox('library'); // no expected id → owns whatever it read
    expect(readOutbox('library')).toBeNull();
  });

  it('markOutboxFinalized with a stale clientId does NOT rewrite a newer hint', () => {
    putOutbox(record({ clientSubmissionId: NEWER }));
    markOutboxFinalized('library', 42, UUID); // stale id
    expect(readOutbox('library')).toEqual(record({ clientSubmissionId: NEWER })); // still 'submitting', not stamped
  });

  it('markOutboxFinalized with the matching clientId advances the hint', () => {
    putOutbox(record());
    markOutboxFinalized('library', 42, UUID);
    expect(readOutbox('library')).toEqual(record({ status: 'finalized', submissionId: 42 }));
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
