import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, writeFile, realpath, rm, symlink } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createTestApp,
  createMockServices,
  resetMockServices,
  createMockDb,
  mockDbChain,
  installMockAppLog,
  createMockLogger,
  inject,
} from '../__tests__/helpers.js';
import { createMockSettings } from '../../shared/schemas/settings/create-mock-settings.fixtures.js';
import type { Db } from '../../db/index.js';
import type { Services } from './index.js';
import type { CompanionEbookRow } from '../services/types.js';
import { isCompanionEbookExposed } from '../../shared/companion-ebook-exposure.js';
import { isCompanionEbookEligible } from '../services/companion-ebook-eligibility.js';
import { findCompanionEbookCandidates } from '../services/companion-ebook-discovery.js';
import { openCompanionEbook, resolveCompanionEbookPath } from '../services/companion-ebook-open.js';
import * as F from '../../core/__tests__/epub-archive.fixture.js';
import { MAX_EPUB_COVER_BYTES } from '../../core/epub/limits.js';
import { CompanionEbookReconciler, type CompanionSelectionResult } from '../services/companion-ebook-reconciler.js';

/**
 * The three collaborators are wrapped in spies that DELEGATE to the real implementations, so
 * every case below still runs against a real temp directory while the two negative invariants
 * — "eligibility is never called on the download path" and "no `readdir` for a stored-only
 * status" — stay assertable. They live in modules separate from the route, which is what makes
 * `vi.mock` intercept the route's call at all (esm-same-module-vi-mock-bypass).
 */
vi.mock('../../shared/companion-ebook-exposure.js', async () => {
  const actual = await vi.importActual<typeof import('../../shared/companion-ebook-exposure.js')>(
    '../../shared/companion-ebook-exposure.js',
  );
  return { ...actual, isCompanionEbookExposed: vi.fn(actual.isCompanionEbookExposed) };
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
    epubHooks.onStream = undefined;

    libraryRoot = await realpath(mkdtempSync(join(tmpdir(), 'narratorr-1974-route-')));
    bookPath = join(libraryRoot, 'Author', 'Title');
    await mkdir(bookPath, { recursive: true });

    services = createMockServices();
    db = createMockDb();
    // #1960 AC26 — every mismatch arm now enqueues a reconcile. The unconfigured Proxy stub
    // REJECTS, and `fireAndForget` logs that at warn, which would add a second warn to every
    // boundary-record assertion in this suite. Resolve it by default; the mismatch tests below
    // assert the call count, and the isolation test opts back into the rejection explicitly.
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
  // Composed HERE rather than added to `epub-archive.fixture.ts`, which is at 364 of its 400
  // `max-lines` cap with this slate still landing (#2003).

  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);
  const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
  const GIF = Buffer.concat([Buffer.from('GIF89a', 'ascii'), Buffer.from([0x01, 0x00])]);
  const WEBP = Buffer.concat([
    Buffer.from('RIFF', 'ascii'),
    Buffer.from([0x10, 0x00, 0x00, 0x00]),
    Buffer.from('WEBP', 'ascii'),
  ]);
  const SVG = Buffer.from('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"/>', 'utf8');

  const CHAPTER: F.ManifestItem = { id: 'ch1', href: 'ch1.xhtml', mediaType: 'application/xhtml+xml' };
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

    it.each(['none', 'ambiguous', 'invalid', 'drm_protected'] as const)(
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
    it('returns 404 for a symlink at the stored basename, via not_regular_file', async () => {
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

    it('returns 404 when the realpath escapes the library root', async () => {
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
        metadata: { title: 'Fixture', author: null, language: null },
        toc: null,
      });
      expect(Object.keys(body).sort()).toEqual(['metadata', 'toc']);
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
       * F9 / AC20 — the load-bearing distinction. An `ambiguous` row is by definition not
       * `available`, so `isCompanionEbookExposed` is false for EVERY row this route exists to
       * act on. A handler copied from the read ladder would make the picker permanently 404.
       */
      it('reaches the reconciler for a stored ambiguous row and never consults the exposure predicate', async () => {
        setObservation(row({
          status: 'ambiguous', filename: null, sizeBytes: null, mtimeMs: null, ctimeMs: null, candidateCount: 2,
        }));
        selectMock.mockResolvedValue({ outcome: 'selected', row: SELECTED_ROW });

        const res = await put({ index: 1 });

        expect(res.statusCode).toBe(200);
        expect(selectMock).toHaveBeenCalledWith(BOOK_ID, 1);
        // Neither the shared predicate nor a re-spelled inline copy of it ran: eligibility is
        // evaluated once, inside the lock, and never at the route.
        expect(vi.mocked(isCompanionEbookExposed)).not.toHaveBeenCalled();
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

  // ==========================================================================
  // #1960 AC26–AC31 — read-path mismatch enqueues a reconcile, self-healing
  // ==========================================================================

  describe('#1960 read-path mismatch enqueues a reconcile', () => {
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

    it('AC31 (accepted characteristic): two consecutive outside-root requests enqueue TWICE, the row is unchanged, exposure stays true, and NO readdir happens', async () => {
      // This is the documented, bilaterally-agreed stale window after a library-root change —
      // NOT a bug. `reconcileBook` registers a fresh run per call and `withBookAdmissionLock`
      // only serializes them; nothing coalesces on this path. The run stops at the LEXICAL
      // containment check, which performs zero filesystem calls, so the cost per request is
      // one eligibility probe and the exposure gate never closes.
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
        // No write at all, so the exposure gate never closes and the next request repeats this.
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
