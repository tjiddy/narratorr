import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, writeFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createTestApp,
  createMockServices,
  resetMockServices,
  createMockDb,
  mockDbChain,
  installMockAppLog,
  inject,
} from '../__tests__/helpers.js';
import { createMockSettings } from '../../shared/schemas/settings/create-mock-settings.fixtures.js';
import type { Db } from '../../db/index.js';
import type { Services } from './index.js';
import type { CompanionEbookRow } from '../services/types.js';
import { isCompanionEbookEligible } from '../services/companion-ebook-eligibility.js';
import { findCompanionEbookCandidates } from '../services/companion-ebook-discovery.js';
import { openCompanionEbook } from '../services/companion-ebook-open.js';

/**
 * The three collaborators are wrapped in spies that DELEGATE to the real implementations, so
 * every case below still runs against a real temp directory while the two negative invariants
 * — "eligibility is never called on the download path" and "no `readdir` for a stored-only
 * status" — stay assertable. They live in modules separate from the route, which is what makes
 * `vi.mock` intercept the route's call at all (esm-same-module-vi-mock-bypass).
 */
vi.mock('../services/companion-ebook-eligibility.js', async () => {
  const actual = await vi.importActual<typeof import('../services/companion-ebook-eligibility.js')>(
    '../services/companion-ebook-eligibility.js',
  );
  return { ...actual, isCompanionEbookEligible: vi.fn(actual.isCompanionEbookEligible) };
});
vi.mock('../services/companion-ebook-discovery.js', async () => {
  const actual = await vi.importActual<typeof import('../services/companion-ebook-discovery.js')>(
    '../services/companion-ebook-discovery.js',
  );
  return { ...actual, findCompanionEbookCandidates: vi.fn(actual.findCompanionEbookCandidates) };
});
vi.mock('../services/companion-ebook-open.js', async () => {
  const actual = await vi.importActual<typeof import('../services/companion-ebook-open.js')>(
    '../services/companion-ebook-open.js',
  );
  return { ...actual, openCompanionEbook: vi.fn(actual.openCompanionEbook) };
});

const BOOK_ID = 11;
const EPUB = 'The Book, Volume 1 — édition.epub';
const EPUB_BYTES = 'PK pretend epub payload';

function row(overrides: Partial<CompanionEbookRow> = {}): CompanionEbookRow {
  return {
    bookId: BOOK_ID,
    status: 'available',
    filename: EPUB,
    sizeBytes: Buffer.byteLength(EPUB_BYTES),
    mtimeMs: 1_700_000_000_000,
    ctimeMs: 1_700_000_000_000,
    validationCode: null,
    candidateCount: 1,
    selectedFilename: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  } as CompanionEbookRow;
}

/** Recursively collect every string leaf of a log record, for the no-leak scan. */
function stringLeaves(value: unknown, acc: string[] = []): string[] {
  if (typeof value === 'string') acc.push(value);
  else if (Array.isArray(value)) for (const v of value) stringLeaves(v, acc);
  else if (value && typeof value === 'object') for (const v of Object.values(value)) stringLeaves(v, acc);
  return acc;
}

describe('companion ebook owner routes', () => {
  let app: Awaited<ReturnType<typeof createTestApp>>;
  let services: Services;
  let db: ReturnType<typeof createMockDb>;
  let libraryRoot: string;
  let bookPath: string;

  beforeEach(async () => {
    vi.mocked(isCompanionEbookEligible).mockClear();
    vi.mocked(findCompanionEbookCandidates).mockClear();
    vi.mocked(openCompanionEbook).mockClear();

    libraryRoot = await realpath(mkdtempSync(join(tmpdir(), 'narratorr-1974-route-')));
    bookPath = join(libraryRoot, 'Author', 'Title');
    await mkdir(bookPath, { recursive: true });

    services = createMockServices();
    db = createMockDb();
    app = await createTestApp(services, inject<Db>(db));

    setSettings({ enabled: true });
    setBook({});
    setObservation(row());
  });

  afterEach(async () => {
    await app.close();
    resetMockServices(services);
    rmSync(libraryRoot, { recursive: true, force: true });
  });

  /** Deep-cloned per call by the shared factory — a mutation here cannot leak into later tests. */
  function setSettings(opts: { enabled: boolean; root?: string }) {
    const settings = createMockSettings({
      companionEpub: { enabled: opts.enabled },
      library: { path: opts.root ?? libraryRoot },
    });
    (services.settings.get as Mock).mockImplementation((category: keyof typeof settings) =>
      Promise.resolve(settings[category]),
    );
  }

  function setBook(overrides: Record<string, unknown> | null) {
    (services.book.getById as Mock).mockResolvedValue(
      overrides === null ? null : { id: BOOK_ID, status: 'imported', path: bookPath, title: 'Title', ...overrides },
    );
  }

  function setObservation(observation: CompanionEbookRow | null) {
    db.select.mockReturnValue(mockDbChain(observation ? [observation] : []));
  }

  async function writeEpub(name = EPUB, bytes = EPUB_BYTES) {
    await writeFile(join(bookPath, name), bytes);
  }

  const download = () => app.inject({ method: 'GET', url: `/api/books/${BOOK_ID}/companion-epub` });
  const state = () => app.inject({ method: 'GET', url: `/api/books/${BOOK_ID}/companion-epub/state` });

  // -------------------------------------------------------------------------
  // GET /api/books/:id/companion-epub — owner download
  // -------------------------------------------------------------------------
  describe('GET /api/books/:id/companion-epub', () => {
    it('streams the file with the documented headers', async () => {
      await writeEpub();
      const res = await download();

      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe('application/epub+zip');
      expect(res.headers['cache-control']).toBe('private, no-store');
      // Every space, the comma, the em dash, and the accented character each collapse to `-`,
      // so nothing can break out of the quoted header value.
      expect(res.headers['content-disposition']).toBe(
        'attachment; filename="The-Book--Volume-1----dition.epub"',
      );
      expect(res.rawPayload.toString()).toBe(EPUB_BYTES);
    });

    describe('Content-Length comes from fstat, never companion_ebooks.size_bytes', () => {
      it('when the real file is LARGER than the stored size', async () => {
        const bytes = `${EPUB_BYTES} plus a great deal more content than was ever observed`;
        await writeEpub(EPUB, bytes);
        setObservation(row({ sizeBytes: 3 }));

        const res = await download();

        expect(res.statusCode).toBe(200);
        expect(res.headers['content-length']).toBe(String(Buffer.byteLength(bytes)));
        expect(res.rawPayload.toString()).toBe(bytes);
      });

      it('when the real file is SMALLER than the stored size', async () => {
        const bytes = 'tiny';
        await writeEpub(EPUB, bytes);
        setObservation(row({ sizeBytes: 9_999_999 }));

        const res = await download();

        expect(res.statusCode).toBe(200);
        expect(res.headers['content-length']).toBe(String(Buffer.byteLength(bytes)));
        expect(res.rawPayload.toString()).toBe(bytes);
      });
    });

    it('returns 409 when the feature is disabled', async () => {
      await writeEpub();
      setSettings({ enabled: false });

      const res = await download();
      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual({ error: expect.any(String) });
    });

    it('returns 404 for an unknown book', async () => {
      setBook(null);
      expect((await download()).statusCode).toBe(404);
    });

    it('returns 404 when books.status is missing, leaving the available row untouched', async () => {
      await writeEpub();
      setBook({ status: 'missing' });

      expect((await download()).statusCode).toBe(404);
      expect(db.update).not.toHaveBeenCalled();
      expect(db.insert).not.toHaveBeenCalled();
      expect(db.delete).not.toHaveBeenCalled();
    });

    it.each(['none', 'ambiguous', 'invalid', 'drm_protected'] as const)(
      'returns 404 for a %s observation',
      async (status) => {
        await writeEpub();
        setObservation(row({ status }));
        expect((await download()).statusCode).toBe(404);
      },
    );

    it('returns 404 when there is no observation row', async () => {
      await writeEpub();
      setObservation(null);
      expect((await download()).statusCode).toBe(404);
    });

    it.each(['', '   ', null])('returns 404 for a blank books.path (%j)', async (path) => {
      await writeEpub();
      setBook({ path });
      expect((await download()).statusCode).toBe(404);
    });

    it('returns 404 when the row is available but the file is gone, and writes nothing', async () => {
      const res = await download();

      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: expect.any(String) });
      expect(db.update).not.toHaveBeenCalled();
      expect(db.insert).not.toHaveBeenCalled();
      expect(db.delete).not.toHaveBeenCalled();
    });

    // AC17 — a negative integration invariant, and a decision reviewers are told not to refile.
    describe('isCompanionEbookEligible is never called', () => {
      it('on the 200 path', async () => {
        await writeEpub();
        expect((await download()).statusCode).toBe(200);
        expect(vi.mocked(isCompanionEbookEligible)).not.toHaveBeenCalled();
      });

      it('on a 404 path', async () => {
        expect((await download()).statusCode).toBe(404);
        expect(vi.mocked(isCompanionEbookEligible)).not.toHaveBeenCalled();
      });
    });

    it('closes the handle exactly once on success', async () => {
      await writeEpub();
      const closeSpy = vi.fn();
      const actual = await vi.importActual<typeof import('../services/companion-ebook-open.js')>(
        '../services/companion-ebook-open.js',
      );
      vi.mocked(openCompanionEbook).mockImplementationOnce(async (input, log) => {
        const result = await actual.openCompanionEbook(input, log);
        if (result.outcome !== 'ok') return result;
        const originalClose = result.handle.close.bind(result.handle);
        result.handle.close = async () => { closeSpy(); return originalClose(); };
        return result;
      });

      const res = await download();

      expect(res.statusCode).toBe(200);
      expect(res.rawPayload.toString()).toBe(EPUB_BYTES);
      expect(closeSpy).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // GET /api/books/:id/companion-epub/state — the owner read
  // -------------------------------------------------------------------------
  describe('GET /api/books/:id/companion-epub/state', () => {
    it('returns 409 when the feature is disabled', async () => {
      setSettings({ enabled: false });
      expect((await state()).statusCode).toBe(409);
    });

    it('returns 404 for an unknown book', async () => {
      setBook(null);
      expect((await state()).statusCode).toBe(404);
    });

    it.each<[string, Record<string, unknown>]>([
      ['a non-imported book', { status: 'missing' }],
      ['a blank path', { path: '   ' }],
      ['a path outside the library root', { path: '/tmp/somewhere-else' }],
      ['a path that is a file, not a directory', { path: 'FILE' }],
    ])('returns 404 for %s', async (_label, overrides) => {
      if (overrides.path === 'FILE') {
        const filePath = join(bookPath, 'not-a-directory');
        await writeFile(filePath, 'x');
        setBook({ path: filePath });
      } else {
        setBook(overrides);
      }

      expect((await state()).statusCode).toBe(404);
    });

    describe('the four stored-only statuses', () => {
      it.each([
        ['available', row({ status: 'available', candidateCount: 2, selectedFilename: EPUB })],
        ['none', row({ status: 'none', filename: null, sizeBytes: null, candidateCount: 0 })],
        ['invalid', row({ status: 'invalid', validationCode: 'not_a_zip', candidateCount: 1 })],
        ['drm_protected', row({ status: 'drm_protected', candidateCount: 1 })],
      ])('round-trips a %s row into the payload with no readdir', async (_label, stored) => {
        // A live directory full of candidates proves the response came from the ROW.
        await writeEpub('a.epub');
        await writeEpub('b.epub');
        setObservation(stored);

        const res = await state();

        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual({
          status: stored.status,
          filename: stored.filename,
          sizeBytes: stored.sizeBytes,
          validationCode: stored.validationCode,
          candidateCount: stored.candidateCount,
          selectedFilename: stored.selectedFilename,
          candidates: [],
        });
        expect(vi.mocked(findCompanionEbookCandidates)).not.toHaveBeenCalled();
      });
    });

    it('returns the all-null none payload for an eligible book with no observation row, with no readdir', async () => {
      await writeEpub('a.epub');
      setObservation(null);

      const res = await state();

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        status: 'none',
        filename: null,
        sizeBytes: null,
        validationCode: null,
        candidateCount: 0,
        selectedFilename: null,
        candidates: [],
      });
      expect(vi.mocked(findCompanionEbookCandidates)).not.toHaveBeenCalled();
    });

    it('reflects a stored selectedFilename', async () => {
      setObservation(row({ candidateCount: 2, selectedFilename: EPUB }));
      expect((await state()).json()).toMatchObject({ selectedFilename: EPUB });
    });

    // AC26 — the stored row says 2 in EVERY case; only the live directory differs.
    describe('the stored-ambiguous live-cardinality matrix', () => {
      beforeEach(() => {
        setObservation(row({
          status: 'ambiguous',
          filename: null,
          sizeBytes: null,
          mtimeMs: null,
          ctimeMs: null,
          candidateCount: 2,
        }));
      });

      it('0 live files → none, count 0', async () => {
        const res = await state();
        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual({
          status: 'none',
          filename: null,
          sizeBytes: null,
          validationCode: null,
          candidateCount: 0,
          selectedFilename: null,
          candidates: [],
        });
      });

      it('1 live file → ambiguous, count 1, one index', async () => {
        await writeEpub('only.epub');
        const res = await state();

        // A single-candidate picker is not degenerate: it is one radio the owner can act on.
        expect(res.json()).toMatchObject({
          status: 'ambiguous',
          candidateCount: 1,
          candidates: [{ index: 0, filename: 'only.epub' }],
        });
      });

      it('2 live files → ambiguous, count 2, indices 0 and 1', async () => {
        await writeEpub('b.epub');
        await writeEpub('a.epub');
        const res = await state();

        expect(res.json()).toMatchObject({
          status: 'ambiguous',
          candidateCount: 2,
          candidates: [{ index: 0, filename: 'a.epub' }, { index: 1, filename: 'b.epub' }],
        });
      });

      it('3 live files → ambiguous, count 3, indices 0..2', async () => {
        await writeEpub('c.epub');
        await writeEpub('a.epub');
        await writeEpub('b.epub');
        const res = await state();

        expect(res.json()).toMatchObject({
          status: 'ambiguous',
          candidateCount: 3,
          candidates: [
            { index: 0, filename: 'a.epub' },
            { index: 1, filename: 'b.epub' },
            { index: 2, filename: 'c.epub' },
          ],
        });
      });

      it('carries every file field as null and never inherits the stored count', async () => {
        await writeEpub('a.epub');
        const res = await state();

        expect(res.json()).toEqual({
          status: 'ambiguous',
          filename: null,
          sizeBytes: null,
          validationCode: null,
          candidateCount: 1, // NOT the stored 2
          selectedFilename: null,
          candidates: [{ index: 0, filename: 'a.epub' }],
        });
      });

      it('issues identical indices across two consecutive requests', async () => {
        await writeEpub('B.epub');
        await writeEpub('a.epub');
        await writeEpub('A.epub');

        const first = (await state()).json();
        const second = (await state()).json();

        expect(first.candidates).toEqual([
          { index: 0, filename: 'A.epub' },
          { index: 1, filename: 'B.epub' },
          { index: 2, filename: 'a.epub' },
        ]);
        expect(second).toEqual(first);
      });

      it('maps discovery gone to 404', async () => {
        vi.mocked(findCompanionEbookCandidates).mockResolvedValueOnce({ outcome: 'gone' });
        expect((await state()).statusCode).toBe(404);
      });

      it('maps discovery undetermined to 503', async () => {
        vi.mocked(findCompanionEbookCandidates).mockResolvedValueOnce({ outcome: 'undetermined' });
        const res = await state();
        expect(res.statusCode).toBe(503);
        expect(res.json()).toEqual({ error: expect.any(String) });
      });
    });
  });

  // -------------------------------------------------------------------------
  // AC7, route-boundary half
  // -------------------------------------------------------------------------
  describe('route-boundary logging', () => {
    let mockLog: ReturnType<typeof installMockAppLog>;

    beforeEach(() => {
      mockLog = installMockAppLog(app);
    });

    afterEach(() => {
      mockLog.restore();
    });

    function assertBoundaryRecord(record: unknown, outcome: string) {
      expect(record).toEqual({ bookId: BOOK_ID, outcome });
      const leaves = stringLeaves(record).join('\n');
      for (const secret of [bookPath, libraryRoot, EPUB]) {
        expect(leaves).not.toContain(secret);
      }
    }

    it('emits { bookId, outcome } and nothing else for a 404 from a non-ok helper outcome', async () => {
      const res = await download(); // the file does not exist → `missing`

      expect(res.statusCode).toBe(404);
      expect(mockLog.spies.warn).toHaveBeenCalledTimes(1);
      assertBoundaryRecord(mockLog.spies.warn.mock.calls[0]![0], 'missing');
    });

    it('emits { bookId, outcome } and nothing else for a 503 from discovery undetermined', async () => {
      setObservation(row({ status: 'ambiguous', filename: null, sizeBytes: null, candidateCount: 2 }));
      vi.mocked(findCompanionEbookCandidates).mockResolvedValueOnce({ outcome: 'undetermined' });

      const res = await state();

      expect(res.statusCode).toBe(503);
      expect(mockLog.spies.warn).toHaveBeenCalledTimes(1);
      assertBoundaryRecord(mockLog.spies.warn.mock.calls[0]![0], 'undetermined');
    });
  });
});
