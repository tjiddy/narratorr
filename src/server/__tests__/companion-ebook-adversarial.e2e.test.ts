import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { PathLike, Stats } from 'node:fs';
import { mkdir, mkdtemp, stat, writeFile, realpath, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { books, companionEbooks } from '@db/schema.js';
import * as F from '@core/__tests__/epub-archive.fixture.js';
import { resolveHref } from '@core/epub/paths.js';
import {
  MAX_ARCHIVE_BYTES,
  MAX_ARCHIVE_ENTRIES,
  MAX_CENTRAL_DIRECTORY_BYTES,
  MAX_EPUB_COVER_BYTES,
  MAX_INSPECTION_BYTES,
  MAX_XML_BYTES,
} from '@core/epub/limits.js';
import { generatePublicId } from '../utils/public-id.js';
import type { CompanionEbookRow } from '../services/types.js';
import { createE2EApp, type E2EApp } from './e2e-helpers.js';
import { removeDirTolerant } from './windows-fs.js';

/**
 * Composed hostile-input coverage for route → resolve → open → inspect/stream (#2026); unit mocks cannot observe cross-layer gaps.
 * Rows 2/12 live with their fixes; rows 14/15 require real-socket and React surfaces respectively.
 * Streams never parse archives; metadata/cover inspect and flatten archive errors to 404 + reconcile; state projects the stored row.
 * `limit_exceeded` persists as `status: invalid` plus a validation code.
 */

/**
 * Mock the OS boundary because same-module local bindings cannot be intercepted. Real calls still delegate;
 * size overrides avoid a 256 MiB fixture, while basename-scoped read tracking proves XXE targets stay unread.
 */
const h = vi.hoisted(() => ({
  sizeOverrides: new Map<string, number>(),
  watched: new Set<string>(),
  watchedReads: [] as string[],
  opened: [] as string[],
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();

  // The hoisted mock factory runs before the imported `path.basename` binding is initialized.
  const leaf = (target: unknown): string => String(target).split(/[\\/]/).pop() ?? '';
  const note = (syscall: string, target: unknown): void => {
    if (h.watched.has(leaf(target))) h.watchedReads.push(`${syscall}:${leaf(target)}`);
  };

  const lstat = (async (target: PathLike, options?: unknown) => {
    const stats = await (actual.lstat as (p: PathLike, o?: unknown) => Promise<Stats>)(target, options);
    const size = h.sizeOverrides.get(String(target));
    if (size === undefined) return stats;
    // `Stats.isFile()` reads `this.mode`, so override size on a prototype-preserving clone.
    const clone = Object.create(
      Object.getPrototypeOf(stats) as object,
      Object.getOwnPropertyDescriptors(stats),
    ) as Stats;
    Object.defineProperty(clone, 'size', { value: size, enumerable: true, configurable: true });
    return clone;
  }) as typeof actual.lstat;

  const open: typeof actual.open = async (target, ...rest) => {
    h.opened.push(String(target));
    note('open', target);
    return actual.open(target, ...rest);
  };

  const readFile = (async (target: unknown, options?: unknown) => {
    note('readFile', target);
    return (actual.readFile as (p: unknown, o?: unknown) => Promise<unknown>)(target, options);
  }) as typeof actual.readFile;

  return { ...actual, default: actual, lstat, open, readFile };
});

// Keep the public 404 literal independent so changing production's constant fails the test.
const UNAVAILABLE_BODY = {
  error: { code: 'companion_epub_unavailable', message: 'Companion ebook is unavailable' },
} as const;

const EPUB_MEDIA_TYPE = 'application/epub+zip';

// Full PNG signature plus two bytes, so the sniffer can match the entire signature.
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);

let e2e: E2EApp;
// Each scenario gets an isolated root. Cleanup waits for `afterAll` because fire-and-forget reconciles can outlive a test.
const libraryRoots: string[] = [];
const scratchDirs: string[] = [];

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Reconcile is fire-and-forget with no completion signal, so bound a state poll rather than sleeping.
async function waitUntil<T>(
  probe: () => Promise<T>,
  predicate: (value: T) => boolean,
  label: string,
): Promise<T> {
  let last: T | undefined;
  for (let attempt = 0; attempt < 300; attempt += 1) {
    last = await probe();
    if (predicate(last)) return last;
    await wait(10);
  }
  throw new Error(`timed out waiting for ${label}; last value was ${JSON.stringify(last)}`);
}

interface CompanionStatePayload {
  status: string;
  filename: string | null;
  sizeBytes: number | null;
  validationCode: string | null;
  candidateCount: number;
  selectedFilename: string | null;
  candidates: Array<{ index: number; filename: string }>;
}

interface SeedOptions {
  filename: string;
  bytes: Buffer;
  // Row 13 alone writes a basename different from the stored one.
  diskFilename?: string;
  // Rows 7/10 subtract this from stored times so `isUnchanged` cannot bypass validation.
  staleBy?: number;
  // Only readable file-bearing statuses satisfy this helper's seeded columns and checks (#2038).
  storedStatus?: 'available' | 'drm_protected';
}

interface Seeded {
  bookId: number;
  publicId: string;
  libraryRoot: string;
  bookPath: string;
  filePath: string;
  row: CompanionEbookRow;
  // Live stat values truncated at the observation write boundary.
  onDisk: { sizeBytes: number; mtimeMs: number; ctimeMs: number };
}

/**
 * Seed every gate required to reach the resolver: enabled setting, canonical library path,
 * imported book, and readable file-bearing row. `candidateCount: 1` and null selection satisfy
 * database checks; `realpath` keeps containment coherent on symlinked temp roots.
 */
async function seedCompanion(options: SeedOptions): Promise<Seeded> {
  const libraryRoot = await realpath(await mkdtemp(join(tmpdir(), 'narratorr-2026-')));
  libraryRoots.push(libraryRoot);
  const bookPath = join(libraryRoot, 'Author', 'Title');
  await mkdir(bookPath, { recursive: true });

  const filePath = join(bookPath, options.diskFilename ?? options.filename);
  await writeFile(filePath, options.bytes);

  await e2e.services.settings.set('library', {
    path: libraryRoot,
    folderFormat: '{author}/{title}',
    fileFormat: '{author} - {title}',
    namingSeparator: 'space',
    namingCase: 'default',
  });
  await e2e.services.settings.set('companionEpub', { enabled: true });

  const publicId = generatePublicId('bk');
  const [book] = await e2e.db
    .insert(books)
    .values({ publicId, title: `Adversarial ${publicId}`, status: 'imported', path: bookPath })
    .returning();

  const stats = await stat(filePath);
  const onDisk = {
    sizeBytes: stats.size,
    mtimeMs: Math.trunc(stats.mtimeMs),
    ctimeMs: Math.trunc(stats.ctimeMs),
  };
  const stale = options.staleBy ?? 0;
  const [row] = await e2e.db
    .insert(companionEbooks)
    .values({
      bookId: book!.id,
      status: options.storedStatus ?? 'available',
      filename: options.filename,
      sizeBytes: onDisk.sizeBytes,
      mtimeMs: onDisk.mtimeMs - stale,
      ctimeMs: onDisk.ctimeMs - stale,
      validationCode: null,
      candidateCount: 1,
      selectedFilename: null,
    })
    .returning();

  return {
    bookId: book!.id,
    publicId,
    libraryRoot,
    bookPath,
    filePath,
    row: row as CompanionEbookRow,
    onDisk,
  };
}

async function createScratchDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'narratorr-2026-scratch-'));
  scratchDirs.push(dir);
  return dir;
}

const metadata = (bookId: number) =>
  e2e.app.inject({ method: 'GET', url: `/api/books/${bookId}/companion-epub/metadata` });
const cover = (bookId: number) =>
  e2e.app.inject({ method: 'GET', url: `/api/books/${bookId}/companion-epub/cover` });
const ownerDownload = (bookId: number) =>
  e2e.app.inject({ method: 'GET', url: `/api/books/${bookId}/companion-epub` });
const publicStream = (publicId: string) =>
  e2e.app.inject({ method: 'GET', url: `/api/v1/books/${publicId}/companion-epub` });
const state = (bookId: number) =>
  e2e.app.inject({ method: 'GET', url: `/api/books/${bookId}/companion-epub/state` });

async function pollState(
  bookId: number,
  predicate: (payload: CompanionStatePayload) => boolean,
  label: string,
): Promise<CompanionStatePayload> {
  return waitUntil(
    async () => (await state(bookId)).json() as CompanionStatePayload,
    predicate,
    label,
  );
}

// Surgery updates both central and local headers because the reader consults both; callers assert the patched bytes.

// Keep ZIP bit encryption separate from the encryption.xml fixture: wrong mimetype makes scan-before-read ordering observable (#2041).
const ZIP_ENCRYPTED_BIT = 0x1;

function readFlags(archive: Buffer, index: number): number {
  return archive.readUInt16LE(F.listCentralDirectory(archive)[index]!.headerOffset + 8);
}

function setEncryptedBit(archive: Buffer, index: number): Buffer {
  const record = F.listCentralDirectory(archive)[index]!;
  const local = F.localFileHeader(archive, index);
  return F.patchArchive(archive, [
    {
      offset: record.headerOffset + 8,
      size: 2,
      value: archive.readUInt16LE(record.headerOffset + 8) | ZIP_ENCRYPTED_BIT,
      why: 'central-directory general-purpose bit 0 — the member declares itself encrypted',
    },
    {
      offset: local.headerOffset + 6,
      size: 2,
      value: archive.readUInt16LE(local.headerOffset + 6) | ZIP_ENCRYPTED_BIT,
      why: 'local-header general-purpose bit 0, kept coherent with the directory',
    },
  ]);
}

function readDeclaredSize(archive: Buffer, index: number): number {
  return archive.readUInt32LE(F.listCentralDirectory(archive)[index]!.headerOffset + 24);
}

function understateDeclaredSize(archive: Buffer, index: number, declared: number): Buffer {
  const record = F.listCentralDirectory(archive)[index]!;
  const local = F.localFileHeader(archive, index);
  return F.patchArchive(archive, [
    {
      offset: record.headerOffset + 24,
      size: 4,
      value: declared,
      why: 'central-directory uncompressedSize, understated — the attacker-authored declaration',
    },
    {
      offset: local.headerOffset + 22,
      size: 4,
      value: declared,
      why: 'local-header uncompressedSize, kept coherent with the directory',
    },
  ]);
}

// Patch both EOCD counts; patching one yields `truncated` before the ceiling and makes the test vacuous.
function declareRecordCount(archive: Buffer, count: number): Buffer {
  const eocd = F.eocdOffset(archive);
  return F.patchArchive(archive, [
    { offset: eocd + 8, size: 2, value: count, why: 'recordsOnDisk, over the entry ceiling' },
    { offset: eocd + 10, size: 2, value: count, why: 'numberOfRecords, kept coherent' },
  ]);
}

function readRecordCount(archive: Buffer): number {
  return archive.readUInt16LE(F.eocdOffset(archive) + 10);
}

beforeAll(async () => {
  e2e = await createE2EApp();
});

afterEach(() => {
  h.sizeOverrides.clear();
  h.watched.clear();
  h.watchedReads.length = 0;
  h.opened.length = 0;
});

afterAll(async () => {
  await e2e.cleanup();
  // Open libSQL handles can raise EPERM on Windows; tolerate a leaked temp dir instead.
  for (const dir of [...libraryRoots, ...scratchDirs]) removeDirTolerant(dir);
});

describe('row 1 — a 213-byte archive declaring half a billion members', () => {
  /**
   * A forged ZIP64 count of ~500M OOM-kills the bare reader after ~31 s under a 1 GiB heap because it allocates `Array(numberOfRecords)`.
   * This row must use the real reader: stubbing it makes process survival vacuous; core tests independently pin the ceiling.
   */
  const DECLARED_RECORDS = 500_000_000n;

  async function forged(): Promise<Buffer> {
    const base = await F.buildArchive({
      store: true,
      entries: [{ name: 'chapter-one.xhtml', content: 'hello' }],
    });
    return F.forgeZip64Tail(base, { declaredRecords: DECLARED_RECORDS });
  }

  it('rejects it at /metadata and streams it back untouched on both download paths', async () => {
    const bytes = await forged();

    // Assert the EOCD sentinel and both ZIP64 counts from authoritative bytes; size and route responses stay green if the hazardous declaration disappears.
    expect(bytes).toHaveLength(213);
    expect(bytes.readUInt16LE(F.eocdOffset(bytes) + 10)).toBe(0xffff);
    const record = F.zip64RecordOffset(bytes);
    expect(bytes.readBigUInt64LE(record + 24)).toBe(DECLARED_RECORDS);
    expect(bytes.readBigUInt64LE(record + 32)).toBe(DECLARED_RECORDS);

    const seeded = await seedCompanion({ filename: 'forged.epub', bytes });

    expect((await metadata(seeded.bookId)).statusCode).toBe(404);
    // A second request proves worker survival.
    expect((await metadata(seeded.bookId)).statusCode).toBe(404);

    // Streams intentionally return hostile bytes; sequence requests because the single libSQL connection serializes transactions (#2006).
    const owner = await ownerDownload(seeded.bookId);
    expect(owner.statusCode).toBe(200);
    expect(owner.headers['content-type']).toBe(EPUB_MEDIA_TYPE);
    expect(owner.rawPayload).toEqual(bytes);
    expect((await ownerDownload(seeded.bookId)).statusCode).toBe(200);

    const publicRes = await publicStream(seeded.publicId);
    expect(publicRes.statusCode).toBe(200);
    expect(publicRes.headers['content-length']).toBe('213');
    expect(publicRes.rawPayload).toEqual(bytes);
    expect((await publicStream(seeded.publicId)).statusCode).toBe(200);
  });
});

// The default OEBPS base accepts `../secret`; a root-level package makes it escape and be rejected. Filesystem-read exclusion belongs to row 4.
describe('row 3 — a traversal href on a root-level package', () => {
  const HOSTILE_HREF = '%2e%2e%2fsecret';
  const ROOT_PACKAGE = 'content.opf';

  it('is the precondition the row depends on: the href is rejected against the archive root', () => {
    expect(resolveHref('', HOSTILE_HREF)).toEqual({ kind: 'rejected', reason: 'unsafe_entry_path' });
    expect(resolveHref('OEBPS', HOSTILE_HREF)).toEqual({ kind: 'entry', name: 'secret' });
  });

  it('3a — a hostile href on the linear spine item fails both inspection routes', async () => {
    const bytes = await F.buildEpub({
      packageName: ROOT_PACKAGE,
      packageOptions: {
        items: [{ id: 'ch1', href: HOSTILE_HREF, mediaType: 'application/xhtml+xml' }],
        itemrefs: [{ idref: 'ch1' }],
      },
    });
    const seeded = await seedCompanion({ filename: 'spine.epub', bytes });

    // Non-empty manifest plus unresolved linear itemref isolates `empty_spine`, which both reads flatten to 404.
    expect((await metadata(seeded.bookId)).statusCode).toBe(404);
    expect((await cover(seeded.bookId)).statusCode).toBe(404);
  });

  it('3b — a hostile href on the cover item alone costs the cover and nothing else', async () => {
    // Explicit nav content makes collateral damage observable; the default fixture's null TOC would let a dropped nav pass.
    const bytes = await F.buildEpub({
      packageName: ROOT_PACKAGE,
      packageOptions: {
        items: [
          F.CHAPTER_ITEM,
          { id: 'nav', href: 'nav.xhtml', mediaType: 'application/xhtml+xml', properties: 'nav' },
          { id: 'cover', href: HOSTILE_HREF, mediaType: 'image/png', properties: 'cover-image' },
        ],
        itemrefs: [{ idref: 'ch1' }],
      },
      files: [{ name: 'nav.xhtml', content: F.navDocumentXml(F.navXml([{ label: 'One' }])) }],
    });
    const seeded = await seedCompanion({ filename: 'cover-href.epub', bytes });

    const metadataRes = await metadata(seeded.bookId);
    expect(metadataRes.statusCode).toBe(200);
    const body = metadataRes.json() as { metadata: { title: string | null }; toc: unknown };
    expect(body.metadata.title).toBe('Fixture');
    expect(body.toc).toEqual([{ title: 'One', depth: 0 }]);

    // A rejected optional cover href maps to `no_cover` without changing archive status.
    expect((await cover(seeded.bookId)).statusCode).toBe(404);
  });
});

// Response absence alone is vacuous: 4a surfaces literal-vs-expanded text, 4b makes expansion change status, and both prove the target stayed unread.
describe('row 4 — SYSTEM file entities in the parsed documents', () => {
  const TARGET = 'xxe-target.txt';

  async function plantTarget(contents: string): Promise<{ path: string; url: string }> {
    const dir = await createScratchDir();
    const path = join(dir, TARGET);
    await writeFile(path, contents, 'utf8');
    return { path, url: pathToFileURL(path).href };
  }

  it('4a — an entity in <dc:title> surfaces literally and reads nothing', async () => {
    const secret = 'TOP-SECRET-KEY-MATERIAL';
    const target = await plantTarget(secret);
    const bytes = await F.buildEpub({
      packageOptions: {
        raw:
          `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE package [<!ENTITY xxe SYSTEM "${target.url}">]>` +
          '<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">' +
          '<metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>&xxe;</dc:title></metadata>' +
          '<manifest><item id="ch1" href="ch1.xhtml" media-type="application/xhtml+xml"/></manifest>' +
          '<spine><itemref idref="ch1"/></spine></package>',
      },
    });
    const seeded = await seedCompanion({ filename: 'xxe-title.epub', bytes });

    h.watched.add(TARGET);
    const res = await metadata(seeded.bookId);

    expect(res.statusCode).toBe(200);
    const body = res.json() as { metadata: { title: string | null } };
    // Cheerio performs no DTD/entity resolution; a parser swap that expands entities flips this literal assertion.
    expect(body.metadata.title).toBe('&xxe;');
    expect(res.payload).not.toContain(secret);
    expect(h.watchedReads).toEqual([]);
    await expect(stat(target.path)).resolves.toBeDefined();
  });

  it('4b — an entity as the container rootfile leaves the package unresolvable', async () => {
    // The target names a real package, so expansion yields 200 while literal text yields 404.
    const target = await plantTarget('content.opf');
    const bytes = await F.buildEpub({
      packageName: 'content.opf',
      container:
        `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE container [<!ENTITY xxe SYSTEM "${target.url}">]>` +
        '<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles>' +
        '<rootfile full-path="&xxe;" media-type="application/oebps-package+xml"/>' +
        '</rootfiles></container>',
    });
    const seeded = await seedCompanion({ filename: 'xxe-rootfile.epub', bytes });

    // Prove the expanded value would resolve.
    expect(F.listCentralDirectory(bytes).map((entry) => entry.rawName.toString('utf8')))
      .toContain('content.opf');

    h.watched.add(TARGET);
    const res = await metadata(seeded.bookId);

    expect(res.statusCode).toBe(404);
    expect(h.watchedReads).toEqual([]);
  });
});

describe('row 5 — a package document whose declared size understates its bytes', () => {
  it('stops at the budget rather than inflating what the declaration promised', async () => {
    // Deflated whitespace cheaply hides 4 MiB + 1 KiB behind a 512-byte declaration.
    const inflated = MAX_XML_BYTES + 1024;
    const built = await F.buildEpub({ packageOptions: { padTo: inflated } });
    // `epubEntries` fixes package at index 2.
    const PACKAGE_INDEX = 2;
    expect(F.listCentralDirectory(built)[PACKAGE_INDEX]!.rawName.toString('utf8'))
      .toBe(F.DEFAULT_PACKAGE);
    expect(readDeclaredSize(built, PACKAGE_INDEX)).toBe(inflated);

    const bytes = understateDeclaredSize(built, PACKAGE_INDEX, 512);
    expect(readDeclaredSize(bytes, PACKAGE_INDEX)).toBe(512);
    expect(bytes.length).toBeLessThan(inflated);

    const seeded = await seedCompanion({ filename: 'understated.epub', bytes });

    // Mandatory reads enforce actual streamed bytes; `cap-exceeded` maps through `limit_exceeded` to 404.
    expect((await metadata(seeded.bookId)).statusCode).toBe(404);
  });
});

describe('row 6 — a nav and a cover that are individually legal and jointly are not', () => {
  /**
   * Nav + cover caps total only 12 MiB against a 16 MiB inspection cap. Four mandatory reads can
   * consume all but a controlled remainder, letting individually legal optional reads exceed it together.
   */
  const REMAINDER = 4000;
  const NAV_BYTES = 3000;
  const COVER_BYTES = 2000;
  const NAV_ENTRY = 'OEBPS/nav.xhtml';
  const COVER_ENTRY = 'OEBPS/cover.png';

  it('reads the TOC first and denies the cover the remaining allowance', async () => {
    const mimetype = F.padTo(F.EPUB_MEDIA_TYPE, MAX_XML_BYTES);
    const container = F.padTo(F.containerXml(F.DEFAULT_PACKAGE), MAX_XML_BYTES);
    const encryption = F.padTo(F.EMPTY_ENCRYPTION_XML, MAX_XML_BYTES - REMAINDER);
    const nav = F.padTo(F.navDocumentXml(F.navXml([{ label: 'One' }])), NAV_BYTES);
    const coverBytes = Buffer.concat([PNG, Buffer.alloc(COVER_BYTES - PNG.length)]);

    // Assert fixture arithmetic so only the aggregate budget can reject it.
    const mandatory =
      Buffer.byteLength(mimetype) +
      Buffer.byteLength(container) +
      MAX_XML_BYTES + // the package document, padded to the ceiling below
      Buffer.byteLength(encryption);
    expect(mandatory).toBe(MAX_INSPECTION_BYTES - REMAINDER);
    expect(Buffer.byteLength(nav)).toBe(NAV_BYTES);
    expect(coverBytes).toHaveLength(COVER_BYTES);
    expect(NAV_BYTES).toBeLessThanOrEqual(MAX_XML_BYTES);
    expect(COVER_BYTES).toBeLessThanOrEqual(MAX_EPUB_COVER_BYTES);
    expect(NAV_BYTES + COVER_BYTES).toBeGreaterThan(REMAINDER);

    const bytes = await F.buildEpub({
      mimetype,
      container,
      encryption,
      packageOptions: {
        padTo: MAX_XML_BYTES,
        items: [
          F.CHAPTER_ITEM,
          { id: 'nav', href: 'nav.xhtml', mediaType: 'application/xhtml+xml', properties: 'nav' },
          { id: 'cover', href: 'cover.png', mediaType: 'image/png', properties: 'cover-image' },
        ],
      },
      files: [
        { name: NAV_ENTRY, content: nav },
        { name: COVER_ENTRY, content: coverBytes },
      ],
    });
    const seeded = await seedCompanion({ filename: 'remainder.epub', bytes });

    const metadataRes = await metadata(seeded.bookId);
    expect(metadataRes.statusCode).toBe(200);
    expect((metadataRes.json() as { toc: unknown }).toc).toEqual([{ title: 'One', depth: 0 }]);

    // Frozen TOC-first order leaves too little for the cover; reversing order would mirror the result.
    expect((await cover(seeded.bookId)).statusCode).toBe(404);
  });
});

describe('row 7 — general-purpose bit 0 on a content entry', () => {
  const STALE_BY = 60_000;

  it('answers 404 and settles /state on drm_protected without reading an entry', async () => {
    // Wrong mimetype separates ordering: `drm_protected` rather than `bad_mimetype` proves the bit scan precedes any entry read.
    const built = await F.buildEpub({ mimetype: 'not-an-epub' });
    const CONTENT_INDEX = 3;
    expect(F.listCentralDirectory(built)[CONTENT_INDEX]!.rawName.toString('utf8'))
      .toBe('OEBPS/ch1.xhtml');
    expect(readFlags(built, CONTENT_INDEX) & ZIP_ENCRYPTED_BIT).toBe(0);

    const bytes = setEncryptedBit(built, CONTENT_INDEX);
    expect(readFlags(bytes, CONTENT_INDEX) & ZIP_ENCRYPTED_BIT).toBe(ZIP_ENCRYPTED_BIT);

    const seeded = await seedCompanion({
      filename: 'encrypted.epub',
      bytes,
      staleBy: STALE_BY,
    });

    // A stale fingerprint prevents `isUnchanged` from bypassing validation.
    expect(seeded.row.mtimeMs).not.toBe(seeded.onDisk.mtimeMs);
    expect(seeded.row.mtimeMs).toBe(seeded.onDisk.mtimeMs - STALE_BY);

    expect((await metadata(seeded.bookId)).statusCode).toBe(404);

    const settled = await pollState(
      seeded.bookId,
      (payload) => payload.status !== 'available',
      'the reconciler to rewrite the row away from available',
    );
    expect(settled.status).toBe('drm_protected');
    expect(settled.validationCode).toBeNull();
    expect(settled.filename).toBe('encrypted.epub');
  });

  // Stored `drm_protected` must allow owner bytes without weakening live inspection; paired with the prior case, only the stored-status gate widens (#2038).
  it('serves the owner download for a stored drm_protected row over a real file', async () => {
    const bytes = await F.buildEpub();
    const seeded = await seedCompanion({
      filename: 'misclassified.epub',
      bytes,
      storedStatus: 'drm_protected',
    });

    expect(seeded.row.status).toBe('drm_protected');

    const res = await ownerDownload(seeded.bookId);

    expect(res.statusCode).toBe(200);
    expect(res.rawPayload.equals(bytes)).toBe(true);
    expect(res.headers['content-disposition']).toBe('attachment; filename="misclassified.epub"');
  });
});

// Every public negative must return the same non-empty 404 envelope; distinguishing missing from unopenable would create an existence oracle.
describe('row 8 — the public stream against a file that moved under it', () => {
  const ORIGINAL = Buffer.from('original companion bytes');

  // Independent expected bytes keep each subcase valid under filtering, shuffling, or `.only`.
  const UNAVAILABLE_PAYLOAD = Buffer.from(JSON.stringify(UNAVAILABLE_BODY), 'utf8');

  type StreamResponse = {
    statusCode: number;
    headers: Record<string, unknown>;
    payload: string;
    rawPayload: Buffer;
  };

  async function streamAfter(
    filename: string,
    arrange: (filePath: string) => Promise<void>,
  ): Promise<StreamResponse> {
    const seeded = await seedCompanion({ filename, bytes: ORIGINAL });
    await arrange(seeded.filePath);
    return publicStream(seeded.publicId);
  }

  function expectUnavailableEnvelope(res: StreamResponse) {
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).not.toBe(EPUB_MEDIA_TYPE);
    expect(JSON.parse(res.payload)).toEqual(UNAVAILABLE_BODY);
    // Pin non-empty wire bytes, not only parsed shape.
    expect(res.rawPayload).toEqual(UNAVAILABLE_PAYLOAD);
  }

  it('8a — a deleted file answers the canonical unavailable envelope', async () => {
    const res = await streamAfter('gone.epub', (filePath) => unlink(filePath));

    expectUnavailableEnvelope(res);
  });

  it('8b — a replacement regular file streams coherently at its own length', async () => {
    const seeded = await seedCompanion({ filename: 'swapped.epub', bytes: ORIGINAL });
    const replacement = Buffer.from('a completely different, longer companion payload');
    expect(replacement.length).not.toBe(ORIGINAL.length);
    await writeFile(seeded.filePath, replacement);

    const res = await publicStream(seeded.publicId);

    // Accepted stale window: no dev/ino binding. Stream the replacement coherently using live `fstat`; do not change this to 404.
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-length']).toBe(String(replacement.length));
    expect(res.rawPayload).toEqual(replacement);
    // The stale stored size proves Content-Length came from the live handle.
    expect(seeded.row.sizeBytes).toBe(ORIGINAL.length);
  });

  it('8c — a directory in the file\'s place answers the same envelope, byte for byte', async () => {
    const directoryRes = await streamAfter('dir.epub', async (filePath) => {
      await unlink(filePath);
      await mkdir(filePath);
    });

    expectUnavailableEnvelope(directoryRes);

    // Compare `not_regular_file` with ENOENT in-test so the anti-oracle proof is order-independent.
    const deletedRes = await streamAfter('also-gone.epub', (filePath) => unlink(filePath));

    expect(directoryRes.rawPayload).toEqual(deletedRes.rawPayload);
  });
});

describe('row 9 — a file larger than the pre-open size ceiling', () => {
  it('rejects before the archive is ever opened', async () => {
    // Measured 2026-07-28: a sparse 256 MiB + 1 file hit `limit_exceeded` in <1 ms. Since only `lstat().size` decides it, this portable override takes the same branch.
    const bytes = await F.buildEpub();
    const seeded = await seedCompanion({ filename: 'oversize.epub', bytes });
    h.sizeOverrides.set(seeded.filePath, MAX_ARCHIVE_BYTES + 1);

    const observed = await stat(seeded.filePath);
    expect(observed.size).toBeLessThan(MAX_ARCHIVE_BYTES);
    expect(h.sizeOverrides.get(seeded.filePath)).toBe(MAX_ARCHIVE_BYTES + 1);

    h.opened.length = 0;
    expect((await metadata(seeded.bookId)).statusCode).toBe(404);

    expect(h.opened.filter((path) => path === seeded.filePath)).toEqual([]);
  });
});

describe('row 10 — an archive declaring more members than the entry ceiling', () => {
  const STALE_BY = 60_000;

  it('answers 404 and settles /state on invalid / limit_exceeded', async () => {
    // Measured 2026-07-28: a real 10,001-entry archive took 502 ms to build and <1 ms to reject. The pre-open declared count is the same field this small fixture patches.
    const built = await F.buildEpub();
    const OVER_CEILING = MAX_ARCHIVE_ENTRIES + 1;
    const bytes = declareRecordCount(built, OVER_CEILING);
    expect(readRecordCount(built)).toBeLessThan(MAX_ARCHIVE_ENTRIES);
    expect(readRecordCount(bytes)).toBe(OVER_CEILING);

    const seeded = await seedCompanion({
      filename: 'too-many.epub',
      bytes,
      staleBy: STALE_BY,
    });
    // Prevent `isUnchanged` from bypassing reconciliation.
    expect(seeded.row.mtimeMs).not.toBe(seeded.onDisk.mtimeMs);
    expect(seeded.row.ctimeMs).toBe(seeded.onDisk.ctimeMs - STALE_BY);

    expect((await metadata(seeded.bookId)).statusCode).toBe(404);

    const settled = await pollState(
      seeded.bookId,
      (payload) => payload.status !== 'available',
      'the reconciler to rewrite the row away from available',
    );
    expect(settled.status).toBe('invalid');
    expect(settled.validationCode).toBe('limit_exceeded');
  });
});

describe('row 11 — a central directory larger than any entry budget', () => {
  it('rejects on the shipped central-directory span cap', async () => {
    /**
     * Span cannot exceed file bytes, so this cap needs a real ~16.8 MiB fixture. Measured 2026-07-28:
     * 95 ms to build, 3 ms to reject; uncapped retention was 2.06–2.39× span across four slots.
     * A conformant EPUB is required—an arbitrary ZIP still 404s as `bad_mimetype` if the cap disappears.
     */
    const bytes = await F.buildArchiveWithCentralDirectorySpan({
      span: MAX_CENTRAL_DIRECTORY_BYTES + 1,
      entries: F.epubEntries(),
      filler: 150,
    });
    // Prove the overage is real filename bytes, not a patched offset.
    expect(F.centralDirectorySpan(bytes)).toBe(MAX_CENTRAL_DIRECTORY_BYTES + 1);
    expect(bytes.length).toBeLessThan(MAX_ARCHIVE_BYTES);

    const seeded = await seedCompanion({ filename: 'wide-directory.epub', bytes });

    expect((await metadata(seeded.bookId)).statusCode).toBe(404);
  });
});

describe('row 13 — a stored basename that byte-differs from the one on disk', () => {
  it('lists, refuses to open, and then repairs itself', async () => {
    // Basename divergence, not Unicode, is the property; a byte-different pair is portable. Do not stale the fingerprint: filename inequality is what makes repair reachable before that comparison.
    const seeded = await seedCompanion({
      filename: 'companion.epub',
      diskFilename: 'companion-1.epub',
      bytes: await F.buildEpub(),
    });
    expect(basename(seeded.filePath)).toBe('companion-1.epub');
    expect(seeded.row.filename).toBe('companion.epub');

    const listed = (await state(seeded.bookId)).json() as CompanionStatePayload;
    expect(listed.status).toBe('available');
    expect(listed.filename).toBe('companion.epub');

    // Listed-but-unopenable is an accepted stale window; the 404 triggers repair.
    expect((await ownerDownload(seeded.bookId)).statusCode).toBe(404);

    // Unlike a deleted file, discovery can select the lone real companion and rewrite the basename.
    const repaired = await pollState(
      seeded.bookId,
      (payload) => payload.filename !== 'companion.epub',
      'the reconciler to repair the stored basename',
    );
    expect(repaired.filename).toBe('companion-1.epub');
    expect(repaired.status).toBe('available');
  });
});

/**
 * Local fixture tests response byte fidelity across spaces, percent, quoting, and non-ASCII.
 * Use apostrophes, not NTFS-illegal double quotes; they exercise the same JSON quoting hazard.
 */
const AWKWARD_BASENAME = "A Book (50%) 'done' ✓.epub";

describe('#2022 — the metadata response declares the stored basename it read', () => {
  it('round-trips an awkward basename byte-identically, and emits none on the 404 arms', async () => {
    const seeded = await seedCompanion({
      filename: AWKWARD_BASENAME,
      bytes: await F.buildEpub({
        packageOptions: { items: [F.CHAPTER_ITEM] },
      }),
    });

    const res = await metadata(seeded.bookId);

    expect(res.statusCode).toBe(200);
    const body = res.json() as { filename: string; metadata: unknown; toc: unknown };
    expect(body.filename).toBe(AWKWARD_BASENAME);
    // Independently read routes must project the same filename.
    expect(((await state(seeded.bookId)).json() as CompanionStatePayload).filename).toBe(AWKWARD_BASENAME);

    // Resolver failure is the boundary where a stored filename could leak into a 404.
    await unlink(seeded.filePath);
    const gone = await metadata(seeded.bookId);
    expect(gone.statusCode).toBe(404);
    expect(gone.json()).not.toHaveProperty('filename');
    expect(gone.rawPayload.toString('utf8')).not.toContain('A Book');
  });
});
