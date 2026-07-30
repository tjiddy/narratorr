import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';
import path from 'node:path';
import type { FileHandle } from 'node:fs/promises';
import * as F from '../__tests__/epub-archive.fixture.js';
import { scanProductionSources } from '../__tests__/source-scan.js';
import { MAX_EPUB_COVER_BYTES, MAX_INSPECTION_BYTES, MAX_TOC_ENTRIES, MAX_XML_BYTES } from './limits.js';
import type { EpubInspection } from './result.js';
import { inspectEpub, validateEpub } from './validate.js';

/**
 * `inspectEpub` and the optional-read helpers in `extract.ts` (#1990, design §4).
 *
 * **Driven end-to-end through `inspectEpub`.** `extract.ts` exports no
 * path-taking function and no production-only seam exists to reach its helpers,
 * so every row here builds a real archive, writes it out, and inspects it. The
 * `fs`/`unzipper` mocks delegate to the real implementations by default and
 * exist only to answer the questions no black-box assertion can: how many times
 * was the file opened, which members had a stream opened, and in what order.
 *
 * The harness is duplicated from `validate.test.ts` rather than shared because
 * `vi.mock` calls are hoisted per test file; the EPUB-document builders it used
 * to carry now live in `../__tests__/epub-archive.fixture.ts`.
 */

const h = vi.hoisted(() => ({
  fsOpen: vi.fn(),
  openCustom: vi.fn(),
  real: {} as {
    fsOpen: (typeof import('node:fs/promises'))['open'];
    Open: (typeof import('unzipper'))['Open'];
  },
  /** Every archive member whose inflated stream was opened, in order. */
  streamed: [] as string[],
  /** Replace one member's stream, by archive name. */
  onStream: undefined as ((name: string) => Readable | undefined) | undefined,
  handles: [] as Array<{ closes: number }>,
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  h.real.fsOpen = actual.open;
  return { ...actual, default: actual, open: h.fsOpen };
});

vi.mock('unzipper', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const real = (actual.default ?? actual) as typeof import('unzipper');
  h.real.Open = real.Open;
  return { ...actual, default: { ...real, Open: { ...real.Open, custom: h.openCustom } } };
});

/** The reader as the spies need to see it — `@types/unzipper` misdeclares `Open.custom` (#1997). */
type ReaderCustom = (
  source: unknown,
  options: unknown,
) => Promise<{ files: Array<Record<string, unknown>> }>;

function errno(code: string): Error {
  return Object.assign(new Error(`simulated ${code}`), { code });
}

/**
 * A `Readable` that emits `value` as an error instead of data, inflating
 * **nothing**.
 *
 * `File.stream()` returns a `Readable`, not a promise, so a rejected mock would
 * produce a `TypeError` on the missing `.pipe()` instead of exercising
 * stream-error classification.
 */
function erroringStream(value: unknown): Readable {
  return new Readable({
    read() {
      this.destroy(value as Error);
    },
  });
}

/**
 * A `Readable` that pushes `bytes` and only *then* fails with `value`.
 *
 * The distinction from {@link erroringStream} is load-bearing rather than
 * cosmetic. A stream that fails before emitting anything inflates nothing, so
 * `counter.bytesCounted` is 0 and charge-as-you-go is not exercised at all — a
 * rollback implementation is indistinguishable from a correct one. This one
 * inflates first, which is exactly the case where forgiving the bytes *would* be
 * a rollback.
 *
 * The two-call shape is what makes the count deterministic: `pipe` only calls
 * `read()` again once it has handed the first chunk to the counting transform,
 * so the bytes are counted before the error is raised.
 */
function partialThenErroringStream(bytes: Buffer, value: unknown): Readable {
  let pushed = false;
  return new Readable({
    read() {
      if (!pushed) {
        pushed = true;
        this.push(bytes);
        return;
      }
      this.destroy(value as Error);
    },
  });
}

/** Make one archive member's stream fail with `value`, having inflated nothing. */
function failEntry(name: string, value: unknown): void {
  h.onStream = (streamed) => (streamed === name ? erroringStream(value) : undefined);
}

/** Make one archive member's stream inflate `bytes` and then fail with `value`. */
function failEntryAfterInflating(name: string, bytes: Buffer, value: unknown): void {
  h.onStream = (streamed) =>
    streamed === name ? partialThenErroringStream(bytes, value) : undefined;
}

// --- suite scaffolding ------------------------------------------------------

let dir: string;
let sequence = 0;

async function place(bytes: Buffer): Promise<string> {
  sequence += 1;
  return F.writeArchive(dir, `fixture-${sequence}.epub`, bytes);
}

/** Build an EPUB, write it out, and inspect it. */
async function inspectBuilt(options: F.EpubOptions = {}): Promise<EpubInspection> {
  return inspectEpub(await place(await F.buildEpub(options)));
}

/** The `available` arm, or a failure naming what came back instead. */
function available(result: EpubInspection): Extract<EpubInspection, { status: 'available' }> {
  if (result.status !== 'available') throw new Error(`expected available, got ${result.status}`);
  return result;
}

beforeAll(async () => {
  dir = await F.createArchiveDir();
});

afterAll(async () => {
  const { rm } = await import('node:fs/promises');
  await rm(dir, { recursive: true, force: true });
});

beforeEach(() => {
  vi.resetAllMocks();
  h.streamed = [];
  h.onStream = undefined;
  h.handles = [];
  h.fsOpen.mockImplementation(async (...args: unknown[]) => {
    const raw = await (h.real.fsOpen as (...a: unknown[]) => Promise<FileHandle>)(...args);
    const record = { closes: 0 };
    h.handles.push(record);
    return new Proxy(raw, {
      get(target, property, receiver) {
        if (property !== 'close') return Reflect.get(target, property, receiver);
        return async () => {
          record.closes += 1;
          return target.close();
        };
      },
    });
  });
  h.openCustom.mockImplementation(async (source: unknown, options: unknown) => {
    const directory = await (h.real.Open.custom as unknown as ReaderCustom)(source, options);
    for (const file of directory.files) {
      const original = (file.stream as (...a: unknown[]) => Readable).bind(file);
      const name = String(file.path);
      // `File` carries `stream` as an own property, so it can be wrapped in
      // place on a real reader result (#1999) — this is the mechanism behind
      // every "no stream was opened" assertion below.
      file.stream = (...args: unknown[]) => {
        h.streamed.push(name);
        return h.onStream?.(name) ?? original(...args);
      };
    }
    return directory;
  });
});

/** The members every valid fixture reads as part of the *structural* pipeline. */
const MANDATORY = [
  'mimetype',
  'META-INF/container.xml',
  F.DEFAULT_PACKAGE,
  'META-INF/encryption.xml',
];

/** Archive members whose stream was opened for an **optional** read. */
function optionalStreams(): string[] {
  return h.streamed.filter((name) => !MANDATORY.includes(name));
}

// --- shared fixture shapes --------------------------------------------------

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const GIF87A = Buffer.concat([Buffer.from('GIF87a', 'ascii'), Buffer.from([0x01, 0x00])]);
const GIF89A = Buffer.concat([Buffer.from('GIF89a', 'ascii'), Buffer.from([0x01, 0x00])]);
const WEBP = Buffer.concat([
  Buffer.from('RIFF', 'ascii'),
  Buffer.from([0x10, 0x00, 0x00, 0x00]),
  Buffer.from('WEBP', 'ascii'),
]);
const SVG = Buffer.from('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"/>', 'utf8');

const CHAPTER: F.ManifestItem = {
  id: 'ch1',
  href: 'ch1.xhtml',
  mediaType: 'application/xhtml+xml',
};
const NAV_ITEM: F.ManifestItem = {
  id: 'nav',
  href: 'nav.xhtml',
  mediaType: 'application/xhtml+xml',
  properties: 'nav',
};
const NCX_ITEM: F.ManifestItem = {
  id: 'ncx',
  href: 'toc.ncx',
  mediaType: 'application/x-dtbncx+xml',
};
const COVER_ITEM: F.ManifestItem = {
  id: 'cover',
  href: 'cover.png',
  mediaType: 'image/png',
  properties: 'cover-image',
};

const NAV_ENTRY = 'OEBPS/nav.xhtml';
const NCX_ENTRY = 'OEBPS/toc.ncx';
const COVER_ENTRY = 'OEBPS/cover.png';

/** An EPUB 3 book whose nav document is `document`, discovered via `properties="nav"`. */
function navBook(document: string | Buffer, options: F.EpubOptions = {}): F.EpubOptions {
  return {
    ...options,
    packageOptions: { items: [CHAPTER, NAV_ITEM], ...options.packageOptions },
    files: [{ name: NAV_ENTRY, content: document }, ...(options.files ?? [])],
  };
}

/** An EPUB 3 book whose nav `<ol>` is built from `nodes`, with the `nav` under `<body>`. */
function navRowsBook(nodes: readonly F.TocNode[], options: F.EpubOptions = {}): F.EpubOptions {
  return navBook(F.navDocumentXml(F.navXml(nodes)), options);
}

/** An EPUB 2 book whose NCX is `document`, reached through `spine@toc`. */
function ncxBook(document: string, options: F.EpubOptions = {}): F.EpubOptions {
  return {
    ...options,
    packageOptions: {
      items: [CHAPTER, NCX_ITEM],
      spine: '<spine toc="ncx"><itemref idref="ch1"/></spine>',
      ...options.packageOptions,
    },
    files: [{ name: NCX_ENTRY, content: document }, ...(options.files ?? [])],
  };
}

function ncxRowsBook(nodes: readonly F.TocNode[], options: F.EpubOptions = {}): F.EpubOptions {
  return ncxBook(F.ncxDocumentXml(F.navMapXml(nodes)), options);
}

/** A book carrying `bytes` as its cover, declared through `properties="cover-image"`. */
function coverBook(bytes: Buffer, options: F.EpubOptions = {}): F.EpubOptions {
  return {
    ...options,
    packageOptions: { items: [CHAPTER, COVER_ITEM], ...options.packageOptions },
    files: [{ name: COVER_ENTRY, content: bytes }, ...(options.files ?? [])],
  };
}

const ONE_ROW: F.TocNode[] = [{ label: 'One' }];
const ONE_ENTRY = [{ title: 'One', depth: 0 }];

// ---------------------------------------------------------------------------

describe('inspectEpub — the shape of a complete inspection', () => {
  it('returns metadata, a flat TOC, and a sniffed cover for an EPUB 3', async () => {
    const result = await inspectBuilt(
      navRowsBook([{ label: 'Chapter One' }, { label: 'Chapter Two' }], {
        packageOptions: {
          items: [CHAPTER, NAV_ITEM, COVER_ITEM],
          metadata: { title: 'A Book', creators: ['Ada Lovelace'], language: 'en-GB' },
        },
        files: [{ name: COVER_ENTRY, content: PNG }],
      }),
    );

    expect(result).toEqual({
      status: 'available',
      metadata: { title: 'A Book', author: 'Ada Lovelace', language: 'en-GB' },
      toc: [
        { title: 'Chapter One', depth: 0 },
        { title: 'Chapter Two', depth: 0 },
      ],
      cover: { mediaType: 'image/png', bytes: PNG },
    });
  });

  it('reads the TOC before the cover, and opens the archive exactly once', async () => {
    await inspectBuilt(
      navRowsBook(ONE_ROW, {
        packageOptions: { items: [CHAPTER, NAV_ITEM, COVER_ITEM] },
        files: [{ name: COVER_ENTRY, content: PNG }],
      }),
    );

    // The frozen order: TOC first — the smaller read, feeding the chapter
    // count — then the cover, the largest and most expendable optional read.
    expect(optionalStreams()).toEqual([NAV_ENTRY, COVER_ENTRY]);
    // One call is one open. There is no context to carry a second.
    expect(h.fsOpen).toHaveBeenCalledTimes(1);
    expect(h.handles).toHaveLength(1);
    expect(h.handles[0]?.closes).toBe(1);
  });
});

// ---------------------------------------------------------------------------

describe('non-available outcomes short-circuit every optional read', () => {
  const NON_AVAILABLE: Array<[label: string, options: F.EpubOptions]> = [
    ['bad_mimetype', { mimetype: 'application/zip' }],
    ['missing_container', { container: false }],
    ['unresolvable_package', { package: false }],
    ['empty_spine', { packageOptions: { itemrefs: [] } }],
    [
      'malformed_xml',
      { container: '<?xml version="1.0"?><container><rootfiles/></container><extra/>' },
    ],
  ];

  it.each(NON_AVAILABLE)('agrees with validateEpub on %s', async (_label, options) => {
    const filePath = await place(
      await F.buildEpub(
        navRowsBook(ONE_ROW, {
          ...options,
          packageOptions: { items: [CHAPTER, NAV_ITEM, COVER_ITEM], ...options.packageOptions },
          files: [{ name: COVER_ENTRY, content: PNG }],
        }),
      ),
    );

    const validation = await validateEpub(filePath);
    h.streamed = [];
    const inspection = await inspectEpub(filePath);

    expect(inspection).toEqual(validation);
    expect(inspection.status).not.toBe('available');
    expect(optionalStreams()).toEqual([]);
  });

  it('returns truncated, like validateEpub, when a mandatory read fails', async () => {
    const filePath = await place(
      await F.buildEpub(
        navRowsBook(ONE_ROW, {
          packageOptions: { items: [CHAPTER, NAV_ITEM, COVER_ITEM] },
          files: [{ name: COVER_ENTRY, content: PNG }],
        }),
      ),
    );
    failEntry(F.DEFAULT_PACKAGE, errno('Z_DATA_ERROR'));

    // The disposition half of the pair below: the identical `Z_DATA_ERROR` at a
    // *mandatory* site is a verdict about the book.
    expect(await inspectEpub(filePath)).toEqual({ status: 'invalid', code: 'truncated' });
    expect(optionalStreams()).toEqual([]);
  });

  it('returns limit_exceeded, like validateEpub, when a mandatory read is oversize', async () => {
    const filePath = await place(
      await F.buildEpub(
        navRowsBook(ONE_ROW, {
          packageOptions: { padTo: MAX_XML_BYTES + 1 },
        }),
      ),
    );

    expect(await inspectEpub(filePath)).toEqual(await validateEpub(filePath));
    expect(await inspectEpub(filePath)).toEqual({ status: 'invalid', code: 'limit_exceeded' });
  });

  it('returns drm_protected without attempting an optional read', async () => {
    const result = await inspectBuilt(
      navRowsBook(ONE_ROW, {
        packageOptions: { items: [CHAPTER, NAV_ITEM, COVER_ITEM] },
        files: [{ name: COVER_ENTRY, content: PNG }],
        encryption:
          `<?xml version="1.0"?><encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container">` +
          `<EncryptedData><CipherData><CipherReference URI="OEBPS/ch1.xhtml"/></CipherData></EncryptedData></encryption>`,
      }),
    );

    expect(result).toEqual({ status: 'drm_protected' });
    expect(optionalStreams()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

describe('an optional read never demotes the status', () => {
  it('returns available with cover null when the cover entry fails mid-inflate', async () => {
    const filePath = await place(await F.buildEpub(coverBook(PNG)));
    failEntry(COVER_ENTRY, errno('Z_DATA_ERROR'));

    // The classification is identical to the mandatory site above — 1.1a's
    // predicate ignores the call site — and only the *disposition* differs. A
    // readable book with one damaged decorative resource is readable.
    const result = available(await inspectEpub(filePath));
    expect(result.cover).toBeNull();
    expect(result.metadata).toEqual({ title: 'Fixture', author: null, language: null });
  });

  it('returns available with toc null when the nav document is malformed', async () => {
    const result = available(
      await inspectBuilt(navBook('<?xml version="1.0"?><div><p>not a nav document</p></div>')),
    );

    expect(result.toc).toBeNull();
  });

  it('returns available with cover null when the cover exceeds its byte cap', async () => {
    const oversize = Buffer.concat([PNG, Buffer.alloc(MAX_EPUB_COVER_BYTES)]);
    const result = available(await inspectBuilt(coverBook(oversize)));

    // A cap breach is never a truncated image: no partial bytes are returned.
    expect(result.cover).toBeNull();
  });

  it('returns a cover sitting exactly on its byte cap, in full', async () => {
    const exact = Buffer.concat([PNG, Buffer.alloc(MAX_EPUB_COVER_BYTES - PNG.length)]);
    const result = available(await inspectBuilt(coverBook(exact)));

    expect(result.cover?.mediaType).toBe('image/png');
    expect(result.cover?.bytes.length).toBe(MAX_EPUB_COVER_BYTES);
  });

  it('propagates a filesystem error raised during the cover read', async () => {
    const filePath = await place(await F.buildEpub(coverBook(PNG)));
    failEntry(COVER_ENTRY, errno('EIO'));

    // An optional read must never convert I/O indeterminacy into a confident
    // `null`: a `throw` classification ignores the call site.
    await expect(inspectEpub(filePath)).rejects.toThrow('simulated EIO');
  });

  it('propagates a filesystem error raised during the TOC read', async () => {
    const filePath = await place(await F.buildEpub(navRowsBook(ONE_ROW)));
    failEntry(NAV_ENTRY, errno('EACCES'));

    await expect(inspectEpub(filePath)).rejects.toThrow('simulated EACCES');
  });
});

// ---------------------------------------------------------------------------

describe('the shared budget: order, pre-reject, and streamed exhaustion', () => {
  /**
   * The mandatory reads are the only way to consume the inspection budget, and
   * each is ceilinged at `MAX_XML_BYTES`. Four of them exist and
   * `4 * MAX_XML_BYTES === MAX_INSPECTION_BYTES`, so padding `mimetype`,
   * `container.xml`, and the package document to the ceiling and `encryption.xml`
   * to `MAX_XML_BYTES - remainder` leaves exactly `remainder` bytes for the
   * optional reads.
   */
  const EMPTY_ENCRYPTION =
    '<?xml version="1.0"?><encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container"></encryption>';

  function withRemainder(remainder: number, options: F.EpubOptions): F.EpubOptions {
    return {
      ...options,
      mimetype: F.padTo(F.EPUB_MEDIA_TYPE, MAX_XML_BYTES),
      container: F.padTo(F.containerXml(F.DEFAULT_PACKAGE), MAX_XML_BYTES),
      packageOptions: { ...options.packageOptions, padTo: MAX_XML_BYTES },
      encryption: F.padTo(EMPTY_ENCRYPTION, MAX_XML_BYTES - remainder),
    };
  }

  it('reads the TOC first when the nav and the cover jointly exceed the remainder', async () => {
    const navDocument = F.padTo(F.navDocumentXml(F.navXml(ONE_ROW)), 3000);
    const result = available(
      await inspectBuilt(
        withRemainder(4000, {
          packageOptions: { items: [CHAPTER, NAV_ITEM, COVER_ITEM] },
          files: [
            { name: NAV_ENTRY, content: navDocument },
            // Individually within `MAX_EPUB_COVER_BYTES`, but 2000 > the 1000
            // bytes the nav leaves behind.
            { name: COVER_ENTRY, content: Buffer.concat([PNG, Buffer.alloc(1990)]) },
          ],
        }),
      ),
    );

    // TOC present, cover dropped — which is only reachable if the TOC was read
    // first. The reverse order would produce the mirror result for the same file.
    expect(result.toc).toEqual(ONE_ENTRY);
    expect(result.cover).toBeNull();
    expect(optionalStreams()).toEqual([NAV_ENTRY]);
  });

  it('pre-rejects an optional read whose declared size exceeds the remainder', async () => {
    const result = available(
      await inspectBuilt(
        withRemainder(3000, {
          packageOptions: { items: [CHAPTER, NAV_ITEM, COVER_ITEM] },
          files: [
            { name: NAV_ENTRY, content: F.padTo(F.navDocumentXml(F.navXml(ONE_ROW)), 5000) },
            { name: COVER_ENTRY, content: PNG },
          ],
        }),
      ),
    );

    expect(result.toc).toBeNull();
    expect(result.cover).toEqual({ mediaType: 'image/png', bytes: PNG });
    // Nothing was charged for the nav, because no stream was ever opened for it —
    // `readEntry` calls `file.stream()` unconditionally, so the pre-reject has to
    // happen before `entry.read`, not inside it.
    expect(optionalStreams()).toEqual([COVER_ENTRY]);
  });

  it('keeps a failed read charged when the actual inflate crosses the remainder', async () => {
    const remainder = 4096;
    const navDocument = F.padTo(F.navDocumentXml(F.navXml(ONE_ROW)), 20000);
    // STORE, so the inflated size is exactly the content length and the whole
    // member arrives in one chunk.
    const bytes = await F.buildArchive({
      store: true,
      entries: F.epubEntries(
        withRemainder(remainder, {
          packageOptions: { items: [CHAPTER, NAV_ITEM, COVER_ITEM] },
          files: [
            { name: NAV_ENTRY, content: navDocument },
            { name: COVER_ENTRY, content: PNG },
          ],
        }),
      ),
    });
    const navIndex = F.listCentralDirectory(bytes).findIndex(
      (entry) => entry.rawName.toString('utf8') === NAV_ENTRY,
    );
    const central = F.listCentralDirectory(bytes)[navIndex]!;
    const local = F.localFileHeader(bytes, navIndex);
    // Understate the declared size so the pre-reject passes and the streamed
    // counter is the only thing that fires. The declared size is used *only* to
    // pre-reject; it is never trusted as the real size.
    const filePath = await place(
      F.patchArchive(bytes, [
        { offset: central.headerOffset + 24, size: 4, value: 100, why: 'central uncompressedSize lie' },
        { offset: local.headerOffset + 22, size: 4, value: 100, why: 'local uncompressedSize lie' },
      ]),
    );

    const result = available(await inspectEpub(filePath));

    expect(result.toc).toBeNull();
    expect(result.cover).toBeNull();
    // The load-bearing assertion. `consumed` lands at
    // `MAX_INSPECTION_BYTES - 4096 + 20000` — past the ceiling by 15,904 bytes,
    // strictly less than the single 20,000-byte chunk that crossed it, and it
    // happens once because nothing is streamed afterwards. A rollback
    // implementation would forgive the nav's bytes, leave 4,096 available, open
    // the cover stream, and return a cover: both assertions here would break.
    expect(optionalStreams()).toEqual([NAV_ENTRY]);
    expect(Buffer.byteLength(navDocument)).toBe(20000);
    expect(20000 - remainder).toBeLessThan(Buffer.byteLength(navDocument));
  });

  /**
   * The partial-decoder-failure pair. Both rows use the **same** fixture and the
   * same `Z_DATA_ERROR` classification, and differ only in how many bytes the nav
   * stream inflated before failing. That difference alone has to change the
   * cover's outcome, which is what makes charge-as-you-go observable: an
   * implementation that forgives a failed read's bytes collapses the two rows
   * into one result and fails the first.
   */
  const PARTIAL_REMAINDER = 4096;
  /** 3,000 bytes — fits the untouched remainder, but not what a 4,000-byte charge leaves. */
  const MID_COVER = Buffer.concat([PNG, Buffer.alloc(3000 - PNG.length)]);

  function partialFixture(): F.EpubOptions {
    return withRemainder(PARTIAL_REMAINDER, {
      packageOptions: { items: [CHAPTER, NAV_ITEM, COVER_ITEM] },
      files: [
        { name: NAV_ENTRY, content: F.navDocumentXml(F.navXml(ONE_ROW)) },
        { name: COVER_ENTRY, content: MID_COVER },
      ],
    });
  }

  it('charges the bytes a decoder failure had already inflated, skipping the cover', async () => {
    const filePath = await place(await F.buildEpub(partialFixture()));
    failEntryAfterInflating(NAV_ENTRY, Buffer.alloc(4000), errno('Z_DATA_ERROR'));

    const result = available(await inspectEpub(filePath));

    // 4,000 of the 4,096-byte remainder are gone, so the 3,000-byte cover no
    // longer fits and is pre-rejected without a stream. Nothing is rolled back
    // just because the read that inflated the bytes did not finish.
    expect(result.toc).toBeNull();
    expect(result.cover).toBeNull();
    expect(optionalStreams()).toEqual([NAV_ENTRY]);
  });

  it('charges nothing for a decoder failure that inflated nothing, so the cover still fits', async () => {
    const filePath = await place(await F.buildEpub(partialFixture()));
    failEntry(NAV_ENTRY, errno('Z_DATA_ERROR'));

    const result = available(await inspectEpub(filePath));

    // Same fixture, same failure label, zero bytes inflated — so the remainder is
    // untouched and the cover succeeds. This is the row that gives the one above
    // its meaning: the charge, not the failure, is what closed the budget.
    expect(result.toc).toBeNull();
    expect(result.cover).toEqual({ mediaType: 'image/png', bytes: MID_COVER });
    expect(optionalStreams()).toEqual([NAV_ENTRY, COVER_ENTRY]);
  });

  it('gives each call its own budget, so an exhausted inspection cannot poison the next', async () => {
    const filePath = await place(
      await F.buildEpub(
        withRemainder(40000, {
          packageOptions: { items: [CHAPTER, NAV_ITEM, COVER_ITEM] },
          files: [
            { name: NAV_ENTRY, content: F.padTo(F.navDocumentXml(F.navXml(ONE_ROW)), 20000) },
            { name: COVER_ENTRY, content: Buffer.concat([PNG, Buffer.alloc(15000)]) },
          ],
        }),
      ),
    );

    const first = available(await inspectEpub(filePath));
    const second = available(await inspectEpub(filePath));

    // A budget shared across calls would leave the second inspection nothing:
    // the first alone consumes all but ~5 KiB of `MAX_INSPECTION_BYTES`.
    expect(second).toEqual(first);
    expect(second.toc).toEqual(ONE_ENTRY);
    expect(second.cover?.mediaType).toBe('image/png');
    // Two calls, two opens, two closes — and two budgets.
    expect(h.fsOpen).toHaveBeenCalledTimes(2);
    expect(h.handles.map((handle) => handle.closes)).toEqual([1, 1]);
  });

  it('pre-rejects a cover the archive understates, where validateEpub is unaffected', async () => {
    const cover = Buffer.concat([PNG, Buffer.alloc(20000)]);
    const bytes = await F.buildArchive({
      store: true,
      entries: F.epubEntries(coverBook(cover)),
    });
    const index = F.listCentralDirectory(bytes).findIndex(
      (entry) => entry.rawName.toString('utf8') === COVER_ENTRY,
    );
    const central = F.listCentralDirectory(bytes)[index]!;
    const local = F.localFileHeader(bytes, index);
    const filePath = await place(
      F.patchArchive(bytes, [
        { offset: central.headerOffset + 24, size: 4, value: 10, why: 'central uncompressedSize lie' },
        { offset: local.headerOffset + 22, size: 4, value: 10, why: 'local uncompressedSize lie' },
      ]),
    );

    // The lie is harmless here — plenty of budget remains, so the entry is read
    // and its real bytes are what the sniffer sees.
    const result = available(await inspectEpub(filePath));
    expect(result.cover?.bytes.length).toBe(cover.length);
    // And `validateEpub` on the same file never opens that entry at all.
    h.streamed = [];
    expect(await validateEpub(filePath)).toEqual({ status: 'available' });
    expect(optionalStreams()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

describe('metadata', () => {
  async function metadataOf(options: F.MetadataOptions): Promise<unknown> {
    return available(await inspectBuilt({ packageOptions: { metadata: options } })).metadata;
  }

  it('reads title, author, and language from an EPUB 3 package document', async () => {
    expect(await metadataOf({ title: 'Frankenstein', creators: ['Mary Shelley'], language: 'en' })).toEqual(
      { title: 'Frankenstein', author: 'Mary Shelley', language: 'en' },
    );
  });

  it('reads the same three fields from an EPUB 2 package document', async () => {
    const result = await inspectBuilt(
      ncxRowsBook(ONE_ROW, {
        packageOptions: {
          items: [CHAPTER, NCX_ITEM],
          spine: '<spine toc="ncx"><itemref idref="ch1"/></spine>',
          metadata: { title: 'Dracula', creators: ['Bram Stoker'], language: 'en-IE' },
        },
      }),
    );

    expect(available(result).metadata).toEqual({
      title: 'Dracula',
      author: 'Bram Stoker',
      language: 'en-IE',
    });
  });

  it('normalises a whitespace-only title to null', async () => {
    expect(await metadataOf({ title: '   \n  ' })).toEqual({
      title: null,
      author: null,
      language: null,
    });
  });

  it('reads a prefixed spelling such as dcterms:title by local name', async () => {
    expect(await metadataOf({ raw: '<dcterms:title>Prefixed</dcterms:title>' })).toEqual({
      title: 'Prefixed',
      author: null,
      language: null,
    });
  });

  it('does not read a title from a subtree that is not a direct child of metadata', async () => {
    expect(await metadataOf({ raw: '<opf:meta><dc:title>Buried</dc:title></opf:meta>' })).toEqual({
      title: null,
      author: null,
      language: null,
    });
  });

  it('takes the first creator and joins nothing when several are declared', async () => {
    expect(await metadataOf({ creators: ['First Author', 'Second Author'] })).toMatchObject({
      author: 'First Author',
    });
  });

  it('takes the first non-empty candidate, not the first candidate then normalised', async () => {
    // `<dc:title></dc:title><dc:title>Real</dc:title>` is `"Real"`, not `null`.
    expect(
      await metadataOf({ raw: '<dc:title></dc:title><dc:title>Real</dc:title>' }),
    ).toMatchObject({ title: 'Real' });
  });

  it('scans only the first metadata element when the package declares two', async () => {
    const result = await inspectBuilt({
      packageOptions: {
        metadataSection:
          F.metadataXml({ title: 'First' }) + F.metadataXml({ title: 'Second', language: 'fr' }),
      },
    });

    expect(available(result).metadata).toEqual({ title: 'First', author: null, language: null });
  });

  it('is null in every field when the package declares no metadata element at all', async () => {
    const result = await inspectBuilt({ packageOptions: { metadataSection: '' } });

    expect(available(result).metadata).toEqual({ title: null, author: null, language: null });
  });

  it('costs no budget, so it survives a package document that exhausts it', async () => {
    // Every optional read is pre-rejected here, yet metadata is still present:
    // it comes from the document the pipeline already parsed.
    const result = await inspectBuilt({
      mimetype: F.padTo(F.EPUB_MEDIA_TYPE, MAX_XML_BYTES),
      container: F.padTo(F.containerXml(F.DEFAULT_PACKAGE), MAX_XML_BYTES),
      packageOptions: {
        items: [CHAPTER, COVER_ITEM],
        metadata: { title: 'Still Here' },
        padTo: MAX_XML_BYTES,
      },
      encryption: F.padTo(
        '<?xml version="1.0"?><encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container"></encryption>',
        MAX_XML_BYTES,
      ),
      files: [{ name: COVER_ENTRY, content: PNG }],
    });

    expect(available(result).metadata).toMatchObject({ title: 'Still Here' });
    expect(available(result).cover).toBeNull();
    expect(optionalStreams()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

describe('TOC discovery by reference, never by filename', () => {
  it('finds an EPUB 3 nav document at a name that is not nav.xhtml', async () => {
    const result = await inspectBuilt({
      packageOptions: {
        items: [
          CHAPTER,
          { ...NAV_ITEM, href: 'Navigation/main.xhtml' },
        ],
      },
      files: [
        { name: 'OEBPS/Navigation/main.xhtml', content: F.navDocumentXml(F.navXml(ONE_ROW)) },
      ],
    });

    expect(available(result).toc).toEqual(ONE_ENTRY);
  });

  it('finds an EPUB 2 NCX at a name that is not toc.ncx', async () => {
    const result = await inspectBuilt({
      packageOptions: {
        items: [CHAPTER, { ...NCX_ITEM, href: 'Data/navigation.xml' }],
        spine: '<spine toc="ncx"><itemref idref="ch1"/></spine>',
      },
      files: [
        {
          name: 'OEBPS/Data/navigation.xml',
          content: F.ncxDocumentXml(F.navMapXml(ONE_ROW)),
        },
      ],
    });

    expect(available(result).toc).toEqual(ONE_ENTRY);
  });

  it('matches the nav token inside a multi-token properties attribute', async () => {
    const result = await inspectBuilt(
      navRowsBook(ONE_ROW, {
        packageOptions: { items: [CHAPTER, { ...NAV_ITEM, properties: 'nav scripted' }] },
      }),
    );

    expect(available(result).toc).toEqual(ONE_ENTRY);
  });

  /**
   * XML 1.0 §2.3 whitespace is space, tab, CR, and LF, and a conforming author
   * may separate tokens with any of them. `hasToken` splits on all four (plus
   * form feed); a `.split(' ')` narrowing would pass every other fixture in this
   * suite, because they all happen to use spaces.
   *
   * Verified as observable rather than assumed: htmlparser2 performs no XML
   * attribute-value normalisation, so the raw separator survives into `attribs`
   * and reaches the predicate. (A conforming XML processor would fold these to
   * spaces before the application ever saw them, which would make this untestable
   * through the public path.)
   */
  const SEPARATORS: Array<[label: string, separator: string]> = [
    ['a tab', '\t'],
    ['a line feed', '\n'],
    ['a carriage return', '\r'],
    ['a form feed', '\f'],
  ];

  it.each(SEPARATORS)(
    'matches every token-set attribute across %s separator',
    async (_label, separator) => {
      // One fixture, all three token sites: `properties~=nav` picks the nav item,
      // `epub:type~=toc` picks the nav element inside it, and
      // `properties~=cover-image` picks the cover.
      const result = await inspectBuilt(
        navBook(
          F.navDocumentXml(
            `<nav epub:type="toc${separator}landmarks">${F.navListXml(ONE_ROW)}</nav>`,
          ),
          {
            packageOptions: {
              items: [
                CHAPTER,
                { ...NAV_ITEM, properties: `nav${separator}scripted` },
                { ...COVER_ITEM, properties: `cover-image${separator}scripted` },
              ],
            },
            files: [{ name: COVER_ENTRY, content: PNG }],
          },
        ),
      );

      expect(available(result).toc).toEqual(ONE_ENTRY);
      expect(available(result).cover).toEqual({ mediaType: 'image/png', bytes: PNG });
    },
  );

  it('does not match properties="navigation", pinning token equality over substring', async () => {
    const result = await inspectBuilt(
      navRowsBook(ONE_ROW, {
        packageOptions: { items: [CHAPTER, { ...NAV_ITEM, properties: 'navigation' }] },
      }),
    );

    expect(available(result).toc).toBeNull();
    expect(optionalStreams()).toEqual([]);
  });

  it('prefers the EPUB 3 nav when both a nav item and an NCX are present', async () => {
    const result = await inspectBuilt({
      packageOptions: {
        items: [CHAPTER, NAV_ITEM, NCX_ITEM],
        spine: '<spine toc="ncx"><itemref idref="ch1"/></spine>',
      },
      files: [
        { name: NAV_ENTRY, content: F.navDocumentXml(F.navXml([{ label: 'From nav' }])) },
        { name: NCX_ENTRY, content: F.ncxDocumentXml(F.navMapXml([{ label: 'From ncx' }])) },
      ],
    });

    expect(available(result).toc).toEqual([{ title: 'From nav', depth: 0 }]);
    expect(optionalStreams()).toEqual([NAV_ENTRY]);
  });

  it('does not fall back to a valid NCX when the declared nav entry is absent', async () => {
    const result = await inspectBuilt({
      packageOptions: {
        items: [CHAPTER, NAV_ITEM, NCX_ITEM],
        spine: '<spine toc="ncx"><itemref idref="ch1"/></spine>',
      },
      // The nav entry is deliberately not written.
      files: [{ name: NCX_ENTRY, content: F.ncxDocumentXml(F.navMapXml(ONE_ROW)) }],
    });

    // "Preferred" is a selection rule, not a retry rule. Falling back would also
    // make the NCX read's pre-reject depend on how many bytes the failed nav read
    // had charged, coupling two independent resources through the shared budget.
    expect(available(result).toc).toBeNull();
    expect(optionalStreams()).toEqual([]);
  });

  it('yields null without throwing when spine@toc names a missing id', async () => {
    const result = await inspectBuilt(
      ncxRowsBook(ONE_ROW, {
        packageOptions: {
          items: [CHAPTER, NCX_ITEM],
          spine: '<spine toc="nowhere"><itemref idref="ch1"/></spine>',
        },
      }),
    );

    expect(available(result).toc).toBeNull();
  });
});

// ---------------------------------------------------------------------------

describe('locating the toc nav is a descendant search', () => {
  it('finds a nav sitting directly under body', async () => {
    const result = await inspectBuilt(navRowsBook(ONE_ROW));

    // `childrenByLocalName($, htmlRoot, 'nav')` returns nothing for this shape,
    // which is the realistic one — every other EPUB 3 fixture in this suite nests
    // its nav under `<body>` for the same reason.
    expect(available(result).toc).toEqual(ONE_ENTRY);
  });

  it('finds a nav wrapped in intervening flow content', async () => {
    const result = await inspectBuilt(
      navBook(F.navDocumentXml(`<section><div>${F.navXml(ONE_ROW)}</div></section>`)),
    );

    expect(available(result).toc).toEqual(ONE_ENTRY);
  });

  it('selects the toc nav rather than merely the first nav in the document', async () => {
    const result = await inspectBuilt(
      navBook(
        F.navDocumentXml(
          F.navXml([{ label: 'Cover' }], 'landmarks') + F.navXml([{ label: 'Real' }], 'toc'),
        ),
      ),
    );

    expect(available(result).toc).toEqual([{ title: 'Real', depth: 0 }]);
  });

  it('selects the earlier of two toc navs', async () => {
    const result = await inspectBuilt(
      navBook(
        F.navDocumentXml(F.navXml([{ label: 'Earlier' }]) + F.navXml([{ label: 'Later' }])),
      ),
    );

    expect(available(result).toc).toEqual([{ title: 'Earlier', depth: 0 }]);
  });

  it('finds a toc nav whose type attribute is bound under a different prefix', async () => {
    // The EPUB spec defines this attribute *with* a prefix, and a prefix is an
    // alias the author binds — `ops:` is as valid as `epub:`. That is why
    // `findTocNav` uses `attrByLocalName` and not `attrByExactName`, and this is
    // the row that says so: every other nav fixture spells it `epub:type`, so
    // narrowing the lookup to the exact name leaves them all green.
    const result = await inspectBuilt(
      navBook(
        '<?xml version="1.0" encoding="UTF-8"?>' +
          '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:ops="http://www.idpf.org/2007/ops">' +
          `<head><title>nav</title></head><body><nav ops:type="toc">${F.navListXml(ONE_ROW)}</nav></body></html>`,
      ),
    );

    expect(available(result).toc).toEqual(ONE_ENTRY);
  });

  it('walks past deep wrapper nesting that would overflow a recursive selector', async () => {
    // Well under `MAX_XML_BYTES` (~275 KiB) but far past the ~11k frames Node's
    // default stack allows. The traversal's visit cap does not protect this walk:
    // the nav has not been selected yet, so nothing bounds its depth but the
    // document. A recursive descendant search throws `RangeError` here.
    const depth = 25000;
    const wrapped = '<div>'.repeat(depth) + F.navXml(ONE_ROW) + '</div>'.repeat(depth);
    const result = await inspectBuilt(navBook(F.navDocumentXml(wrapped)));

    expect(available(result).toc).toEqual(ONE_ENTRY);
  });
});

// ---------------------------------------------------------------------------

describe('the EPUB 3 TOC traversal', () => {
  async function tocOf(nodes: readonly F.TocNode[]): Promise<unknown> {
    return available(await inspectBuilt(navRowsBook(nodes))).toc;
  }

  it('flattens three nesting levels into depth 0, 1, 2 in document order', async () => {
    expect(
      await tocOf([
        { label: 'A', children: [{ label: 'A1', children: [{ label: 'A1a' }] }] },
        { label: 'B' },
      ]),
    ).toEqual([
      { title: 'A', depth: 0 },
      { title: 'A1', depth: 1 },
      { title: 'A1a', depth: 2 },
      { title: 'B', depth: 0 },
    ]);
  });

  it('does not let a parent row swallow its descendants’ titles', async () => {
    // In EPUB 3 the nested `<ol>` is a *sibling* of the `<a>`, not a descendant,
    // so taking the label from a direct child of the `li` gives this row's title
    // alone. Reading the `li`'s own text would produce "Part OneChapter 1Chapter 2".
    expect(
      await tocOf([{ label: 'Part One', children: [{ label: 'Chapter 1' }, { label: 'Chapter 2' }] }]),
    ).toEqual([
      { title: 'Part One', depth: 0 },
      { title: 'Chapter 1', depth: 1 },
      { title: 'Chapter 2', depth: 1 },
    ]);
  });

  it('reads a span label when the row has no anchor', async () => {
    expect(await tocOf([{ label: 'Unlinked', span: true }])).toEqual([
      { title: 'Unlinked', depth: 0 },
    ]);
  });

  it('drops label-less and whitespace-only rows while still traversing their children', async () => {
    expect(
      await tocOf([{ children: [{ label: 'Kept' }] }, { label: '  \n ', children: [{ label: 'Also' }] }]),
    ).toEqual([
      // Depth is structural, so the survivors keep depth 1 rather than shifting up.
      { title: 'Kept', depth: 1 },
      { title: 'Also', depth: 1 },
    ]);
  });

  it('collapses newlines and runs of spaces in a label', async () => {
    expect(await tocOf([{ label: '  A\n   long\t\ttitle  ' }])).toEqual([
      { title: 'A long title', depth: 0 },
    ]);
  });

  it('returns null rather than an empty array when the nav has no direct ol', async () => {
    const result = await inspectBuilt(
      navBook(F.navDocumentXml('<nav epub:type="toc"><p>nothing here</p></nav>')),
    );

    expect(available(result).toc).toBeNull();
  });

  it('returns null rather than an empty array when every row is dropped', async () => {
    expect(await tocOf([{}, {}])).toBeNull();
  });

  it('returns MAX_TOC_ENTRIES rows in full', async () => {
    const nodes = Array.from({ length: MAX_TOC_ENTRIES }, (_unused, index) => ({
      label: `Row ${index}`,
    }));

    expect(await tocOf(nodes)).toHaveLength(MAX_TOC_ENTRIES);
  });

  it('caps at MAX_TOC_ENTRIES without erroring when one more row is declared', async () => {
    const nodes = Array.from({ length: MAX_TOC_ENTRIES + 1 }, (_unused, index) => ({
      label: `Row ${index}`,
    }));
    const toc = await tocOf(nodes);

    expect(toc).toHaveLength(MAX_TOC_ENTRIES);
    expect(toc).toContainEqual({ title: `Row ${MAX_TOC_ENTRIES - 1}`, depth: 0 });
  });

  it('terminates on the visit cap for a label-less chain nested far past it', async () => {
    // Nothing above the bottom row is *emitted*, so a cap counting only emitted
    // rows would run all the way down. The visit cap bounds the work itself, and
    // the chain is deep enough that a recursive traversal would overflow.
    // (Written by repetition rather than through the builder, which is itself
    // recursive and would overflow while *constructing* the fixture.)
    const depth = 5000;
    const chain =
      '<ol><li>'.repeat(depth) + '<a href="c.xhtml">Bottom</a>' + '</li></ol>'.repeat(depth);
    const result = await inspectBuilt(
      navBook(F.navDocumentXml(`<nav epub:type="toc">${chain}</nav>`)),
    );

    expect(available(result).toc).toBeNull();
  });
});

// ---------------------------------------------------------------------------

describe('the EPUB 2 (NCX) TOC traversal mirrors the same contract', () => {
  async function tocOf(nodes: readonly F.TocNode[]): Promise<unknown> {
    return available(await inspectBuilt(ncxRowsBook(nodes))).toc;
  }

  it('flattens three nesting levels into depth 0, 1, 2 in document order', async () => {
    expect(
      await tocOf([
        { label: 'A', children: [{ label: 'A1', children: [{ label: 'A1a' }] }] },
        { label: 'B' },
      ]),
    ).toEqual([
      { title: 'A', depth: 0 },
      { title: 'A1', depth: 1 },
      { title: 'A1a', depth: 2 },
      { title: 'B', depth: 0 },
    ]);
  });

  it('does not let a parent navPoint swallow its descendants’ titles', async () => {
    expect(await tocOf([{ label: 'Part One', children: [{ label: 'Chapter 1' }] }])).toEqual([
      { title: 'Part One', depth: 0 },
      { title: 'Chapter 1', depth: 1 },
    ]);
  });

  it('drops label-less and whitespace-only rows while still traversing their children', async () => {
    expect(
      await tocOf([{ children: [{ label: 'Kept' }] }, { label: ' \n ', children: [{ label: 'Also' }] }]),
    ).toEqual([
      { title: 'Kept', depth: 1 },
      { title: 'Also', depth: 1 },
    ]);
  });

  it('drops a navPoint whose navLabel carries no text element', async () => {
    const result = await inspectBuilt(
      ncxBook(
        F.ncxDocumentXml(
          '<navMap><navPoint id="a"><navLabel/><content src="c.xhtml"/></navPoint>' +
            '<navPoint id="b"><navLabel><text>Kept</text></navLabel><content src="c.xhtml"/></navPoint></navMap>',
        ),
      ),
    );

    expect(available(result).toc).toEqual([{ title: 'Kept', depth: 0 }]);
  });

  it('collapses newlines and runs of spaces in a label', async () => {
    expect(await tocOf([{ label: '  A\n   long\t\ttitle  ' }])).toEqual([
      { title: 'A long title', depth: 0 },
    ]);
  });

  it('ignores playOrder in favour of document order', async () => {
    expect(
      await tocOf([
        { label: 'Written first', playOrder: 9 },
        { label: 'Written second', playOrder: 1 },
      ]),
    ).toEqual([
      { title: 'Written first', depth: 0 },
      { title: 'Written second', depth: 0 },
    ]);
  });

  it('returns null rather than an empty array when the ncx has no navMap', async () => {
    const result = await inspectBuilt(ncxBook(F.ncxDocumentXml('')));

    expect(available(result).toc).toBeNull();
  });

  it('returns null rather than an empty array when every row is dropped', async () => {
    expect(await tocOf([{}, {}])).toBeNull();
  });

  it('caps at MAX_TOC_ENTRIES without erroring', async () => {
    const nodes = Array.from({ length: MAX_TOC_ENTRIES + 1 }, (_unused, index) => ({
      label: `Row ${index}`,
    }));

    expect(await tocOf(nodes)).toHaveLength(MAX_TOC_ENTRIES);
  });

  it('terminates on the visit cap for a label-less chain nested far past it', async () => {
    const depth = 5000;
    const chain =
      '<navPoint id="p">'.repeat(depth) +
      '<navLabel><text>Bottom</text></navLabel>' +
      '</navPoint>'.repeat(depth);
    const result = await inspectBuilt(ncxBook(F.ncxDocumentXml(`<navMap>${chain}</navMap>`)));

    expect(available(result).toc).toBeNull();
  });
});

// ---------------------------------------------------------------------------

describe('TOC multiplicity: first in document order everywhere', () => {
  it('uses the first manifest item carrying properties="nav"', async () => {
    const result = await inspectBuilt({
      packageOptions: {
        items: [
          CHAPTER,
          { ...NAV_ITEM, id: 'nav1', href: 'first.xhtml' },
          { ...NAV_ITEM, id: 'nav2', href: 'second.xhtml' },
        ],
      },
      files: [
        { name: 'OEBPS/first.xhtml', content: F.navDocumentXml(F.navXml([{ label: 'First' }])) },
        { name: 'OEBPS/second.xhtml', content: F.navDocumentXml(F.navXml([{ label: 'Second' }])) },
      ],
    });

    expect(available(result).toc).toEqual([{ title: 'First', depth: 0 }]);
    expect(optionalStreams()).toEqual(['OEBPS/first.xhtml']);
  });

  it('uses the first spine element when the package declares two', async () => {
    const result = await inspectBuilt(
      ncxRowsBook(ONE_ROW, {
        packageOptions: {
          items: [CHAPTER, NCX_ITEM],
          spine:
            '<spine toc="ncx"><itemref idref="ch1"/></spine>' +
            '<spine toc="nowhere"><itemref idref="ch1"/></spine>',
        },
      }),
    );

    expect(available(result).toc).toEqual(ONE_ENTRY);
  });

  it('yields null when spine@toc names an id two manifest items declare', async () => {
    const result = await inspectBuilt(
      ncxRowsBook(ONE_ROW, {
        packageOptions: {
          items: [CHAPTER, NCX_ITEM, { ...NCX_ITEM, href: 'other.ncx' }],
          spine: '<spine toc="ncx"><itemref idref="ch1"/></spine>',
        },
      }),
    );

    // `itemsById` maps a duplicated id to `null`, so "matches exactly one
    // manifest item" is decidable rather than silently first-match.
    expect(available(result).toc).toBeNull();
    expect(optionalStreams()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

describe('malformed means exactly the parser’s rejected arm', () => {
  const REJECTED: Array<[label: string, document: string | Buffer]> = [
    ['a root that is not html', '<?xml version="1.0"?><div><p>x</p></div>'],
    ['two root elements', '<?xml version="1.0"?><html><body/></html><html><body/></html>'],
    [
      'bytes that fail fatal decoding',
      // `<html>` then two lone continuation bytes, which are not legal UTF-8
      // anywhere, then `</html>`. The fatal decoder rejects before parsing.
      Buffer.concat([
        Buffer.from('<html>', 'ascii'),
        Buffer.from([0x80, 0x81]),
        Buffer.from('</html>', 'ascii'),
      ]),
    ],
  ];

  it.each(REJECTED)('yields toc null for a nav document with %s', async (_label, document) => {
    const result = await inspectBuilt(navBook(document));

    expect(available(result).toc).toBeNull();
  });

  it('yields toc null for a nav document over MAX_XML_BYTES', async () => {
    const result = await inspectBuilt(
      navBook(F.padTo(F.navDocumentXml(F.navXml(ONE_ROW)), MAX_XML_BYTES + 1)),
    );

    expect(available(result).toc).toBeNull();
  });

  it('still yields rows for markup cheerio repairs', async () => {
    // Unclosed and mismatched tags. `cheerio.load(..., { xmlMode: true })` repairs
    // rather than throwing, and the contract is narrowed to what the chosen
    // mechanism can actually decide — so this parses to a usable `html` root and
    // returns its rows. No second well-formedness check exists to make it fail.
    const result = await inspectBuilt(
      navBook(
        '<?xml version="1.0"?><html><body><nav epub:type="toc"><ol>' +
          '<li><a href="c.xhtml">Repaired</span></li>' +
          '<li><a href="c.xhtml">Also' +
          '</ol></nav></body></html>',
      ),
    );

    expect(available(result).toc).toEqual([
      { title: 'Repaired', depth: 0 },
      { title: 'Also', depth: 0 },
    ]);
  });
});

// ---------------------------------------------------------------------------

describe('the cover', () => {
  const SIGNATURES: Array<[label: string, bytes: Buffer, mediaType: string]> = [
    ['PNG', PNG, 'image/png'],
    ['JPEG', JPEG, 'image/jpeg'],
    ['GIF87a', GIF87A, 'image/gif'],
    ['GIF89a', GIF89A, 'image/gif'],
    ['WebP', WEBP, 'image/webp'],
  ];

  it.each(SIGNATURES)('sniffs %s magic bytes', async (_label, bytes, mediaType) => {
    const result = available(await inspectBuilt(coverBook(bytes)));

    expect(result.cover).toEqual({ mediaType, bytes });
  });

  it('rejects SVG even when the manifest declares image/png', async () => {
    const result = await inspectBuilt(
      coverBook(SVG, {
        packageOptions: { items: [CHAPTER, { ...COVER_ITEM, mediaType: 'image/png' }] },
      }),
    );

    expect(available(result).cover).toBeNull();
  });

  it('lets the bytes win over a manifest declaring image/svg+xml', async () => {
    const result = await inspectBuilt(
      coverBook(PNG, {
        packageOptions: { items: [CHAPTER, { ...COVER_ITEM, mediaType: 'image/svg+xml' }] },
      }),
    );

    expect(available(result).cover).toEqual({ mediaType: 'image/png', bytes: PNG });
  });

  it('rejects a truncated four-byte PNG prefix, pinning full-signature matching', async () => {
    const result = await inspectBuilt(coverBook(Buffer.from([0x89, 0x50, 0x4e, 0x47])));

    expect(available(result).cover).toBeNull();
  });

  it('rejects a RIFF container that is not WebP, pinning the second WebP check', async () => {
    const riffOnly = Buffer.concat([
      Buffer.from('RIFF', 'ascii'),
      Buffer.from([0x10, 0x00, 0x00, 0x00]),
      Buffer.from('WAVE', 'ascii'),
    ]);
    const result = await inspectBuilt(coverBook(riffOnly));

    expect(available(result).cover).toBeNull();
  });

  it('finds the cover by manifest metadata even when the entry is named not-a-cover.bin', async () => {
    const result = await inspectBuilt({
      packageOptions: { items: [CHAPTER, { ...COVER_ITEM, href: 'not-a-cover.bin' }] },
      files: [{ name: 'OEBPS/not-a-cover.bin', content: PNG }],
    });

    expect(available(result).cover).toEqual({ mediaType: 'image/png', bytes: PNG });
  });

  it('finds a cover declared only through <meta name="cover">', async () => {
    const result = await inspectBuilt({
      packageOptions: {
        items: [CHAPTER, { id: 'cover', href: 'cover.png', mediaType: 'image/png' }],
        metadata: { covers: ['cover'] },
      },
      files: [{ name: COVER_ENTRY, content: PNG }],
    });

    expect(available(result).cover).toEqual({ mediaType: 'image/png', bytes: PNG });
  });

  it('prefers <meta name="cover"> over a properties="cover-image" item', async () => {
    const result = await inspectBuilt({
      packageOptions: {
        items: [
          CHAPTER,
          { id: 'meta-cover', href: 'from-meta.png', mediaType: 'image/png' },
          { ...COVER_ITEM, href: 'from-properties.png' },
        ],
        metadata: { covers: ['meta-cover'] },
      },
      files: [
        { name: 'OEBPS/from-meta.png', content: PNG },
        { name: 'OEBPS/from-properties.png', content: JPEG },
      ],
    });

    expect(available(result).cover).toEqual({ mediaType: 'image/png', bytes: PNG });
    expect(optionalStreams()).toEqual(['OEBPS/from-meta.png']);
  });

  it('yields null without throwing when nothing declares a cover', async () => {
    expect(available(await inspectBuilt()).cover).toBeNull();
  });
});

// ---------------------------------------------------------------------------

describe('cover multiplicity and no fallback between tiers', () => {
  it('uses the first <meta name="cover"> when two are declared', async () => {
    const result = await inspectBuilt({
      packageOptions: {
        items: [
          CHAPTER,
          { id: 'first', href: 'first.png', mediaType: 'image/png' },
          { id: 'second', href: 'second.png', mediaType: 'image/jpeg' },
        ],
        metadata: { covers: ['first', 'second'] },
      },
      files: [
        { name: 'OEBPS/first.png', content: PNG },
        { name: 'OEBPS/second.png', content: JPEG },
      ],
    });

    expect(available(result).cover).toEqual({ mediaType: 'image/png', bytes: PNG });
  });

  it('uses the first properties="cover-image" item when two are declared', async () => {
    const result = await inspectBuilt({
      packageOptions: {
        items: [
          CHAPTER,
          { ...COVER_ITEM, id: 'c1', href: 'first.png' },
          { ...COVER_ITEM, id: 'c2', href: 'second.png' },
        ],
      },
      files: [
        { name: 'OEBPS/first.png', content: PNG },
        { name: 'OEBPS/second.png', content: JPEG },
      ],
    });

    expect(available(result).cover).toEqual({ mediaType: 'image/png', bytes: PNG });
  });

  it('yields null when the meta content names an id two manifest items declare', async () => {
    const result = await inspectBuilt({
      packageOptions: {
        items: [
          CHAPTER,
          { id: 'twin', href: 'first.png', mediaType: 'image/png' },
          { id: 'twin', href: 'second.png', mediaType: 'image/png' },
        ],
        metadata: { covers: ['twin'] },
      },
      files: [
        { name: 'OEBPS/first.png', content: PNG },
        { name: 'OEBPS/second.png', content: PNG },
      ],
    });

    expect(available(result).cover).toBeNull();
    expect(optionalStreams()).toEqual([]);
  });

  const BROKEN_TIER_ONE: Array<[label: string, covers: readonly (string | null)[]]> = [
    ['names no manifest item', ['nowhere']],
    ['carries no content attribute', [null]],
  ];

  it.each(BROKEN_TIER_ONE)(
    'never consults tier 2 when the declared cover %s',
    async (_label, covers) => {
      const result = await inspectBuilt({
        packageOptions: {
          items: [CHAPTER, { ...COVER_ITEM, href: 'fallback.png' }],
          metadata: { covers },
        },
        files: [{ name: 'OEBPS/fallback.png', content: PNG }],
      });

      // A declared-but-broken cover is a defective book, not a book with a second
      // cover. Falling back would also couple the two tiers through the shared
      // budget once bytes had been charged.
      expect(available(result).cover).toBeNull();
      expect(optionalStreams()).toEqual([]);
    },
  );

  it('never consults tier 2 when the declared cover entry is absent from the archive', async () => {
    const result = await inspectBuilt({
      packageOptions: {
        items: [
          CHAPTER,
          { id: 'ghost', href: 'ghost.png', mediaType: 'image/png' },
          { ...COVER_ITEM, href: 'fallback.png' },
        ],
        metadata: { covers: ['ghost'] },
      },
      files: [{ name: 'OEBPS/fallback.png', content: PNG }],
    });

    expect(available(result).cover).toBeNull();
    expect(optionalStreams()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

describe('the optional-resource failure matrix', () => {
  /** Every way a declared TOC can be unusable. All of them dispose to `toc: null`. */
  const TOC_NULL: Array<[label: string, options: F.EpubOptions]> = [
    [
      'the nav item declares no href',
      {
        packageOptions: {
          manifest:
            `<manifest>${F.itemXml(CHAPTER)}` +
            '<item id="nav" media-type="application/xhtml+xml" properties="nav"/></manifest>',
        },
      },
    ],
    [
      'the nav href is remote',
      {
        packageOptions: {
          items: [CHAPTER, { ...NAV_ITEM, href: 'https://example.com/nav.xhtml' }],
        },
      },
    ],
    [
      'the nav href escapes the container root',
      { packageOptions: { items: [CHAPTER, { ...NAV_ITEM, href: '../../nav.xhtml' }] } },
    ],
    ['the nav entry is absent from the archive', { packageOptions: { items: [CHAPTER, NAV_ITEM] } }],
    [
      'the ncx item declares no href',
      {
        packageOptions: {
          manifest:
            `<manifest>${F.itemXml(CHAPTER)}` +
            '<item id="ncx" media-type="application/x-dtbncx+xml"/></manifest>',
          spine: '<spine toc="ncx"><itemref idref="ch1"/></spine>',
        },
      },
    ],
    [
      'the ncx href is remote',
      {
        packageOptions: {
          items: [CHAPTER, { ...NCX_ITEM, href: 'https://example.com/toc.ncx' }],
          spine: '<spine toc="ncx"><itemref idref="ch1"/></spine>',
        },
      },
    ],
    [
      'the ncx href escapes the container root',
      {
        packageOptions: {
          items: [CHAPTER, { ...NCX_ITEM, href: '../../toc.ncx' }],
          spine: '<spine toc="ncx"><itemref idref="ch1"/></spine>',
        },
      },
    ],
    [
      'the ncx entry is absent from the archive',
      {
        packageOptions: {
          items: [CHAPTER, NCX_ITEM],
          spine: '<spine toc="ncx"><itemref idref="ch1"/></spine>',
        },
      },
    ],
    ['neither a nav item nor a spine toc attribute exists', {}],
  ];

  it.each(TOC_NULL)('yields toc null when %s', async (_label, options) => {
    const result = await inspectBuilt(options);

    expect(available(result).toc).toBeNull();
    expect(optionalStreams()).toEqual([]);
  });

  it('yields toc null when the ncx root is not an ncx element', async () => {
    const result = await inspectBuilt(ncxBook('<?xml version="1.0"?><html><body/></html>'));

    expect(available(result).toc).toBeNull();
  });

  // These two cover the *disposition* of a decoder failure — `toc: null` rather
  // than a demoted status — with nothing inflated. The budget consequence of a
  // failure that did inflate bytes is a different property and lives with the
  // rest of the budget accounting, above.
  it('yields toc null when the nav read fails without inflating anything', async () => {
    const filePath = await place(await F.buildEpub(navRowsBook(ONE_ROW)));
    failEntry(NAV_ENTRY, errno('Z_DATA_ERROR'));

    expect(available(await inspectEpub(filePath)).toc).toBeNull();
  });

  it('yields toc null when the ncx read fails without inflating anything', async () => {
    const filePath = await place(await F.buildEpub(ncxRowsBook(ONE_ROW)));
    failEntry(NCX_ENTRY, errno('Z_DATA_ERROR'));

    expect(available(await inspectEpub(filePath)).toc).toBeNull();
  });

  it('yields toc null when the nav read fails after inflating bytes', async () => {
    const filePath = await place(await F.buildEpub(navRowsBook(ONE_ROW)));
    failEntryAfterInflating(NAV_ENTRY, Buffer.alloc(512), errno('Z_DATA_ERROR'));

    expect(available(await inspectEpub(filePath)).toc).toBeNull();
  });

  /** Every way a declared cover can be unusable. All of them dispose to `cover: null`. */
  const COVER_NULL: Array<[label: string, options: F.EpubOptions]> = [
    [
      'the cover item declares no href',
      {
        packageOptions: {
          manifest:
            `<manifest>${F.itemXml(CHAPTER)}` +
            '<item id="cover" media-type="image/png" properties="cover-image"/></manifest>',
        },
      },
    ],
    [
      'the cover href is remote',
      {
        packageOptions: {
          items: [CHAPTER, { ...COVER_ITEM, href: 'https://example.com/cover.png' }],
        },
      },
    ],
    [
      'the cover href escapes the container root',
      { packageOptions: { items: [CHAPTER, { ...COVER_ITEM, href: '../../cover.png' }] } },
    ],
    [
      'the cover entry is absent from the archive',
      { packageOptions: { items: [CHAPTER, COVER_ITEM] } },
    ],
  ];

  it.each(COVER_NULL)('yields cover null when %s', async (_label, options) => {
    const result = await inspectBuilt(options);

    expect(available(result).cover).toBeNull();
    expect(optionalStreams()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

describe('public surface and guardrails', () => {
  const IMAGE_LIBRARIES = ['sharp', 'image-size', 'probe-image-size', 'jimp', 'canvas'];

  it('adds no image dependency to package.json', async () => {
    const { readFile } = await import('node:fs/promises');
    const manifest = JSON.parse(
      await readFile(path.join(import.meta.dirname, '../../../package.json'), 'utf8'),
    ) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    const declared = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies });

    // Nothing in Narratorr decodes the cover — it is streamed to a browser that
    // has its own bounded decoder — so a pixel-dimension bomb has no decoder here
    // to attack, and the byte cap plus magic-byte sniffing closes the reachable
    // case (#1990 Decision 1).
    expect(declared.filter((name) => IMAGE_LIBRARIES.includes(name))).toEqual([]);
  });

  it('imports no image library anywhere in src/core/epub', async () => {
    // Comments are not stripped: an `import` written in prose is still a claim
    // this folder decodes images, and the `from '…'` anchor keeps it precise.
    const sources = await scanProductionSources(import.meta.dirname);

    const offenders = IMAGE_LIBRARIES.filter((name) =>
      sources.some(({ code }) => new RegExp(`from\\s+['"]${name}['"]`).test(code)),
    );
    expect(offenders).toEqual([]);
  });

  it('exposes no path-taking or archive-opening function from extract.ts', async () => {
    const module = await import('./extract.js');
    const { readFile } = await import('node:fs/promises');
    const source = await readFile(path.join(import.meta.dirname, 'extract.ts'), 'utf8');

    // Decision 2: `validateEpub` and `inspectEpub` are the only path-taking
    // functions the folder offers outside it. `extract.ts` holds the helpers they
    // call, and opens, closes, and re-opens nothing.
    expect(Object.keys(module).sort()).toEqual([
      'extractEpubCover',
      'extractEpubMetadata',
      'extractEpubToc',
    ]);
    expect(source).not.toContain('filePath');
    expect(source).not.toContain('node:fs');
    expect(source).not.toContain('withZipSource');
  });

  // `extract.ts`'s layer-guard coverage is **not** asserted here.
  // `layer-guard.test.ts` › `describe('src/core/epub layer guard')` discovers
  // every production module in this folder through the shared recursive scan
  // and names its files with `expect.arrayContaining`, so a new module is in
  // scope automatically and with no edit. Re-scanning the folder to prove that
  // would restate the selection decision #2000 gave a single home.

  it('leaves the ebook-only search guard byte-for-byte unchanged', async () => {
    const { readFile } = await import('node:fs/promises');
    const source = await readFile(
      path.join(import.meta.dirname, '../../server/services/search-pipeline.ts'),
      'utf8',
    );

    expect(source).toContain(
      'const EBOOK_FORMAT_RE = /(?<![a-zA-Z\\d])(azw3|epub|pdf|mobi)(?![a-zA-Z\\d])/i;',
    );
  });

  it('keeps MAX_INSPECTION_BYTES the aggregate ceiling the budget arithmetic assumes', async () => {
    // The four mandatory reads are each ceilinged at `MAX_XML_BYTES`, and the
    // budget fixtures above derive their remainders from this equality. Retune
    // either constant and those fixtures stop meaning what they say.
    expect(4 * MAX_XML_BYTES).toBe(MAX_INSPECTION_BYTES);
  });
});
