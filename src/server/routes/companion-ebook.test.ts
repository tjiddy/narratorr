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

// The case-collision fixture is unrepresentable on case-insensitive filesystems.
const CASE_SENSITIVE_FS = process.platform !== 'win32';
import { openCompanionEbook, resolveCompanionEbookPath } from '../services/companion-ebook-open.js';
import * as F from '@core/__tests__/epub-archive.fixture.js';
import { MAX_EPUB_COVER_BYTES } from '@core/epub/limits.js';
import { CompanionEbookReconciler, type CompanionSelectionResult } from '../services/companion-ebook-reconciler.js';

/** Delegating module spies preserve real filesystem behavior while exposing negative calls. */
vi.mock('@shared/companion-ebook-exposure.js', async () => {
  const actual = await vi.importActual<typeof import('@shared/companion-ebook-exposure.js')>(
    '@shared/companion-ebook-exposure.js',
  );
  // Wrap both gates so selection/refresh negatives cannot become vacuous if callers switch gates.
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
    // Delegation lets inspect_failed delete the file after a real successful resolution (#1976).
    resolveCompanionEbookPath: vi.fn(actual.resolveCompanionEbookPath),
  };
});

/** Delegating unzipper hook can fail one member stream while every other case reads real archives. */
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
    // The Proxy stub rejects by default; resolve it so fireAndForget does not add stray warns.
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

  /** Warn boundaries expose only bookId/outcome; resolver debug records may contain paths. */
  function assertBoundaryRecord(record: unknown, outcome: string) {
    expect(record).toEqual({ bookId: BOOK_ID, outcome });
    const leaves = stringLeaves(record).join('\n');
    for (const secret of [bookPath, libraryRoot, EPUB]) {
      expect(leaves).not.toContain(secret);
    }
  }

  const download = () => app.inject({ method: 'GET', url: `/api/books/${BOOK_ID}/companion-epub` });
  const state = () => app.inject({ method: 'GET', url: `/api/books/${BOOK_ID}/companion-epub/state` });

  describe('GET /api/books/:id/companion-epub', () => {
    it('streams the file with the documented headers', async () => {
      await writeEpub();
      const res = await download();

      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe('application/epub+zip');
      expect(res.headers['cache-control']).toBe('private, no-store');
      // Every unsafe header character collapses to a dash.
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

    // drm_protected is deliberately absent: it is served; none/ambiguous name no file and invalid is not servable.
    it.each(['none', 'ambiguous', 'invalid'] as const)(
      'returns 404 for a %s observation',
      async (status) => {
        await writeEpub();
        setObservation(row({ status }));
        expect((await download()).statusCode).toBe(404);
      },
    );

    /** Owner reads serve stored DRM rows because bytes are already local and classification can be wrong (#2038). */
    it('streams a stored drm_protected row with the same headers and bytes as an available one', async () => {
      const bytes = `${EPUB_BYTES} for a book the classifier called DRM'd`;
      await writeEpub(EPUB, bytes);
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

    // AC17 is a negative integration invariant: eligibility never runs on the download path.
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
        // Live candidates ensure a readdir would change the response.
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

    // Every case stores count 2; only live directory cardinality varies (AC26).
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

        // A single live candidate remains actionable as one radio option.
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
          candidateCount: 1,
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

  describe('route-boundary logging', () => {
    let mockLog: ReturnType<typeof installMockAppLog>;

    beforeEach(() => {
      mockLog = installMockAppLog(app);
    });

    afterEach(() => {
      mockLog.restore();
    });

    it('emits { bookId, outcome } and nothing else for a 404 from a non-ok helper outcome', async () => {
      const res = await download();

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

  function navRowsBook(nodes: readonly F.TocNode[], metadata?: F.MetadataOptions): F.EpubOptions {
    return {
      packageOptions: { items: [CHAPTER, NAV_ITEM], ...(metadata && { metadata }) },
      files: [{ name: NAV_ENTRY, content: F.navDocumentXml(F.navXml(nodes)) }],
    };
  }

  function ncxRowsBook(nodes: readonly F.TocNode[]): F.EpubOptions {
    return {
      packageOptions: {
        items: [CHAPTER, NCX_ITEM],
        spine: '<spine toc="ncx"><itemref idref="ch1"/></spine>',
      },
      files: [{ name: NCX_ENTRY, content: F.ncxDocumentXml(F.navMapXml(nodes)) }],
    };
  }

  function coverBook(bytes: Buffer, declaredMediaType = 'image/png'): F.EpubOptions {
    return {
      packageOptions: { items: [CHAPTER, coverItem(declaredMediaType)] },
      files: [{ name: COVER_ENTRY, content: bytes }],
    };
  }

  async function placeEpub(options: F.EpubOptions = {}): Promise<void> {
    await writeFile(join(bookPath, EPUB), await F.buildEpub(options));
  }

  const metadataReq = () => app.inject({ method: 'GET', url: `/api/books/${BOOK_ID}/companion-epub/metadata` });
  const coverReq = () => app.inject({ method: 'GET', url: `/api/books/${BOOK_ID}/companion-epub/cover` });

  const READ_ROUTES: Array<[string, () => ReturnType<typeof metadataReq>]> = [
    ['metadata', metadataReq],
    ['cover', coverReq],
  ];

  /** All three routes share gate behavior; their distinct success payloads are asserted separately. */
  const GATED_ROUTES: Array<[string, () => ReturnType<typeof metadataReq>]> = [
    ['companion-epub (download)', download],
    ...READ_ROUTES,
  ];

  /** Cross-route equality catches any route re-forking the shared owner-readable gate. */
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
      // Require rejection so an all-200 regression cannot satisfy equality.
      expect([409, 404]).toContain(first!.statusCode);
    });

    it('all three routes reach the file layer only after the gate passes', async () => {
      await placeEpub();
      setObservation(row({ status: 'ambiguous' }));

      for (const [, request] of GATED_ROUTES) await request();

      expect(vi.mocked(openCompanionEbook)).not.toHaveBeenCalled();
      expect(vi.mocked(resolveCompanionEbookPath)).not.toHaveBeenCalled();
    });

    /** Positive direction: all three routes pass the owner-readable gate together for stored DRM (#2038). */
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

    // DRM passes this stored-status gate; readable and encrypted live outcomes are pinned below.
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

    // Drive real resolver outcomes; dev/inode identity is intentionally outside this contract.
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

    // Stored available plus a negative live verdict is a stale-window outcome, not a new error class.
    it('returns 404 when inspectEpub RETURNS a non-available status', async () => {
      await writeFile(join(bookPath, EPUB), 'this is not a zip archive at all');
      expect((await request()).statusCode).toBe(404);
    });

    it('returns 404 and never renders any EPUB HTML in the body', async () => {
      await placeEpub(navRowsBook([{ label: 'Chapter One' }]));
      const res = await request();
      expect(res.rawPayload.toString()).not.toContain('<html');
      expect(res.rawPayload.toString()).not.toContain('<nav');
    });
  });

  /**
   * Stored DRM passes the gate, but live inspection still decides. Because both rejection
   * layers flatten to 404, full 200 and resolver/log assertions distinguish the two arms.
   */
  describe('a stored drm_protected row on the read routes', () => {
    it('metadata answers its existing 200 when the live inspection comes back available', async () => {
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
      // A bare fixture would 404 as no_cover and make the gate observation vacuous.
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

    /** The shared fixture encrypts spine content via encryption.xml; font-only encryption is not DRM. */
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
        // Resolver execution proves the gate passed despite the flattened 404.
        expect(vi.mocked(resolveCompanionEbookPath)).toHaveBeenCalledTimes(1);
        expect(mockLog.spies.warn).toHaveBeenCalledTimes(1);
        assertBoundaryRecord(mockLog.spies.warn.mock.calls[0]![0], 'drm_protected');
        expect(services.companionEbook.reconcileBook).toHaveBeenCalledTimes(1);
      });

      /** Stored DRM/live DRM agree, so the warning must say unavailable, not mismatch (#2040). */
      it.each(READ_ROUTES)('names the read unavailable rather than a disagreement, on the %s route', async (_label, request) => {
        await placeEpub(F.drmProtectedEpub());
        setObservation(row({ status: 'drm_protected' }));

        expect((await request()).statusCode).toBe(404);

        expect(mockLog.spies.warn.mock.calls[0]![1]).toBe(
          'Companion ebook inspection did not yield a readable file',
        );
        expect(String(mockLog.spies.warn.mock.calls[0]![1])).not.toMatch(/agree|mismatch/i);
      });

      /** A rejected reconcile is the only way to observe fireAndForget's warning context. */
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

    // toc: null means unreadable, not zero chapters; no parallel count may disagree (AC11).
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

    /** Unique basename reachable only through storage prevents a constant-backed assertion passing vacuously. */
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
      // Emit the stored basename, never re-derive it from the resolved absolute path.
      expect(filename).not.toContain('/');
      expect(filename).not.toContain('\\');
    });

    /** Exact metadata/state filename equality prevents independent derivations from drifting. */
    it('emits exactly what GET /state projects as filename for the same book', async () => {
      await placeDistinctEpub(navRowsBook([{ label: 'One' }]));

      const metadataBody = (await metadataReq()).json();
      const stateBody = (await state()).json();

      expect(stateBody.filename).toBe(DISTINCT);
      expect(metadataBody.filename).toBe(stateBody.filename);
    });

    /** Swap storage after gate capture to pin one filename and one row read per request. */
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
      // Cover the feature gate, stored-status gate, resolver, and live inspection boundaries.
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
      // Owner-library bytes are private and change with the file; never use the public cover cache.
      expect(res.headers['cache-control']).toBe('private, no-store');
      expect(res.rawPayload.equals(bytes)).toBe(true);
    });

    /** Shared inspection may return filename, but the cover contract remains raw image bytes (#2022 AC4). */
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

    // Content type follows sniffed bytes, never the manifest declaration (AC15).
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
      // image/svg+xml is unreachable because sniffing emits only the four supported literals.
      expect(res.headers['content-type']).toBe('image/png');
    });

    it('returns 404 when the book declares no cover', async () => {
      await placeEpub(navRowsBook([{ label: 'One' }]));
      expect((await coverReq()).statusCode).toBe(404);
    });

    it('returns 404 when a <meta name="cover"> names no manifest item', async () => {
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

    // Helmet owns nosniff globally; this route must not set it itself (AC17).
    it('sets no X-Content-Type-Options header of its own', async () => {
      await placeEpub(coverBook(PNG));
      expect((await coverReq()).headers['x-content-type-options']).toBeUndefined();
    });
  });

  describe('inspectEpub rejection maps to 404 on both read routes', () => {
    let mockLog: ReturnType<typeof installMockAppLog>;

    beforeEach(() => {
      mockLog = installMockAppLog(app);
    });

    afterEach(() => {
      mockLog.restore();
    });

    function errorDebugRecords(): Array<Record<string, unknown>> {
      return mockLog.spies.debug.mock.calls
        .map((call) => call[0] as Record<string, unknown>)
        .filter((record) => record !== null && typeof record === 'object' && 'error' in record);
    }

    // Delete after real resolution so inspection rejects; preOpenRejection never converts I/O to a verdict.
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
      // The boundary record stays { bookId, outcome }; underlying error paths stay out of warn and body.
      expect(mockLog.spies.warn).toHaveBeenCalledTimes(1);
      assertBoundaryRecord(mockLog.spies.warn.mock.calls[0]![0], 'inspect_failed');
      const bodyLeaves = stringLeaves(res.json()).join('\n');
      for (const secret of [bookPath, libraryRoot, EPUB]) expect(bodyLeaves).not.toContain(secret);
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
      // Check enumerable keys: objectContaining({ message }) also accepts a raw Error (#1982).
      expect(records[0]!.error).not.toBeInstanceOf(Error);
      expect(Object.keys(records[0]!.error as object).sort()).toEqual(['code', 'message', 'stack', 'type']);
    });

    // An optional-member EIO must share the pre-open rejection channel.
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

    const SELECTED_ROW = row({ status: 'available', filename: 'b.epub', candidateCount: 2, selectedFilename: 'b.epub' });

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

    describe('the pre-lock gate', () => {
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
       * Selection must bypass both read gates: ambiguous rows make both false, so copied read
       * logic would permanently 404 the picker. Eligibility runs once under lock (F9/AC20).
       */
      it('reaches the reconciler for a stored ambiguous row and never consults either gate', async () => {
        setObservation(row({
          status: 'ambiguous', filename: null, sizeBytes: null, mtimeMs: null, ctimeMs: null, candidateCount: 2,
        }));
        selectMock.mockResolvedValue({ outcome: 'selected', row: SELECTED_ROW });

        const res = await put({ index: 1 });

        expect(res.statusCode).toBe(200);
        expect(selectMock).toHaveBeenCalledWith(BOOK_ID, 1);
        expect(vi.mocked(isCompanionEbookExposed)).not.toHaveBeenCalled();
        expect(vi.mocked(isCompanionEbookOwnerReadable)).not.toHaveBeenCalled();
        expect(vi.mocked(isCompanionEbookEligible)).not.toHaveBeenCalled();
      });
    });

    describe('the outcome map', () => {
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
        expect(res.json()).toEqual({ error });
        expectNoLeak(res.json());
        expect(mockLog.spies.warn).toHaveBeenCalledTimes(1);
        assertBoundaryRecord(mockLog.spies.warn.mock.calls[0]![0], outcome);
      });

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

    describe('the selected response', () => {
      it('returns 200 with the state DTO for the row the commit returned', async () => {
        selectMock.mockResolvedValue({ outcome: 'selected', row: SELECTED_ROW });

        const res = await put({ index: 1 });

        expect(res.statusCode).toBe(200);
        // Keep this literal independent; using the production projector would hide shared field drift.
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

        // Stored basenames are public to the owner here; only full paths remain forbidden.
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

      // Selection intentionally has no precondition; the service resolves the fresh occupant (F23).
      it('succeeds with no ETag, nonce, or precondition header participating', async () => {
        selectMock.mockResolvedValue({ outcome: 'selected', row: SELECTED_ROW });

        const res = await put({ index: 1 });

        expect(res.statusCode).toBe(200);
        expect(res.headers.etag).toBeUndefined();
        const staleIndexRetry = await put({ index: 1 });
        expect(staleIndexRetry.statusCode).toBe(200);
      });
    });
  });

  describe('POST /api/books/:id/companion-epub/refresh', () => {
    let reconcileMock: Mock;
    let mockLog: ReturnType<typeof installMockAppLog>;

    beforeEach(() => {
      reconcileMock = services.companionEbook.reconcileBook as unknown as Mock;
      // Restore the resolved default after reset or fireAndForget adds unrelated warn records.
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
      // true forces unchanged files to be rejudged; omitting it makes refresh a no-op.
      expect(reconcileMock).toHaveBeenCalledWith(BOOK_ID, true);
    });

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
     * Refresh is status-agnostic and skips eligibility/read gates. The reconciler rechecks
     * eligibility under lock; a route-level stat would be stale duplicate work (AC10).
     */
    it('AC10: consults neither the eligibility guard nor either gate', async () => {
      const res = await refresh();

      expect(res.statusCode).toBe(202);
      expect(vi.mocked(isCompanionEbookEligible)).not.toHaveBeenCalled();
      expect(vi.mocked(isCompanionEbookExposed)).not.toHaveBeenCalled();
      expect(vi.mocked(isCompanionEbookOwnerReadable)).not.toHaveBeenCalled();
      expect(vi.mocked(findCompanionEbookCandidates)).not.toHaveBeenCalled();
    });

    it('AC11: is independent of the reconcile — a promise that NEVER settles still returns 202', async () => {
      reconcileMock.mockReturnValue(new Promise<void>(() => {}));

      const res = await refresh();

      expect(res.statusCode).toBe(202);
      expect(res.json()).toEqual({ status: 'queued' });
    });

    it('AC12: a REJECTING reconciler changes neither the status nor the body', async () => {
      reconcileMock.mockRejectedValue(new Error('reconcile rejected'));

      const res = await refresh();

      expect(res.statusCode).toBe(202);
      expect(res.json()).toEqual({ status: 'queued' });
    });

    it('AC12: a SYNCHRONOUSLY THROWING reconciler changes neither the status nor the body', async () => {
      // fireAndForget catches rejections, but its eagerly evaluated argument can throw first.
      reconcileMock.mockImplementation(() => { throw new Error('reconcile threw synchronously'); });

      const res = await refresh();

      expect(res.statusCode).toBe(202);
      expect(res.json()).toEqual({ status: 'queued' });
    });

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

      expect(mockLog.spies.warn).not.toHaveBeenCalled();
    });

    /** createTestApp omits auth; createAuthTestApp verifies inherited auth and CSRF with the real plugin. */
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
          // withTypeProvider is type-only; the helper's two compilers determine runtime behavior.
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

        const unauthenticated = await csrfApp.inject({ method: 'POST', url });
        expect(unauthenticated.statusCode).toBe(401);
      });
    });
  });

  /** Default available rows make these negatives stored/live disagreements; DRM agreement is covered above. */
  describe('#1960 an unavailable owner read enqueues a reconcile', () => {
    const NEGATIVE_OUTCOMES = ['invalid_filename', 'not_regular_file', 'outside_library', 'missing', 'unreadable'] as const;

    const reconcileMock = () => services.companionEbook.reconcileBook as unknown as Mock;

    it.each(NEGATIVE_OUTCOMES)('owner download: %s enqueues exactly one reconcile, with the 404 unchanged', async (outcome) => {
      vi.mocked(openCompanionEbook).mockResolvedValueOnce({ outcome });

      const res = await download();

      expect(res.statusCode).toBe(404);
      expect(JSON.parse(res.payload)).toEqual({ error: 'Companion ebook not found' });
      expect(reconcileMock()).toHaveBeenCalledTimes(1);
      expect(reconcileMock()).toHaveBeenCalledWith(BOOK_ID);
    });

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

    it('AC27: an inspectEpub THROW enqueues exactly one reconcile', async () => {
      // The resolver returns ok, then the file vanishes before inspection.
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
      // A readable non-EPUB returns a negative verdict rather than throwing.
      await writeEpub(EPUB, 'not a zip at all');

      const res = await metadataReq();

      expect(res.statusCode).toBe(404);
      expect(reconcileMock()).toHaveBeenCalledTimes(1);
    });

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

    it('AC31 (accepted characteristic): two consecutive outside-root requests enqueue TWICE, the row is unchanged, the owner gate stays open, and NO readdir happens', async () => {
      // Accepted root-change stale window: runs serialize without coalescing, and lexical
      // containment fails before discovery, leaving the owner gate open at bounded cost.
      const reconcilerDb = createMockDb();
      let snapshotReads = 0;
      reconcilerDb.select.mockImplementation(() => ({
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        limit: vi.fn().mockImplementation(() => {
          snapshotReads++;
          // Odd reads are book snapshots; even reads are observations.
          return Promise.resolve(snapshotReads % 2 === 1 ? [{ id: BOOK_ID, status: 'imported', path: bookPath }] : []);
        }),
      }));
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
        // Stored availability admits both requests before the new-root containment failure.
        vi.mocked(openCompanionEbook)
          .mockResolvedValueOnce({ outcome: 'outside_library' })
          .mockResolvedValueOnce({ outcome: 'outside_library' });
        vi.mocked(findCompanionEbookCandidates).mockClear();

        const first = await localApp.inject({ method: 'GET', url: `/api/books/${BOOK_ID}/companion-epub` });
        const second = await localApp.inject({ method: 'GET', url: `/api/books/${BOOK_ID}/companion-epub` });
        await Promise.all(runs);

        expect(first.statusCode).toBe(404);
        expect(second.statusCode).toBe(404);
        expect(runs).toHaveLength(2);
        expect(reconcilerDb.update).not.toHaveBeenCalled();
        expect(reconcilerDb.insert).not.toHaveBeenCalled();
        expect(reconcilerDb.transaction).not.toHaveBeenCalled();
        expect(findCompanionEbookCandidates).not.toHaveBeenCalled();
        expect(isCompanionEbookExposed({ enabled: true, bookStatus: 'imported', observationStatus: 'available' })).toBe(true);
      } finally {
        await localApp.close();
        rmSync(newRoot, { recursive: true, force: true });
      }
    });
  });

});
