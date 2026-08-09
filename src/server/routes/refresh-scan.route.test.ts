import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { createTestApp, createMockServices, resetMockServices } from '../__tests__/helpers.js';
import type { Services } from './index.js';
import { RefreshScanError } from '../services/refresh-scan.service.js';

vi.mock('../utils/cover-cache.js', () => ({
  serveCoverFromCache: vi.fn().mockResolvedValue(null),
  cleanCoverCache: vi.fn().mockResolvedValue(undefined),
  COVER_FILE_REGEX: /^cover\.(jpg|jpeg|png|webp)$/i,
}));

vi.mock('../config.js', () => ({
  config: { configPath: '/test-config' },
}));

vi.mock('../services/refresh-scan.service.js', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    refreshScanBook: vi.fn(),
  };
});

import { refreshScanBook } from '../services/refresh-scan.service.js';

describe('POST /api/books/:id/refresh-scan', () => {
  let app: Awaited<ReturnType<typeof createTestApp>>;
  let services: Services;

  beforeAll(async () => {
    services = createMockServices();
    app = await createTestApp(services);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    resetMockServices(services);
    vi.mocked(refreshScanBook).mockReset();
  });

  it('returns 200 with RefreshScanResult shape on success', async () => {
    vi.mocked(refreshScanBook).mockResolvedValue({
      bookId: 1,
      codec: 'mp3',
      bitrate: 128000,
      fileCount: 3,
      durationMinutes: 120,
      narratorsUpdated: true,
    });

    const res = await app.inject({ method: 'POST', url: '/api/books/1/refresh-scan' });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body).toEqual({
      bookId: 1,
      codec: 'mp3',
      bitrate: 128000,
      fileCount: 3,
      durationMinutes: 120,
      narratorsUpdated: true,
    });
  });

  it('durationMinutes is in minutes, not raw seconds', async () => {
    vi.mocked(refreshScanBook).mockResolvedValue({
      bookId: 1,
      codec: 'aac',
      bitrate: 256000,
      fileCount: 1,
      durationMinutes: 2,
      narratorsUpdated: false,
    });

    const res = await app.inject({ method: 'POST', url: '/api/books/1/refresh-scan' });
    const body = JSON.parse(res.payload);
    expect(body.durationMinutes).toBe(2);
  });

  // The flag means a source supplied a replacement, not that an embedded tag existed.
  it('passes a true narratorsUpdated through unchanged', async () => {
    vi.mocked(refreshScanBook).mockResolvedValue({
      bookId: 1, codec: 'mp3', bitrate: 128000, fileCount: 1, durationMinutes: 60, narratorsUpdated: true,
    });
    const res = await app.inject({ method: 'POST', url: '/api/books/1/refresh-scan' });
    expect(JSON.parse(res.payload).narratorsUpdated).toBe(true);
  });

  it('passes a false narratorsUpdated through unchanged', async () => {
    vi.mocked(refreshScanBook).mockResolvedValue({
      bookId: 1, codec: 'mp3', bitrate: 128000, fileCount: 1, durationMinutes: 60, narratorsUpdated: false,
    });
    const res = await app.inject({ method: 'POST', url: '/api/books/1/refresh-scan' });
    expect(JSON.parse(res.payload).narratorsUpdated).toBe(false);
  });

  it('returns 404 with error body when book ID does not exist', async () => {
    vi.mocked(refreshScanBook).mockRejectedValue(
      new RefreshScanError('NOT_FOUND', 'Book 999 not found'),
    );
    const res = await app.inject({ method: 'POST', url: '/api/books/999/refresh-scan' });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.payload)).toEqual({ error: 'Book 999 not found' });
  });

  it('returns 400 with error body when book has no path', async () => {
    vi.mocked(refreshScanBook).mockRejectedValue(
      new RefreshScanError('NO_PATH', 'Book 1 has no library path — import it first'),
    );
    const res = await app.inject({ method: 'POST', url: '/api/books/1/refresh-scan' });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.payload)).toEqual({ error: 'Book 1 has no library path — import it first' });
  });

  it('returns 400 with error body when book path does not exist on disk', async () => {
    vi.mocked(refreshScanBook).mockRejectedValue(
      new RefreshScanError('PATH_MISSING', 'Book path does not exist on disk: /lib/book'),
    );
    const res = await app.inject({ method: 'POST', url: '/api/books/1/refresh-scan' });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.payload)).toEqual({ error: 'Book path does not exist on disk: /lib/book' });
  });

  it('returns 400 with error body when no audio files found', async () => {
    vi.mocked(refreshScanBook).mockRejectedValue(
      new RefreshScanError('NO_AUDIO_FILES', 'No audio files found in book directory'),
    );
    const res = await app.inject({ method: 'POST', url: '/api/books/1/refresh-scan' });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.payload)).toEqual({ error: 'No audio files found in book directory' });
  });

  it('returns 500 with generic error body on unexpected error', async () => {
    vi.mocked(refreshScanBook).mockRejectedValue(new Error('Unexpected'));
    const res = await app.inject({ method: 'POST', url: '/api/books/1/refresh-scan' });
    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.payload)).toEqual({ error: 'Internal server error' });
  });

  it('passes bookService, settingsService, and request.log to refreshScanBook', async () => {
    vi.mocked(refreshScanBook).mockResolvedValue({
      bookId: 1, codec: 'mp3', bitrate: 128000, fileCount: 1, durationMinutes: 60, narratorsUpdated: false,
    });
    await app.inject({ method: 'POST', url: '/api/books/1/refresh-scan' });
    expect(refreshScanBook).toHaveBeenCalledWith(
      1,
      expect.anything(), // bookService
      expect.anything(), // settingsService
      expect.anything(), // request.log
    );
  });

  describe('#1960 companion-ebook reconcile', () => {
    const reconcileMock = () => services.companionEbook.reconcileBook as ReturnType<typeof vi.fn>;

    beforeEach(() => {
      reconcileMock().mockResolvedValue(undefined);
    });

    it('AC17: a successful scan fires exactly one reconcileBook for that book', async () => {
      vi.mocked(refreshScanBook).mockResolvedValue({
        bookId: 7, codec: 'mp3', bitrate: 128000, fileCount: 1, durationMinutes: 60, narratorsUpdated: false,
      });

      const res = await app.inject({ method: 'POST', url: '/api/books/7/refresh-scan' });

      expect(res.statusCode).toBe(200);
      expect(reconcileMock()).toHaveBeenCalledTimes(1);
      // Refresh & Scan is a user-initiated force path.
      expect(reconcileMock()).toHaveBeenCalledWith(7, true);
      expect(services.companionEbook.reconcileAll).not.toHaveBeenCalled();
    });

    // Coded errors occur before the audio probe but finally must still force reconciliation.
    it.each([
      ['NOT_FOUND', 'Book 5 not found', 404],
      ['NO_PATH', 'Book 5 has no library path — import it first', 400],
      ['PATH_MISSING', 'Book path does not exist on disk: /lib/book', 400],
      ['NO_AUDIO_FILES', 'No audio files found in book directory', 400],
    ] as const)('AC16: %s still fires one reconcileBook and keeps its %i mapping', async (code, message, status) => {
      vi.mocked(refreshScanBook).mockRejectedValue(new RefreshScanError(code, message));

      const res = await app.inject({ method: 'POST', url: '/api/books/5/refresh-scan' });

      expect(res.statusCode).toBe(status);
      expect(JSON.parse(res.payload)).toEqual({ error: message });
      expect(reconcileMock()).toHaveBeenCalledTimes(1);
      expect(reconcileMock()).toHaveBeenCalledWith(5, true);
    });

    it('AC16: an unexpected throw still fires one reconcileBook and keeps its 500', async () => {
      vi.mocked(refreshScanBook).mockRejectedValue(new Error('Unexpected'));

      const res = await app.inject({ method: 'POST', url: '/api/books/5/refresh-scan' });

      expect(res.statusCode).toBe(500);
      expect(JSON.parse(res.payload)).toEqual({ error: 'Internal server error' });
      expect(reconcileMock()).toHaveBeenCalledTimes(1);
    });

    it('AC15: a rejecting reconciler changes neither the status code nor the body', async () => {
      reconcileMock().mockRejectedValue(new Error('reconcile rejected'));
      vi.mocked(refreshScanBook).mockResolvedValue({
        bookId: 3, codec: 'mp3', bitrate: 128000, fileCount: 2, durationMinutes: 30, narratorsUpdated: true,
      });

      const res = await app.inject({ method: 'POST', url: '/api/books/3/refresh-scan' });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload).bookId).toBe(3);
    });

    it('#2034 AC7: the trigger is still never awaited — a never-settling reconciler still responds', async () => {
      // If the route awaits this promise, inject times out.
      reconcileMock().mockReturnValue(new Promise<void>(() => {}));
      vi.mocked(refreshScanBook).mockResolvedValue({
        bookId: 3, codec: 'mp3', bitrate: 128000, fileCount: 2, durationMinutes: 30, narratorsUpdated: true,
      });

      const res = await app.inject({ method: 'POST', url: '/api/books/3/refresh-scan' });

      expect(res.statusCode).toBe(200);
      expect(reconcileMock()).toHaveBeenCalledWith(3, true);
    });

    it('#2034 AC7: a SYNCHRONOUSLY THROWING reconciler changes neither the status code nor the body', async () => {
      // fireAndForget evaluates eagerly, so the trigger's own try must contain this throw.
      reconcileMock().mockImplementation(() => { throw new Error('reconcile threw synchronously'); });
      vi.mocked(refreshScanBook).mockResolvedValue({
        bookId: 3, codec: 'mp3', bitrate: 128000, fileCount: 2, durationMinutes: 30, narratorsUpdated: true,
      });

      const res = await app.inject({ method: 'POST', url: '/api/books/3/refresh-scan' });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload).bookId).toBe(3);
    });
  });

  /**
   * Source-scan the cross-suite invariant: only two user actions force; seven seams must not.
   * Count arguments because omitted force and explicit undefined are observably different to Vitest.
   */
  describe('#2034 AC8: triggerCompanionReconcile call-site inventory', () => {
    /** Count top-level arguments while respecting nesting and quotes. */
    function countArgs(argText: string): number {
      let depth = 0;
      let quote: string | null = null;
      let args = argText.trim() === '' ? 0 : 1;
      for (let i = 0; i < argText.length; i++) {
        const char = argText[i]!;
        if (quote !== null) {
          if (char === '\\') i++;
          else if (char === quote) quote = null;
          continue;
        }
        if (char === "'" || char === '"' || char === '`') quote = char;
        else if ('([{'.includes(char)) depth++;
        else if (')]}'.includes(char)) depth--;
        else if (char === ',' && depth === 0) args++;
      }
      // A trailing comma before the close paren is style, not an argument.
      return argText.trimEnd().endsWith(',') ? args - 1 : args;
    }

    /** Every `triggerCompanionReconcile(...)` CALL in a source file, with its argument count. */
    function callsIn(source: string): number[] {
      const counts: number[] = [];
      // Skip import bindings and this.triggerCompanionReconcile method calls.
      const pattern = /(?<![.\w])triggerCompanionReconcile\(/g;
      for (let match = pattern.exec(source); match !== null; match = pattern.exec(source)) {
        // The same-named METHOD DECLARATION in `import-queue-worker.ts` is not a call.
        const lineStart = source.lastIndexOf('\n', match.index) + 1;
        if (/\b(private|public|protected|function)\s+$/.test(source.slice(lineStart, match.index))) continue;

        let depth = 1;
        let i = match.index + match[0].length;
        const argStart = i;
        let quote: string | null = null;
        for (; i < source.length && depth > 0; i++) {
          const char = source[i]!;
          if (quote !== null) {
            if (char === '\\') i++;
            else if (char === quote) quote = null;
            continue;
          }
          if (char === "'" || char === '"' || char === '`') quote = char;
          else if ('([{'.includes(char)) depth++;
          else if (')]}'.includes(char)) depth--;
        }
        counts.push(countArgs(source.slice(argStart, i - 1)));
      }
      return counts;
    }

    // Only Refresh & Scan and companion refresh force. The seven background/read seams do not;
    // forcing request-time opener paths would put full EPUB validation on an unbounded rate path.
    const INVENTORY = [
      // Two renames (non-forcing), then Refresh & Scan (forcing).
      { file: 'src/server/routes/books.ts', counts: [4, 4, 5] },
      { file: 'src/server/routes/books-fix-match.ts', counts: [4] },
      // The owner read-unavailable arm (non-forcing), then the refresh endpoint (forcing).
      { file: 'src/server/routes/companion-ebook.ts', counts: [4, 5] },
      { file: 'src/server/routes/v1/companion-ebook.ts', counts: [4] },
      { file: 'src/server/services/book-rejection.service.ts', counts: [4] },
      { file: 'src/server/services/import-queue-worker.ts', counts: [4] },
    ] as const;

    it.each(INVENTORY)('$file passes exactly $counts arguments per call', async ({ file, counts }) => {
      const { readFile } = await import('node:fs/promises');
      const source = await readFile(new URL(`../../../${file}`, import.meta.url), 'utf8');

      expect(callsIn(source)).toEqual([...counts]);
    });

    it('has exactly TWO forcing call sites and SEVEN non-forcing ones (AC8)', async () => {
      const { readFile } = await import('node:fs/promises');
      const forcing: string[] = [];
      let nonForcing = 0;
      for (const { file } of INVENTORY) {
        const source = await readFile(new URL(`../../../${file}`, import.meta.url), 'utf8');
        for (const count of callsIn(source)) {
          if (count > 4) forcing.push(file);
          else nonForcing++;
        }
      }

      expect(forcing).toEqual([
        'src/server/routes/books.ts',
        'src/server/routes/companion-ebook.ts',
      ]);
      expect(nonForcing).toBe(7);
    });

    it('covers every triggerCompanionReconcile call site in the tree — the inventory cannot go stale', async () => {
      const { readdir, readFile } = await import('node:fs/promises');
      const serverRoot = new URL('../../', import.meta.url);

      async function walk(dir: URL): Promise<string[]> {
        const found: string[] = [];
        for (const entry of await readdir(dir, { withFileTypes: true })) {
          const child = new URL(`${entry.name}${entry.isDirectory() ? '/' : ''}`, dir);
          if (entry.isDirectory()) found.push(...await walk(child));
          else if (entry.name.endsWith('.ts') && !entry.name.includes('.test.')) {
            const source = await readFile(child, 'utf8');
            // The trigger's own definition is not a call site.
            if (callsIn(source).length > 0 && !entry.name.startsWith('companion-ebook-trigger')) {
              found.push(child.pathname);
            }
          }
        }
        return found;
      }

      const discovered = (await walk(serverRoot)).map((path) => `src/server${path.split('/src/server')[1]}`).sort();

      expect(discovered).toEqual(INVENTORY.map((entry) => entry.file).sort());
    });
  });
});
