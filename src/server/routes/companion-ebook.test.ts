import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, writeFile, realpath, rm, symlink } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createTestApp,
  createAuthTestApp,
  createMockServices,
  resetMockServices,
  createMockDb,
  mockDbChain,
  installMockAppLog,
  createMockLogger,
  inject,
  type ZodTestApp,
} from '../__tests__/helpers.js';
import { createMockSettings } from '@shared/schemas/settings/create-mock-settings.fixtures.js';
import type { Db } from '@db/index.js';
import type { Services } from './index.js';
import type { CompanionEbookRow } from '../services/types.js';
import { isCompanionEbookExposed, isCompanionEbookOwnerReadable } from '@shared/companion-ebook-exposure.js';
import { isCompanionEbookEligible } from '../services/companion-ebook-eligibility.js';
import { findCompanionEbookCandidates } from '../services/companion-ebook-discovery.js';
import { CAN_SYMLINK } from '../__tests__/windows-fs.js';

// Two files differing only by case cannot coexist on a case-insensitive FS —
// the fixture itself is unrepresentable on NTFS, so the test can only be skipped.
const CASE_SENSITIVE_FS = process.platform !== 'win32';
import { openCompanionEbook, resolveCompanionEbookPath } from '../services/companion-ebook-open.js';
import * as F from '@core/__tests__/epub-archive.fixture.js';
import { MAX_EPUB_COVER_BYTES } from '@core/epub/limits.js';
import { CompanionEbookReconciler, type CompanionSelectionResult } from '../services/companion-ebook-reconciler.js';

/**
 * The three collaborators are wrapped in spies that DELEGATE to the real implementations, so
 * every case below still runs against a real temp directory while the two negative invariants
 * — "eligibility is never called on the download path" and "no `readdir` for a stored-only
 * status" — stay assertable. They live in modules separate from the route, which is what makes
 * `vi.mock` intercept the route's call at all (esm-same-module-vi-mock-bypass).
 */
vi.mock('@shared/companion-ebook-exposure.js', async () => {
  const actual = await vi.importActual<typeof import('@shared/companion-ebook-exposure.js')>(
    '@shared/companion-ebook-exposure.js',
  );
  // BOTH gates are wrapped (#2038). The negative assertions on the selection `PUT` and the
  // refresh `POST` name both, so a route that starts consulting the OTHER one is still caught —
  // spying only the advertisement gate would leave those cases vacuous the moment the owner
  // ladder stopped calling it.
  return {
    ...actual,
    isCompanionEbookExposed: vi.fn(actual.isCompanionEbookExposed),
    isCompanionEbookOwnerReadable: vi.fn(actual.isCompanionEbookOwnerReadable),
  };
});
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
  return {
    ...actual,
    openCompanionEbook: vi.fn(actual.openCompanionEbook),
    // #1976 — the two read routes reach the resolver, not the opener. Spied for the same
    // reason: the `inspect_failed` case needs the REAL resolver to succeed and the file to
    // vanish immediately afterwards, which is only expressible from inside a delegating wrapper.
    resolveCompanionEbookPath: vi.fn(actual.resolveCompanionEbookPath),
  };
});

/**
 * A delegating `unzipper` wrapper, so ONE case can fail a single archive member's inflated
 * stream (`extract.test.ts`'s `failEntry` technique). `onStream` defaults to `undefined`, so
 * every other case in this file reads real archives through the real reader.
 *
 * `File.stream` is an own property, so it can be wrapped in place on a real reader result.
 */
const epubHooks = vi.hoisted(() => ({
  onStream: undefined as ((name: string) => Readable | undefined) | undefined,
}));

vi.mock('unzipper', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const real = (actual.default ?? actual) as typeof import('unzipper');
  const custom = async (source: unknown, options: unknown) => {
    const directory = await (real.Open.custom as unknown as
      (s: unknown, o: unknown) => Promise<{ files: Array<Record<string, unknown>> }>)(source, options);
    for (const file of directory.files) {
      const original = (file.stream as (...a: unknown[]) => Readable).bind(file);
      const name = String(file.path);
      file.stream = (...args: unknown[]) => epubHooks.onStream?.(name) ?? original(...args);
    }
    return directory;
  };
  return { ...actual, default: { ...real, Open: { ...real.Open, custom } } };
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
    vi.mocked(resolveCompanionEbookPath).mockClear();
    vi.mocked(isCompanionEbookExposed).mockClear();
    vi.mocked(isCompanionEbookOwnerReadable).mockClear();
    epubHooks.onStream = undefined;

    libraryRoot = await realpath(mkdtempSync(join(tmpdir(), 'narratorr-1974-route-')));
    bookPath = join(libraryRoot, 'Author', 'Title');
    await mkdir(bookPath, { recursive: true });

    services = createMockServices();
    db = createMockDb();
    // #1960 AC26 — every read that cannot serve its file now enqueues a reconcile. The
    // unconfigured Proxy stub REJECTS, and `fireAndForget` logs that at warn, which would add a
    // second warn to every boundary-record assertion in this suite. Resolve it by default; the
    // reconcile tests below assert the call count, and the isolation tests (plus #2040's
    // trigger-context case) opt back into the rejection explicitly.
    (services.companionEbook.reconcileBook as unknown as Mock).mockResolvedValue(undefined);
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

  /**
   * The AC6 route-boundary rule, in one place: the `warn` record is `{ bookId, outcome }` and
   * nothing else, and no path, library root, or basename appears anywhere in it. #1976's three
   * routes reuse this verbatim rather than restating it.
   *
   * It is deliberately NOT applied to `debug` records — the resolver's carry the path by
   * design (AC2/AC6), and asserting otherwise would contradict `companion-ebook-open.test.ts`.
   */
  function assertBoundaryRecord(record: unknown, outcome: string) {
    expect(record).toEqual({ bookId: BOOK_ID, outcome });
    const leaves = stringLeaves(record).join('\n');
    for (const secret of [bookPath, libraryRoot, EPUB]) {
      expect(leaves).not.toContain(secret);
    }
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

    // `drm_protected` is deliberately NOT in this list since #2038 — it is served, and its 200
    // is the case immediately below. The other three stay: `none` and `ambiguous` name no file,
    // and `invalid`'s file is not servable.
    it.each(['none', 'ambiguous', 'invalid'] as const)(
      'returns 404 for a %s observation',
      async (status) => {
        await writeEpub();
        setObservation(row({ status }));
        expect((await download()).statusCode).toBe(404);
      },
    );

    /**
     * #2038 AC3 — the owner downloads a stored `drm_protected` row. Serving the bytes removes no
     * DRM (the file is already on the owner's disk), and when the classifier is WRONG the block
     * converted a misclassification into denied access to a perfectly good file.
     *
     * The row carries `filename`/`sizeBytes`/`mtimeMs`/`ctimeMs` because
     * `ck_companion_ebooks_file_present` guarantees it for `drm_protected` exactly as it does for
     * `available` — this is not a fixture convenience.
     */
    it('streams a stored drm_protected row with the same headers and bytes as an available one', async () => {
      const bytes = `${EPUB_BYTES} for a book the classifier called DRM'd`;
      await writeEpub(EPUB, bytes);
      // A deliberately wrong stored size, so the `Content-Length` below can only have come from
      // the fstat — the same observation the `available` pair above makes.
      setObservation(row({ status: 'drm_protected', sizeBytes: 7 }));

      const res = await download();

      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe('application/epub+zip');
      expect(res.headers['content-length']).toBe(String(Buffer.byteLength(bytes)));
      expect(res.headers['content-disposition']).toBe(
        'attachment; filename="The-Book--Volume-1----dition.epub"',
      );
      expect(res.rawPayload.toString()).toBe(bytes);
    });

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

      it.skipIf(!CASE_SENSITIVE_FS)('issues identical indices across two consecutive requests', async () => {
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

  // =========================================================================
  // #1976 — the two owner reads and the selection PUT
  // =========================================================================

  // --- EPUB fixture shapes, composed from `buildEpub` options -----------------
  // Composed HERE because each shape is this suite's own route fixture, not a shared one. The
  // cap argument that used to sit here is gone: #2003 split the fixture module in two and #2041
  // moved the DRM shape into it, so headroom is no longer the reason anything stays local.

  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);
  const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
  const GIF = Buffer.concat([Buffer.from('GIF89a', 'ascii'), Buffer.from([0x01, 0x00])]);
  const WEBP = Buffer.concat([
    Buffer.from('RIFF', 'ascii'),
    Buffer.from([0x10, 0x00, 0x00, 0x00]),
    Buffer.from('WEBP', 'ascii'),
  ]);
  const SVG = Buffer.from('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"/>', 'utf8');

  const CHAPTER = F.CHAPTER_ITEM;
  const NAV_ITEM: F.ManifestItem = {
    id: 'nav', href: 'nav.xhtml', mediaType: 'application/xhtml+xml', properties: 'nav',
  };
  const NCX_ITEM: F.ManifestItem = { id: 'ncx', href: 'toc.ncx', mediaType: 'application/x-dtbncx+xml' };
  const NAV_ENTRY = 'OEBPS/nav.xhtml';
  const NCX_ENTRY = 'OEBPS/toc.ncx';
  const COVER_ENTRY = 'OEBPS/cover.png';

  function coverItem(mediaType: string): F.ManifestItem {
    return { id: 'cover', href: 'cover.png', mediaType, properties: 'cover-image' };
  }

  /** An EPUB 3 book whose nav `<ol>` is built from `nodes`. */
  function navRowsBook(nodes: readonly F.TocNode[], metadata?: F.MetadataOptions): F.EpubOptions {
    return {
      packageOptions: { items: [CHAPTER, NAV_ITEM], ...(metadata && { metadata }) },
      files: [{ name: NAV_ENTRY, content: F.navDocumentXml(F.navXml(nodes)) }],
    };
  }

  /** An EPUB 2 book whose NCX `<navMap>` is built from `nodes`, reached through `spine@toc`. */
  function ncxRowsBook(nodes: readonly F.TocNode[]): F.EpubOptions {
    return {
      packageOptions: {
        items: [CHAPTER, NCX_ITEM],
        spine: '<spine toc="ncx"><itemref idref="ch1"/></spine>',
      },
      files: [{ name: NCX_ENTRY, content: F.ncxDocumentXml(F.navMapXml(nodes)) }],
    };
  }

  /** A book carrying `bytes` as its cover, declared through `properties="cover-image"`. */
  function coverBook(bytes: Buffer, declaredMediaType = 'image/png'): F.EpubOptions {
    return {
      packageOptions: { items: [CHAPTER, coverItem(declaredMediaType)] },
      files: [{ name: COVER_ENTRY, content: bytes }],
    };
  }

  /** Write a built EPUB at the stored basename the `available` row names. */
  async function placeEpub(options: F.EpubOptions = {}): Promise<void> {
    await writeFile(join(bookPath, EPUB), await F.buildEpub(options));
  }

  const metadataReq = () => app.inject({ method: 'GET', url: `/api/books/${BOOK_ID}/companion-epub/metadata` });
  const coverReq = () => app.inject({ method: 'GET', url: `/api/books/${BOOK_ID}/companion-epub/cover` });

  /** Both read routes share every gate, both resolver mappings, and both inspection negatives. */
  const READ_ROUTES: Array<[string, () => ReturnType<typeof metadataReq>]> = [
    ['metadata', metadataReq],
    ['cover', coverReq],
  ];

  /**
   * All THREE companion-file routes, for the named owner-readable-gate consistency test
   * (PR #2010 F2 / DRY-3). Download is in here deliberately: the gate is now `the` decision at
   * one site rather than two that must stay aligned, and this is the test that fails if a
   * later change re-forks it. Every case below is a gate NEGATIVE, which is exactly the part
   * all three share — their success tails (stream / metadata DTO / cover bytes) differ and are
   * asserted per route elsewhere.
   */
  const GATED_ROUTES: Array<[string, () => ReturnType<typeof metadataReq>]> = [
    ['companion-epub (download)', download],
    ...READ_ROUTES,
  ];

  // -------------------------------------------------------------------------
  // The owner-readable gate — ONE decision, shared by all three routes (F2)
  // -------------------------------------------------------------------------

  /**
   * The named consistency test the DRY-3 finding asked for. Each case drives one gate term and
   * asserts that download, metadata, and cover answer IDENTICALLY — same status, same body.
   *
   * Its value is the cross-route equality, not the individual statuses (those are already
   * covered per route): re-forking `loadExposedCompanionContext` so any one route gains or
   * loses a term makes the surviving routes disagree here, which is precisely the drift the
   * extraction removes.
   */
  describe('the owner-readable gate is one decision for all three companion-file routes', () => {
    it.each<[string, () => Promise<void>]>([
      ['the feature is disabled', async () => { setSettings({ enabled: false }); }],
      ['the book is unknown', async () => { setBook(null); }],
      ['books.status is not imported', async () => { setBook({ status: 'missing' }); }],
      ['the observation row is absent', async () => { setObservation(null); }],
      ['the observation is not available', async () => { setObservation(row({ status: 'ambiguous' })); }],
      ['the stored filename is null', async () => { setObservation(row({ filename: null })); }],
      ['books.path is null', async () => { setBook({ path: null }); }],
      ['books.path is blank', async () => { setBook({ path: '   ' }); }],
    ])('all three routes answer identically when %s', async (_label, arrange) => {
      await placeEpub();
      await arrange();

      const results = [];
      for (const [label, request] of GATED_ROUTES) {
        const res = await request();
        results.push({ label, statusCode: res.statusCode, body: res.json() });
      }

      const [first, ...rest] = results;
      for (const other of rest) {
        expect({ statusCode: other.statusCode, body: other.body })
          .toEqual({ statusCode: first!.statusCode, body: first!.body });
      }
      // …and the shared answer is genuinely a rejection, so an all-200 regression cannot
      // satisfy the equality above.
      expect([409, 404]).toContain(first!.statusCode);
    });

    it('all three routes reach the file layer only after the gate passes', async () => {
      await placeEpub();
      setObservation(row({ status: 'ambiguous' }));

      for (const [, request] of GATED_ROUTES) await request();

      // The gate rejected before any opener or resolver ran, on every route.
      expect(vi.mocked(openCompanionEbook)).not.toHaveBeenCalled();
      expect(vi.mocked(resolveCompanionEbookPath)).not.toHaveBeenCalled();
    });

    /**
     * The same one-decision property in the POSITIVE direction (#2038). The cases above prove
     * all three routes REJECT together; without this one, widening the gate for download alone
     * and leaving the reads on the advertisement predicate would keep every case above green.
     *
     * The three success tails differ, so the shared observable is "reached the file layer":
     * download opens a descriptor, the two reads resolve a path.
     */
    it('all three routes pass the gate together for a stored drm_protected row', async () => {
      await placeEpub(coverBook(PNG));
      setObservation(row({ status: 'drm_protected' }));

      const results = [];
      for (const [label, request] of GATED_ROUTES) {
        results.push({ label, statusCode: (await request()).statusCode });
      }

      expect(results).toEqual([
        { label: 'companion-epub (download)', statusCode: 200 },
        { label: 'metadata', statusCode: 200 },
        { label: 'cover', statusCode: 200 },
      ]);
      expect(vi.mocked(openCompanionEbook)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(resolveCompanionEbookPath)).toHaveBeenCalledTimes(2);
    });
  });

  // -------------------------------------------------------------------------
  // The shared read ladder (AC5, AC6, AC7, AC8/AC9)
  // -------------------------------------------------------------------------
  describe.each(READ_ROUTES)('GET /api/books/:id/companion-epub/%s — the shared ladder', (_label, request) => {
    it('returns 409 when the feature is disabled', async () => {
      await placeEpub();
      setSettings({ enabled: false });

      const res = await request();
      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual({ error: expect.any(String) });
    });

    it('returns 404 for an unknown book', async () => {
      setBook(null);
      expect((await request()).statusCode).toBe(404);
    });

    it('returns 404 when books.status is missing even though the row says available', async () => {
      await placeEpub();
      setBook({ status: 'missing' });
      expect((await request()).statusCode).toBe(404);
    });

    // Split the same way the download route's list is (#2038): `drm_protected` now passes the
    // stored-status gate on both read routes, and its two arms — live inspection `available`
    // (the misclassified-row recovery) and live inspection NOT `available` (a genuinely
    // encrypted file) — are pinned in their own describe below.
    it.each(['none', 'ambiguous', 'invalid'] as const)(
      'returns 404 for a %s observation',
      async (status) => {
        await placeEpub();
        setObservation(row({ status }));
        expect((await request()).statusCode).toBe(404);
      },
    );

    it('returns 404 when there is no observation row', async () => {
      await placeEpub();
      setObservation(null);
      expect((await request()).statusCode).toBe(404);
    });

    it('returns 404 when the stored filename is null', async () => {
      await placeEpub();
      setObservation(row({ filename: null }));
      expect((await request()).statusCode).toBe(404);
    });

    it.each(['', '   ', null])('returns 404 for a blank books.path (%j)', async (path) => {
      await placeEpub();
      setBook({ path });
      expect((await request()).statusCode).toBe(404);
    });

    // Resolver negatives, driven for REAL — never "the open throws", and never a dev/ino
    // comparison (plan §5 declines that binding).
    it.skipIf(!CAN_SYMLINK)('returns 404 for a symlink at the stored basename, via not_regular_file', async () => {
      const realTarget = join(bookPath, 'real.epub');
      await writeFile(realTarget, await F.buildEpub());
      await symlink(realTarget, join(bookPath, EPUB));

      expect((await request()).statusCode).toBe(404);
      const [result] = vi.mocked(resolveCompanionEbookPath).mock.results;
      await expect(result!.value).resolves.toEqual({ outcome: 'not_regular_file' });
    });

    it('returns 404 for a vanished file, via missing', async () => {
      expect((await request()).statusCode).toBe(404);
      const [result] = vi.mocked(resolveCompanionEbookPath).mock.results;
      await expect(result!.value).resolves.toEqual({ outcome: 'missing' });
    });

    it.skipIf(!CAN_SYMLINK)('returns 404 when the realpath escapes the library root', async () => {
      const outside = mkdtempSync(join(tmpdir(), 'narratorr-1976-out-'));
      try {
        const externalBook = join(outside, 'Title');
        await mkdir(externalBook, { recursive: true });
        await writeFile(join(externalBook, EPUB), await F.buildEpub());
        await symlink(externalBook, join(libraryRoot, 'escape'));
        setBook({ path: join(libraryRoot, 'escape') });

        expect((await request()).statusCode).toBe(404);
        const [result] = vi.mocked(resolveCompanionEbookPath).mock.results;
        await expect(result!.value).resolves.toEqual({ outcome: 'outside_library' });
      } finally {
        rmSync(outside, { recursive: true, force: true });
      }
    });

    // AC7 — the stored row said `available` and the live file disagrees. That is the §4
    // stale-window outcome, not an error class of its own.
    it('returns 404 when inspectEpub RETURNS a non-available status', async () => {
      await writeFile(join(bookPath, EPUB), 'this is not a zip archive at all');
      expect((await request()).statusCode).toBe(404);
    });

    it('returns 404 and never renders any EPUB HTML in the body', async () => {
      await placeEpub(navRowsBook([{ label: 'Chapter One' }]));
      const res = await request();
      // Whatever the route emitted, it is not markup from inside the archive.
      expect(res.rawPayload.toString()).not.toContain('<html');
      expect(res.rawPayload.toString()).not.toContain('<nav');
    });
  });

  // -------------------------------------------------------------------------
  // #2038 AC4 — a stored drm_protected row on the two READ routes, both arms
  // -------------------------------------------------------------------------

  /**
   * The widened gate admits the stored row; the LIVE inspection still decides. Both arms are
   * pinned because only the pair distinguishes "the gate widened" from "the archive reader
   * widened", and the second would be a genuine security regression rather than this issue.
   *
   * Route status alone cannot tell the two apart — both routes flatten every gate rejection and
   * every inspection rejection onto one bare `404` on purpose (the existence-oracle property).
   * So the positive arm asserts the FULL 200 response, and the negative arm asserts the sharper
   * observables: the resolver ran (so the gate did pass) and the boundary record's `outcome` is
   * the inspection verdict rather than a gate outcome.
   */
  describe('a stored drm_protected row on the read routes', () => {
    it('metadata answers its existing 200 when the live inspection comes back available', async () => {
      // The motivating case, live 2026-07-29: the classifier was WRONG about this file. The
      // stored row says DRM; the archive on disk is a perfectly good EPUB.
      await placeEpub(
        navRowsBook(
          [{ label: 'Part One', children: [{ label: 'Chapter One' }] }, { label: 'Part Two' }],
          { title: 'A Companion', creators: ['Ada Lovelace'], language: 'en-GB' },
        ),
      );
      setObservation(row({ status: 'drm_protected' }));

      const res = await metadataReq();

      expect(res.statusCode).toBe(200);
      expect(res.headers['cache-control']).toBe('private, no-store');
      // The same payload the `available` row produces — nothing added, renamed, or defaulted
      // *for DRM*. `filename` (#2022) is on every metadata 200 regardless of stored status, and
      // for this fixture it is the DRM row's own basename.
      expect(res.json()).toEqual({
        filename: EPUB,
        metadata: { title: 'A Companion', author: 'Ada Lovelace', language: 'en-GB' },
        toc: [
          { title: 'Part One', depth: 0 },
          { title: 'Chapter One', depth: 1 },
          { title: 'Part Two', depth: 0 },
        ],
      });
    });

    it('cover answers its existing 200 bytes and headers when the live inspection comes back available', async () => {
      // A cover-bearing fixture deliberately: a bare book carries no embedded cover and would
      // 404 as `no_cover`, which proves nothing about the gate.
      await placeEpub(coverBook(PNG));
      setObservation(row({ status: 'drm_protected' }));

      const res = await coverReq();

      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe('image/png');
      expect(res.headers['content-length']).toBe(String(PNG.length));
      expect(res.headers['content-disposition']).toBe('inline');
      expect(res.headers['cache-control']).toBe('private, no-store');
      expect(res.rawPayload.equals(PNG)).toBe(true);
    });

    /**
     * `F.drmProtectedEpub()` is the shared fixture (#2041): a `META-INF/encryption.xml`
     * declaring the spine's own content document encrypted, which is the shape §4 calls
     * `drm_protected` (a font-only encryption is the obfuscated-font case it deliberately does
     * NOT). The `encryption.xml` route rather than the ZIP encryption bit — it needs no
     * byte-patching of the built archive, and both reach the same verdict. The verdict itself is
     * pinned in `validate.test.ts`, which is the only suite that can observe it: everything here
     * flattens to one 404.
     */
    describe('a genuinely encrypted file still 404s at the live inspection', () => {
      let mockLog: ReturnType<typeof installMockAppLog>;

      beforeEach(() => {
        mockLog = installMockAppLog(app);
      });

      afterEach(() => {
        mockLog.restore();
      });

      it.each(READ_ROUTES)('on the %s route', async (_label, request) => {
        await placeEpub(F.drmProtectedEpub());
        setObservation(row({ status: 'drm_protected' }));

        const res = await request();

        expect(res.statusCode).toBe(404);
        // The gate PASSED — a gate rejection never reaches the resolver, so this is what
        // separates "still 404s because the live term held" from "still 404s because the gate
        // never widened at all".
        expect(vi.mocked(resolveCompanionEbookPath)).toHaveBeenCalledTimes(1);
        // …and the record names the INSPECTION verdict, not a gate outcome.
        expect(mockLog.spies.warn).toHaveBeenCalledTimes(1);
        assertBoundaryRecord(mockLog.spies.warn.mock.calls[0]![0], 'drm_protected');
        // One reconcile enqueued, fire-and-forget — unchanged from every other read that could
        // not serve its file.
        expect(services.companionEbook.reconcileBook).toHaveBeenCalledTimes(1);
      });

      /**
       * The MESSAGE, not just the record (#2040 F1/F2). This is the one path where the stored
       * row and the live file AGREE and the request still 404s, so the old
       * "did not agree with the stored row" wording was actively false here. `assertBoundaryRecord`
       * reads argument 0 only; without this assertion reverting the message to its mismatch-only
       * text leaves the whole suite green.
       */
      it.each(READ_ROUTES)('names the read unavailable rather than a disagreement, on the %s route', async (_label, request) => {
        await placeEpub(F.drmProtectedEpub());
        setObservation(row({ status: 'drm_protected' }));

        expect((await request()).statusCode).toBe(404);

        expect(mockLog.spies.warn.mock.calls[0]![1]).toBe(
          'Companion ebook inspection did not yield a readable file',
        );
        // The claim the split falsified, pinned negatively as well: stored DRM over live DRM is
        // an agreement, so no diagnostic on this path may say the two disagreed.
        expect(String(mockLog.spies.warn.mock.calls[0]![1])).not.toMatch(/agree|mismatch/i);
      });

      /**
       * The second changed string: the fire-and-forget trigger context, which only surfaces when
       * the reconcile itself REJECTS (`fireAndForget` logs `{ error }` against it at warn). The
       * suite resolves `reconcileBook` by default precisely so this second warn stays out of
       * every other boundary-record assertion, so this case opts back into the rejection the way
       * the AC28 isolation tests do.
       */
      it('names the failing reconcile by the read, not by a mismatch, when the reconciler rejects', async () => {
        await placeEpub(F.drmProtectedEpub());
        setObservation(row({ status: 'drm_protected' }));
        (services.companionEbook.reconcileBook as unknown as Mock).mockRejectedValue(
          new Error('reconcile rejected'),
        );

        expect((await metadataReq()).statusCode).toBe(404);
        // `fireAndForget`'s `.catch` settles on a microtask, after the response is already out.
        await new Promise((resolve) => setImmediate(resolve));

        const contexts = mockLog.spies.warn.mock.calls.map((call) => call[1]);
        expect(contexts).toContain('Companion ebook reconcile failed after an unavailable read');
        expect(contexts.join('\n')).not.toMatch(/mismatch/i);
      });
    });
  });

  // -------------------------------------------------------------------------
  // GET /api/books/:id/companion-epub/metadata (AC10, AC11)
  // -------------------------------------------------------------------------
  describe('GET /api/books/:id/companion-epub/metadata', () => {
    it('returns the OPF fields and a flattened EPUB 3 nav TOC', async () => {
      await placeEpub(
        navRowsBook(
          [{ label: 'Part One', children: [{ label: 'Chapter One' }] }, { label: 'Part Two' }],
          { title: 'A Companion', creators: ['Ada Lovelace'], language: 'en-GB' },
        ),
      );

      const res = await metadataReq();

      expect(res.statusCode).toBe(200);
      expect(res.headers['cache-control']).toBe('private, no-store');
      expect(res.json()).toEqual({
        filename: EPUB,
        metadata: { title: 'A Companion', author: 'Ada Lovelace', language: 'en-GB' },
        toc: [
          { title: 'Part One', depth: 0 },
          { title: 'Chapter One', depth: 1 },
          { title: 'Part Two', depth: 0 },
        ],
      });
    });

    it('returns the TOC rows and their depths from an EPUB 2 NCX', async () => {
      await placeEpub(ncxRowsBook([{ label: 'One', children: [{ label: 'One.a' }] }]));

      const res = await metadataReq();

      expect(res.statusCode).toBe(200);
      expect(res.json().toc).toEqual([
        { title: 'One', depth: 0 },
        { title: 'One.a', depth: 1 },
      ]);
    });

    // AC11 — `toc: null` is "we could not read one", NOT zero chapters, and there is no
    // second field beside the array for the panel to disagree with.
    it('returns toc: null for an unreadable nav document, with NO chapterCount key', async () => {
      await placeEpub({
        packageOptions: { items: [CHAPTER, NAV_ITEM] },
        files: [{ name: NAV_ENTRY, content: '<?xml version="1.0"?><div><p>not a nav document</p></div>' }],
      });

      const res = await metadataReq();

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toEqual({
        filename: EPUB,
        metadata: { title: 'Fixture', author: null, language: null },
        toc: null,
      });
      expect(Object.keys(body).sort()).toEqual(['filename', 'metadata', 'toc']);
      expect(body).not.toHaveProperty('chapterCount');
    });

    it('returns toc: null when the book declares no navigation at all', async () => {
      await placeEpub();
      expect((await metadataReq()).json().toc).toBeNull();
    });

    // AC10 — surfaced exactly as `EpubMetadata` declares them: null, not omitted and not ''.
    it('returns null creator and language rather than omitting or empty-stringing them', async () => {
      await placeEpub(navRowsBook([{ label: 'One' }], { title: 'Only A Title' }));

      const body = (await metadataReq()).json();

      expect(body.metadata).toEqual({ title: 'Only A Title', author: null, language: null });
      expect(Object.keys(body.metadata).sort()).toEqual(['author', 'language', 'title']);
    });

    it('returns a null title when the OPF omits dc:title', async () => {
      await placeEpub(navRowsBook([{ label: 'One' }], { title: null }));
      expect((await metadataReq()).json().metadata.title).toBeNull();
    });

    // -----------------------------------------------------------------------
    // #2022 — the response declares WHICH file it read
    // -----------------------------------------------------------------------

    /**
     * A basename the fixture does not otherwise use. The observation-point rule
     * (`vacuous-assertion-observation-points`): asserting `body.filename` against `EPUB` — the
     * value `row()` defaults to and `placeEpub` writes — passes for a field wired to any
     * constant the suite already has lying around. This one is only ever reachable through the
     * stored row.
     */
    const DISTINCT = 'ZZ-Distinctive-Stored-Basename.epub';

    async function placeDistinctEpub(options: F.EpubOptions = {}): Promise<void> {
      await writeFile(join(bookPath, DISTINCT), await F.buildEpub(options));
      setObservation(row({ filename: DISTINCT }));
    }

    it('emits the STORED basename the gate resolved, with no directory component', async () => {
      await placeDistinctEpub(navRowsBook([{ label: 'One' }]));

      const res = await metadataReq();

      expect(res.statusCode).toBe(200);
      const { filename } = res.json();
      expect(filename).toBe(DISTINCT);
      // A path can never regress in: the route emits the row's value, never a re-derivation
      // from the resolved absolute path.
      expect(filename).not.toContain('/');
      expect(filename).not.toContain('\\');
    });

    /**
     * The property the CLIENT's coherence rule depends on (#2022 AC2): the panel compares
     * `/metadata`'s `filename` against the `/state` row it renders beside, so the two routes
     * must project the same value for the same book. Asserting each is merely non-empty would
     * pass for two independently-derived strings.
     */
    it('emits exactly what GET /state projects as filename for the same book', async () => {
      await placeDistinctEpub(navRowsBook([{ label: 'One' }]));

      const metadataBody = (await metadataReq()).json();
      const stateBody = (await state()).json();

      expect(stateBody.filename).toBe(DISTINCT);
      expect(metadataBody.filename).toBe(stateBody.filename);
    });

    /**
     * AC3's one-filename-per-request invariant (spec review F2). The distinctive row is stable
     * across a whole request in every other case here, so none of them can tell "the handler
     * reused the gate's value" from "the handler re-read the row". This one swaps the
     * observation AFTER the gate has captured it — from inside the resolver, which runs between
     * the gate and the response — and asserts the emitted name is still the captured one.
     *
     * The row read is counted as well: a second `findCompanionEbook` would be a second
     * observation even when it happened to agree.
     */
    it('emits the filename the gate captured even when the row changes mid-request, and reads the row once', async () => {
      await placeDistinctEpub(navRowsBook([{ label: 'One' }]));
      const realResolve = vi.mocked(resolveCompanionEbookPath).getMockImplementation()!;
      vi.mocked(resolveCompanionEbookPath).mockImplementationOnce(async (...args) => {
        setObservation(row({ filename: 'SWAPPED-AFTER-THE-GATE.epub' }));
        return realResolve(...args);
      });

      const res = await metadataReq();

      expect(res.statusCode).toBe(200);
      expect(res.json().filename).toBe(DISTINCT);
      expect(db.select).toHaveBeenCalledTimes(1);
    });

    it('emits no filename on any gate, resolver, or inspection negative', async () => {
      // One case per boundary: the feature gate (409, before the row read), the stored-status
      // gate (404), the resolver (404, the file is simply absent), and the live inspection
      // (404, the bytes are not an archive).
      const negatives: Array<[string, () => Promise<void>]> = [
        ['the feature is disabled', async () => { await placeDistinctEpub(); setSettings({ enabled: false }); }],
        ['the stored status is not owner-readable', async () => {
          await placeDistinctEpub();
          setObservation(row({ status: 'ambiguous', filename: DISTINCT }));
        }],
        ['the file is gone', async () => { setObservation(row({ filename: DISTINCT })); }],
        ['the file is not an archive', async () => {
          await writeFile(join(bookPath, DISTINCT), 'not a zip archive at all');
          setObservation(row({ filename: DISTINCT }));
        }],
      ];

      for (const [label, arrange] of negatives) {
        await arrange();
        const res = await metadataReq();
        expect([404, 409], label).toContain(res.statusCode);
        expect(res.json(), label).not.toHaveProperty('filename');
        expect(JSON.stringify(res.json()), label).not.toContain(DISTINCT);
        await rm(join(bookPath, DISTINCT), { force: true });
        setSettings({ enabled: true });
      }
    });
  });

  // -------------------------------------------------------------------------
  // GET /api/books/:id/companion-epub/cover (AC12-AC17)
  // -------------------------------------------------------------------------
  describe('GET /api/books/:id/companion-epub/cover', () => {
    it.each<[string, Buffer, string]>([
      ['PNG', PNG, 'image/png'],
      ['JPEG', JPEG, 'image/jpeg'],
      ['GIF', GIF, 'image/gif'],
      ['WebP', WEBP, 'image/webp'],
    ])('serves a %s cover with the documented headers', async (_label, bytes, mediaType) => {
      await placeEpub(coverBook(bytes));

      const res = await coverReq();

      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe(mediaType);
      expect(res.headers['content-length']).toBe(String(bytes.length));
      expect(res.headers['content-disposition']).toBe('inline');
      // NOT `public, max-age=86400` — these bytes are library content behind owner auth and
      // change whenever the file does. The asymmetry with `/api/books/:id/cover` is deliberate.
      expect(res.headers['cache-control']).toBe('private, no-store');
      expect(res.rawPayload.equals(bytes)).toBe(true);
    });

    /**
     * #2022 AC4 — `/cover` shares `loadCompanionInspection` with `/metadata` and must NOT gain
     * the filename the shared helper now returns. Its body is raw image bytes, so the assertion
     * is over the payload rather than a parsed key: a spread of the helper's result into a JSON
     * response here would be a contract change on a route this issue does not touch.
     */
    it('is byte-identical and carries no filename anywhere in its response', async () => {
      const distinct = 'ZZ-Cover-Route-Basename.epub';
      await writeFile(join(bookPath, distinct), await F.buildEpub(coverBook(PNG)));
      setObservation(row({ filename: distinct }));

      const res = await coverReq();

      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe('image/png');
      expect(res.headers['content-length']).toBe(String(PNG.length));
      expect(res.headers['content-disposition']).toBe('inline');
      expect(res.headers['cache-control']).toBe('private, no-store');
      expect(res.rawPayload.equals(PNG)).toBe(true);
      expect(res.rawPayload.toString('binary')).not.toContain('filename');
      expect(res.rawPayload.toString('binary')).not.toContain(distinct);
    });

    // AC15, both directions — the media type the BYTES say, never the one the manifest claims.
    it('returns 404 for a manifest declaring image/png over SVG bytes', async () => {
      await placeEpub(coverBook(SVG, 'image/png'));

      const res = await coverReq();

      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: expect.any(String) });
    });

    it('serves image/png for a manifest declaring image/svg+xml over PNG bytes', async () => {
      await placeEpub(coverBook(PNG, 'image/svg+xml'));

      const res = await coverReq();

      expect(res.statusCode).toBe(200);
      // `image/svg+xml` is unreachable by construction — the four sniffed literals are the
      // only values emittable — rather than by a route-level check.
      expect(res.headers['content-type']).toBe('image/png');
    });

    it('returns 404 when the book declares no cover', async () => {
      await placeEpub(navRowsBook([{ label: 'One' }]));
      expect((await coverReq()).statusCode).toBe(404);
    });

    it('returns 404 when a <meta name="cover"> names no manifest item', async () => {
      // A declared-but-broken cover is not a book with a second cover.
      await placeEpub({
        packageOptions: { items: [CHAPTER], metadata: { covers: ['no-such-item'] } },
      });
      expect((await coverReq()).statusCode).toBe(404);
    });

    it('serves a cover sitting exactly on MAX_EPUB_COVER_BYTES', async () => {
      const exact = Buffer.concat([PNG, Buffer.alloc(MAX_EPUB_COVER_BYTES - PNG.length)]);
      await placeEpub(coverBook(exact));

      const res = await coverReq();

      expect(res.statusCode).toBe(200);
      expect(res.headers['content-length']).toBe(String(MAX_EPUB_COVER_BYTES));
      expect(res.rawPayload.length).toBe(MAX_EPUB_COVER_BYTES);
    });

    it('returns 404 one byte over the cap, and sends NO truncated body', async () => {
      const over = Buffer.concat([PNG, Buffer.alloc(MAX_EPUB_COVER_BYTES - PNG.length + 1)]);
      await placeEpub(coverBook(over));

      const res = await coverReq();

      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: expect.any(String) });
    });

    // AC17 — `nosniff` is helmet's, globally. The route sets no header of its own.
    it('sets no X-Content-Type-Options header of its own', async () => {
      await placeEpub(coverBook(PNG));
      expect((await coverReq()).headers['x-content-type-options']).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // AC8/AC9 — inspectEpub REJECTING, on both routes
  // -------------------------------------------------------------------------
  describe('inspectEpub rejection maps to 404 on both read routes', () => {
    let mockLog: ReturnType<typeof installMockAppLog>;

    beforeEach(() => {
      mockLog = installMockAppLog(app);
    });

    afterEach(() => {
      mockLog.restore();
    });

    /** Every `debug` record carrying an `error` key. */
    function errorDebugRecords(): Array<Record<string, unknown>> {
      return mockLog.spies.debug.mock.calls
        .map((call) => call[0] as Record<string, unknown>)
        .filter((record) => record !== null && typeof record === 'object' && 'error' in record);
    }

    // Driven by deleting the file AFTER the resolver has verified it, from inside the
    // delegating wrapper — so the resolver genuinely succeeds and the inspection genuinely
    // rejects. `preOpenRejection`'s `lstat` has no catch: I/O failure is never a verdict.
    it.each(READ_ROUTES)('returns 404, never 500, on the %s route', async (_label, request) => {
      await placeEpub();
      const actual = await vi.importActual<typeof import('../services/companion-ebook-open.js')>(
        '../services/companion-ebook-open.js',
      );
      vi.mocked(resolveCompanionEbookPath).mockImplementationOnce(async (input, log) => {
        const resolved = await actual.resolveCompanionEbookPath(input, log);
        await rm(join(bookPath, EPUB));
        return resolved;
      });

      const res = await request();

      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: expect.any(String) });
      // The boundary record is `{ bookId, outcome }` and nothing else — no path, no filename,
      // no library root — even though the underlying error's message and stack carry all three.
      expect(mockLog.spies.warn).toHaveBeenCalledTimes(1);
      assertBoundaryRecord(mockLog.spies.warn.mock.calls[0]![0], 'inspect_failed');
      // …and the response body leaks none of them either.
      const bodyLeaves = stringLeaves(res.json()).join('\n');
      for (const secret of [bookPath, libraryRoot, EPUB]) expect(bodyLeaves).not.toContain(secret);
      // The global error handler's `request.log.error(error, …)` never ran.
      expect(mockLog.spies.error).not.toHaveBeenCalled();
    });

    it('logs the rejection exactly once at debug, with a serializeError-shaped error', async () => {
      await placeEpub();
      const actual = await vi.importActual<typeof import('../services/companion-ebook-open.js')>(
        '../services/companion-ebook-open.js',
      );
      vi.mocked(resolveCompanionEbookPath).mockImplementationOnce(async (input, log) => {
        const resolved = await actual.resolveCompanionEbookPath(input, log);
        await rm(join(bookPath, EPUB));
        return resolved;
      });

      await metadataReq();

      const records = errorDebugRecords();
      expect(records).toHaveLength(1);
      expect(Object.keys(records[0]!).sort()).toEqual(['bookId', 'error', 'path']);
      // Own-ENUMERABLE key set, not `objectContaining({ message })` — a raw `Error` passes
      // that matcher because `message` and `stack` are non-enumerable on it (#1982).
      expect(records[0]!.error).not.toBeInstanceOf(Error);
      expect(Object.keys(records[0]!.error as object).sort()).toEqual(['code', 'message', 'stack', 'type']);
    });

    // The SAME mapping driven through an OPTIONAL read rather than the pre-open, which proves
    // both rejection sources share one channel rather than two that happen to agree today.
    it.each(READ_ROUTES)(
      'maps a cover-read EIO to the same 404 + inspect_failed on the %s route',
      async (_label, request) => {
        await placeEpub(coverBook(PNG));
        epubHooks.onStream = (name) =>
          name === COVER_ENTRY
            ? new Readable({ read() { this.destroy(Object.assign(new Error('simulated EIO'), { code: 'EIO' })); } })
            : undefined;

        const res = await request();

        expect(res.statusCode).toBe(404);
        expect(mockLog.spies.warn).toHaveBeenCalledTimes(1);
        assertBoundaryRecord(mockLog.spies.warn.mock.calls[0]![0], 'inspect_failed');
        expect(mockLog.spies.error).not.toHaveBeenCalled();
      },
    );

    it('emits the boundary record with the inspection STATUS as the outcome for a returned negative', async () => {
      await writeFile(join(bookPath, EPUB), 'this is not a zip archive at all');

      expect((await metadataReq()).statusCode).toBe(404);

      expect(mockLog.spies.warn).toHaveBeenCalledTimes(1);
      assertBoundaryRecord(mockLog.spies.warn.mock.calls[0]![0], 'invalid');
    });

    it('emits the boundary record with the resolver outcome for a resolver negative', async () => {
      expect((await coverReq()).statusCode).toBe(404);

      expect(mockLog.spies.warn).toHaveBeenCalledTimes(1);
      assertBoundaryRecord(mockLog.spies.warn.mock.calls[0]![0], 'missing');
    });

    it('emits no_cover for a book whose cover is unreadable', async () => {
      await placeEpub(coverBook(SVG, 'image/png'));

      expect((await coverReq()).statusCode).toBe(404);

      expect(mockLog.spies.warn).toHaveBeenCalledTimes(1);
      assertBoundaryRecord(mockLog.spies.warn.mock.calls[0]![0], 'no_cover');
    });
  });

  // -------------------------------------------------------------------------
  // PUT /api/books/:id/companion-epub/selection (AC18-AC21, AC31-AC34)
  // -------------------------------------------------------------------------
  describe('PUT /api/books/:id/companion-epub/selection', () => {
    let selectMock: Mock;
    let mockLog: ReturnType<typeof installMockAppLog>;

    beforeEach(() => {
      selectMock = services.companionEbook.selectCompanionEbook as unknown as Mock;
      selectMock.mockReset();
      mockLog = installMockAppLog(app);
    });

    afterEach(() => {
      mockLog.restore();
    });

    const put = (body: unknown) =>
      app.inject({ method: 'PUT', url: `/api/books/${BOOK_ID}/companion-epub/selection`, payload: body as never });

    /** The row a `selected` outcome carries, and the DTO the panel must receive for it. */
    const SELECTED_ROW = row({ status: 'available', filename: 'b.epub', candidateCount: 2, selectedFilename: 'b.epub' });

    // -----------------------------------------------------------------------
    // Body validation (AC18, AC19) — rejected by the schema, before the handler
    // -----------------------------------------------------------------------
    describe('body validation', () => {
      it.each<[string, unknown]>([
        ['a missing index', {}],
        ['a string index', { index: '0' }],
        ['a negative index', { index: -1 }],
        ['a fractional index', { index: 1.5 }],
        ['an extra key', { index: 0, filename: 'x.epub' }],
        ['a filename instead of an index', { filename: 'x.epub' }],
        ['a path instead of an index', { path: '/library/x.epub' }],
        ['a null index', { index: null }],
      ])('returns 400 for %s, without reaching the reconciler', async (_label, body) => {
        const res = await put(body);

        expect(res.statusCode).toBe(400);
        expect(selectMock).not.toHaveBeenCalled();
      });

      it('accepts index 0 — the list is 0-based, matching what /state issues', async () => {
        selectMock.mockResolvedValue({ outcome: 'selected', row: SELECTED_ROW });

        expect((await put({ index: 0 })).statusCode).toBe(200);
        expect(selectMock).toHaveBeenCalledWith(BOOK_ID, 0);
      });
    });

    // -----------------------------------------------------------------------
    // The route's own two-term gate (AC20)
    // -----------------------------------------------------------------------
    describe('the pre-lock gate', () => {
      // F10 — the unknown-book gate, which must run BEFORE the mutation.
      it('returns 404 with the exact notFound body for an unknown book, without mutating', async () => {
        setBook(null);

        const res = await put({ index: 0 });

        expect(res.statusCode).toBe(404);
        expect(res.json()).toEqual({ error: 'Companion ebook not found' });
        expect(selectMock).not.toHaveBeenCalled();
      });

      it('returns 409 with the featureDisabled body when the feature is off, without mutating', async () => {
        setSettings({ enabled: false });

        const res = await put({ index: 0 });

        expect(res.statusCode).toBe(409);
        expect(res.json()).toEqual({ error: 'Companion ebooks are disabled' });
        expect(selectMock).not.toHaveBeenCalled();
      });

      /**
       * F9 / AC20 — the load-bearing distinction. An `ambiguous` row is by definition neither
       * `available` nor `drm_protected`, so BOTH gates are false for every row this route exists
       * to act on. A handler copied from the read ladder would make the picker permanently 404.
       *
       * Both are named (#2038): asserting only the advertisement gate would go vacuous the
       * moment the owner ladder stopped calling it, which is exactly what this issue did.
       */
      it('reaches the reconciler for a stored ambiguous row and never consults either gate', async () => {
        setObservation(row({
          status: 'ambiguous', filename: null, sizeBytes: null, mtimeMs: null, ctimeMs: null, candidateCount: 2,
        }));
        selectMock.mockResolvedValue({ outcome: 'selected', row: SELECTED_ROW });

        const res = await put({ index: 1 });

        expect(res.statusCode).toBe(200);
        expect(selectMock).toHaveBeenCalledWith(BOOK_ID, 1);
        // Neither shared predicate nor a re-spelled inline copy of either ran: eligibility is
        // evaluated once, inside the lock, and never at the route.
        expect(vi.mocked(isCompanionEbookExposed)).not.toHaveBeenCalled();
        expect(vi.mocked(isCompanionEbookOwnerReadable)).not.toHaveBeenCalled();
        expect(vi.mocked(isCompanionEbookEligible)).not.toHaveBeenCalled();
      });
    });

    // -----------------------------------------------------------------------
    // AC31's map — one case per non-2xx outcome, eleven arms
    // -----------------------------------------------------------------------
    describe('the outcome map', () => {
      /** A path-bearing scan: no temp dir, no library root, and no basename in the body. */
      function expectNoLeak(body: unknown): void {
        const leaves = stringLeaves(body).join('\n');
        for (const secret of [bookPath, libraryRoot, EPUB, 'b.epub']) {
          expect(leaves).not.toContain(secret);
        }
      }

      it.each<[CompanionSelectionResult['outcome'], number, string]>([
        ['out_of_range', 400, 'Candidate index is out of range'],
        ['book_missing', 404, 'Companion ebook not found'],
        ['ineligible', 404, 'Companion ebook not found'],
        ['gone', 404, 'Companion ebook not found'],
        ['unresolvable', 404, 'Companion ebook not found'],
        ['disabled', 409, 'Companion ebooks are disabled'],
        ['conflicted', 409, 'Companion ebook selection conflicted with a concurrent change'],
        ['undetermined', 503, 'Companion ebook selection could not be completed'],
        ['retained', 503, 'Companion ebook selection could not be completed'],
        ['stopped', 503, 'Companion ebook selection could not be completed'],
        ['failed', 503, 'Companion ebook selection could not be completed'],
      ])('maps %s to %i with the flat owner error body', async (outcome, status, error) => {
        selectMock.mockResolvedValue({ outcome });

        const res = await put({ index: 0 });

        expect(res.statusCode).toBe(status);
        // The WHOLE body, and the flat `{ error: string }` convention — never the v1
        // `{ error: { code, message } }` envelope.
        expect(res.json()).toEqual({ error });
        expectNoLeak(res.json());
        // Every non-2xx outcome emits the boundary record, and only `{ bookId, outcome }`.
        expect(mockLog.spies.warn).toHaveBeenCalledTimes(1);
        assertBoundaryRecord(mockLog.spies.warn.mock.calls[0]![0], outcome);
      });

      // Same status, deliberately different bodies: `disabled` reuses the route's own disabled
      // sentence so a feature flip mid-request reads identically to one caught at the gate.
      it('gives disabled and conflicted distinct bodies under the same 409', async () => {
        selectMock.mockResolvedValueOnce({ outcome: 'disabled' });
        const disabled = await put({ index: 0 });
        selectMock.mockResolvedValueOnce({ outcome: 'conflicted' });
        const conflicted = await put({ index: 0 });

        expect(disabled.statusCode).toBe(409);
        expect(conflicted.statusCode).toBe(409);
        expect(disabled.json()).not.toEqual(conflicted.json());
      });
    });

    // -----------------------------------------------------------------------
    // AC32 — the success DTO is not an error envelope
    // -----------------------------------------------------------------------
    describe('the selected response', () => {
      it('returns 200 with the state DTO for the row the commit returned', async () => {
        selectMock.mockResolvedValue({ outcome: 'selected', row: SELECTED_ROW });

        const res = await put({ index: 1 });

        expect(res.statusCode).toBe(200);
        // An INDEPENDENTLY written exact DTO literal, not `projectStoredState(row)` (F21):
        // deriving the expectation through the same projector the route must use would make a
        // field omission or a rename agree on both sides of the assertion.
        expect(res.json()).toEqual({
          status: 'available',
          filename: 'b.epub',
          sizeBytes: SELECTED_ROW.sizeBytes,
          validationCode: null,
          candidateCount: 2,
          selectedFilename: 'b.epub',
          candidates: [],
        });
      });

      it('carries filename and selectedFilename, but no full path and no library root', async () => {
        selectMock.mockResolvedValue({ outcome: 'selected', row: SELECTED_ROW });

        const body = (await put({ index: 1 })).json();

        // The narrower scan: these are stored basenames the owner already sees on `/state`,
        // so the error bodies' basename-absence rule does not apply here.
        expect(body.filename).toBe('b.epub');
        expect(body.selectedFilename).toBe('b.epub');
        const leaves = stringLeaves(body).join('\n');
        expect(leaves).not.toContain(bookPath);
        expect(leaves).not.toContain(libraryRoot);
      });

      it('emits NO boundary warn record on the success path', async () => {
        selectMock.mockResolvedValue({ outcome: 'selected', row: SELECTED_ROW });

        expect((await put({ index: 1 })).statusCode).toBe(200);
        expect(mockLog.spies.warn).not.toHaveBeenCalled();
      });

      // F23, the HTTP half — AC34's accepted drift, proven at the route boundary. The service
      // half (the fresh occupant wins) lives in the reconciler integration suite.
      it('succeeds with no ETag, nonce, or precondition header participating', async () => {
        selectMock.mockResolvedValue({ outcome: 'selected', row: SELECTED_ROW });

        const res = await put({ index: 1 });

        expect(res.statusCode).toBe(200);
        expect(res.headers.etag).toBeUndefined();
        // Nothing was demanded of the request either: the same body succeeded with no
        // `If-Match`, no `If-Unmodified-Since`, and no nonce field.
        const staleIndexRetry = await put({ index: 1 });
        expect(staleIndexRetry.statusCode).toBe(200);
      });
    });
  });

  // -------------------------------------------------------------------------
  // POST /api/books/:id/companion-epub/refresh (#2034 AC9-AC14)
  // -------------------------------------------------------------------------
  describe('POST /api/books/:id/companion-epub/refresh', () => {
    let reconcileMock: Mock;
    let mockLog: ReturnType<typeof installMockAppLog>;

    beforeEach(() => {
      reconcileMock = services.companionEbook.reconcileBook as unknown as Mock;
      // `shared-test-double-defaults-ripple`: re-established AFTER the suite-level
      // `mockResolvedValue`, because these cases reconfigure the same mock. Leaving it rejecting
      // would make `fireAndForget` log a `warn` and break this block's own record assertions.
      reconcileMock.mockReset();
      reconcileMock.mockResolvedValue(undefined);
      mockLog = installMockAppLog(app);
    });

    afterEach(() => {
      mockLog.restore();
    });

    const refresh = () =>
      app.inject({ method: 'POST', url: `/api/books/${BOOK_ID}/companion-epub/refresh` });

    it('AC11: returns 202 with { status: "queued" } and fires exactly one FORCED reconcile', async () => {
      const res = await refresh();

      expect(res.statusCode).toBe(202);
      expect(res.json()).toEqual({ status: 'queued' });
      expect(reconcileMock).toHaveBeenCalledTimes(1);
      // The whole point of the endpoint: a forced pass, so a stale verdict on an unchanged file
      // is re-judged. Drop the `true` and the route becomes an expensive no-op.
      expect(reconcileMock).toHaveBeenCalledWith(BOOK_ID, true);
    });

    // --- AC10: the gate is exactly the selection PUT's two terms -------------

    it('AC10: returns 409 with the module’s disabled body when the feature is off, without reconciling', async () => {
      setSettings({ enabled: false });

      const res = await refresh();

      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual({ error: 'Companion ebooks are disabled' });
      expect(reconcileMock).not.toHaveBeenCalled();
    });

    it('AC10: returns 404 with the module’s notFound body for an unknown book, without reconciling', async () => {
      setBook(null);

      const res = await refresh();

      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: 'Companion ebook not found' });
      expect(reconcileMock).not.toHaveBeenCalled();
    });

    /**
     * AC10's deliberate omission, and the `handleCompanionEpubSelection` precedent: the route
     * gate is a cheap early-out, not the authority. `isCompanionEbookEligible` costs a `stat` of
     * the book directory and the reconciler re-evaluates it inside the lock anyway, so calling it
     * here would buy a second answer that can already have drifted by the time the lock is taken.
     *
     * Neither gate is consulted either, and NOT because "the rows are not `available`" (#2038
     * AC7): this endpoint is deliberately status-AGNOSTIC. The panel renders its re-check
     * control in every state, and forcing a re-judgement of a currently-`available` row — the
     * false-DRM incident in reverse — is a first-class use of it.
     */
    it('AC10: consults neither the eligibility guard nor either gate', async () => {
      const res = await refresh();

      expect(res.statusCode).toBe(202);
      expect(vi.mocked(isCompanionEbookEligible)).not.toHaveBeenCalled();
      expect(vi.mocked(isCompanionEbookExposed)).not.toHaveBeenCalled();
      expect(vi.mocked(isCompanionEbookOwnerReadable)).not.toHaveBeenCalled();
      // And no candidate listing either — the route does no filesystem work of its own.
      expect(vi.mocked(findCompanionEbookCandidates)).not.toHaveBeenCalled();
    });

    it('AC11: is independent of the reconcile — a promise that NEVER settles still returns 202', async () => {
      // If the handler awaited the trigger, `inject` would hang and this case would time out.
      reconcileMock.mockReturnValue(new Promise<void>(() => {}));

      const res = await refresh();

      expect(res.statusCode).toBe(202);
      expect(res.json()).toEqual({ status: 'queued' });
    });

    // --- AC12: the fire-and-forget-preflight pair, as AC28 pins it upstream ---

    it('AC12: a REJECTING reconciler changes neither the status nor the body', async () => {
      reconcileMock.mockRejectedValue(new Error('reconcile rejected'));

      const res = await refresh();

      expect(res.statusCode).toBe(202);
      expect(res.json()).toEqual({ status: 'queued' });
    });

    it('AC12: a SYNCHRONOUSLY THROWING reconciler changes neither the status nor the body', async () => {
      // `fireAndForget` catches a rejection but evaluates its argument EAGERLY, so only
      // `triggerCompanionReconcile`'s own `try` contains this one (fire-and-forget-preflight).
      // Without it, a 202 would become a 500.
      reconcileMock.mockImplementation(() => { throw new Error('reconcile threw synchronously'); });

      const res = await refresh();

      expect(res.statusCode).toBe(202);
      expect(res.json()).toEqual({ status: 'queued' });
    });

    // --- AC13/AC14: ambient auth + CSRF, and the leak-free boundary ---------

    it('AC14: no error body carries a path, a filename, or the library root', async () => {
      setSettings({ enabled: false });
      const disabled = await refresh();
      setSettings({ enabled: true });
      setBook(null);
      const unknown = await refresh();

      for (const body of [disabled.json(), unknown.json()]) {
        const leaves = stringLeaves(body).join('\n');
        for (const secret of [bookPath, libraryRoot, EPUB]) {
          expect(leaves).not.toContain(secret);
        }
      }
    });

    it('AC14: the happy path emits no boundary warn record at all', async () => {
      await refresh();

      // Matching every shipped route in this module: a success logs nothing, and the 202 is not
      // an outcome worth a default-level record.
      expect(mockLog.spies.warn).not.toHaveBeenCalled();
    });

    /**
     * AC13 — auth and CSRF are AMBIENT, so they need their own app: `createTestApp` deliberately
     * registers no `authPlugin`, which is why every other case in this file reaches the handler
     * unauthenticated. Built on the shared `createAuthTestApp`, which installs the real plugin.
     *
     * The route wires nothing itself. What these two cases prove is that it inherits the
     * protection: `POST` is a non-safe method, so `enforceCsrf` covers it, and the path is not in
     * `BASE_PUBLIC_ROUTES` (which is module-private — the 401 without credentials IS the
     * observable for that).
     */
    describe('AC13: ambient auth and CSRF, in basic-auth mode', () => {
      let csrfApp: ZodTestApp;
      let basicAuthHeader: string;
      const url = `/api/books/${BOOK_ID}/companion-epub/refresh`;

      beforeEach(async () => {
        const { companionEbookRoutes } = await import('./companion-ebook.js');

        const csrfServices = createMockServices();
        (csrfServices.companionEbook.reconcileBook as unknown as Mock).mockResolvedValue(undefined);
        const settings = createMockSettings({
          companionEpub: { enabled: true },
          library: { path: libraryRoot },
        });
        (csrfServices.settings.get as Mock).mockImplementation((category: keyof typeof settings) =>
          Promise.resolve(settings[category]));
        (csrfServices.book.getById as Mock).mockResolvedValue({
          id: BOOK_ID, status: 'imported', path: bookPath, title: 'Title',
        });

        ({ app: csrfApp, authHeader: basicAuthHeader } = await createAuthTestApp(csrfServices, {
          db: inject<Db>(createMockDb()),
          // `companionEbookRoutes` is reached through a `never` cast — `withTypeProvider` is a
          // type-level operation only, so the two COMPILERS the helper sets are what matter.
          routes: (app, services, db) => companionEbookRoutes(
            app as never,
            {
              bookService: services.book,
              settingsService: services.settings,
              reconciler: services.companionEbook as never,
            },
            db,
          ),
        }));
      });

      afterEach(async () => {
        await csrfApp.close();
      });

      it('rejects the POST with 403 when X-Requested-With is absent', async () => {
        const res = await csrfApp.inject({ method: 'POST', url, headers: { authorization: basicAuthHeader } });

        expect(res.statusCode).toBe(403);
        expect(JSON.parse(res.payload).error).toMatch(/CSRF/);
      });

      it('lets the POST through with X-Requested-With, and 401s it with no credentials at all', async () => {
        const allowed = await csrfApp.inject({
          method: 'POST',
          url,
          headers: { authorization: basicAuthHeader, 'x-requested-with': 'XMLHttpRequest' },
        });
        expect(allowed.statusCode).toBe(202);

        // Not in `BASE_PUBLIC_ROUTES`: with no credentials the ambient hook challenges first.
        const unauthenticated = await csrfApp.inject({ method: 'POST', url });
        expect(unauthenticated.statusCode).toBe(401);
      });
    });
  });

  // ==========================================================================
  // #1960 AC26–AC31 — an unavailable read enqueues a reconcile, self-healing
  //
  // Every case in here seeds the default stored `available` row, so each one IS a genuine
  // stored/live disagreement and the per-test wording below stays accurate. The describe is
  // named for the trigger (the read could not serve its file) rather than for the cause,
  // because since #2038 the owner arm also fires on an AGREEING stored-DRM/live-DRM read —
  // covered separately in `a genuinely encrypted file still 404s at the live inspection`.
  // ==========================================================================

  describe('#1960 an unavailable owner read enqueues a reconcile', () => {
    const NEGATIVE_OUTCOMES = ['invalid_filename', 'not_regular_file', 'outside_library', 'missing', 'unreadable'] as const;

    const reconcileMock = () => services.companionEbook.reconcileBook as unknown as Mock;

    // --- Owner download (site 2): every `openCompanionEbook` negative -------

    it.each(NEGATIVE_OUTCOMES)('owner download: %s enqueues exactly one reconcile, with the 404 unchanged', async (outcome) => {
      vi.mocked(openCompanionEbook).mockResolvedValueOnce({ outcome });

      const res = await download();

      expect(res.statusCode).toBe(404);
      expect(JSON.parse(res.payload)).toEqual({ error: 'Companion ebook not found' });
      expect(reconcileMock()).toHaveBeenCalledTimes(1);
      expect(reconcileMock()).toHaveBeenCalledWith(BOOK_ID);
    });

    // --- Owner metadata + cover (site 1): every resolver negative -----------

    it.each(NEGATIVE_OUTCOMES)('owner metadata: %s enqueues exactly one reconcile, with the 404 unchanged', async (outcome) => {
      vi.mocked(resolveCompanionEbookPath).mockResolvedValueOnce({ outcome });

      const res = await metadataReq();

      expect(res.statusCode).toBe(404);
      expect(JSON.parse(res.payload)).toEqual({ error: 'Companion ebook not found' });
      expect(reconcileMock()).toHaveBeenCalledTimes(1);
      expect(reconcileMock()).toHaveBeenCalledWith(BOOK_ID);
    });

    it.each(NEGATIVE_OUTCOMES)('owner cover: %s enqueues exactly one reconcile, with the 404 unchanged', async (outcome) => {
      vi.mocked(resolveCompanionEbookPath).mockResolvedValueOnce({ outcome });

      const res = await coverReq();

      expect(res.statusCode).toBe(404);
      expect(JSON.parse(res.payload)).toEqual({ error: 'Companion ebook not found' });
      expect(reconcileMock()).toHaveBeenCalledTimes(1);
    });

    // --- AC27: the two post-resolve disagreement arms -----------------------

    it('AC27: an inspectEpub THROW enqueues exactly one reconcile', async () => {
      // The resolver says `ok` and the file vanishes immediately afterwards — a mismatch by
      // the same definition, even though the resolver succeeded.
      await writeEpub();
      vi.mocked(resolveCompanionEbookPath).mockImplementationOnce(async (input, log) => {
        const real = await vi.importActual<typeof import('../services/companion-ebook-open.js')>(
          '../services/companion-ebook-open.js',
        );
        const resolved = await real.resolveCompanionEbookPath(input, log);
        await rm(join(bookPath, EPUB), { force: true });
        return resolved;
      });

      const res = await metadataReq();

      expect(res.statusCode).toBe(404);
      expect(reconcileMock()).toHaveBeenCalledTimes(1);
    });

    it('AC27: an inspection that does not agree with the stored row enqueues exactly one reconcile', async () => {
      // A real, readable file that is NOT a valid EPUB — `inspectEpub` returns a non-`available`
      // verdict rather than throwing.
      await writeEpub(EPUB, 'not a zip at all');

      const res = await metadataReq();

      expect(res.statusCode).toBe(404);
      expect(reconcileMock()).toHaveBeenCalledTimes(1);
    });

    // --- The happy paths enqueue nothing ------------------------------------

    it('a successful download enqueues ZERO reconciles', async () => {
      await writeEpub();

      expect((await download()).statusCode).toBe(200);
      expect(reconcileMock()).not.toHaveBeenCalled();
    });

    it('a successful metadata read enqueues ZERO reconciles', async () => {
      await placeEpub();

      expect((await metadataReq()).statusCode).toBe(200);
      expect(reconcileMock()).not.toHaveBeenCalled();
    });

    // --- AC28: isolation ----------------------------------------------------

    it('AC28: a REJECTING reconciler changes neither the status code nor the body', async () => {
      reconcileMock().mockRejectedValue(new Error('reconcile rejected'));
      vi.mocked(openCompanionEbook).mockResolvedValueOnce({ outcome: 'missing' });

      const res = await download();

      expect(res.statusCode).toBe(404);
      expect(JSON.parse(res.payload)).toEqual({ error: 'Companion ebook not found' });
    });

    it('AC28: a SYNCHRONOUSLY THROWING reconciler changes neither the status code nor the body', async () => {
      reconcileMock().mockImplementation(() => { throw new Error('reconcile threw synchronously'); });
      vi.mocked(openCompanionEbook).mockResolvedValueOnce({ outcome: 'missing' });

      const res = await download();

      expect(res.statusCode).toBe(404);
      expect(JSON.parse(res.payload)).toEqual({ error: 'Companion ebook not found' });
    });

    // --- AC31: the accepted persistent re-enqueue, and its cost bound --------

    it('AC31 (accepted characteristic): two consecutive outside-root requests enqueue TWICE, the row is unchanged, the owner gate stays open, and NO readdir happens', async () => {
      // This is the documented, bilaterally-agreed stale window after a library-root change —
      // NOT a bug. `reconcileBook` registers a fresh run per call and `withBookAdmissionLock`
      // only serializes them; nothing coalesces on this path. The run stops at the LEXICAL
      // containment check, which performs zero filesystem calls, so the cost per request is
      // one eligibility probe and the owner gate never closes.
      const reconcilerDb = createMockDb();
      let snapshotReads = 0;
      reconcilerDb.select.mockImplementation(() => ({
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        limit: vi.fn().mockImplementation(() => {
          snapshotReads++;
          // Odd read = the `books` snapshot (imported, path OUTSIDE the root); even = observation.
          return Promise.resolve(snapshotReads % 2 === 1 ? [{ id: BOOK_ID, status: 'imported', path: bookPath }] : []);
        }),
      }));
      // A root that does NOT contain `bookPath` — the post-root-change stale window.
      const newRoot = await realpath(mkdtempSync(join(tmpdir(), 'narratorr-1960-newroot-')));
      const reconciler = new CompanionEbookReconciler(
        inject<Db>(reconcilerDb),
        inject<ConstructorParameters<typeof CompanionEbookReconciler>[1]>({
          get: vi.fn().mockImplementation((cat: string) =>
            Promise.resolve(cat === 'companionEpub' ? { enabled: true } : { path: newRoot })),
        }),
        inject<ConstructorParameters<typeof CompanionEbookReconciler>[2]>(createMockLogger()),
      );

      const runs: Promise<void>[] = [];
      const localServices = createMockServices();
      localServices.companionEbook = inject<Services['companionEbook']>({
        reconcileBook: (id: number) => { const p = reconciler.reconcileBook(id); runs.push(p); return p; },
        reconcileAll: () => reconciler.reconcileAll(),
      });
      const localDb = createMockDb();
      localDb.select.mockReturnValue(mockDbChain([row()]));
      const localSettings = createMockSettings({ companionEpub: { enabled: true }, library: { path: libraryRoot } });
      (localServices.settings.get as Mock).mockImplementation((c: keyof typeof localSettings) => Promise.resolve(localSettings[c]));
      (localServices.book.getById as Mock).mockResolvedValue({ id: BOOK_ID, status: 'imported', path: bookPath, title: 'Title' });
      const localApp = await createTestApp(localServices, inject<Db>(localDb));

      try {
        // The stored row still says `available`, so exposure lets both requests through to the
        // opener, which then fails containment against the NEW root.
        vi.mocked(openCompanionEbook)
          .mockResolvedValueOnce({ outcome: 'outside_library' })
          .mockResolvedValueOnce({ outcome: 'outside_library' });
        vi.mocked(findCompanionEbookCandidates).mockClear();

        const first = await localApp.inject({ method: 'GET', url: `/api/books/${BOOK_ID}/companion-epub` });
        const second = await localApp.inject({ method: 'GET', url: `/api/books/${BOOK_ID}/companion-epub` });
        await Promise.all(runs);

        expect(first.statusCode).toBe(404);
        expect(second.statusCode).toBe(404);
        // Two enqueues, not one: serialization is not coalescing.
        expect(runs).toHaveLength(2);
        // No write at all, so the owner gate never closes and the next request repeats this.
        expect(reconcilerDb.update).not.toHaveBeenCalled();
        expect(reconcilerDb.insert).not.toHaveBeenCalled();
        expect(reconcilerDb.transaction).not.toHaveBeenCalled();
        // Cost bound: containment rejects LEXICALLY, so discovery is never reached.
        expect(findCompanionEbookCandidates).not.toHaveBeenCalled();
        // Exposure is unchanged — the predicate takes no path or root input.
        expect(isCompanionEbookExposed({ enabled: true, bookStatus: 'imported', observationStatus: 'available' })).toBe(true);
      } finally {
        await localApp.close();
        rmSync(newRoot, { recursive: true, force: true });
      }
    });
  });

});
