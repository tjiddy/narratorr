import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import type { FastifyBaseLogger } from 'fastify';

// Real filesystem semantics AND injected errno failures: the temp+rename replacement, the
// hard-link identity guarantees, and the type policy are all unobservable through a fully mocked
// fs, while the ENOSPC/EACCES arms cannot be produced without injection.
const actualFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');

vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal() as Record<string, unknown>),
  writeFile: vi.fn(),
  rename: vi.fn(),
}));

import { rename, writeFile } from 'node:fs/promises';
import { generateOpf, sidecarLockKey, writeOpfSidecar, type OpfWriteOutcome } from './opf-writer.js';
import { refreshOpfForBook } from './opf-refresh.js';
import { hasPendingPathWrite, withPathWriteLock } from './path-write-lock.js';
import { reconcileBookSidecars } from '../services/bulk-sidecar-reconcile.js';
import { NARRATORR_OPF_MARKER, OPF_BACKUP_FILENAME, OPF_FILENAME } from '@core/utils/opf-regex.js';
import type { Db } from '@db/index.js';
import type { BookService, BookWithAuthor } from '../services/book.service.js';
import type { EventHistoryService } from '../services/event-history.service.js';
import type { SettingsService } from '../services/settings.service.js';

/** Windows raises EPERM without Developer Mode; probe the capability rather than the platform. */
async function probe(make: (dir: string) => Promise<void>): Promise<boolean> {
  const dir = await actualFs.mkdtemp(join(tmpdir(), 'opf-probe-'));
  try {
    await make(dir);
    return true;
  } catch {
    return false;
  } finally {
    await actualFs.rm(dir, { recursive: true, force: true }).catch(() => { /* tolerant */ });
  }
}

const CAN_SYMLINK = await probe(async (dir) => {
  const target = join(dir, 't');
  await actualFs.writeFile(target, '');
  await actualFs.symlink(target, join(dir, 'l'));
});

const CAN_HARDLINK = await probe(async (dir) => {
  const target = join(dir, 't');
  await actualFs.writeFile(target, '');
  await actualFs.link(target, join(dir, 'peer'));
});

function makeLog(): FastifyBaseLogger {
  return {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    fatal: vi.fn(), trace: vi.fn(), child: vi.fn().mockReturnThis(),
    silent: vi.fn(), level: 'info',
  } as unknown as FastifyBaseLogger;
}

function makeBook(path: string | null, overrides: Partial<BookWithAuthor> = {}): BookWithAuthor {
  return {
    id: 1,
    path,
    title: 'Mort',
    subtitle: null,
    description: null,
    publisher: null,
    coverUrl: null,
    asin: null,
    isbn: null,
    seriesName: null,
    seriesPosition: null,
    duration: null,
    publishedDate: null,
    genres: null,
    authors: [{ name: 'Terry Pratchett' }],
    narrators: [],
    ...overrides,
  } as unknown as BookWithAuthor;
}

function makeBookService(...books: (BookWithAuthor | null)[]): BookService {
  const getById = vi.fn();
  for (const book of books) getById.mockResolvedValueOnce(book);
  getById.mockResolvedValue(books.at(-1) ?? null);
  return { getById } as unknown as BookService;
}

function makeEventHistory(): { service: EventHistoryService; create: Mock } {
  const create = vi.fn().mockResolvedValue({ id: 1 });
  return { service: { create } as unknown as EventHistoryService, create };
}

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: injected`), { code });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** Poll rather than await: the point is to observe disk state mid-sequence. */
async function until(predicate: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('condition never became true');
}

let root: string;
let folder: string;
let opfPath: string;
let bakPath: string;

beforeEach(async () => {
  vi.clearAllMocks();
  // The factory's vi.fn()s carry no implementation, so re-arm the real ones every test.
  (writeFile as Mock).mockImplementation(actualFs.writeFile as never);
  (rename as Mock).mockImplementation(actualFs.rename as never);

  root = await actualFs.mkdtemp(join(tmpdir(), 'narratorr-2297-'));
  folder = join(root, 'Terry Pratchett', 'Mort');
  await actualFs.mkdir(folder, { recursive: true });
  opfPath = join(folder, OPF_FILENAME);
  bakPath = join(folder, OPF_BACKUP_FILENAME);
});

afterEach(async () => {
  // Windows keeps handles open; a leaked tmpdir is cheaper than a red suite.
  await actualFs.rm(root, { recursive: true, force: true }).catch(() => { /* tolerant */ });
});

const read = (path: string): Promise<string> => actualFs.readFile(path, 'utf-8');
const readBytes = (path: string): Promise<Buffer> => actualFs.readFile(path);
const exists = (path: string): Promise<boolean> => actualFs.stat(path).then(() => true, () => false);

async function tempsLeftBehind(): Promise<string[]> {
  return (await actualFs.readdir(folder)).filter((name) => name.endsWith('.tmp'));
}

interface RunOptions {
  book: BookWithAuthor;
  bookService?: BookService;
  eventHistory?: EventHistoryService | undefined;
  preserve?: boolean;
  onFailure?: (cause: unknown) => void;
  log?: FastifyBaseLogger;
  bookFolder?: string;
}

async function runWrite(options: RunOptions): Promise<OpfWriteOutcome> {
  const { book, preserve = true, eventHistory, onFailure, log = makeLog() } = options;
  return writeOpfSidecar({
    enabled: true,
    bookService: options.bookService ?? makeBookService(book),
    bookId: book.id,
    bookFolder: options.bookFolder ?? folder,
    log,
    ...(onFailure && { onFailure }),
    ...(preserve && { preserve: { source: 'auto' as const, ...(eventHistory && { eventHistory }) } }),
  });
}

/** A hand-built marked document, so a formatting change in `generateOpf` cannot move the fixture. */
function markedDoc(inner: string): string {
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<package version="2.0" xmlns="http://www.idpf.org/2007/opf" unique-identifier="bookid">',
    '<metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">',
    `  ${NARRATORR_OPF_MARKER}`,
    inner,
    '</metadata>',
    '</package>',
    '',
  ].join('\n');
}

// The book whose generated document recovers no metadata at all: `title` passes
// `z.string().trim().min(1)` but `escapeXml` strips the control, so `<dc:title>` is empty.
const unparseableBook = (path: string) => makeBook(path, {
  title: '', authors: [], narrators: [], genres: null,
} as Partial<BookWithAuthor>);

describe('writeOpfSidecar — divergence preservation (#2297)', () => {
  it('preserves the curated sidecar, records the divergence, then writes the DB values', async () => {
    const curated = generateOpf(makeBook(folder, { seriesName: 'Discworld', seriesPosition: 4 }));
    await actualFs.writeFile(opfPath, curated, 'utf-8');

    const imported = makeBook(folder, { seriesName: 'Discworld: Death', seriesPosition: 1 });
    const { service, create } = makeEventHistory();
    const outcome = await runWrite({ book: imported, eventHistory: service });

    expect(outcome).toBe('written');
    expect(await read(bakPath)).toBe(curated);
    expect(await read(opfPath)).toBe(generateOpf(imported));

    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      bookId: 1,
      bookTitle: 'Mort',
      eventType: 'sidecar_diverged',
      source: 'auto',
      reason: {
        changed_fields: ['seriesName', 'seriesPosition'],
        previous: { seriesName: 'Discworld', seriesPosition: 4 },
      },
    }));
  });

  it('treats a non-series divergence identically (publisher revised, narrator dropped)', async () => {
    const curated = generateOpf(makeBook(folder, {
      publisher: 'Gollancz', narrators: [{ name: 'Nigel Planer' }],
    } as Partial<BookWithAuthor>));
    await actualFs.writeFile(opfPath, curated, 'utf-8');

    const imported = makeBook(folder, { publisher: 'Corgi', narrators: [] } as Partial<BookWithAuthor>);
    const { service, create } = makeEventHistory();

    expect(await runWrite({ book: imported, eventHistory: service })).toBe('written');
    expect(await read(bakPath)).toBe(curated);
    expect(create.mock.calls[0]![0].reason).toEqual({
      changed_fields: ['narrators', 'publisher'],
      previous: { narrators: ['Nigel Planer'], publisher: 'Gollancz' },
    });
  });

  it('places the backup and issues the event BEFORE the sidecar is replaced (AC1 order)', async () => {
    const curated = generateOpf(makeBook(folder, { seriesName: 'Discworld', seriesPosition: 4 }));
    await actualFs.writeFile(opfPath, curated, 'utf-8');

    const held = deferred<{ id: number }>();
    const create = vi.fn().mockReturnValue(held.promise);
    const eventHistory = { create } as unknown as EventHistoryService;

    const pending = runWrite({ book: makeBook(folder, { seriesName: 'Discworld: Death' }), eventHistory });

    await until(() => exists(bakPath));
    // A call-order assertion would pass against a writer that replaced first; read the bytes.
    expect(await read(opfPath)).toBe(curated);
    expect(create).toHaveBeenCalledTimes(1);

    held.resolve({ id: 1 });
    expect(await pending).toBe('written');
    expect(await read(opfPath)).toContain('Discworld: Death');
  });
});

describe('writeOpfSidecar — quiet paths (#2297 AC3/AC4)', () => {
  it('byte-identical regeneration produces no backup, no event, and no warning', async () => {
    const book = makeBook(folder, { seriesName: 'Discworld', seriesPosition: 4 });
    await actualFs.writeFile(opfPath, generateOpf(book), 'utf-8');
    const { service, create } = makeEventHistory();
    const log = makeLog();

    expect(await runWrite({ book, eventHistory: service, log })).toBe('written');
    expect(await exists(bakPath)).toBe(false);
    expect(create).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('formatting-only drift writes through quietly (whitespace, unknown meta, reordered scalars)', async () => {
    // Deliberately NOT a mutation of generateOpf output, and deliberately no <dc:creator> or
    // <dc:subject> reordering — those change parsed arrays and are covered as divergences below.
    await actualFs.writeFile(opfPath, markedDoc([
      '      <meta name="calibre:rating" content="5"/>',
      '  <dc:creator opf:role="aut">Terry Pratchett</dc:creator>',
      '  <meta name="calibre:series" content="Discworld"/>',
      '  <meta name="calibre:series_index" content="0"/>',
      '  <dc:title>Mort</dc:title>',
    ].join('\n')), 'utf-8');

    const book = makeBook(folder, { seriesName: 'Discworld', seriesPosition: 0 });
    const { service, create } = makeEventHistory();

    expect(await runWrite({ book, eventHistory: service })).toBe('written');
    expect(await exists(bakPath)).toBe(false);
    expect(create).not.toHaveBeenCalled();
    expect(await read(opfPath)).toBe(generateOpf(book));
  });

  it('leaves a pre-existing metadata.opf.bak untouched on a quiet write', async () => {
    const book = makeBook(folder);
    await actualFs.writeFile(opfPath, generateOpf(book), 'utf-8');
    await actualFs.writeFile(bakPath, `${NARRATORR_OPF_MARKER}earlier`, 'utf-8');

    expect(await runWrite({ book })).toBe('written');
    expect(await read(bakPath)).toBe(`${NARRATORR_OPF_MARKER}earlier`);
  });

  it('produces exactly one artifact pair per diverging book in a batch', async () => {
    const { service, create } = makeEventHistory();
    const folders: string[] = [];
    for (let index = 0; index < 4; index++) {
      const dir = join(root, `book-${index}`);
      await actualFs.mkdir(dir, { recursive: true });
      folders.push(dir);
      const seeded = makeBook(dir, { id: index, publisher: index === 1 || index === 3 ? 'Old' : 'Same' });
      await actualFs.writeFile(join(dir, OPF_FILENAME), generateOpf(seeded), 'utf-8');
    }

    for (const [index, dir] of folders.entries()) {
      const book = makeBook(dir, { id: index, publisher: 'Same' });
      await runWrite({ book, bookFolder: dir, eventHistory: service });
    }

    const backups = await Promise.all(folders.map((dir) => exists(join(dir, OPF_BACKUP_FILENAME))));
    expect(backups).toEqual([false, true, false, true]);
    expect(create).toHaveBeenCalledTimes(2);
  });
});

describe('writeOpfSidecar — equal-under-caps is not equal (#2297 AC4)', () => {
  it('preserves when both descriptions truncate to the same 8,000 characters but differ in the tail', async () => {
    const shared = 'x'.repeat(8_000);
    await actualFs.writeFile(opfPath, generateOpf(makeBook(folder, { description: `${shared}OLD` })), 'utf-8');

    const book = makeBook(folder, { description: `${shared}NEW` });
    const { service, create } = makeEventHistory();

    expect(await runWrite({ book, eventHistory: service })).toBe('written');
    expect(await read(bakPath)).toContain(`${shared}OLD`);
    // Field equality alone would write through and destroy the tail; the empty-changed_fields
    // card is the defect the unproven arm exists to prevent.
    expect(create.mock.calls[0]![0].reason).toEqual({
      changed_fields: ['description'],
      previous: { description: shared },
      equivalence_unproven: true,
    });
  });

  it('adds no noise: the same over-long book re-imported unchanged stays byte-equal and quiet', async () => {
    const book = makeBook(folder, { description: `${'x'.repeat(8_000)}TAIL` });
    await actualFs.writeFile(opfPath, generateOpf(book), 'utf-8');
    const { service, create } = makeEventHistory();

    expect(await runWrite({ book, eventHistory: service })).toBe('written');
    expect(await exists(bakPath)).toBe(false);
    expect(create).not.toHaveBeenCalled();
  });

  it('preserves on a `truncated` diagnostic (title over 512 characters)', async () => {
    const shared = 'T'.repeat(512);
    await actualFs.writeFile(opfPath, generateOpf(makeBook(folder, { title: `${shared}OLD` })), 'utf-8');
    const { service, create } = makeEventHistory();

    await runWrite({ book: makeBook(folder, { title: `${shared}NEW` }), eventHistory: service });
    expect(await exists(bakPath)).toBe(true);
    expect(create.mock.calls[0]![0].reason).toMatchObject({ changed_fields: ['title'], equivalence_unproven: true });
  });

  it('preserves on a `capped` diagnostic (65-element genres array)', async () => {
    const genres = Array.from({ length: 64 }, (_, i) => `G${i}`);
    await actualFs.writeFile(opfPath, generateOpf(makeBook(folder, { genres: [...genres, 'OLD65'] })), 'utf-8');
    const { service, create } = makeEventHistory();

    await runWrite({ book: makeBook(folder, { genres: [...genres, 'NEW65'] }), eventHistory: service });
    expect(await exists(bakPath)).toBe(true);
    expect(create.mock.calls[0]![0].reason).toMatchObject({ changed_fields: ['genres'], equivalence_unproven: true });
  });

  it('preserves on a `dropped-over-bound` diagnostic, and the whole ASIN survives only in the backup', async () => {
    const longAsin = 'B'.repeat(70);
    await actualFs.writeFile(opfPath, generateOpf(makeBook(folder, { asin: longAsin })), 'utf-8');
    const { service, create } = makeEventHistory();

    await runWrite({ book: makeBook(folder, { asin: null }), eventHistory: service });

    const reason = create.mock.calls[0]![0].reason as { changed_fields: string[]; previous: Record<string, unknown> };
    expect(reason.changed_fields).toEqual(['asin']);
    // The reader DROPS an over-bound identifier rather than truncating it into a different
    // identity, so the summary cannot carry it — that is the division of labour with the bytes.
    expect(reason.previous.asin).toBeNull();
    expect(await read(bakPath)).toContain(longAsin);
  });
});

describe('writeOpfSidecar — parse-null arms (#2297 AC5)', () => {
  it.each([
    ['a marker-only document the reader recovers nothing from', markedDoc('')],
    ['a truncated document that still carries the marker', generateOpf(makeBook('/x')).slice(generateOpf(makeBook('/x')).indexOf('<meta name="narratorr:managed"'))],
  ])('preserves when the EXISTING side does not parse (%s)', async (_label, existing) => {
    await actualFs.writeFile(opfPath, existing, 'utf-8');
    const book = makeBook(folder, { seriesName: 'Discworld', seriesPosition: 4 });
    const { service, create } = makeEventHistory();

    expect(await runWrite({ book, eventHistory: service })).toBe('written');
    expect(await read(bakPath)).toBe(existing);

    const reason = create.mock.calls[0]![0].reason as Record<string, unknown>;
    expect(reason.previous).toEqual({});
    expect(reason.previous_unavailable).toBe(true);
    expect(reason.changed_fields).toEqual(['title', 'authors', 'seriesName', 'seriesPosition']);
  });

  it('preserves when the GENERATED side does not parse, listing the values actually at risk', async () => {
    const curated = generateOpf(makeBook(folder, { publisher: 'Gollancz' }));
    await actualFs.writeFile(opfPath, curated, 'utf-8');
    const { service, create } = makeEventHistory();
    const log = makeLog();

    expect(await runWrite({ book: unparseableBook(folder), eventHistory: service, log })).toBe('written');
    expect(await read(bakPath)).toBe(curated);

    const reason = create.mock.calls[0]![0].reason as Record<string, unknown>;
    expect(reason.generated_unparseable).toBe(true);
    expect(reason.changed_fields).toEqual(['title', 'authors', 'publisher']);
    expect(reason.previous).toEqual({ title: 'Mort', authors: ['Terry Pratchett'], publisher: 'Gollancz' });
    expect(log.warn).toHaveBeenCalledWith({ bookId: 1 }, expect.stringContaining('no recoverable metadata'));
  });

  it('sets both flags with an empty changed_fields when NEITHER side parses', async () => {
    await actualFs.writeFile(opfPath, markedDoc(''), 'utf-8');
    const { service, create } = makeEventHistory();

    expect(await runWrite({ book: unparseableBook(folder), eventHistory: service })).toBe('written');
    expect(create.mock.calls[0]![0].reason).toEqual({
      changed_fields: [],
      previous: {},
      previous_unavailable: true,
      generated_unparseable: true,
    });
  });

  it('is quiet when the same unparseable content sits on both sides (byte-equal short-circuits)', async () => {
    const book = unparseableBook(folder);
    await actualFs.writeFile(opfPath, generateOpf(book), 'utf-8');
    const { service, create } = makeEventHistory();
    const log = makeLog();

    expect(await runWrite({ book, eventHistory: service, log })).toBe('written');
    expect(await exists(bakPath)).toBe(false);
    expect(create).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('a first write with an unparseable generated document stays a plain write, but still warns', async () => {
    const { service, create } = makeEventHistory();
    const log = makeLog();

    expect(await runWrite({ book: unparseableBook(folder), eventHistory: service, log })).toBe('written');
    expect(await exists(bakPath)).toBe(false);
    expect(create).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith({ bookId: 1 }, expect.stringContaining('no recoverable metadata'));
  });

  it('a genuinely zero-byte metadata.opf is a foreign file, not an AC5 case', async () => {
    await actualFs.writeFile(opfPath, '', 'utf-8');
    const { service, create } = makeEventHistory();

    expect(await runWrite({ book: makeBook(folder), eventHistory: service })).toBe('skipped');
    expect(await readBytes(opfPath)).toHaveLength(0);
    expect(await exists(bakPath)).toBe(false);
    expect(create).not.toHaveBeenCalled();
  });
});

describe('writeOpfSidecar — field-level divergence rules (#2297 AC4/AC15)', () => {
  it('records seriesPosition 4 → null as previous.seriesPosition === 4', async () => {
    await actualFs.writeFile(opfPath, generateOpf(makeBook(folder, { seriesName: 'Discworld', seriesPosition: 4 })), 'utf-8');
    const { service, create } = makeEventHistory();

    await runWrite({ book: makeBook(folder, { seriesName: 'Discworld', seriesPosition: null }), eventHistory: service });
    expect(create.mock.calls[0]![0].reason.previous).toEqual({ seriesPosition: 4 });
  });

  it('records seriesPosition null → 4 as the key PRESENT with a null value', async () => {
    await actualFs.writeFile(opfPath, generateOpf(makeBook(folder, { seriesName: 'Discworld', seriesPosition: null })), 'utf-8');
    const { service, create } = makeEventHistory();

    await runWrite({ book: makeBook(folder, { seriesName: 'Discworld', seriesPosition: 4 }), eventHistory: service });
    const previous = create.mock.calls[0]![0].reason.previous as Record<string, unknown>;
    expect('seriesPosition' in previous).toBe(true);
    expect(previous.seriesPosition).toBeNull();
  });

  it('treats seriesPosition 0 against null as a divergence (0 is a valid position)', async () => {
    await actualFs.writeFile(opfPath, generateOpf(makeBook(folder, { seriesName: 'Discworld', seriesPosition: 0 })), 'utf-8');
    const { service, create } = makeEventHistory();

    await runWrite({ book: makeBook(folder, { seriesName: 'Discworld', seriesPosition: null }), eventHistory: service });
    expect(create.mock.calls[0]![0].reason.previous).toEqual({ seriesPosition: 0 });
  });

  it('treats an ISBN change and an ISBN removal as divergences', async () => {
    await actualFs.writeFile(opfPath, generateOpf(makeBook(folder, { isbn: '9781234567890' })), 'utf-8');
    const { service, create } = makeEventHistory();

    await runWrite({ book: makeBook(folder, { isbn: null }), eventHistory: service });
    expect(create.mock.calls[0]![0].reason).toEqual({
      changed_fields: ['isbn'], previous: { isbn: '9781234567890' },
    });
  });

  it('treats a reordered authors array as a divergence (order is meaningful)', async () => {
    const authors = [{ name: 'A. Author' }, { name: 'B. Author' }] as BookWithAuthor['authors'];
    await actualFs.writeFile(opfPath, generateOpf(makeBook(folder, { authors })), 'utf-8');
    const { service, create } = makeEventHistory();

    const reversed = [...authors].reverse() as BookWithAuthor['authors'];
    await runWrite({ book: makeBook(folder, { authors: reversed }), eventHistory: service });
    // An unordered set comparison passes the same-order case and silently fails this one.
    expect(create.mock.calls[0]![0].reason).toEqual({
      changed_fields: ['authors'], previous: { authors: ['A. Author', 'B. Author'] },
    });
  });
});

describe('writeOpfSidecar — type-aware ownership (#2297 AC6)', () => {
  // Declared behaviour change: today's readFile+writeFile follows the link and succeeds. These
  // red against current code in the OPPOSITE direction from every other test here, on purpose.
  it.skipIf(!CAN_SYMLINK)('refuses a symlinked metadata.opf for all three writers, leaving the target intact', async () => {
    const outside = join(root, 'elsewhere.opf');
    const targetBytes = generateOpf(makeBook(folder, { publisher: 'Gollancz' }));
    await actualFs.writeFile(outside, targetBytes, 'utf-8');
    await actualFs.symlink(outside, opfPath);

    const book = makeBook(folder, { publisher: 'Corgi' });
    const { service, create } = makeEventHistory();

    expect(await runWrite({ book, eventHistory: service })).toBe('skipped');
    expect(await refreshOpfForBook({
      settingsService: { get: vi.fn().mockResolvedValue({ writeOpf: true }) } as unknown as SettingsService,
      bookService: makeBookService(book), bookId: 1, bookFolder: folder, log: makeLog(),
    })).toBe('skipped');
    expect(await reconcileBookSidecars({
      bookId: 1, title: 'Mort', bookFolder: folder, coverUrl: null,
      bookService: makeBookService(book), db: {} as Db, log: makeLog(),
    })).toEqual({ failed: false });

    expect((await actualFs.lstat(opfPath)).isSymbolicLink()).toBe(true);
    expect(await read(outside)).toBe(targetBytes);
    expect(await exists(bakPath)).toBe(false);
    expect(create).not.toHaveBeenCalled();
  });

  it('refuses a DIRECTORY named metadata.opf rather than surfacing EISDIR', async () => {
    await actualFs.mkdir(opfPath);
    const log = makeLog();

    expect(await runWrite({ book: makeBook(folder), log })).toBe('skipped');
    expect((await actualFs.lstat(opfPath)).isDirectory()).toBe(true);
    expect(log.warn).toHaveBeenCalledWith(
      { opfPath: expect.stringContaining(OPF_FILENAME) },
      expect.stringContaining('not a regular file'),
    );
  });

  it.skipIf(!CAN_HARDLINK)('severs a hard-linked sidecar: the peer name keeps the pre-write bytes', async () => {
    const curated = generateOpf(makeBook(folder, { publisher: 'Gollancz' }));
    await actualFs.writeFile(opfPath, curated, 'utf-8');
    const peer = join(folder, 'seed-copy.opf');
    await actualFs.link(opfPath, peer);

    const book = makeBook(folder, { publisher: 'Corgi' });
    expect(await runWrite({ book, eventHistory: makeEventHistory().service })).toBe('written');

    // A direct writeFile would mutate the shared inode and rewrite the peer too.
    expect(await read(peer)).toBe(curated);
    expect(await read(opfPath)).toBe(generateOpf(book));
  });

  it('still preserves an unmarked foreign OPF and still fails safe on an unreadable one', async () => {
    const foreign = '<?xml version="1.0"?><package><metadata><dc:title>ABS</dc:title></metadata></package>';
    await actualFs.writeFile(opfPath, foreign, 'utf-8');
    const log = makeLog();

    expect(await runWrite({ book: makeBook(folder), log })).toBe('skipped');
    expect(await read(opfPath)).toBe(foreign);
    expect(log.warn).toHaveBeenCalledWith(
      { opfPath: expect.stringContaining(OPF_FILENAME) },
      expect.stringContaining('foreign'),
    );
  });
});

describe('writeOpfSidecar — pre-existing gates still hold (#2297 AC7/AC8)', () => {
  it('a pointer single-file import writes nothing and never acquires the lock', async () => {
    const pointer = join(folder, 'Mort.m4b');
    await actualFs.writeFile(pointer, 'audio', 'utf-8');
    const held = deferred<void>();
    const blocked = withPathWriteLock(sidecarLockKey(pointer), () => held.promise);

    // Resolves while the key is demonstrably held: it cannot have queued behind it.
    expect(await runWrite({ book: makeBook(pointer), bookFolder: pointer })).toBe('skipped');
    expect(hasPendingPathWrite(sidecarLockKey(pointer))).toBe(true);

    held.resolve();
    await blocked;
    expect(await exists(join(folder, OPF_FILENAME))).toBe(false);
  });

  it('with tagging.writeOpf off there is no sidecar, no backup, and no event', async () => {
    const { service, create } = makeEventHistory();
    const outcome = await writeOpfSidecar({
      enabled: false, bookService: makeBookService(makeBook(folder)), bookId: 1,
      bookFolder: folder, log: makeLog(), preserve: { source: 'auto', eventHistory: service },
    });

    expect(outcome).toBe('skipped');
    expect(await exists(opfPath)).toBe(false);
    expect(await exists(bakPath)).toBe(false);
    expect(create).not.toHaveBeenCalled();
  });
});

describe('writeOpfSidecar — atomic replacement and failure arms (#2297 AC10)', () => {
  it('leaves the ORIGINAL bytes on disk when the rename fails after the temp is written', async () => {
    const curated = generateOpf(makeBook(folder, { publisher: 'Gollancz' }));
    await actualFs.writeFile(opfPath, curated, 'utf-8');
    const cause = errno('EIO');
    (rename as Mock).mockRejectedValueOnce(cause);
    const onFailure = vi.fn();
    const log = makeLog();

    // No `preserve`: one replacement, so the injected rename is unambiguously the sidecar's.
    const outcome = await runWrite({ book: makeBook(folder, { publisher: 'Corgi' }), preserve: false, onFailure, log });

    expect(outcome).toBe('failed');
    // Reading the destination is the whole point: a call-count assertion passes against the
    // unsafe direct-write implementation, which truncates on open.
    expect(await read(opfPath)).toBe(curated);
    expect(await tempsLeftBehind()).toEqual([]);
    expect(onFailure).toHaveBeenCalledWith(cause);
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ bookId: 1 }),
      'Failed to write metadata.opf — continuing',
    );
  });

  it('cleans up a PARTIALLY WRITTEN temp when the temp write itself rejects', async () => {
    const curated = generateOpf(makeBook(folder, { publisher: 'Gollancz' }));
    await actualFs.writeFile(opfPath, curated, 'utf-8');
    const cause = errno('ENOSPC');
    (writeFile as Mock).mockImplementationOnce(async (path: string) => {
      // Reject only AFTER creating the temp — the arm a try wrapped around `rename` alone misses.
      await actualFs.writeFile(path, 'partial');
      throw cause;
    });
    const onFailure = vi.fn();

    const outcome = await runWrite({ book: makeBook(folder, { publisher: 'Corgi' }), preserve: false, onFailure });

    expect(outcome).toBe('failed');
    expect(await read(opfPath)).toBe(curated);
    expect(await tempsLeftBehind()).toEqual([]);
    expect(onFailure).toHaveBeenCalledWith(cause);
  });

  it('leaves no temp behind after a successful replacement', async () => {
    await actualFs.writeFile(opfPath, generateOpf(makeBook(folder, { publisher: 'Gollancz' })), 'utf-8');
    await runWrite({ book: makeBook(folder, { publisher: 'Corgi' }), eventHistory: makeEventHistory().service });
    expect(await tempsLeftBehind()).toEqual([]);
  });

  it('a failing backup write leaves the sidecar untouched and records nothing', async () => {
    const curated = generateOpf(makeBook(folder, { publisher: 'Gollancz' }));
    await actualFs.writeFile(opfPath, curated, 'utf-8');
    const cause = errno('EACCES');
    (writeFile as Mock).mockRejectedValueOnce(cause);
    const { service, create } = makeEventHistory();
    const onFailure = vi.fn();
    const log = makeLog();

    const outcome = await runWrite({ book: makeBook(folder, { publisher: 'Corgi' }), eventHistory: service, onFailure, log });

    expect(outcome).toBe('failed');
    expect(await read(opfPath)).toBe(curated);
    expect(await exists(bakPath)).toBe(false);
    expect(create).not.toHaveBeenCalled();
    expect(onFailure).toHaveBeenCalledWith(cause);
    expect((onFailure.mock.calls[0]![0] as NodeJS.ErrnoException).code).toBe('EACCES');
    expect(log.warn).toHaveBeenCalled();
  });

  it('keeps the backup and the event when the sidecar replacement fails afterwards', async () => {
    const curated = generateOpf(makeBook(folder, { publisher: 'Gollancz' }));
    await actualFs.writeFile(opfPath, curated, 'utf-8');
    let renames = 0;
    (rename as Mock).mockImplementation(async (from: string, to: string) => {
      renames += 1;
      if (renames === 2) throw errno('EIO');
      return actualFs.rename(from, to);
    });
    const { service, create } = makeEventHistory();

    const outcome = await runWrite({ book: makeBook(folder, { publisher: 'Corgi' }), eventHistory: service });

    expect(outcome).toBe('failed');
    expect(await read(bakPath)).toBe(curated);
    expect(create).toHaveBeenCalledTimes(1);
    expect(await read(opfPath)).toBe(curated);
    expect(await tempsLeftBehind()).toEqual([]);
  });

  it.skipIf(!CAN_HARDLINK)('replaces a hard-linked metadata.opf.bak rather than writing through it', async () => {
    const curated = generateOpf(makeBook(folder, { publisher: 'Gollancz' }));
    await actualFs.writeFile(opfPath, curated, 'utf-8');
    const earlier = `${NARRATORR_OPF_MARKER}\nearlier generation`;
    await actualFs.writeFile(bakPath, earlier, 'utf-8');
    const peer = join(folder, 'operator-copy.bak');
    await actualFs.link(bakPath, peer);

    await runWrite({ book: makeBook(folder, { publisher: 'Corgi' }), eventHistory: makeEventHistory().service });

    // copyFile would open the destination O_TRUNC and rewrite the peer through the shared inode.
    expect(await read(peer)).toBe(earlier);
    expect(await read(bakPath)).toBe(curated);
  });

  it('backs up BYTES, not a decoded string — invalid UTF-8 survives byte-identically', async () => {
    const invalid = Buffer.concat([
      Buffer.from(`${NARRATORR_OPF_MARKER}`, 'utf-8'),
      Buffer.from([0xc3, 0x28, 0xa0, 0xa1]),
    ]);
    await actualFs.writeFile(opfPath, invalid);

    await runWrite({ book: makeBook(folder), eventHistory: makeEventHistory().service });

    // A utf-8 string round-trip substitutes U+FFFD and changes the length.
    expect(await readBytes(bakPath)).toEqual(invalid);
  });
});

describe('writeOpfSidecar — backup destination claim (#2297 AC10)', () => {
  async function seedDivergentSidecar(): Promise<string> {
    const curated = generateOpf(makeBook(folder, { publisher: 'Gollancz' }));
    await actualFs.writeFile(opfPath, curated, 'utf-8');
    return curated;
  }

  it('claims an absent destination', async () => {
    const curated = await seedDivergentSidecar();
    expect(await runWrite({ book: makeBook(folder, { publisher: 'Corgi' }), eventHistory: makeEventHistory().service })).toBe('written');
    expect(await read(bakPath)).toBe(curated);
  });

  it('claims and overwrites its own marked previous snapshot', async () => {
    const curated = await seedDivergentSidecar();
    await actualFs.writeFile(bakPath, `${NARRATORR_OPF_MARKER}\nolder`, 'utf-8');

    expect(await runWrite({ book: makeBook(folder, { publisher: 'Corgi' }), eventHistory: makeEventHistory().service })).toBe('written');
    expect(await read(bakPath)).toBe(curated);
    expect(await exists(`${bakPath}.bak`)).toBe(false);
  });

  it('fails closed on an operator-authored UNMARKED metadata.opf.bak', async () => {
    const curated = await seedDivergentSidecar();
    const operatorFile = 'my own notes about this book\n';
    await actualFs.writeFile(bakPath, operatorFile, 'utf-8');
    const { service, create } = makeEventHistory();
    const onFailure = vi.fn();
    const log = makeLog();

    const outcome = await runWrite({ book: makeBook(folder, { publisher: 'Corgi' }), eventHistory: service, onFailure, log });

    expect(outcome).toBe('failed');
    expect(await read(bakPath)).toBe(operatorFile);
    expect(await read(opfPath)).toBe(curated);
    expect(create).not.toHaveBeenCalled();
    // A refusal is a semantic 'failed', so the documented side channel must still fire once.
    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(String((onFailure.mock.calls[0]![0] as Error).message)).toContain(OPF_BACKUP_FILENAME);
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ backupPath: expect.stringContaining(OPF_BACKUP_FILENAME), state: 'foreign' }),
      expect.stringContaining('Refusing to claim'),
    );
  });

  it.skipIf(!CAN_SYMLINK)('fails closed on a SYMLINK at metadata.opf.bak pointing at marked content', async () => {
    const curated = await seedDivergentSidecar();
    const outside = join(root, 'marked-elsewhere.opf');
    await actualFs.writeFile(outside, `${NARRATORR_OPF_MARKER}\nsomeone else's`, 'utf-8');
    await actualFs.symlink(outside, bakPath);
    const onFailure = vi.fn();

    // A readFile-only claim finds the marker in the TARGET and passes; only lstat catches it.
    expect(await runWrite({ book: makeBook(folder, { publisher: 'Corgi' }), eventHistory: makeEventHistory().service, onFailure })).toBe('failed');
    expect(await read(outside)).toBe(`${NARRATORR_OPF_MARKER}\nsomeone else's`);
    expect((await actualFs.lstat(bakPath)).isSymbolicLink()).toBe(true);
    expect(await read(opfPath)).toBe(curated);
    expect((onFailure.mock.calls[0]![0] as { state: string }).state).toBe('non-regular');
  });

  it('fails closed on a DIRECTORY at metadata.opf.bak', async () => {
    const curated = await seedDivergentSidecar();
    await actualFs.mkdir(bakPath);

    expect(await runWrite({ book: makeBook(folder, { publisher: 'Corgi' }), eventHistory: makeEventHistory().service })).toBe('failed');
    expect((await actualFs.lstat(bakPath)).isDirectory()).toBe(true);
    expect(await read(opfPath)).toBe(curated);
  });
});

describe('writeOpfSidecar — recording is nonfatal (#2297 AC16)', () => {
  it('still replaces the sidecar when eventHistory.create rejects', async () => {
    const curated = generateOpf(makeBook(folder, { publisher: 'Gollancz' }));
    await actualFs.writeFile(opfPath, curated, 'utf-8');
    const eventHistory = { create: vi.fn().mockRejectedValue(new Error('DB locked')) } as unknown as EventHistoryService;
    const log = makeLog();

    const book = makeBook(folder, { publisher: 'Corgi' });
    expect(await runWrite({ book, eventHistory, log })).toBe('written');
    expect(await read(bakPath)).toBe(curated);
    expect(await read(opfPath)).toBe(generateOpf(book));
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ bookId: 1 }),
      expect.stringContaining('Failed to record the sidecar_diverged event'),
    );
  });

  it('writes the backup and logs changed_fields when no EventHistoryService is wired', async () => {
    const curated = generateOpf(makeBook(folder, { publisher: 'Gollancz' }));
    await actualFs.writeFile(opfPath, curated, 'utf-8');
    const log = makeLog();

    const book = makeBook(folder, { publisher: 'Corgi' });
    expect(await runWrite({ book, eventHistory: undefined, log })).toBe('written');
    expect(await read(bakPath)).toBe(curated);
    expect(await read(opfPath)).toBe(generateOpf(book));
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ changed_fields: ['publisher'] }),
      expect.stringContaining('no event history service is wired'),
    );
  });
});

describe('writeOpfSidecar — row-owns-folder and serialization (#2297 AC11)', () => {
  it.each([
    ['the row now points elsewhere (re-import old-path cleanup)', () => makeBook('/somewhere/else')],
    ['the row path is null (wrong-release rejection)', () => makeBook(null)],
    ['the row is gone (book deletion)', () => null],
  ])('skips without touching the folder when %s', async (_label, make) => {
    const book = make();
    const { service, create } = makeEventHistory();

    const outcome = await writeOpfSidecar({
      enabled: true, bookService: makeBookService(book), bookId: 1, bookFolder: folder,
      log: makeLog(), preserve: { source: 'auto', eventHistory: service },
    });

    expect(outcome).toBe('skipped');
    expect(await exists(opfPath)).toBe(false);
    expect(await exists(bakPath)).toBe(false);
    expect(create).not.toHaveBeenCalled();
  });

  it('matches a folder expressed with a trailing separator and platform separators', async () => {
    const posixPath = folder.split('\\').join('/');
    const book = makeBook(posixPath);

    expect(await runWrite({ book, bookFolder: `${folder}${sep}` })).toBe('written');
    expect(await exists(opfPath)).toBe(true);
  });

  it('import first: a refresh issued mid-import applies only after the lock is released', async () => {
    const curated = generateOpf(makeBook(folder, { publisher: 'Gollancz' }));
    await actualFs.writeFile(opfPath, curated, 'utf-8');

    const held = deferred<{ id: number }>();
    const create = vi.fn().mockReturnValue(held.promise);
    const importBook = makeBook(folder, { publisher: 'Corgi' });
    const refreshBook = makeBook(folder, { publisher: 'Operator Press' });

    const importing = writeOpfSidecar({
      enabled: true, bookService: makeBookService(importBook), bookId: 1, bookFolder: folder,
      log: makeLog(), preserve: { source: 'auto', eventHistory: { create } as unknown as EventHistoryService },
    });
    await until(() => exists(bakPath));

    const refreshing = writeOpfSidecar({
      enabled: true, bookService: makeBookService(refreshBook), bookId: 1, bookFolder: folder, log: makeLog(),
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(await read(opfPath)).toBe(curated);

    held.resolve({ id: 1 });
    expect(await importing).toBe('written');
    expect(await refreshing).toBe('written');

    expect(await read(bakPath)).toBe(curated);
    expect(create.mock.calls[0]![0].reason.previous).toEqual({ publisher: 'Gollancz' });
    expect(await read(opfPath)).toBe(generateOpf(refreshBook));
  });

  it('refresh first: the import backs up the operator value the refresh just authored', async () => {
    await actualFs.writeFile(opfPath, generateOpf(makeBook(folder, { publisher: 'Gollancz' })), 'utf-8');

    const gate = deferred<BookWithAuthor>();
    const refreshBook = makeBook(folder, { publisher: 'Operator Press' });
    const refreshService = { getById: vi.fn().mockReturnValue(gate.promise) } as unknown as BookService;

    const refreshing = writeOpfSidecar({
      enabled: true, bookService: refreshService, bookId: 1, bookFolder: folder, log: makeLog(),
    });
    // Queued behind the refresh's held critical section, so it can only read the operator value.
    const { service, create } = makeEventHistory();
    const importing = writeOpfSidecar({
      enabled: true, bookService: makeBookService(makeBook(folder, { publisher: 'Corgi' })),
      bookId: 1, bookFolder: folder, log: makeLog(), preserve: { source: 'auto', eventHistory: service },
    });

    gate.resolve(refreshBook);
    expect(await refreshing).toBe('written');
    expect(await importing).toBe('written');

    expect(await read(bakPath)).toBe(generateOpf(refreshBook));
    expect(create.mock.calls[0]![0].reason.previous).toEqual({ publisher: 'Operator Press' });
  });
});

describe('the divergence guard is opt-in at the call site (#2297 AC9)', () => {
  const divergentBook = () => makeBook(folder, { publisher: 'Corgi' });

  async function seedCurated(): Promise<string> {
    const curated = generateOpf(makeBook(folder, { publisher: 'Gollancz' }));
    await actualFs.writeFile(opfPath, curated, 'utf-8');
    return curated;
  }

  it('refreshOpfForBook overwrites a diverged marked sidecar with no backup and no record', async () => {
    await seedCurated();
    const book = divergentBook();

    const outcome = await refreshOpfForBook({
      settingsService: { get: vi.fn().mockResolvedValue({ writeOpf: true }) } as unknown as SettingsService,
      bookService: makeBookService(book), bookId: 1, bookFolder: folder, log: makeLog(),
    });

    // The operator just authored this value; a sidecar that stops following the edit — or a .bak
    // beside every book — is the worse failure here.
    expect(outcome).toBe('written');
    expect(await read(opfPath)).toBe(generateOpf(book));
    expect(await exists(bakPath)).toBe(false);
  });

  it('reconcileBookSidecars writes each diverged sidecar with no artifacts and an unchanged success verdict', async () => {
    await seedCurated();
    const book = divergentBook();

    const outcome = await reconcileBookSidecars({
      bookId: 1, title: 'Mort', bookFolder: folder, coverUrl: null,
      bookService: makeBookService(book), db: {} as Db, log: makeLog(),
    });

    expect(outcome).toEqual({ failed: false });
    expect(await read(opfPath)).toBe(generateOpf(book));
    expect(await exists(bakPath)).toBe(false);
  });
});

describe('the backup is a rolling one-generation snapshot (#2297 AC12)', () => {
  it('two consecutive diverging imports leave ONE backup holding the most recent bytes, and TWO events', async () => {
    const first = generateOpf(makeBook(folder, { publisher: 'First' }));
    await actualFs.writeFile(opfPath, first, 'utf-8');
    const { service, create } = makeEventHistory();

    await runWrite({ book: makeBook(folder, { publisher: 'Second' }), eventHistory: service });
    await runWrite({ book: makeBook(folder, { publisher: 'Third' }), eventHistory: service });

    expect(await read(bakPath)).toBe(generateOpf(makeBook(folder, { publisher: 'Second' })));
    expect(await exists(`${bakPath}.bak`)).toBe(false);
    expect((await actualFs.readdir(folder)).sort()).toEqual([OPF_FILENAME, OPF_BACKUP_FILENAME].sort());
    expect(create).toHaveBeenCalledTimes(2);
  });
});
