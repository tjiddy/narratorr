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
 * End-to-end through real archives. Mocks delegate to real implementations and only
 * observe opens, streamed members, and order; the harness stays local because vi.mock hoists.
 */

const h = vi.hoisted(() => ({
  fsOpen: vi.fn(),
  openCustom: vi.fn(),
  real: {} as {
    fsOpen: (typeof import('node:fs/promises'))['open'];
    Open: (typeof import('unzipper'))['Open'];
  },
  streamed: [] as string[],
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

/** Spy-facing reader shape; @types/unzipper misdeclares Open.custom. */
type ReaderCustom = (
  source: unknown,
  options: unknown,
) => Promise<{ files: Array<Record<string, unknown>> }>;

function errno(code: string): Error {
  return Object.assign(new Error(`simulated ${code}`), { code });
}

/** Stream failure before data; File.stream cannot be modeled as a rejected promise. */
function erroringStream(value: unknown): Readable {
  return new Readable({
    read() {
      this.destroy(value as Error);
    },
  });
}

/**
 * Emits bytes before failing so charge-without-rollback is observable. Two read calls
 * ensure the counting transform receives the chunk before the error.
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

function failEntry(name: string, value: unknown): void {
  h.onStream = (streamed) => (streamed === name ? erroringStream(value) : undefined);
}

function failEntryAfterInflating(name: string, bytes: Buffer, value: unknown): void {
  h.onStream = (streamed) =>
    streamed === name ? partialThenErroringStream(bytes, value) : undefined;
}

let dir: string;
let sequence = 0;

async function place(bytes: Buffer): Promise<string> {
  sequence += 1;
  return F.writeArchive(dir, `fixture-${sequence}.epub`, bytes);
}

async function inspectBuilt(options: F.EpubOptions = {}): Promise<EpubInspection> {
  return inspectEpub(await place(await F.buildEpub(options)));
}

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
      // File.stream is an own property and can be wrapped on the real reader.
      file.stream = (...args: unknown[]) => {
        h.streamed.push(name);
        return h.onStream?.(name) ?? original(...args);
      };
    }
    return directory;
  });
});

/** Members always read by structural validation. */
const MANDATORY = [
  'mimetype',
  'META-INF/container.xml',
  F.DEFAULT_PACKAGE,
  'META-INF/encryption.xml',
];

function optionalStreams(): string[] {
  return h.streamed.filter((name) => !MANDATORY.includes(name));
}

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

const CHAPTER = F.CHAPTER_ITEM;
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

function navBook(document: string | Buffer, options: F.EpubOptions = {}): F.EpubOptions {
  return {
    ...options,
    packageOptions: { items: [CHAPTER, NAV_ITEM], ...options.packageOptions },
    files: [{ name: NAV_ENTRY, content: document }, ...(options.files ?? [])],
  };
}

function navRowsBook(nodes: readonly F.TocNode[], options: F.EpubOptions = {}): F.EpubOptions {
  return navBook(F.navDocumentXml(F.navXml(nodes)), options);
}

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

function coverBook(bytes: Buffer, options: F.EpubOptions = {}): F.EpubOptions {
  return {
    ...options,
    packageOptions: { items: [CHAPTER, COVER_ITEM], ...options.packageOptions },
    files: [{ name: COVER_ENTRY, content: bytes }, ...(options.files ?? [])],
  };
}

const ONE_ROW: F.TocNode[] = [{ label: 'One' }];
const ONE_ENTRY = [{ title: 'One', depth: 0 }];

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

    // TOC precedes cover because it is smaller and supplies the chapter count.
    expect(optionalStreams()).toEqual([NAV_ENTRY, COVER_ENTRY]);
    expect(h.fsOpen).toHaveBeenCalledTimes(1);
    expect(h.handles).toHaveLength(1);
    expect(h.handles[0]?.closes).toBe(1);
  });
});

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

    // The identical Z_DATA_ERROR is a verdict here but disposes to null at an optional site.
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
      navRowsBook(
        ONE_ROW,
        F.drmProtectedEpub({
          packageOptions: { items: [CHAPTER, NAV_ITEM, COVER_ITEM] },
          files: [{ name: COVER_ENTRY, content: PNG }],
        }),
      ),
    );

    expect(result).toEqual({ status: 'drm_protected' });
    expect(optionalStreams()).toEqual([]);
  });
});

describe('an optional read never demotes the status', () => {
  it('returns available with cover null when the cover entry fails mid-inflate', async () => {
    const filePath = await place(await F.buildEpub(coverBook(PNG)));
    failEntry(COVER_ENTRY, errno('Z_DATA_ERROR'));

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

    await expect(inspectEpub(filePath)).rejects.toThrow('simulated EIO');
  });

  it('propagates a filesystem error raised during the TOC read', async () => {
    const filePath = await place(await F.buildEpub(navRowsBook(ONE_ROW)));
    failEntry(NAV_ENTRY, errno('EACCES'));

    await expect(inspectEpub(filePath)).rejects.toThrow('simulated EACCES');
  });
});

describe('the shared budget: order, pre-reject, and streamed exhaustion', () => {
  /**
   * Four mandatory reads are capped at MAX_XML_BYTES; padding them leaves an exact
   * optional-read remainder.
   */
  function withRemainder(remainder: number, options: F.EpubOptions): F.EpubOptions {
    return {
      ...options,
      mimetype: F.padTo(F.EPUB_MEDIA_TYPE, MAX_XML_BYTES),
      container: F.padTo(F.containerXml(F.DEFAULT_PACKAGE), MAX_XML_BYTES),
      packageOptions: { ...options.packageOptions, padTo: MAX_XML_BYTES },
      encryption: F.padTo(F.EMPTY_ENCRYPTION_XML, MAX_XML_BYTES - remainder),
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
            // The nav leaves 1,000 bytes, less than this individually valid cover.
            { name: COVER_ENTRY, content: Buffer.concat([PNG, Buffer.alloc(1990)]) },
          ],
        }),
      ),
    );

    // This asymmetric result proves TOC was read first.
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
    // Pre-rejection occurs before entry.read, so the nav opens no stream or charge.
    expect(optionalStreams()).toEqual([COVER_ENTRY]);
  });

  it('keeps a failed read charged when the actual inflate crosses the remainder', async () => {
    const remainder = 4096;
    const navDocument = F.padTo(F.navDocumentXml(F.navXml(ONE_ROW)), 20000);
    // STORE makes inflated size equal content length in one chunk.
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
    // Understate declared size so only streamed accounting can enforce the real size.
    const filePath = await place(
      F.patchArchive(bytes, [
        { offset: central.headerOffset + 24, size: 4, value: 100, why: 'central uncompressedSize lie' },
        { offset: local.headerOffset + 22, size: 4, value: 100, why: 'local uncompressedSize lie' },
      ]),
    );

    const result = available(await inspectEpub(filePath));

    expect(result.toc).toBeNull();
    expect(result.cover).toBeNull();
    // The crossing chunk remains charged; rolling it back would leave room for the cover.
    expect(optionalStreams()).toEqual([NAV_ENTRY]);
    expect(Buffer.byteLength(navDocument)).toBe(20000);
    expect(20000 - remainder).toBeLessThan(Buffer.byteLength(navDocument));
  });

  /**
   * Same fixture and failure; only bytes emitted before failure differ, making
   * charge-as-you-go observable.
   */
  const PARTIAL_REMAINDER = 4096;
  /** Fits the untouched 4,096-byte remainder, not the 96 bytes left after a 4,000-byte charge. */
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

    expect(result.toc).toBeNull();
    expect(result.cover).toBeNull();
    expect(optionalStreams()).toEqual([NAV_ENTRY]);
  });

  it('charges nothing for a decoder failure that inflated nothing, so the cover still fits', async () => {
    const filePath = await place(await F.buildEpub(partialFixture()));
    failEntry(NAV_ENTRY, errno('Z_DATA_ERROR'));

    const result = available(await inspectEpub(filePath));

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

    expect(second).toEqual(first);
    expect(second.toc).toEqual(ONE_ENTRY);
    expect(second.cover?.mediaType).toBe('image/png');
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

    // Sniffing uses the real streamed bytes, not the understated size.
    const result = available(await inspectEpub(filePath));
    expect(result.cover?.bytes.length).toBe(cover.length);
    h.streamed = [];
    expect(await validateEpub(filePath)).toEqual({ status: 'available' });
    expect(optionalStreams()).toEqual([]);
  });
});

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
    // Metadata comes from the parsed package, so optional pre-rejection cannot remove it.
    const result = await inspectBuilt({
      mimetype: F.padTo(F.EPUB_MEDIA_TYPE, MAX_XML_BYTES),
      container: F.padTo(F.containerXml(F.DEFAULT_PACKAGE), MAX_XML_BYTES),
      packageOptions: {
        items: [CHAPTER, COVER_ITEM],
        metadata: { title: 'Still Here' },
        padTo: MAX_XML_BYTES,
      },
      encryption: F.padTo(F.EMPTY_ENCRYPTION_XML, MAX_XML_BYTES),
      files: [{ name: COVER_ENTRY, content: PNG }],
    });

    expect(available(result).metadata).toMatchObject({ title: 'Still Here' });
    expect(available(result).cover).toBeNull();
    expect(optionalStreams()).toEqual([]);
  });
});

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

  /** Exercises every accepted separator; htmlparser2 preserves them for the token predicate. */
  const SEPARATORS: Array<[label: string, separator: string]> = [
    ['a tab', '\t'],
    ['a line feed', '\n'],
    ['a carriage return', '\r'],
    ['a form feed', '\f'],
  ];

  it.each(SEPARATORS)(
    'matches every token-set attribute across %s separator',
    async (_label, separator) => {
      // One fixture covers nav-item, toc-nav, and cover-image token checks.
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
      files: [{ name: NCX_ENTRY, content: F.ncxDocumentXml(F.navMapXml(ONE_ROW)) }],
    });

    // Nav selection precludes NCX fallback through the partly charged shared budget.
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

describe('locating the toc nav is a descendant search', () => {
  it('finds a nav sitting directly under body', async () => {
    const result = await inspectBuilt(navRowsBook(ONE_ROW));

    // A nav under body is not a direct child of html; childrenByLocalName would miss it.
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
    // Prefixes are aliases; local-name lookup must accept ops:type as epub:type.
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
    // Well under the byte cap but deeper than the JS stack; recursive discovery would overflow.
    const depth = 25000;
    const wrapped = '<div>'.repeat(depth) + F.navXml(ONE_ROW) + '</div>'.repeat(depth);
    const result = await inspectBuilt(navBook(F.navDocumentXml(wrapped)));

    expect(available(result).toc).toEqual(ONE_ENTRY);
  });
});

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
    // Label-less rows prove the visit cap bounds work, not output. Repetition avoids
    // overflowing the recursive fixture builder.
    const depth = 5000;
    const chain =
      '<ol><li>'.repeat(depth) + '<a href="c.xhtml">Bottom</a>' + '</li></ol>'.repeat(depth);
    const result = await inspectBuilt(
      navBook(F.navDocumentXml(`<nav epub:type="toc">${chain}</nav>`)),
    );

    expect(available(result).toc).toBeNull();
  });
});

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

    expect(available(result).toc).toBeNull();
    expect(optionalStreams()).toEqual([]);
  });
});

describe('malformed means exactly the parser’s rejected arm', () => {
  const REJECTED: Array<[label: string, document: string | Buffer]> = [
    ['a root that is not html', '<?xml version="1.0"?><div><p>x</p></div>'],
    ['two root elements', '<?xml version="1.0"?><html><body/></html><html><body/></html>'],
    [
      'bytes that fail fatal decoding',
      // Lone continuation bytes force fatal UTF-8 rejection before parsing.
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
    // htmlparser2 repairs this tag soup; no second well-formedness parser exists.
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

describe('the optional-resource failure matrix', () => {
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

  // These isolate null disposition; partial-failure budget accounting is tested above.
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

describe('public surface and guardrails', () => {
  const IMAGE_LIBRARIES = ['sharp', 'image-size', 'probe-image-size', 'jimp', 'canvas'];

  it('adds no image dependency to package.json', async () => {
    const { readFile } = await import('node:fs/promises');
    const manifest = JSON.parse(
      await readFile(path.join(import.meta.dirname, '../../../package.json'), 'utf8'),
    ) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    const declared = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies });

    expect(declared.filter((name) => IMAGE_LIBRARIES.includes(name))).toEqual([]);
  });

  it('imports no image library anywhere in src/core/epub', async () => {
    // Comments remain in the scan; the anchored import pattern avoids prose false positives.
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

    expect(Object.keys(module).sort()).toEqual([
      'extractEpubCover',
      'extractEpubMetadata',
      'extractEpubToc',
    ]);
    expect(source).not.toContain('filePath');
    expect(source).not.toContain('node:fs');
    expect(source).not.toContain('withZipSource');
  });

  it('keeps MAX_INSPECTION_BYTES the aggregate ceiling the budget arithmetic assumes', async () => {
    // Budget fixtures depend on four mandatory XML ceilings equaling the aggregate cap.
    expect(4 * MAX_XML_BYTES).toBe(MAX_INSPECTION_BYTES);
  });
});
