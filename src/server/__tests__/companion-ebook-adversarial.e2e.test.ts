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
 * The adversarial integration suite for the composed companion-ebook read paths (#2026).
 *
 * Every unit in the slate (#1986-#1990, #1959, #1960, #1963, #1976) is tested in isolation.
 * Nothing tested the COMPOSED path — `route → resolveCompanionEbookPath → openCompanionEbook →
 * validate/inspect → stream` — against hostile input, and a post-merge audit found three
 * defects that per-issue review structurally could not see: two spanned module boundaries and
 * one was a resource bound that only exists at the system level. Per-issue tests mock at their
 * own boundaries, so a gap BETWEEN layers is precisely what they cannot observe.
 *
 * **Test-only. No production behaviour changes.** A scenario that exposes a defect gets its own
 * issue, referenced in a comment here — never a fix smuggled into a test-only PR.
 *
 * **Rows 2 and 12 are deliberately absent.** They shipped with the fixes in `31dbad3b`:
 * the symlink-at-the-verified-path row lives in `companion-ebook-open.test.ts` and the
 * slot-released-on-pre-stream-disconnect row in `routes/v1/companion-ebook-stream.test.ts`.
 * Row 14 (an ignored `Range` header) and row 15 (a hostile filename rendered by the panel) are
 * likewise elsewhere by surface — the first beside the real-socket stream suite because
 * `app.inject()` cannot drive a socket, the second in `CompanionEbookSection.test.tsx` because
 * `app.inject()` cannot render React.
 *
 * **Where inspection actually happens**, because getting this wrong produces tests that assert
 * the wrong status:
 *
 * - **Neither streaming path parses the archive.** The owner download and the public v1 stream
 *   both run `openCompanionEbook` → `streamCompanionEbook` and nothing else. A forged,
 *   oversized, or DRM-flagged archive streams back as a clean `200` with a `Content-Length`
 *   from `fstat`. That is correct, and it is worth asserting — but it is not `limit_exceeded`.
 * - **`inspectEpub` runs on exactly two routes**, `/companion-epub/metadata` and
 *   `/companion-epub/cover`, both through `loadCompanionInspection`, which flattens every
 *   archive-shaped rejection to a `404` plus a fire-and-forget reconcile.
 * - **`/companion-epub/state` never inspects.** It projects the stored row; only `ambiguous` is
 *   served live. A hostile archive cannot change what `/state` returns until the reconciler
 *   rewrites the row.
 * - **`limit_exceeded` is a `validationCode`, not a status.** A limit rejection persists as
 *   `status: 'invalid'` + `validationCode: 'limit_exceeded'`.
 */

// ---------------------------------------------------------------------------
// The `node:fs/promises` seam
// ---------------------------------------------------------------------------

/**
 * Mocked at the OS boundary, never at a module under test (`esm-same-module-vi-mock-bypass`):
 * `validate.ts` and `companion-ebook-open.ts` call their own helpers through local bindings, so
 * a factory overriding their exports would not intercept those calls, and adding `__internal`
 * indirection to production code to make it mockable is forbidden.
 *
 * Everything delegates to the real implementation. The hooks exist for exactly two rows:
 *
 * - `sizeOverrides` is row 9's over-`MAX_ARCHIVE_BYTES` archive. Inflating what `lstat` reports
 *   is what makes that row cheap; writing 256 MiB on every run is not acceptable.
 * - `watched` / `watchedReads` is row 4's XXE target — the proof that the file the entity names
 *   was never read. Scoped to that one basename on purpose: the harness generates plenty of
 *   unrelated filesystem traffic and an assertion over all of it would be noise.
 */
const h = vi.hoisted(() => ({
  /** Absolute path → the `size` `lstat` must report instead of the real one. */
  sizeOverrides: new Map<string, number>(),
  /** Basenames whose reads must be provable never to have happened. */
  watched: new Set<string>(),
  /** `<syscall>:<basename>` for every watched read that DID happen. */
  watchedReads: [] as string[],
  /** Every path handed to `open`, so "the archive was never opened" is decidable. */
  opened: [] as string[],
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();

  // `path.basename` cannot be imported here — a `vi.mock` factory is hoisted above the import
  // block, so module-scope bindings are not yet initialised when it runs.
  const leaf = (target: unknown): string => String(target).split(/[\\/]/).pop() ?? '';
  const note = (syscall: string, target: unknown): void => {
    if (h.watched.has(leaf(target))) h.watchedReads.push(`${syscall}:${leaf(target)}`);
  };

  const lstat = (async (target: PathLike, options?: unknown) => {
    const stats = await (actual.lstat as (p: PathLike, o?: unknown) => Promise<Stats>)(target, options);
    const size = h.sizeOverrides.get(String(target));
    if (size === undefined) return stats;
    // A structural clone with one field replaced, rather than a mutated original: `isFile()`
    // reads `this.mode`, so the prototype and every other own property have to survive.
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

// ---------------------------------------------------------------------------
// Fixtures shared across rows
// ---------------------------------------------------------------------------

/**
 * The public route's ONE `404` body. Spelled here as a literal rather than imported, so a
 * change to the shipped constant is a failing test rather than a silently-agreeing one.
 */
const UNAVAILABLE_BODY = {
  error: { code: 'companion_epub_unavailable', message: 'Companion ebook is unavailable' },
} as const;

const EPUB_MEDIA_TYPE = 'application/epub+zip';

/** A ten-byte PNG: a full signature plus two bytes, so the sniffer matches in full. */
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);

let e2e: E2EApp;
/**
 * One library root PER SCENARIO — that is where the no-cross-test-leakage property lives: no
 * two rows ever share a book folder, a book row, or an observation row.
 *
 * Removal is deferred to `afterAll` rather than done in `afterEach`, deliberately. Almost every
 * row's request enqueues a fire-and-forget reconcile that is still in flight when the test
 * returns (there is no completion signal to await — `fire-and-forget-preflight`), and deleting
 * the directory out from under it would turn an unrelated background pass into filesystem noise
 * on the next row's failure output. Sixteen small directories are cheap; a racing delete is not.
 */
const libraryRoots: string[] = [];
/** Scratch directories that are NOT library roots — row 4's entity targets. */
const scratchDirs: string[] = [];

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A bounded poll, never a fixed sleep. `triggerCompanionReconcile` is fire-and-forget and
 * returns no completion signal (`fire-and-forget-preflight`), so there is nothing to await —
 * the only honest shape is "poll the route until it settles, or fail saying what it never
 * became".
 */
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
  /** The basename stored in `companion_ebooks.filename`. */
  filename: string;
  /** The archive bytes written into the book folder. */
  bytes: Buffer;
  /**
   * The basename actually WRITTEN, when it must differ from the stored one. Row 13 only —
   * every other row leaves the two identical.
   */
  diskFilename?: string;
  /**
   * **The documented fingerprint override.** Subtracts this many milliseconds from the stored
   * `mtimeMs`/`ctimeMs` so the reconciler's `isUnchanged` conjunction cannot short-circuit
   * before validating. Rows 7 and 10 only — they are the two rows that drive a reconcile
   * through a file whose name, size and candidate count are all unchanged, and a faithfully
   * seeded fingerprint would make the reconciler skip and their `/state` poll time out.
   * Every other row seeds the true `stat`.
   */
  staleBy?: number;
  /**
   * The STORED `companion_ebooks.status` (#2038). Defaults to `available`, so every row seeded
   * before the owner gate widened behaves exactly as it did.
   *
   * Only the two file-bearing statuses are seedable here: `ck_companion_ebooks_file_present`
   * requires `filename`/`sizeBytes`/`mtimeMs`/`ctimeMs` non-null, and this helper always writes
   * all four. `invalid` is the third such status but wants a `validationCode` this helper does
   * not seed, and `none`/`ambiguous` fail the CHECK outright.
   */
  storedStatus?: 'available' | 'drm_protected';
}

interface Seeded {
  bookId: number;
  publicId: string;
  libraryRoot: string;
  bookPath: string;
  /** The absolute path of the file actually written. */
  filePath: string;
  /** The row as inserted. */
  row: CompanionEbookRow;
  /** The live `lstat`, truncated the way the observation write boundary truncates. */
  onDisk: { sizeBytes: number; mtimeMs: number; ctimeMs: number };
}

/**
 * The shared preconditions every hostile-archive row needs, in one place.
 *
 * `loadExposedCompanionContext` gates on `isCompanionEbookOwnerReadable`, so a request only
 * reaches the resolver when ALL of these hold — and each one of them is a silent 404 or a failed
 * INSERT when it does not:
 *
 * - `companionEpub.enabled === true`; it defaults to **false**.
 * - `library.path` set to this scenario's temp root, `realpath`ed so the resolver's
 *   containment check (which canonicalises) agrees with it on a symlinked `/tmp`.
 * - `books.status === 'imported'` and `books.path` a real directory inside that root.
 * - A stored status the owner gate admits — `available` (the default) or `drm_protected`
 *   (#2038), which is `storedStatus`'s only other legal value here.
 * - All four file-presence columns non-null (`ck_companion_ebooks_file_present`, which covers
 *   both of those statuses).
 * - **`candidateCount: 1`.** The column defaults to `0` and
 *   `ck_companion_ebooks_candidate_count` requires `>= 1` for both file-bearing statuses —
 *   seeded literally without it, the INSERT fails before any route runs.
 * - **`selectedFilename: null`.** A non-null selection is only well-formed when it equals
 *   `filename`; leaving it null satisfies the selection CHECK and keeps `isUnchanged`'s
 *   selection-present comparison stable.
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

/** A scratch directory outside every library root — row 4's entity targets live here. */
async function createScratchDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'narratorr-2026-scratch-'));
  scratchDirs.push(dir);
  return dir;
}

// --- the four owner/public surfaces, by name -------------------------------

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

/** Poll `/state` until the projected row satisfies `predicate`. */
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

// --- byte-level archive surgery --------------------------------------------
//
// Every helper below rewrites one field in BOTH the central directory and the matching local
// file header, because the reader consults both, and every caller asserts its precondition on
// the resulting bytes before invoking the route.

/**
 * ZIP general-purpose bit 0 — "this member is encrypted".
 *
 * **Deliberately not folded into `F.drmProtectedEpub()`** (#2041), which reaches the same verdict
 * through a `META-INF/encryption.xml`. These two prove different properties on different axes:
 * the bit scan sits BEFORE the `mimetype` read in the pipeline, which is why row 7 builds an
 * archive with a deliberately wrong `mimetype` and still reads `drm_protected` rather than
 * `bad_mimetype`. A structurally valid shared fixture cannot express that. The helpers also
 * belong with the other byte-level archive surgery above, which shares the both-headers preamble.
 */
const ZIP_ENCRYPTED_BIT = 0x1;

/** Read one central-directory record's 2-byte general-purpose flags field. */
function readFlags(archive: Buffer, index: number): number {
  return archive.readUInt16LE(F.listCentralDirectory(archive)[index]!.headerOffset + 8);
}

/** Set general-purpose bit 0 on member `index`, in both headers. */
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

/** Read one central-directory record's declared `uncompressedSize`. */
function readDeclaredSize(archive: Buffer, index: number): number {
  return archive.readUInt32LE(F.listCentralDirectory(archive)[index]!.headerOffset + 24);
}

/** Understate member `index`'s declared uncompressed size, in both headers. */
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

/**
 * Rewrite the EOCD's declared record count. Both count fields move together because the
 * preflight requires `recordsOnDisk === numberOfRecords` before it reaches any ceiling — patch
 * one alone and the rejection is a structural `truncated`, which would pass just as happily
 * against an implementation with no entry ceiling at all.
 */
function declareRecordCount(archive: Buffer, count: number): Buffer {
  const eocd = F.eocdOffset(archive);
  return F.patchArchive(archive, [
    { offset: eocd + 8, size: 2, value: count, why: 'recordsOnDisk, over the entry ceiling' },
    { offset: eocd + 10, size: 2, value: count, why: 'numberOfRecords, kept coherent' },
  ]);
}

/** The declared record count, as the preflight reads it on the legacy branch. */
function readRecordCount(archive: Buffer): number {
  return archive.readUInt16LE(F.eocdOffset(archive) + 10);
}

// ---------------------------------------------------------------------------

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
  // `removeDirTolerant`, never a raw `rmSync`: on Windows a directory still holding an open
  // libSQL handle raises EPERM, and a leaked tmpdir is cheaper than a red suite
  // (`windows-hostile-test-primitives`).
  for (const dir of [...libraryRoots, ...scratchDirs]) removeDirTolerant(dir);
});

// ===========================================================================
// Row 1 — the 213-byte ZIP64 count forgery
// ===========================================================================

describe('row 1 — a 213-byte archive declaring half a billion members', () => {
  /**
   * The motivating fixture: an entirely valid ZIP32 archive with a forged ZIP64 tail declaring
   * ~500M records. Handed to a bare `Open.file()` it OOM-kills the process after ~31 s under a
   * 1 GiB heap cap, because the reader maps over `Array(numberOfRecords)` and that field is an
   * unchecked 8-byte quantity on the ZIP64 path.
   *
   * **Run against the REAL reader, deliberately.** The per-issue suites stub `Open.custom` so a
   * regression fails as an assertion rather than by taking the worker down. Here that stub would
   * make the row vacuous: "the process survives" is the property under test, and it is a
   * property no unit test can assert. If the pre-open ceiling ever regresses, this row takes the
   * worker with it — which is the honest signal, and the ceiling itself is independently pinned
   * in the `src/core/epub/` suites.
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

    /**
     * Precondition, read back from the AUTHORITATIVE bytes rather than from the builder's
     * arguments — and the byte length alone is not it. `213` says the file is small; it says
     * nothing about the half-billion count, and the route observables cannot tell the
     * difference: `/metadata` flattens every archive rejection to the same 404 and neither
     * streaming path parses at all. So a fixture that kept its 213 bytes while losing the
     * hazardous declaration would leave every assertion below green and falsely certify
     * protection against the ZIP64 OOM path.
     *
     * Three fields have to be right for this to be that attack. The EOCD sentinel is what
     * makes the reader consult the ZIP64 record in the first place — without it the count is
     * read from the legacy 2-byte field and the 8-byte quantity is never reached — and the
     * record's two count fields are the unchecked quantity itself.
     */
    expect(bytes).toHaveLength(213);
    expect(bytes.readUInt16LE(F.eocdOffset(bytes) + 10)).toBe(0xffff);
    const record = F.zip64RecordOffset(bytes);
    expect(bytes.readBigUInt64LE(record + 24)).toBe(DECLARED_RECORDS);
    expect(bytes.readBigUInt64LE(record + 32)).toBe(DECLARED_RECORDS);

    const seeded = await seedCompanion({ filename: 'forged.epub', bytes });

    // The inspecting surface refuses it pre-open. `limit_exceeded` is a validationCode, not a
    // status, and `loadCompanionInspection` flattens every archive-shaped rejection to a 404.
    expect((await metadata(seeded.bookId)).statusCode).toBe(404);
    // Process survival, on this surface: a second request still answers.
    expect((await metadata(seeded.bookId)).statusCode).toBe(404);

    // Neither streaming path parses the archive, so both hand back exactly the 213 bytes.
    // Sequenced, never fired together: one libSQL connection permits a single transaction at a
    // time and these share the e2e database (#2006).
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

// ===========================================================================
// Row 3 — a hostile manifest href under a root-level package
// ===========================================================================

/**
 * **What row 3 actually proves.** `resolveHref` percent-decodes BEFORE joining, and containment
 * is against the archive root rather than the base directory — so under the fixture's default
 * `OEBPS/content.opf` base, `%2e%2e%2fsecret` resolves to the *accepted* entry `secret`, pinned
 * deliberately in `paths.test.ts`. Rooting the package at the archive top is what makes one
 * `../` escape the root and hit `normalizeArchivePath`'s `..` rejection.
 *
 * Note what it does NOT prove: an href never becomes a filesystem path at all — the reader
 * addresses ZIP entries by name only. "Nothing outside the library root is read" is asserted
 * with the read spy row 4 uses, not inferred from a status here.
 */
describe('row 3 — a traversal href on a root-level package', () => {
  const HOSTILE_HREF = '%2e%2e%2fsecret';
  const ROOT_PACKAGE = 'content.opf';

  it('is the precondition the row depends on: the href is rejected against the archive root', () => {
    // Asserted directly, before any route request, so the row cannot silently degrade into
    // exercising a legitimate archive-root reference.
    expect(resolveHref('', HOSTILE_HREF)).toEqual({ kind: 'rejected', reason: 'unsafe_entry_path' });
    // And the contrast that makes the root-level package load-bearing.
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

    // The manifest is non-empty, so `empty_manifest` is not what fires: the spine item's href
    // fails to resolve, no linear itemref completes its chain, and the archive is
    // `invalid('empty_spine')`. Both reads flatten that to 404.
    expect((await metadata(seeded.bookId)).statusCode).toBe(404);
    expect((await cover(seeded.bookId)).statusCode).toBe(404);
  });

  it('3b — a hostile href on the cover item alone costs the cover and nothing else', async () => {
    /**
     * The nav item and its document are mandatory here, not decoration. `buildEpub`'s default
     * manifest declares a single `ch1.xhtml` with no `properties="nav"` item and no NCX, so
     * `extractEpubToc` finds no nav item, falls through to the NCX path, and returns `null` —
     * a 3b written on the default fixture would assert `200` with `toc: null` and would pass
     * without ever presenting a TOC, so a regression that dropped an unrelated valid nav would
     * go undetected. The positive TOC is what proves the hostile cover href did no collateral
     * damage.
     */
    const bytes = await F.buildEpub({
      packageName: ROOT_PACKAGE,
      packageOptions: {
        items: [
          { id: 'ch1', href: 'ch1.xhtml', mediaType: 'application/xhtml+xml' },
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
    // Deep-equal to the exact entries the nav document declares — never merely non-null.
    expect(body.toc).toEqual([{ title: 'One', depth: 0 }]);

    // The cover is an optional read: a rejected href yields `cover: null`, which the route maps
    // to its `no_cover` 404 rather than to a status change.
    expect((await cover(seeded.bookId)).statusCode).toBe(404);
  });
});

// ===========================================================================
// Row 4 — XXE through the two documents that are parsed
// ===========================================================================

/**
 * `container.xml` is parsed only to resolve the package path and is never returned by
 * `/metadata`, so "the secret does not appear in the response" is nearly vacuous on its own.
 * Two things fix that: 4a puts the entity somewhere SURFACED (`metadata.title` reaches the
 * body, so literal-vs-expanded is directly observable), and 4b makes the STATUS differ (with
 * the target naming a real package, expansion resolves and answers `200` while literal text
 * does not). Both additionally prove the target file was never read.
 */
describe('row 4 — SYSTEM file entities in the parsed documents', () => {
  const TARGET = 'xxe-target.txt';

  async function plantTarget(contents: string): Promise<{ path: string; url: string }> {
    const dir = await createScratchDir();
    const path = join(dir, TARGET);
    await writeFile(path, contents, 'utf8');
    // `pathToFileURL` so a Windows backslash cannot break the fixture.
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
    // The LITERAL entity reference, unexpanded. This is the composed-route mirror of the unit
    // guard in `xml.test.ts`: cheerio's backend performs no DTD or entity resolution at all, so
    // XXE is structurally unavailable rather than defended against — and a parser swap that
    // reintroduced it would flip this assertion.
    expect(body.metadata.title).toBe('&xxe;');
    expect(res.payload).not.toContain(secret);
    expect(h.watchedReads).toEqual([]);
    // The file is still there — the parser simply never read it.
    await expect(stat(target.path)).resolves.toBeDefined();
  });

  it('4b — an entity as the container rootfile leaves the package unresolvable', async () => {
    // The target contains a package path that WOULD resolve if the entity were expanded, so
    // expansion produces a 200 and literal text produces a 404. That is what makes this
    // subcase status-differentiating rather than a restatement of 4a.
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

    // Precondition: the archive really does hold a `content.opf` the expanded form would find.
    expect(F.listCentralDirectory(bytes).map((entry) => entry.rawName.toString('utf8')))
      .toContain('content.opf');

    h.watched.add(TARGET);
    const res = await metadata(seeded.bookId);

    // Literal `&xxe;` is not an archive entry, so the package is `unresolvable_package`.
    expect(res.statusCode).toBe(404);
    expect(h.watchedReads).toEqual([]);
  });
});

// ===========================================================================
// Row 5 — an understated declared size on the package document
// ===========================================================================

describe('row 5 — a package document whose declared size understates its bytes', () => {
  it('stops at the budget rather than inflating what the declaration promised', async () => {
    // 4 MiB + 1 KiB of actual inflated bytes behind a 512-byte declaration. Deflated whitespace
    // costs almost nothing on disk, which is exactly the asymmetry an attacker exploits.
    const inflated = MAX_XML_BYTES + 1024;
    const built = await F.buildEpub({ packageOptions: { padTo: inflated } });
    // Entry order is fixed by `epubEntries`: mimetype, container, package, chapter.
    const PACKAGE_INDEX = 2;
    expect(F.listCentralDirectory(built)[PACKAGE_INDEX]!.rawName.toString('utf8'))
      .toBe(F.DEFAULT_PACKAGE);
    expect(readDeclaredSize(built, PACKAGE_INDEX)).toBe(inflated);

    const bytes = understateDeclaredSize(built, PACKAGE_INDEX, 512);
    // Precondition: the bytes on disk really do lie about their size.
    expect(readDeclaredSize(bytes, PACKAGE_INDEX)).toBe(512);
    expect(bytes.length).toBeLessThan(inflated);

    const seeded = await seedCompanion({ filename: 'understated.epub', bytes });

    // The declared size is advisory and is never an enforcement point for a mandatory read:
    // the counting transform aborts the stream at the ceiling and the read reports
    // `cap-exceeded`, which maps to `limit_exceeded` and flattens to a 404.
    expect((await metadata(seeded.bookId)).statusCode).toBe(404);
  });
});

// ===========================================================================
// Row 6 — the aggregate inspection budget
// ===========================================================================

describe('row 6 — a nav and a cover that are individually legal and jointly are not', () => {
  /**
   * **The arithmetic that actually works.** Nav is capped by `MAX_XML_BYTES` (4 MiB) and the
   * cover by `MAX_EPUB_COVER_BYTES` (8 MiB), totalling 12 MiB against a 16 MiB
   * `MAX_INSPECTION_BYTES` — so the two CANNOT jointly exceed the inspection cap by themselves.
   * The working shape is the remainder pattern: there are exactly four mandatory reads
   * (`mimetype`, `container.xml`, the package document, `encryption.xml`), each ceilinged at
   * `MAX_XML_BYTES`, and `4 × MAX_XML_BYTES === MAX_INSPECTION_BYTES`. Pad the first three to
   * the ceiling and `encryption.xml` to `MAX_XML_BYTES - remainder`, leaving exactly
   * `remainder` bytes for the two optional reads.
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

    // The fixture arithmetic, asserted rather than assumed — so the test provably exercises the
    // AGGREGATE budget rather than an individual cap.
    const mandatory =
      Buffer.byteLength(mimetype) +
      Buffer.byteLength(container) +
      MAX_XML_BYTES + // the package document, padded to the ceiling below
      Buffer.byteLength(encryption);
    expect(mandatory).toBe(MAX_INSPECTION_BYTES - REMAINDER);
    expect(Buffer.byteLength(nav)).toBe(NAV_BYTES);
    expect(coverBytes).toHaveLength(COVER_BYTES);
    // Each individually legal…
    expect(NAV_BYTES).toBeLessThanOrEqual(MAX_XML_BYTES);
    expect(COVER_BYTES).toBeLessThanOrEqual(MAX_EPUB_COVER_BYTES);
    // …and jointly over what the mandatory reads left behind.
    expect(NAV_BYTES + COVER_BYTES).toBeGreaterThan(REMAINDER);

    const bytes = await F.buildEpub({
      mimetype,
      container,
      encryption,
      packageOptions: {
        padTo: MAX_XML_BYTES,
        items: [
          { id: 'ch1', href: 'ch1.xhtml', mediaType: 'application/xhtml+xml' },
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

    // The TOC is read first BY DESIGN, so the cover loses the 1000 bytes the nav left and is
    // pre-rejected on its declared size. The reverse order would produce the mirror result for
    // the same file, which is exactly why the order is frozen.
    expect((await cover(seeded.bookId)).statusCode).toBe(404);
  });
});

// ===========================================================================
// Row 7 — a ZIP-encrypted content entry, reconciled to drm_protected
// ===========================================================================

describe('row 7 — general-purpose bit 0 on a content entry', () => {
  const STALE_BY = 60_000;

  it('answers 404 and settles /state on drm_protected without reading an entry', async () => {
    /**
     * The mimetype is deliberately WRONG. The encryption-bit scan runs inside `openArchive`,
     * before the first `entry.read()`, and the mimetype check runs after it — so a verdict of
     * `drm_protected` rather than `bad_mimetype` is the observable proof that no entry stream
     * was ever opened. Asserting `drm_protected` on a well-formed fixture would prove only that
     * the bit was noticed, not that it was noticed first.
     */
    const built = await F.buildEpub({ mimetype: 'not-an-epub' });
    // Entry index 3 is `OEBPS/ch1.xhtml` — a content entry, not a structural one.
    const CONTENT_INDEX = 3;
    expect(F.listCentralDirectory(built)[CONTENT_INDEX]!.rawName.toString('utf8'))
      .toBe('OEBPS/ch1.xhtml');
    expect(readFlags(built, CONTENT_INDEX) & ZIP_ENCRYPTED_BIT).toBe(0);

    const bytes = setEncryptedBit(built, CONTENT_INDEX);
    // Precondition: the bytes on disk really do declare the member encrypted.
    expect(readFlags(bytes, CONTENT_INDEX) & ZIP_ENCRYPTED_BIT).toBe(ZIP_ENCRYPTED_BIT);

    const seeded = await seedCompanion({
      filename: 'encrypted.epub',
      bytes,
      staleBy: STALE_BY,
    });

    // Precondition: the seeded fingerprint is deliberately stale. Without it `isUnchanged`
    // returns before any validation — the reconciler writes nothing, and the poll below times
    // out in a way that reads like a flaky test rather than a missing precondition.
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

  /**
   * The composed positive #2038 adds, and the mirror of the case above. Same route, same stored
   * `drm_protected` status — but a REAL file on disk, and the owner gets its bytes.
   *
   * This is the misclassification-recovery case stated end to end: the classifier was wrong
   * about a real book (`287ee627`, The Shining), and under the old single gate that verdict
   * denied the owner access to a perfectly good file forever. Serving it removes no DRM; the
   * bytes were already on the owner's disk.
   *
   * Read together with the case above, the pair is the whole security argument: widening the
   * STORED-status gate widened the download and nothing else — row 7's `404` on the two read
   * routes still comes from the live archive reader, which this issue did not touch.
   */
  it('serves the owner download for a stored drm_protected row over a real file', async () => {
    const bytes = await F.buildEpub();
    const seeded = await seedCompanion({
      filename: 'misclassified.epub',
      bytes,
      storedStatus: 'drm_protected',
    });

    // Precondition: the row really is stored as DRM, so the 200 below is the widened gate's
    // doing and not a fixture that quietly seeded `available`.
    expect(seeded.row.status).toBe('drm_protected');

    const res = await ownerDownload(seeded.bookId);

    expect(res.statusCode).toBe(200);
    expect(res.rawPayload.equals(bytes)).toBe(true);
    expect(res.headers['content-disposition']).toBe('attachment; filename="misclassified.epub"');
  });
});

// ===========================================================================
// Row 8 — the file under the stored basename changes
// ===========================================================================

/**
 * The v1 route has exactly ONE `404` body, sent by `unavailable(reply)` from every negative
 * branch. It never sends an empty body, and it deliberately does not distinguish "no such book"
 * from "open failed", because that distinction is the existence oracle the endpoint must not
 * become. 8a and 8c therefore assert the IDENTICAL envelope, and the assertion is doing two
 * jobs: pinning the shape, and pinning that a deleted file and a directory-swapped file are
 * indistinguishable to an unauthenticated caller.
 */
describe('row 8 — the public stream against a file that moved under it', () => {
  const ORIGINAL = Buffer.from('original companion bytes');

  /**
   * The exact bytes the route is expected to put on the wire for BOTH negatives.
   *
   * A module-level constant rather than a payload captured from a sibling test: byte identity
   * between 8a and 8c has to be a property of each response independently, or a focused filter
   * (`-t 8c`), a shuffled order, or a `.only` turns correct production behaviour into a failure
   * against an uninitialised variable. Each subcase now compares against this and the identity
   * follows transitively — and 8c additionally proves it directly, in-test, below.
   */
  const UNAVAILABLE_PAYLOAD = Buffer.from(JSON.stringify(UNAVAILABLE_BODY), 'utf8');

  type StreamResponse = {
    statusCode: number;
    headers: Record<string, unknown>;
    payload: string;
    rawPayload: Buffer;
  };

  /** Seed a book, then leave its companion path in whatever hostile shape `arrange` makes. */
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
    // No EPUB payload bytes — the route answers JSON, and the body parses as exactly the
    // canonical envelope.
    expect(res.headers['content-type']).not.toBe(EPUB_MEDIA_TYPE);
    expect(JSON.parse(res.payload)).toEqual(UNAVAILABLE_BODY);
    // And byte-for-byte, so "the public route never sends an empty body" and "both negatives
    // are indistinguishable" are pinned on the wire form, not merely on the parsed shape.
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

    // This LOOKS like a bug and is not: `openCompanionEbook` takes its size from the live
    // handle's `fstat` and deliberately has no dev/ino identity binding, so the answer is the
    // file that is there now, coherently — never a mixed body and never the stale length. That
    // omission is a documented decision (§4's accepted stale window); do not "fix" this test by
    // asserting a 404, and do not add an identity binding to make it one.
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-length']).toBe(String(replacement.length));
    expect(res.rawPayload).toEqual(replacement);
    // The stored observation still claims the old size — proving the length came from the live
    // handle rather than from the row.
    expect(seeded.row.sizeBytes).toBe(ORIGINAL.length);
  });

  it('8c — a directory in the file\'s place answers the same envelope, byte for byte', async () => {
    const directoryRes = await streamAfter('dir.epub', async (filePath) => {
      await unlink(filePath);
      await mkdir(filePath);
    });

    expectUnavailableEnvelope(directoryRes);

    // The anti-oracle property, proved DIRECTLY and inside this one test: a second book whose
    // file was deleted is driven through the same route here, so the comparison needs nothing
    // from 8a and holds under any test order or filter. `verifyPath`'s `lstat().isFile()`
    // rejects the directory as `not_regular_file` while the deletion makes `lstat` throw
    // `ENOENT` — two different internal outcomes, one indistinguishable public answer.
    const deletedRes = await streamAfter('also-gone.epub', (filePath) => unlink(filePath));

    expect(directoryRes.rawPayload).toEqual(deletedRes.rawPayload);
  });
});

// ===========================================================================
// Row 9 — an archive over MAX_ARCHIVE_BYTES
// ===========================================================================

describe('row 9 — a file larger than the pre-open size ceiling', () => {
  it('rejects before the archive is ever opened', async () => {
    /**
     * **Scaled down, with the full scale measured by hand.** A genuine fixture is a 256 MiB + 1
     * file; measured directly against `validateEpub` on 2026-07-28 (Linux, Node 24.18) a sparse
     * `truncate` to exactly `MAX_ARCHIVE_BYTES + 1` produced
     * `{ status: 'invalid', code: 'limit_exceeded' }` in under 1 ms, with `stat.blocks === 0`.
     * The verdict is decided by `lstat().size` alone, so inflating what `lstat` reports
     * exercises the identical branch without a quarter-gigabyte write on every run — and unlike
     * a sparse file it behaves the same on a filesystem that has no sparse support.
     */
    const bytes = await F.buildEpub();
    const seeded = await seedCompanion({ filename: 'oversize.epub', bytes });
    h.sizeOverrides.set(seeded.filePath, MAX_ARCHIVE_BYTES + 1);

    // Precondition: the seam really is reporting an over-ceiling size for this exact path.
    const observed = await stat(seeded.filePath);
    expect(observed.size).toBeLessThan(MAX_ARCHIVE_BYTES);
    expect(h.sizeOverrides.get(seeded.filePath)).toBe(MAX_ARCHIVE_BYTES + 1);

    h.opened.length = 0;
    expect((await metadata(seeded.bookId)).statusCode).toBe(404);

    // `preOpenRejection` runs before `withZipSource`, so no descriptor is ever taken for the
    // archive — the resolver's `lstat` is the only syscall that touched it.
    expect(h.opened.filter((path) => path === seeded.filePath)).toEqual([]);
  });
});

// ===========================================================================
// Row 10 — more members than the entry ceiling, reconciled to invalid
// ===========================================================================

describe('row 10 — an archive declaring more members than the entry ceiling', () => {
  const STALE_BY = 60_000;

  it('answers 404 and settles /state on invalid / limit_exceeded', async () => {
    /**
     * **Scaled down, with the full scale measured by hand.** A genuine archive holding
     * `MAX_ARCHIVE_ENTRIES + 1` real members was built and validated directly on 2026-07-28
     * (Linux, Node 24.18): 502 ms to build, 947,899 bytes on disk, a 548,946-byte central
     * directory, and `{ status: 'invalid', code: 'limit_exceeded' }` in under 1 ms. The
     * enforcement point is the pre-open DECLARED count, and a real archive's declaration is the
     * same field this fixture patches — so a 1 KiB archive that declares 10,001 members takes
     * the identical branch for a thousandth of the bytes.
     */
    const built = await F.buildEpub();
    const OVER_CEILING = MAX_ARCHIVE_ENTRIES + 1;
    const bytes = declareRecordCount(built, OVER_CEILING);
    // Precondition: the bytes on disk really do declare an over-ceiling count.
    expect(readRecordCount(built)).toBeLessThan(MAX_ARCHIVE_ENTRIES);
    expect(readRecordCount(bytes)).toBe(OVER_CEILING);

    const seeded = await seedCompanion({
      filename: 'too-many.epub',
      bytes,
      staleBy: STALE_BY,
    });
    // Precondition: the seeded fingerprint is deliberately stale, so `isUnchanged` cannot
    // short-circuit the reconciler before it validates.
    expect(seeded.row.mtimeMs).not.toBe(seeded.onDisk.mtimeMs);
    expect(seeded.row.ctimeMs).toBe(seeded.onDisk.ctimeMs - STALE_BY);

    expect((await metadata(seeded.bookId)).statusCode).toBe(404);

    const settled = await pollState(
      seeded.bookId,
      (payload) => payload.status !== 'available',
      'the reconciler to rewrite the row away from available',
    );
    // `limit_exceeded` is a validationCode, not a status — `ck_companion_ebooks_validation_code`
    // enforces exactly this pairing.
    expect(settled.status).toBe('invalid');
    expect(settled.validationCode).toBe('limit_exceeded');
  });
});

// ===========================================================================
// Row 11 — a central directory over the span ceiling
// ===========================================================================

describe('row 11 — a central directory larger than any entry budget', () => {
  it('rejects on the shipped central-directory span cap', async () => {
    /**
     * **The smallest fixture that can trip this cap, with the full scale measured by hand.**
     * `span ≤ eocdOffset ≤ fileSize`, so unlike a declared *count* an over-cap span has no
     * 213-byte analogue — the bytes have to exist. Measured on 2026-07-28 (Linux, Node 24.18):
     * a `MAX_CENTRAL_DIRECTORY_BYTES + 1` span is a 16,774,990-byte file, 95 ms to build in
     * memory, rejected by `validateEpub` in 3 ms. The hazard this bounds is the uncapped case,
     * where retention tracks the span linearly at 2.06-2.39× and a ~128 MiB span still fits
     * inside the 256 MiB file ceiling — roughly 0.9-1.2 GiB across the four concurrent
     * reconciler slots.
     *
     * #2025 has landed (`51e5900c`); this asserts its cap, and there is deliberately no
     * conditional and no placeholder here.
     *
     * **The archive is a conformant EPUB carrying the over-cap directory**, not an arbitrary
     * ZIP, and that is what makes the row's `404` attributable to the span ceiling. Built the
     * other way — 150 long-named filler members and nothing else — removing the cap merely
     * moves the rejection to `bad_mimetype` and `/metadata` answers `404` either way, so the
     * test would stay green against a build with no span ceiling at all. Here, with the cap
     * gone, the archive opens and inspects as a perfectly readable book.
     */
    const bytes = await F.buildArchiveWithCentralDirectorySpan({
      span: MAX_CENTRAL_DIRECTORY_BYTES + 1,
      entries: F.epubEntries(),
      filler: 150,
    });
    // Precondition: the span really is one byte over the cap — a genuine byte of filename, not
    // a patched offset.
    expect(F.centralDirectorySpan(bytes)).toBe(MAX_CENTRAL_DIRECTORY_BYTES + 1);
    expect(bytes.length).toBeLessThan(MAX_ARCHIVE_BYTES);

    const seeded = await seedCompanion({ filename: 'wide-directory.epub', bytes });

    expect((await metadata(seeded.bookId)).statusCode).toBe(404);
  });
});

// ===========================================================================
// Row 13 — the stored basename does not byte-match the file on disk
// ===========================================================================

describe('row 13 — a stored basename that byte-differs from the one on disk', () => {
  it('lists, refuses to open, and then repairs itself', async () => {
    /**
     * **The property under test is basename divergence, not Unicode.** NFC/NFD is merely one
     * way to produce a stored-vs-disk mismatch, and it is the one way whose outcome depends on
     * the host filesystem. Any byte-differing pair produces the identical composed-path
     * behaviour, deterministically, on every filesystem — no capability probe, no syscall
     * emulation, no skip. Nothing in the companion path calls `String.normalize`, which is
     * exactly why normalisation is not special here.
     *
     * This row needs no stale fingerprint and must not be given one: discovery reads the real
     * on-disk basename while the row stores a different one, so `prior.filename ===
     * resolution.filename` is already false and `isUnchanged` short-circuits on filename before
     * any fingerprint comparison. That inequality is *why* the repair is reachable at all.
     */
    const seeded = await seedCompanion({
      filename: 'companion.epub',
      diskFilename: 'companion-1.epub',
      bytes: await F.buildEpub(),
    });
    expect(basename(seeded.filePath)).toBe('companion-1.epub');
    expect(seeded.row.filename).toBe('companion.epub');

    // 1. `/state` projects the stored row with no filesystem check at all.
    const listed = (await state(seeded.bookId)).json() as CompanionStatePayload;
    expect(listed.status).toBe('available');
    expect(listed.filename).toBe('companion.epub');

    // 2. The download resolves the stored name EXACTLY and finds nothing. Listed-but-unopenable
    //    is the same accepted stale-window class as row 8a, not a defect: `/state` is
    //    documented as display-only, and the 404 plus a reconcile is the designed repair.
    expect((await ownerDownload(seeded.bookId)).statusCode).toBe(404);

    // 3. The repair — row 13's unique contribution, and why it is not a duplicate of 8a. There
    //    the file is gone, so discovery finds no candidate and the row cannot be repaired. Here
    //    discovery readdirs the directory, `resolveCandidate` selects the lone real companion,
    //    and `revalidateCompanionFile` rewrites the row to point at it.
    const repaired = await pollState(
      seeded.bookId,
      (payload) => payload.filename !== 'companion.epub',
      'the reconciler to repair the stored basename',
    );
    expect(repaired.filename).toBe('companion-1.epub');
    expect(repaired.status).toBe('available');
  });
});

// ---------------------------------------------------------------------------
// #2022 — `/metadata` declares the basename it read
// ---------------------------------------------------------------------------

/**
 * A LOCAL literal, deliberately not borrowed from `CompanionEbookSection.test.tsx`'s row-15
 * fixture: escaping is that suite's concern (it can render React; `app.inject()` cannot), and
 * this one's is byte-fidelity through the composed response. Spaces, a percent sign, quotation
 * marks, and a non-ASCII glyph — the four shapes that get mangled by a stray `encodeURI`, a
 * header round-trip, or a latin1 decode somewhere between the row read and the JSON body.
 *
 * APOSTROPHES, not double quotes: this fixture is written to a REAL file, and `"` is one of
 * NTFS's nine illegal filename characters (`< > : " / \ | ? *`), so the original spelling
 * failed the whole suite on Windows at file-creation — the Linux pipeline cannot see it
 * (windows-hostile-test-primitives, primitive 5). The apostrophe exercises the same
 * quoting/JSON-escape hazards and is legal on every filesystem the suite runs on.
 */
const AWKWARD_BASENAME = "A Book (50%) 'done' ✓.epub";

describe('#2022 — the metadata response declares the stored basename it read', () => {
  it('round-trips an awkward basename byte-identically, and emits none on the 404 arms', async () => {
    const seeded = await seedCompanion({
      filename: AWKWARD_BASENAME,
      bytes: await F.buildEpub({
        packageOptions: { items: [{ id: 'ch1', href: 'ch1.xhtml', mediaType: 'application/xhtml+xml' }] },
      }),
    });

    const res = await metadata(seeded.bookId);

    expect(res.statusCode).toBe(200);
    const body = res.json() as { filename: string; metadata: unknown; toc: unknown };
    expect(body.filename).toBe(AWKWARD_BASENAME);
    // …and it is the same value `/state` projects, which is the property the panel's coherence
    // rule is built on: the two routes read the row independently.
    expect(((await state(seeded.bookId)).json() as CompanionStatePayload).filename).toBe(AWKWARD_BASENAME);

    // The 404 arms carry no filename at all. Removing the file drives the resolver negative,
    // which is the boundary a leak would most plausibly cross.
    await unlink(seeded.filePath);
    const gone = await metadata(seeded.bookId);
    expect(gone.statusCode).toBe(404);
    expect(gone.json()).not.toHaveProperty('filename');
    expect(gone.rawPayload.toString('utf8')).not.toContain('A Book');
  });
});
