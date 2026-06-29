import { describe, it, expect, vi } from 'vitest';
import { mkdir, rm, writeFile, readFile, stat } from 'node:fs/promises';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import { refreshOpfForBook } from './opf-refresh.js';
import { OPF_FILENAME, NARRATORR_OPF_MARKER, hasNarratorrMarker } from '../../core/utils/opf-regex.js';
import type { BookService, BookWithAuthor } from '../services/book.service.js';
import type { SettingsService } from '../services/settings.service.js';

/**
 * Real-fs coverage for the #1670 foreign-file preservation invariant. The route tests
 * (`books.test.ts`) mock `writeOpfForImport`, so they prove the route *calls* the writer but never
 * that a foreign `metadata.opf` actually survives the route→writer path against a real filesystem.
 * These exercise `refreshOpfForBook` + `writeOpfForImport` end-to-end with real I/O. Mirrors the
 * temp-dir lifecycle in `delete-managed-files.test.ts`.
 */

/** A foreign ABS/Calibre `metadata.opf` body (no narratorr marker → must be preserved verbatim). */
const FOREIGN_OPF = '<?xml version="1.0"?>\n<package><metadata><dc:title>From Audiobookshelf</dc:title></metadata></package>\n';
/** A narratorr-authored OPF stub (carries the provenance marker → eligible for overwrite). */
const MARKED_OPF = `<?xml version="1.0"?>\n<package><metadata>\n  ${NARRATORR_OPF_MARKER}\n  <dc:title>Stale Title</dc:title></metadata></package>\n`;

function makeLog(): FastifyBaseLogger {
  return {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    fatal: vi.fn(), trace: vi.fn(), child: vi.fn().mockReturnThis(),
    silent: vi.fn(), level: 'info',
  } as unknown as FastifyBaseLogger;
}

const pathExists = (p: string): Promise<boolean> => stat(p).then(() => true, () => false);

/** A resolved book whose generated OPF is clearly distinct from the stub bodies above. */
function makeBook(): BookWithAuthor {
  return {
    id: 1,
    title: 'The Real Current Title',
    subtitle: null,
    description: 'A description that the foreign file does not contain.',
    publisher: null,
    publishedDate: null,
    asin: 'B00REALASIN',
    isbn: null,
    seriesName: null,
    seriesPosition: null,
    genres: [],
    authors: [{ name: 'Real Author' }],
    narrators: [],
  } as unknown as BookWithAuthor;
}

function makeBookService(): BookService {
  return { getById: vi.fn().mockResolvedValue(makeBook()) } as unknown as BookService;
}

function makeSettingsService(writeOpf: boolean): SettingsService {
  return { get: vi.fn().mockResolvedValue({ writeOpf }) } as unknown as SettingsService;
}

function withTmp(fn: (root: string) => Promise<void>): () => Promise<void> {
  return async () => {
    const root = mkdtempSync(join(tmpdir(), 'narratorr-1699-'));
    try {
      await fn(root);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  };
}

describe('refreshOpfForBook — real-fs foreign-file preservation (#1699)', () => {
  it('preserves a foreign metadata.opf byte-identical when writeOpf=true', withTmp(async (root) => {
    const bookFolder = join(root, 'Author', 'Book');
    await mkdir(bookFolder, { recursive: true });
    const opfPath = join(bookFolder, OPF_FILENAME);
    await writeFile(opfPath, FOREIGN_OPF, 'utf-8');

    await refreshOpfForBook({
      settingsService: makeSettingsService(true),
      bookService: makeBookService(),
      bookId: 1,
      bookFolder,
      log: makeLog(),
    });

    // The foreign file (no narratorr marker) must survive untouched — byte-for-byte.
    expect(await readFile(opfPath, 'utf-8')).toBe(FOREIGN_OPF);
  }));

  it('overwrites a narratorr-managed metadata.opf with current metadata when writeOpf=true', withTmp(async (root) => {
    const bookFolder = join(root, 'Author', 'Book');
    await mkdir(bookFolder, { recursive: true });
    const opfPath = join(bookFolder, OPF_FILENAME);
    await writeFile(opfPath, MARKED_OPF, 'utf-8');

    await refreshOpfForBook({
      settingsService: makeSettingsService(true),
      bookService: makeBookService(),
      bookId: 1,
      bookFolder,
      log: makeLog(),
    });

    const after = await readFile(opfPath, 'utf-8');
    // The own-file marker gate (mayWriteOpf → hasNarratorrMarker) returned true → rewritten.
    expect(after).not.toBe(MARKED_OPF);
    expect(hasNarratorrMarker(after)).toBe(true); // freshly generated OPF re-stamps the marker
    expect(after).toContain('The Real Current Title'); // body now reflects the book's current metadata
  }));

  it('skips entirely (no write, no throw) when bookFolder is null', withTmp(async (root) => {
    const settingsService = makeSettingsService(true);
    const bookService = makeBookService();

    await expect(refreshOpfForBook({
      settingsService,
      bookService,
      bookId: 1,
      bookFolder: null,
      log: makeLog(),
    })).resolves.toBe('skipped');

    // The null guard short-circuits before the writer — settings/book are never consulted and no
    // stray file is joined into the process CWD.
    expect(settingsService.get).not.toHaveBeenCalled();
    expect(bookService.getById).not.toHaveBeenCalled();
    expect(await pathExists(join(root, OPF_FILENAME))).toBe(false);
  }));

  it('leaves a foreign metadata.opf untouched when writeOpf=false', withTmp(async (root) => {
    const bookFolder = join(root, 'Author', 'Book');
    await mkdir(bookFolder, { recursive: true });
    const opfPath = join(bookFolder, OPF_FILENAME);
    await writeFile(opfPath, FOREIGN_OPF, 'utf-8');
    const bookService = makeBookService();

    await refreshOpfForBook({
      settingsService: makeSettingsService(false),
      bookService,
      bookId: 1,
      bookFolder,
      log: makeLog(),
    });

    // The `enabled` short-circuit in writeOpfSidecar fires before the book load — the foreign file is
    // never even read. (Asserting getById is not called distinguishes the short-circuit from the
    // foreign-marker gate, which would *also* preserve this file but only after loading the book.)
    expect(bookService.getById).not.toHaveBeenCalled();
    expect(await readFile(opfPath, 'utf-8')).toBe(FOREIGN_OPF);
  }));

  it('writes nothing and never loads the book when writeOpf=false and no OPF exists', withTmp(async (root) => {
    // With NO existing OPF, the foreign-marker gate can't be what prevents a write (an absent file is
    // ENOENT → mayWriteOpf returns true → it WOULD write). So if no `metadata.opf` appears, the only
    // thing that stopped it is the `enabled` short-circuit. Deleting that guard makes this test fail.
    const bookFolder = join(root, 'Author', 'Book');
    await mkdir(bookFolder, { recursive: true });
    const opfPath = join(bookFolder, OPF_FILENAME);
    const bookService = makeBookService();

    await refreshOpfForBook({
      settingsService: makeSettingsService(false),
      bookService,
      bookId: 1,
      bookFolder,
      log: makeLog(),
    });

    expect(bookService.getById).not.toHaveBeenCalled();
    expect(await pathExists(opfPath)).toBe(false);
  }));
});
