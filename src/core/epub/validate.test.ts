import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';
import path from 'node:path';
import type { FileHandle } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import * as F from '../__tests__/epub-archive.fixture.js';
import { MAX_ARCHIVE_BYTES, MAX_INSPECTION_BYTES, MAX_XML_BYTES } from './limits.js';
import type { EpubValidation } from './result.js';
import { validateEpub } from './validate.js';

/**
 * `validateEpub` — the structural pipeline, its precedence, and the
 * `encryption.xml` classifier (#1989, design §4).
 *
 * **Mocked at the OS / library edge only** — `node:fs/promises` for `lstat` and
 * `open`, and `unzipper` for the reader. `validate.ts` calls its own helpers
 * through local bindings, so a `vi.mock` factory overriding *its* exports would
 * not intercept those calls, and adding `__internal` indirection to production
 * code to make it mockable is exactly the shape to avoid. Both mocks delegate to
 * the real implementation by default, so nearly every row below is a genuine
 * end-to-end run against a real file on disk and the pinned reader.
 *
 * The spies answer questions no black-box assertion can: was `open()` reached at
 * all, which archive members were streamed, in what order, and did the handle
 * close.
 */

type ReadArgs = [buffer: Buffer, offset: number, length: number, position: number];
type ReadResult = { bytesRead: number; buffer: Buffer };

/**
 * The reader as the spies below need to see it — a directory of members whose
 * `stream` can be wrapped. Deliberately not `unzipper`'s own `CentralDirectory`:
 * `@types/unzipper@0.10.11` misdeclares the `Open.custom` source contract
 * (#1997), so naming its types here would pin the wrong shape.
 */
type ReaderCustom = (
  source: unknown,
  options: unknown,
) => Promise<{ files: Array<Record<string, unknown>> }>;

const h = vi.hoisted(() => ({
  fsOpen: vi.fn(),
  fsLstat: vi.fn(),
  openCustom: vi.fn(),
  real: {} as {
    fsOpen: (typeof import('node:fs/promises'))['open'];
    fsLstat: (typeof import('node:fs/promises'))['lstat'];
    Open: (typeof import('unzipper'))['Open'];
  },
  onStat: undefined as (() => Promise<Stats>) | undefined,
  onRead: undefined as ((raw: FileHandle, args: ReadArgs) => Promise<ReadResult>) | undefined,
  /** Every positional read the pipeline performed, in order. */
  reads: [] as Array<{ position: number; length: number; preOpen: boolean }>,
  /** Every archive member whose inflated stream was opened, in order. */
  streamed: [] as string[],
  handles: [] as Array<{ closes: number }>,
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  h.real.fsOpen = actual.open;
  h.real.fsLstat = actual.lstat;
  return { ...actual, default: actual, open: h.fsOpen, lstat: h.fsLstat };
});

vi.mock('unzipper', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const real = (actual.default ?? actual) as typeof import('unzipper');
  h.real.Open = real.Open;
  return { ...actual, default: { ...real, Open: { ...real.Open, custom: h.openCustom } } };
});

/** Only the three members production uses are forwarded; everything else is absent by design. */
function wrapHandle(raw: FileHandle, record: { closes: number }): FileHandle {
  return {
    async read(...args: ReadArgs): Promise<ReadResult> {
      // Recorded on *attempt*, not on success — the injected-failure rows below
      // assert which reads were reached, and a read that rejects still happened.
      h.reads.push({
        position: args[3],
        length: args[2],
        preOpen: h.openCustom.mock.calls.length === 0,
      });
      return h.onRead ? h.onRead(raw, args) : raw.read(...args);
    },
    async stat(): Promise<Stats> {
      return h.onStat ? h.onStat() : raw.stat();
    },
    async close(): Promise<void> {
      record.closes += 1;
      return raw.close();
    },
  } as unknown as FileHandle;
}

function errno(code: string): Error {
  return Object.assign(new Error(`simulated ${code}`), { code });
}

/** A `Stats` stand-in carrying only the two fields the pipeline reads. */
function fakeStats(options: { isFile: boolean; size: number }): Stats {
  return { isFile: () => options.isFile, size: options.size } as unknown as Stats;
}

// --- EPUB fixture shapes ----------------------------------------------------

/**
 * The EPUB-document builders (`containerXml`, `packageXml`, `padTo`,
 * `epubEntries`, `buildEpub`, …) live in the shared fixture module — #1990's
 * `extract.test.ts` needs the same shapes. Only the `encryption.xml` builders
 * below stay local: this is the only suite that classifies one.
 */

const {
  DEFAULT_PACKAGE,
  EPUB_MEDIA_TYPE,
  XHTML,
  buildEpub,
  containerXml,
  padTo,
} = F;
type EpubOptions = F.EpubOptions;
type ManifestItem = F.ManifestItem;

const DEFAULT_ITEMS: ManifestItem[] = [
  { id: 'ch1', href: 'ch1.xhtml', mediaType: 'application/xhtml+xml' },
];

// --- encryption.xml shapes --------------------------------------------------

interface CipherSpec {
  /** `undefined` omits the `URI` attribute entirely. */
  uri?: string;
  /** Write the attribute under a prefixed name instead of the exact `URI`. */
  uriAttributeName?: string;
  /** Emit an `<EncryptedData>` carrying no `<CipherReference>` at all. */
  withoutReference?: boolean;
  /** Namespace prefix applied to all three element names. */
  prefix?: string;
  algorithm?: string;
}

const ADOBE_ALGORITHM = 'http://ns.adobe.com/pdf/enc#RC';
const IDPF_ALGORITHM = 'http://www.idpf.org/2008/embedding';

function encryptedDataXml(spec: CipherSpec): string {
  const p = spec.prefix === undefined ? '' : `${spec.prefix}:`;
  const algorithm = `<EncryptionMethod Algorithm="${spec.algorithm ?? ADOBE_ALGORITHM}"/>`;
  if (spec.withoutReference) return `<${p}EncryptedData>${algorithm}</${p}EncryptedData>`;
  const name = spec.uriAttributeName ?? 'URI';
  const attribute = spec.uri === undefined ? '' : ` ${name}="${spec.uri}"`;
  return (
    `<${p}EncryptedData>${algorithm}<${p}CipherData><${p}CipherReference${attribute}/></${p}CipherData></${p}EncryptedData>`
  );
}

function encryptionXml(specs: CipherSpec[], options: { padTo?: number } = {}): string {
  const document =
    `<?xml version="1.0" encoding="UTF-8"?><encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container" xmlns:enc="http://www.w3.org/2001/04/xmlenc#">` +
    `${specs.map(encryptedDataXml).join('')}</encryption>`;
  return options.padTo === undefined ? document : padTo(document, options.padTo);
}

// --- suite scaffolding ------------------------------------------------------

let dir: string;
let sequence = 0;

async function place(bytes: Buffer, extension = 'epub'): Promise<string> {
  sequence += 1;
  return F.writeArchive(dir, `fixture-${sequence}.${extension}`, bytes);
}

/** Build an EPUB, write it out, and validate it. */
async function validateBuilt(options: EpubOptions = {}): Promise<EpubValidation> {
  return validateEpub(await place(await buildEpub(options)));
}

beforeAll(async () => {
  dir = await F.createArchiveDir();
});

afterAll(async () => {
  const { rm } = await import('node:fs/promises');
  await rm(dir, { recursive: true, force: true });
});

beforeEach(() => {
  // `*Once()` queues are used below; `vi.clearAllMocks()` does not drain them.
  vi.resetAllMocks();
  h.onStat = undefined;
  h.onRead = undefined;
  h.reads = [];
  h.streamed = [];
  h.handles = [];
  h.fsLstat.mockImplementation(async (...args: unknown[]) =>
    (h.real.fsLstat as (...a: unknown[]) => Promise<Stats>)(...args),
  );
  h.fsOpen.mockImplementation(async (...args: unknown[]) => {
    const raw = await (h.real.fsOpen as (...a: unknown[]) => Promise<FileHandle>)(...args);
    const record = { closes: 0 };
    h.handles.push(record);
    return wrapHandle(raw, record);
  });
  h.openCustom.mockImplementation(async (source: unknown, options: unknown) => {
    const directory = await (
      h.real.Open.custom as unknown as ReaderCustom
    )(source, options);
    for (const file of directory.files) {
      const original = (file.stream as (...a: unknown[]) => Readable).bind(file);
      file.stream = (...args: unknown[]) => {
        h.streamed.push(String(file.path));
        return original(...args);
      };
    }
    return directory;
  });
});

// ---------------------------------------------------------------------------

describe('happy paths', () => {
  it('validates a minimal EPUB 3 with a nav item and a cover image', async () => {
    const result = await validateBuilt({
      packageOptions: {
        items: [
          { id: 'ch1', href: 'ch1.xhtml', mediaType: 'application/xhtml+xml' },
          { id: 'nav', href: 'nav.xhtml', mediaType: 'application/xhtml+xml', properties: 'nav' },
          { id: 'cover', href: 'cover.png', mediaType: 'image/png', properties: 'cover-image' },
        ],
      },
      files: [
        { name: 'OEBPS/nav.xhtml', content: XHTML },
        { name: 'OEBPS/cover.png', content: Buffer.from([0x89, 0x50, 0x4e, 0x47]) },
      ],
    });

    expect(result).toEqual({ status: 'available' });
  });

  it('validates a minimal EPUB 2 with an NCX referenced by spine@toc', async () => {
    const result = await validateBuilt({
      packageOptions: {
        items: [
          { id: 'ch1', href: 'ch1.xhtml', mediaType: 'application/xhtml+xml' },
          { id: 'ncx', href: 'book.ncx', mediaType: 'application/x-dtbncx+xml' },
        ],
        manifest:
          '<manifest><item id="ch1" href="ch1.xhtml" media-type="application/xhtml+xml"/>' +
          '<item id="ncx" href="book.ncx" media-type="application/x-dtbncx+xml"/>' +
          '<item id="cover" href="cover.png" media-type="image/png"/></manifest>',
        spine: '<spine toc="ncx"><itemref idref="ch1"/></spine>',
      },
      files: [
        { name: 'OEBPS/book.ncx', content: '<?xml version="1.0"?><ncx><navMap/></ncx>' },
        { name: 'OEBPS/cover.png', content: Buffer.from([0x89, 0x50, 0x4e, 0x47]) },
      ],
    });

    expect(result).toEqual({ status: 'available' });
  });

  it('resolves a nested layout through the package document directory', async () => {
    const result = await validateBuilt({
      packageOptions: {
        items: [
          { id: 'ch1', href: 'Text/ch1.xhtml', mediaType: 'application/xhtml+xml' },
          { id: 'nav', href: 'Nav/nav.xhtml', mediaType: 'application/xhtml+xml', properties: 'nav' },
          { id: 'ncx', href: 'toc/book.ncx', mediaType: 'application/x-dtbncx+xml' },
          { id: 'cover', href: 'Images/cover.png', mediaType: 'image/png' },
        ],
      },
      files: [
        { name: 'OEBPS/Text/ch1.xhtml', content: XHTML },
        { name: 'OEBPS/Nav/nav.xhtml', content: XHTML },
        { name: 'OEBPS/toc/book.ncx', content: '<?xml version="1.0"?><ncx><navMap/></ncx>' },
        { name: 'OEBPS/Images/cover.png', content: Buffer.from([0x89, 0x50, 0x4e, 0x47]) },
      ],
    });

    expect(result).toEqual({ status: 'available' });
  });

  it('resolves a root-level package, so dirname normalises to the container root', async () => {
    // `path.posix.dirname('content.opf')` is `'.'`; a base of `'.'` and a base of
    // `''` must resolve `ch1.xhtml` to the same archive key.
    const result = await validateBuilt({ packageName: 'content.opf' });

    expect(result).toEqual({ status: 'available' });
  });
});

// ---------------------------------------------------------------------------

describe('not_a_zip', () => {
  it('rejects a text file renamed .epub', async () => {
    const filePath = await place(Buffer.from('this is plainly not a ZIP archive'));

    expect(await validateEpub(filePath)).toEqual({ status: 'invalid', code: 'not_a_zip' });
  });

  it('rejects a directory without ever opening it', async () => {
    const { mkdir } = await import('node:fs/promises');
    const directory = path.join(dir, 'book-directory.epub');
    await mkdir(directory, { recursive: true });

    expect(await validateEpub(directory)).toEqual({ status: 'invalid', code: 'not_a_zip' });
    expect(h.fsOpen).not.toHaveBeenCalled();
  });

  it('rejects a symlink pointing at a valid EPUB without ever opening it', async () => {
    const { symlink } = await import('node:fs/promises');
    const target = await place(await buildEpub());
    const link = path.join(dir, `link-${(sequence += 1)}.epub`);
    await symlink(target, link);

    expect(await validateEpub(link)).toEqual({ status: 'invalid', code: 'not_a_zip' });
    expect(h.fsOpen).not.toHaveBeenCalled();
  });

  it('rejects a zero-byte file, having opened it to read the signature', async () => {
    const filePath = await place(Buffer.alloc(0));

    expect(await validateEpub(filePath)).toEqual({ status: 'invalid', code: 'not_a_zip' });
    expect(h.fsOpen).toHaveBeenCalledTimes(1);
  });

  it('rejects a three-byte file, so the signature read comes back short', async () => {
    const filePath = await place(Buffer.from([0x50, 0x4b, 0x03]));

    expect(await validateEpub(filePath)).toEqual({ status: 'invalid', code: 'not_a_zip' });
    expect(h.fsOpen).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------

describe('truncated', () => {
  it('rejects an archive with its trailing bytes lopped off, never reaching the reader', async () => {
    const bytes = await buildEpub();
    const filePath = await place(bytes.subarray(0, bytes.length - 10));

    expect(await validateEpub(filePath)).toEqual({ status: 'invalid', code: 'truncated' });
    expect(h.openCustom).not.toHaveBeenCalled();
  });

  it('rejects an accepted EOCD whose central directory is unreachable', async () => {
    // The EOCD passes our preflight — the disk fields and record counts agree —
    // but its `offsetToStartOfCentralDirectory` points at four bytes of payload,
    // so the pinned reader runs out of bytes parsing the first 46-byte record.
    const bytes = await buildEpub();
    const eocd = F.eocdOffset(bytes);
    const filePath = await place(
      F.patchArchive(bytes, [
        { offset: eocd + 16, size: 4, value: eocd - 4, why: 'central directory offset points into nothing' },
      ]),
    );

    expect(await validateEpub(filePath)).toEqual({ status: 'invalid', code: 'truncated' });
    expect(h.openCustom).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------

describe('bad_mimetype', () => {
  it('rejects a plain ZIP of loose files with no mimetype entry', async () => {
    const filePath = await place(
      await F.buildArchive({ entries: [{ name: 'a.txt', content: 'a' }, { name: 'b.txt', content: 'b' }] }),
    );

    expect(await validateEpub(filePath)).toEqual({ status: 'invalid', code: 'bad_mimetype' });
  });

  it('rejects a mimetype entry declaring application/zip', async () => {
    expect(await validateBuilt({ mimetype: 'application/zip' })).toEqual({
      status: 'invalid',
      code: 'bad_mimetype',
    });
  });

  it('rejects an empty archive, which passes the signature check and the preflight', async () => {
    const bytes = await F.buildArchive({ entries: [] });
    expect(bytes.subarray(0, 4)).toEqual(F.EOCD_SIGNATURE);
    const filePath = await place(bytes);

    expect(await validateEpub(filePath)).toEqual({ status: 'invalid', code: 'bad_mimetype' });
    expect(h.openCustom).toHaveBeenCalledTimes(1);
  });

  it('accepts a mimetype that is deflated and not first in the archive', async () => {
    // Position and compression method are deliberately not checked — that is the
    // epubcheck-strict rule and it would reject readable, Kindle-sendable books.
    expect(await validateBuilt({ mimetypeLast: true, store: false })).toEqual({ status: 'available' });
  });

  it('accepts a mimetype padded with surrounding whitespace', async () => {
    expect(await validateBuilt({ mimetype: `  \r\n${EPUB_MEDIA_TYPE}\r\n \n` })).toEqual({
      status: 'available',
    });
  });

  it('accepts a mimetype padded to exactly MAX_XML_BYTES', async () => {
    expect(await validateBuilt({ mimetype: padTo(EPUB_MEDIA_TYPE, MAX_XML_BYTES) })).toEqual({
      status: 'available',
    });
  });

  it('maps a mimetype inflating to MAX_XML_BYTES + 1 to limit_exceeded, not bad_mimetype', async () => {
    expect(await validateBuilt({ mimetype: padTo(EPUB_MEDIA_TYPE, MAX_XML_BYTES + 1) })).toEqual({
      status: 'invalid',
      code: 'limit_exceeded',
    });
  });
});

// ---------------------------------------------------------------------------

describe('missing_container', () => {
  it('rejects an archive with no META-INF/container.xml', async () => {
    expect(await validateBuilt({ container: false })).toEqual({
      status: 'invalid',
      code: 'missing_container',
    });
  });
});

// ---------------------------------------------------------------------------

describe('unresolvable_package', () => {
  const UNRESOLVABLE: EpubValidation = { status: 'invalid', code: 'unresolvable_package' };

  it('rejects a full-path naming an entry absent from the archive', async () => {
    expect(await validateBuilt({ containerFullPath: 'OEBPS/absent.opf' })).toEqual(UNRESOLVABLE);
  });

  it('rejects a full-path escaping the container root', async () => {
    expect(await validateBuilt({ containerFullPath: '../outside.opf' })).toEqual(UNRESOLVABLE);
  });

  it('rejects a remote full-path', async () => {
    expect(await validateBuilt({ containerFullPath: 'https://example.test/p.opf' })).toEqual(
      UNRESOLVABLE,
    );
  });

  const NO_PACKAGE: Array<[label: string, container: string]> = [
    [
      'a container with no rootfiles element',
      '<?xml version="1.0"?><container version="1.0"/>',
    ],
    [
      'a rootfiles element with no rootfile child',
      '<?xml version="1.0"?><container version="1.0"><rootfiles/></container>',
    ],
    [
      'a first rootfile with no full-path attribute',
      `<?xml version="1.0"?><container version="1.0"><rootfiles>${containerXml(null).split('<rootfiles>')[1]!.split('</rootfiles>')[0]!}</rootfiles></container>`,
    ],
    [
      'a first rootfile with an empty full-path',
      '<?xml version="1.0"?><container version="1.0"><rootfiles><rootfile full-path=""/></rootfiles></container>',
    ],
  ];

  it.each(NO_PACKAGE)('rejects %s without letting a TypeError escape', async (_label, container) => {
    // `attrByExactName` returns `undefined` for an absent attribute, and
    // `undefined` is never handed to `resolveHref` — the absent case is decided
    // before the call.
    await expect(validateBuilt({ container })).resolves.toEqual(UNRESOLVABLE);
  });

  it('consults only the first rootfile, so a valid second does not rescue a broken first', async () => {
    const container =
      '<?xml version="1.0"?><container version="1.0"><rootfiles>' +
      '<rootfile full-path=""/>' +
      `<rootfile full-path="${DEFAULT_PACKAGE}" media-type="application/oebps-package+xml"/>` +
      '</rootfiles></container>';

    expect(await validateBuilt({ container })).toEqual(UNRESOLVABLE);
  });
});

// ---------------------------------------------------------------------------

describe('empty_manifest', () => {
  it('rejects an empty manifest element', async () => {
    expect(await validateBuilt({ packageOptions: { manifest: '<manifest/>' } })).toEqual({
      status: 'invalid',
      code: 'empty_manifest',
    });
  });

  it('rejects a package document carrying no manifest element at all', async () => {
    expect(await validateBuilt({ packageOptions: { manifest: '' } })).toEqual({
      status: 'invalid',
      code: 'empty_manifest',
    });
  });

  it('outranks empty_spine, matching the pipeline order', async () => {
    expect(
      await validateBuilt({ packageOptions: { manifest: '<manifest/>', spine: '<spine/>' } }),
    ).toEqual({ status: 'invalid', code: 'empty_manifest' });
  });
});

// ---------------------------------------------------------------------------

describe('empty_spine', () => {
  const EMPTY_SPINE: EpubValidation = { status: 'invalid', code: 'empty_spine' };

  it('rejects an empty spine element', async () => {
    expect(await validateBuilt({ packageOptions: { spine: '<spine/>' } })).toEqual(EMPTY_SPINE);
  });

  it('rejects a package document carrying no spine element at all', async () => {
    expect(await validateBuilt({ packageOptions: { spine: '' } })).toEqual(EMPTY_SPINE);
  });

  it('rejects a spine whose every itemref is linear="no"', async () => {
    expect(
      await validateBuilt({
        packageOptions: { itemrefs: [{ idref: 'ch1', linear: 'no' }, { idref: 'ch1', linear: 'no' }] },
      }),
    ).toEqual(EMPTY_SPINE);
  });

  it('rejects a lone linear itemref with no idref', async () => {
    expect(await validateBuilt({ packageOptions: { itemrefs: [{}] } })).toEqual(EMPTY_SPINE);
  });

  it('rejects a lone linear itemref matching no manifest item', async () => {
    expect(await validateBuilt({ packageOptions: { itemrefs: [{ idref: 'missing' }] } })).toEqual(
      EMPTY_SPINE,
    );
  });

  it('rejects a lone linear itemref whose manifest item names a missing entry', async () => {
    expect(
      await validateBuilt({
        packageOptions: {
          items: [{ id: 'ch1', href: 'absent.xhtml', mediaType: 'application/xhtml+xml' }],
        },
      }),
    ).toEqual(EMPTY_SPINE);
  });

  it('rejects an idref matching two manifest items, since exactly one must match', async () => {
    expect(
      await validateBuilt({
        packageOptions: {
          items: [
            { id: 'ch1', href: 'ch1.xhtml', mediaType: 'application/xhtml+xml' },
            { id: 'ch1', href: 'ch1.xhtml', mediaType: 'application/xhtml+xml' },
          ],
        },
      }),
    ).toEqual(EMPTY_SPINE);
  });

  it('rejects a lone linear itemref whose manifest href is remote', async () => {
    expect(
      await validateBuilt({
        packageOptions: {
          items: [{ id: 'ch1', href: 'https://example.test/ch1.xhtml', mediaType: 'application/xhtml+xml' }],
        },
      }),
    ).toEqual(EMPTY_SPINE);
  });

  it('rejects a lone linear itemref whose manifest href escapes the container root', async () => {
    expect(
      await validateBuilt({
        packageOptions: {
          items: [{ id: 'ch1', href: '../../outside.xhtml', mediaType: 'application/xhtml+xml' }],
        },
      }),
    ).toEqual(EMPTY_SPINE);
  });

  it('accepts a mixed spine where one linear itemref resolves and one does not', async () => {
    // Decision 6 — partial damage must not mark a readable book invalid.
    expect(
      await validateBuilt({
        packageOptions: {
          items: [
            { id: 'ch1', href: 'ch1.xhtml', mediaType: 'application/xhtml+xml' },
            { id: 'broken', href: 'absent.xhtml', mediaType: 'application/xhtml+xml' },
          ],
          itemrefs: [{ idref: 'broken' }, { idref: 'ch1' }],
        },
      }),
    ).toEqual({ status: 'available' });
  });
});

// ---------------------------------------------------------------------------

describe('malformed_xml', () => {
  it('rejects a container.xml containing plain text', async () => {
    expect(await validateBuilt({ container: 'this document has no root element' })).toEqual({
      status: 'invalid',
      code: 'malformed_xml',
    });
  });

  it('rejects a package document whose root local name is html', async () => {
    expect(await validateBuilt({ packageOptions: { raw: XHTML } })).toEqual({
      status: 'invalid',
      code: 'malformed_xml',
    });
  });
});

// ---------------------------------------------------------------------------

describe('limit_exceeded', () => {
  it('rejects a file over MAX_ARCHIVE_BYTES before opening it', async () => {
    const filePath = await place(await buildEpub());
    h.fsLstat.mockResolvedValueOnce(fakeStats({ isFile: true, size: MAX_ARCHIVE_BYTES + 1 }));

    expect(await validateEpub(filePath)).toEqual({ status: 'invalid', code: 'limit_exceeded' });
    expect(h.fsOpen).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------

describe('the 1.1c passthrough arms', () => {
  it('maps unsafe_entry_path straight through and stops there', async () => {
    const bytes = await buildEpub({ files: [{ name: 'OEBPS/aaa/bbb.xhtml', content: XHTML }] });
    const index = F.listCentralDirectory(bytes).findIndex(
      (entry) => entry.rawName.toString('utf8') === 'OEBPS/aaa/bbb.xhtml',
    );
    expect(index).toBeGreaterThanOrEqual(0);
    const filePath = await place(F.patchEntryName(bytes, index, Buffer.from('OEBPS/../../b.xhtml')));

    expect(await validateEpub(filePath)).toEqual({ status: 'invalid', code: 'unsafe_entry_path' });
    expect(h.streamed).toEqual([]);
  });

  it('maps duplicate_entry straight through and stops there', async () => {
    const bytes = await buildEpub({ files: [{ name: 'OEBPS/dup.xhtml', content: XHTML }] });
    const entries = F.listCentralDirectory(bytes);
    const index = entries.findIndex((entry) => entry.rawName.toString('utf8') === 'OEBPS/dup.xhtml');
    const filePath = await place(F.patchEntryName(bytes, index, Buffer.from('OEBPS/ch1.xhtml')));

    expect(await validateEpub(filePath)).toEqual({ status: 'invalid', code: 'duplicate_entry' });
    expect(h.streamed).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

describe('fstat is the size and file-kind authority', () => {
  it('rejects a directory the stubbed lstat called a regular file, after opening', async () => {
    const { mkdir } = await import('node:fs/promises');
    const directory = path.join(dir, 'fstat-directory.epub');
    await mkdir(directory, { recursive: true });
    h.fsLstat.mockResolvedValueOnce(fakeStats({ isFile: true, size: 1024 }));

    expect(await validateEpub(directory)).toEqual({ status: 'invalid', code: 'not_a_zip' });
    expect(h.fsOpen).toHaveBeenCalledTimes(1);
    expect(h.handles[0]?.closes).toBe(1);
  });

  it('rejects an oversize fstat the stubbed lstat called small, after opening', async () => {
    const filePath = await place(await buildEpub());
    h.fsLstat.mockResolvedValueOnce(fakeStats({ isFile: true, size: 1024 }));
    h.onStat = async () => fakeStats({ isFile: true, size: MAX_ARCHIVE_BYTES + 1 });

    expect(await validateEpub(filePath)).toEqual({ status: 'invalid', code: 'limit_exceeded' });
    expect(h.fsOpen).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------

describe('consumer-level exact boundaries', () => {
  it('does not reject an lstat size of exactly MAX_ARCHIVE_BYTES', async () => {
    const filePath = await place(await buildEpub());
    h.fsLstat.mockResolvedValueOnce(fakeStats({ isFile: true, size: MAX_ARCHIVE_BYTES }));

    expect(await validateEpub(filePath)).toEqual({ status: 'available' });
    expect(h.fsOpen).toHaveBeenCalledTimes(1);
  });

  it('does not reject an fstat size of exactly MAX_ARCHIVE_BYTES', async () => {
    const filePath = await place(await buildEpub());
    h.onStat = async () => fakeStats({ isFile: true, size: MAX_ARCHIVE_BYTES });

    // The stubbed size exceeds the real fixture, so the run fails at the
    // preflight — the assertion is that it is not `limit_exceeded`, which is
    // exactly what a `>=` slip would produce.
    expect(await validateEpub(filePath)).toEqual({ status: 'invalid', code: 'truncated' });
    expect(h.reads.some((read) => read.position === 0 && read.length === 4)).toBe(true);
  });
});

// ---------------------------------------------------------------------------

describe('ZIP-level encryption', () => {
  /** Set general-purpose bit 0 on one member, in both header copies. */
  async function withEncryptionBit(options: EpubOptions, name: string): Promise<string> {
    const bytes = await buildEpub(options);
    const index = F.listCentralDirectory(bytes).findIndex(
      (entry) => entry.rawName.toString('utf8') === name,
    );
    expect(index).toBeGreaterThanOrEqual(0);
    const central = F.listCentralDirectory(bytes)[index]!;
    const local = F.localFileHeader(bytes, index);
    const flags = bytes.readUInt16LE(central.headerOffset + 8);
    return place(
      F.patchArchive(bytes, [
        { offset: central.headerOffset + 8, size: 2, value: flags | 0x1, why: 'central encryption bit' },
        { offset: local.headerOffset + 6, size: 2, value: flags | 0x1, why: 'local encryption bit' },
      ]),
    );
  }

  it('reports drm_protected from the central directory, before any entry stream', async () => {
    const filePath = await withEncryptionBit({}, 'OEBPS/ch1.xhtml');

    expect(await validateEpub(filePath)).toEqual({ status: 'drm_protected' });
    expect(h.streamed).toEqual([]);
  });

  it('passes no password argument to any read or stream call in src/core/epub/', async () => {
    const { readdir, readFile } = await import('node:fs/promises');
    const files = (await readdir(import.meta.dirname, { recursive: true })).filter(
      (entry) => entry.endsWith('.ts') && !entry.endsWith('.test.ts'),
    );
    const sources = await Promise.all(
      files.map(async (file) => ({
        file,
        code: (await readFile(path.join(import.meta.dirname, file), 'utf8'))
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/\/\/.*$/gm, ''),
      })),
    );
    const offenders = sources
      .filter(({ code }) => /\b(?:stream|read)\s*\(\s*[^)]*password/i.test(code))
      .map(({ file }) => file);

    expect(offenders).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

describe('precedence', () => {
  it('prefers empty_spine over an encryption.xml encrypting a content document', async () => {
    const result = await validateBuilt({
      packageOptions: { spine: '<spine/>' },
      encryption: encryptionXml([{ uri: 'OEBPS/ch1.xhtml' }]),
    });

    expect(result).toEqual({ status: 'invalid', code: 'empty_spine' });
  });

  it('prefers drm_protected over bad_mimetype, since the bit scan runs first', async () => {
    const bytes = await buildEpub({ mimetype: 'application/zip' });
    const index = F.listCentralDirectory(bytes).findIndex(
      (entry) => entry.rawName.toString('utf8') === 'OEBPS/ch1.xhtml',
    );
    const central = F.listCentralDirectory(bytes)[index]!;
    const local = F.localFileHeader(bytes, index);
    const flags = bytes.readUInt16LE(central.headerOffset + 8);
    const filePath = await place(
      F.patchArchive(bytes, [
        { offset: central.headerOffset + 8, size: 2, value: flags | 0x1, why: 'central encryption bit' },
        { offset: local.headerOffset + 6, size: 2, value: flags | 0x1, why: 'local encryption bit' },
      ]),
    );

    expect(await validateEpub(filePath)).toEqual({ status: 'drm_protected' });
  });

  it('prefers duplicate_entry over the encryption-bit scan', async () => {
    const bytes = await buildEpub({ files: [{ name: 'OEBPS/dup.xhtml', content: XHTML }] });
    const entries = F.listCentralDirectory(bytes);
    const dupIndex = entries.findIndex((entry) => entry.rawName.toString('utf8') === 'OEBPS/dup.xhtml');
    const central = entries[dupIndex]!;
    const local = F.localFileHeader(bytes, dupIndex);
    const flags = bytes.readUInt16LE(central.headerOffset + 8);
    const withBit = F.patchArchive(bytes, [
      { offset: central.headerOffset + 8, size: 2, value: flags | 0x1, why: 'central encryption bit' },
      { offset: local.headerOffset + 6, size: 2, value: flags | 0x1, why: 'local encryption bit' },
    ]);
    const filePath = await place(F.patchEntryName(withBit, dupIndex, Buffer.from('OEBPS/ch1.xhtml')));

    expect(await validateEpub(filePath)).toEqual({ status: 'invalid', code: 'duplicate_entry' });
  });
});

// ---------------------------------------------------------------------------

describe('the declared uncompressed size is never consulted', () => {
  /** Patch a member's declared uncompressed size in both header copies. */
  function patchDeclaredSize(bytes: Buffer, name: string, value: number): Buffer {
    const entries = F.listCentralDirectory(bytes);
    const index = entries.findIndex((entry) => entry.rawName.toString('utf8') === name);
    expect(index).toBeGreaterThanOrEqual(0);
    const local = F.localFileHeader(bytes, index);
    return F.patchArchive(bytes, [
      { offset: entries[index]!.headerOffset + 24, size: 4, value, why: 'central uncompressedSize lie' },
      { offset: local.headerOffset + 22, size: 4, value, why: 'local uncompressedSize lie' },
    ]);
  }

  it('understated: the counting transform still stops a package document over MAX_XML_BYTES', async () => {
    const bytes = await buildEpub({
      packageOptions: { padTo: MAX_XML_BYTES + 1 },
    });
    const filePath = await place(patchDeclaredSize(bytes, DEFAULT_PACKAGE, 500));

    expect(await validateEpub(filePath)).toEqual({ status: 'invalid', code: 'limit_exceeded' });
  });

  it('overstated: a readable package document is not pre-rejected by a lying header', async () => {
    const bytes = await buildEpub();
    const filePath = await place(patchDeclaredSize(bytes, DEFAULT_PACKAGE, MAX_XML_BYTES + 1_000));

    expect(await validateEpub(filePath)).toEqual({ status: 'available' });
  });
});

// ---------------------------------------------------------------------------

describe('error lifecycle', () => {
  const THROWN: Array<[string, unknown]> = [
    ['EACCES', errno('EACCES')],
    ['EIO', errno('EIO')],
    ['ESTALE', errno('ESTALE')],
    ['EMFILE', errno('EMFILE')],
    ['ENOENT', errno('ENOENT')],
    ['the undocumented ETIMEDOUT', errno('ETIMEDOUT')],
    ['the undocumented ENODEV', errno('ENODEV')],
    ['the undocumented EREMOTEIO', errno('EREMOTEIO')],
  ];

  it.each(THROWN)('propagates %s from lstat', async (_label, value) => {
    h.fsLstat.mockRejectedValueOnce(value);

    await expect(validateEpub('/nowhere.epub')).rejects.toBe(value);
  });

  it.each(THROWN)('propagates %s from Open.custom()', async (_label, value) => {
    const filePath = await place(await buildEpub());
    h.openCustom.mockRejectedValueOnce(value);

    await expect(validateEpub(filePath)).rejects.toBe(value);
  });

  it.each(THROWN)('propagates %s from an entry stream', async (_label, value) => {
    const filePath = await place(await buildEpub());
    const failing = value;
    h.openCustom.mockImplementationOnce(async (source: unknown, options: unknown) => {
      const directory = await (
        h.real.Open.custom as unknown as ReaderCustom
      )(source, options);
      for (const file of directory.files) {
        file.stream = () => {
          const stream = new Readable({ read() {} });
          queueMicrotask(() => stream.emit('error', failing));
          return stream;
        };
      }
      return directory;
    });

    await expect(validateEpub(filePath)).rejects.toBe(failing);
  });

  it('propagates a TypeError from Open.custom() rather than calling the book corrupt', async () => {
    const filePath = await place(await buildEpub());
    const failure = new TypeError('our own defect');
    h.openCustom.mockRejectedValueOnce(failure);

    await expect(validateEpub(filePath)).rejects.toBe(failure);
  });

  it('propagates a ZipSourceProtocolError', async () => {
    const filePath = await place(await buildEpub());
    // A reader returning a different member count than the validated declared
    // count raises `ZipSourceProtocolError` — a dependency-bump signal, never a
    // book verdict.
    h.openCustom.mockResolvedValueOnce({ files: [] });

    await expect(validateEpub(filePath)).rejects.toThrow(/pinned reader returned 0 members/);
  });

  it('reports a coded EIO from Open.custom() as a throw and an uncoded parse error as truncated', async () => {
    const filePath = await place(await buildEpub());
    h.openCustom.mockRejectedValueOnce(errno('EIO'));
    await expect(validateEpub(filePath)).rejects.toThrow(/simulated EIO/);

    h.openCustom.mockRejectedValueOnce(new Error('FILE_ENDED'));
    expect(await validateEpub(filePath)).toEqual({ status: 'invalid', code: 'truncated' });
  });

  it('reports corrupted deflate bytes in a mandatory read as truncated', async () => {
    const bytes = await buildEpub({ packageOptions: { padTo: 4096 } });
    const local = F.localFileHeader(
      bytes,
      F.listCentralDirectory(bytes).findIndex(
        (entry) => entry.rawName.toString('utf8') === DEFAULT_PACKAGE,
      ),
    );
    const corrupted = Buffer.from(bytes);
    // Scramble the middle of the deflate stream: the header still parses, the
    // inflate does not.
    corrupted.fill(0xff, local.dataOffset + 8, local.dataOffset + 40);
    const filePath = await place(corrupted);

    expect(await validateEpub(filePath)).toEqual({ status: 'invalid', code: 'truncated' });
  });

  it('propagates a failure raised while the four-byte signature stream is consumed', async () => {
    const filePath = await place(await buildEpub());
    const failure = errno('EIO');
    h.onRead = async (raw, args) => {
      if (args[3] === 0 && args[2] === 4) throw failure;
      return raw.read(...args);
    };

    await expect(validateEpub(filePath)).rejects.toBe(failure);
    expect(h.openCustom).not.toHaveBeenCalled();
    // Only the signature read happened — the preflight never ran.
    expect(h.reads).toEqual([{ position: 0, length: 4, preOpen: true }]);
    expect(h.handles[0]?.closes).toBe(1);
  });

  const CLOSES: Array<[label: string, run: () => Promise<unknown>]> = [
    ['a success', async () => validateBuilt()],
    ['a structural rejection', async () => validateBuilt({ container: false })],
    [
      'a propagated throw',
      async () => {
        const filePath = await place(await buildEpub());
        h.openCustom.mockRejectedValueOnce(errno('EACCES'));
        return validateEpub(filePath).catch(() => undefined);
      },
    ],
  ];

  it.each(CLOSES)('closes the handle after %s', async (_label, run) => {
    await run();

    expect(h.handles).toHaveLength(1);
    expect(h.handles[0]?.closes).toBe(1);
  });
});

// ---------------------------------------------------------------------------

describe('the encryption.xml classifier', () => {
  const FONTS = 'OEBPS/Fonts';

  /** The real library EPUB's shape: Adobe RC obfuscation over manifest-declared fonts. */
  function adobeFontShape(count = 4): EpubOptions {
    const fonts = Array.from({ length: count }, (_, index) => ({
      id: `font${index}`,
      href: `Fonts/f${index}.ttf`,
      mediaType: 'font/ttf',
    }));
    return {
      packageOptions: {
        items: [
          { id: 'ch1', href: 'ch1.xhtml', mediaType: 'application/xhtml+xml' },
          { id: 'ch2', href: 'ch2.xhtml', mediaType: 'application/xhtml+xml' },
          ...fonts,
        ],
        itemrefs: [{ idref: 'ch1' }, { idref: 'ch2' }],
      },
      files: [
        { name: 'OEBPS/ch2.xhtml', content: XHTML },
        ...fonts.map((font) => ({ name: `OEBPS/${font.href}`, content: 'font-bytes' })),
      ],
      encryption: encryptionXml(fonts.map((font) => ({ uri: `${FONTS}/${path.posix.basename(font.href)}` }))),
    };
  }

  it('validates the real library EPUBs shape as available', async () => {
    expect(await validateBuilt(adobeFontShape())).toEqual({ status: 'available' });
  });

  it('treats an EPUB with no encryption.xml as unaffected', async () => {
    expect(await validateBuilt()).toEqual({ status: 'available' });
  });

  it('accepts IDPF embedding obfuscation over otf and woff2 fonts', async () => {
    const result = await validateBuilt({
      packageOptions: {
        items: [
          ...DEFAULT_ITEMS,
          { id: 'f1', href: 'Fonts/a.otf', mediaType: 'font/otf' },
          { id: 'f2', href: 'Fonts/b.woff2', mediaType: 'font/woff2' },
        ],
      },
      files: [
        { name: `${FONTS}/a.otf`, content: 'otf' },
        { name: `${FONTS}/b.woff2`, content: 'woff2' },
      ],
      encryption: encryptionXml([
        { uri: `${FONTS}/a.otf`, algorithm: IDPF_ALGORITHM },
        { uri: `${FONTS}/b.woff2`, algorithm: IDPF_ALGORITHM },
      ]),
    });

    expect(result).toEqual({ status: 'available' });
  });

  it('reports drm_protected for an encrypted spine document named chapter.ttf', async () => {
    // The extension says font; the manifest media type and the spine say content.
    const result = await validateBuilt({
      packageOptions: {
        items: [{ id: 'ch1', href: 'chapter.ttf', mediaType: 'application/xhtml+xml' }],
      },
      files: [{ name: 'OEBPS/chapter.ttf', content: XHTML }],
      encryption: encryptionXml([{ uri: 'OEBPS/chapter.ttf' }]),
    });

    expect(result).toEqual({ status: 'drm_protected' });
  });

  it('reports drm_protected for an encrypted font no manifest item declares', async () => {
    const result = await validateBuilt({
      files: [{ name: `${FONTS}/orphan.ttf`, content: 'font' }],
      encryption: encryptionXml([{ uri: `${FONTS}/orphan.ttf` }]),
    });

    expect(result).toEqual({ status: 'drm_protected' });
  });

  it('accepts a manifest-declared font whose archive name is upper-case', async () => {
    const result = await validateBuilt({
      packageOptions: {
        items: [...DEFAULT_ITEMS, { id: 'f1', href: 'FONT.TTF', mediaType: 'font/ttf' }],
      },
      files: [{ name: 'OEBPS/FONT.TTF', content: 'font' }],
      encryption: encryptionXml([{ uri: 'OEBPS/FONT.TTF' }]),
    });

    expect(result).toEqual({ status: 'available' });
  });

  const MEDIA_TYPES = [
    'font/ttf',
    'font/otf',
    'font/woff',
    'font/woff2',
    'application/font-sfnt',
    'application/vnd.ms-opentype',
    'application/font-woff',
    'application/x-font-ttf',
    'FONT/TTF',
    ' font/ttf ',
  ];

  it.each(MEDIA_TYPES)('accepts an encrypted unspined item with media-type %s', async (mediaType) => {
    const result = await validateBuilt({
      packageOptions: {
        items: [...DEFAULT_ITEMS, { id: 'f1', href: 'Fonts/a.bin', mediaType }],
      },
      files: [{ name: `${FONTS}/a.bin`, content: 'font' }],
      encryption: encryptionXml([{ uri: `${FONTS}/a.bin` }]),
    });

    expect(result).toEqual({ status: 'available' });
  });

  it('rejects a font media type carrying a parameter suffix', async () => {
    const result = await validateBuilt({
      packageOptions: {
        items: [...DEFAULT_ITEMS, { id: 'f1', href: 'Fonts/a.ttf', mediaType: 'font/ttf; charset=utf-8' }],
      },
      files: [{ name: `${FONTS}/a.ttf`, content: 'font' }],
      encryption: encryptionXml([{ uri: `${FONTS}/a.ttf` }]),
    });

    expect(result).toEqual({ status: 'drm_protected' });
  });

  it('reports drm_protected for a font referenced by a linear="no" itemref', async () => {
    const result = await validateBuilt({
      packageOptions: {
        items: [...DEFAULT_ITEMS, { id: 'f1', href: 'Fonts/a.ttf', mediaType: 'font/ttf' }],
        itemrefs: [{ idref: 'ch1' }, { idref: 'f1', linear: 'no' }],
      },
      files: [{ name: `${FONTS}/a.ttf`, content: 'font' }],
      encryption: encryptionXml([{ uri: `${FONTS}/a.ttf` }]),
    });

    expect(result).toEqual({ status: 'drm_protected' });
  });

  const ALIAS_FONT = { id: 'font-id', href: 'Fonts/a.ttf', mediaType: 'font/ttf' };
  // A syntactically different spelling that `resolveHref` maps to the same key,
  // so an implementation grouping by the raw attribute fails here.
  const ALIAS_CHAPTER = { id: 'chapter-id', href: 'Fonts/./a.ttf', mediaType: 'application/xhtml+xml' };

  it.each([
    ['font first', [ALIAS_FONT, ALIAS_CHAPTER]],
    ['chapter first', [ALIAS_CHAPTER, ALIAS_FONT]],
  ] as Array<[string, ManifestItem[]]>)(
    'reports drm_protected for conflicting manifest aliases — %s',
    async (_label, aliases) => {
      const result = await validateBuilt({
        packageOptions: {
          items: [...DEFAULT_ITEMS, ...aliases],
          itemrefs: [{ idref: 'ch1' }, { idref: 'chapter-id' }],
        },
        files: [{ name: `${FONTS}/a.ttf`, content: 'font' }],
        encryption: encryptionXml([{ uri: `${FONTS}/a.ttf` }]),
      });

      expect(result).toEqual({ status: 'drm_protected' });
    },
  );

  it('accepts two unspined font aliases resolving to one entry', async () => {
    const result = await validateBuilt({
      packageOptions: {
        items: [
          ...DEFAULT_ITEMS,
          { id: 'font-a', href: 'Fonts/a.ttf', mediaType: 'font/ttf' },
          { id: 'font-b', href: 'Fonts/./a.ttf', mediaType: 'font/otf' },
        ],
      },
      files: [{ name: `${FONTS}/a.ttf`, content: 'font' }],
      encryption: encryptionXml([{ uri: `${FONTS}/a.ttf` }]),
    });

    expect(result).toEqual({ status: 'available' });
  });

  const NON_FONTS: Array<[label: string, mediaType: string, name: string]> = [
    ['a stylesheet', 'text/css', 'style.css'],
    ['a cover image', 'image/png', 'cover.png'],
    ['a script', 'text/javascript', 'app.js'],
    ['an audio resource', 'audio/mpeg', 'clip.mp3'],
  ];

  it.each(NON_FONTS)('reports drm_protected for %s', async (_label, mediaType, name) => {
    const result = await validateBuilt({
      packageOptions: {
        items: [...DEFAULT_ITEMS, { id: 'res', href: name, mediaType }],
      },
      files: [{ name: `OEBPS/${name}`, content: 'bytes' }],
      encryption: encryptionXml([{ uri: `OEBPS/${name}` }]),
    });

    expect(result).toEqual({ status: 'drm_protected' });
  });

  it('reports drm_protected for a URI naming an entry absent from the archive', async () => {
    expect(await validateBuilt({ encryption: encryptionXml([{ uri: 'OEBPS/ghost.ttf' }]) })).toEqual({
      status: 'drm_protected',
    });
  });

  it('reports drm_protected when every content document is encrypted', async () => {
    const result = await validateBuilt({
      packageOptions: {
        items: [
          { id: 'ch1', href: 'ch1.xhtml', mediaType: 'application/xhtml+xml' },
          { id: 'ch2', href: 'ch2.xhtml', mediaType: 'application/xhtml+xml' },
        ],
        itemrefs: [{ idref: 'ch1' }, { idref: 'ch2' }],
      },
      files: [{ name: 'OEBPS/ch2.xhtml', content: XHTML }],
      encryption: encryptionXml([{ uri: 'OEBPS/ch1.xhtml' }, { uri: 'OEBPS/ch2.xhtml' }]),
    });

    expect(result).toEqual({ status: 'drm_protected' });
  });

  it('finds a reference through a namespace-prefixed spelling', async () => {
    const result = await validateBuilt({
      packageOptions: {
        items: [...DEFAULT_ITEMS, { id: 'f1', href: 'Fonts/a.ttf', mediaType: 'font/ttf' }],
      },
      files: [{ name: `${FONTS}/a.ttf`, content: 'font' }],
      encryption: encryptionXml([{ uri: `${FONTS}/a.ttf`, prefix: 'enc' }]),
    });

    expect(result).toEqual({ status: 'available' });
  });

  const MALFORMED: Array<[label: string, spec: CipherSpec]> = [
    ['an EncryptedData carrying no CipherReference', { withoutReference: true }],
    ['a CipherReference with no URI attribute', {}],
    ['a CipherReference with an empty URI', { uri: '' }],
    ['a CipherReference carrying only a prefixed enc:URI', { uri: 'OEBPS/ch1.xhtml', uriAttributeName: 'enc:URI' }],
  ];

  it.each(MALFORMED)('reports malformed_xml for %s', async (_label, spec) => {
    expect(await validateBuilt({ encryption: encryptionXml([spec]) })).toEqual({
      status: 'invalid',
      code: 'malformed_xml',
    });
  });

  it('reports malformed_xml for an encryption.xml with the wrong root element', async () => {
    expect(await validateBuilt({ encryption: '<?xml version="1.0"?><nope/>' })).toEqual({
      status: 'invalid',
      code: 'malformed_xml',
    });
  });

  it('reports malformed_xml for an encryption.xml that does not decode', async () => {
    // A lone 0xFF byte is not legal UTF-8 and has no BOM, so the fatal decoder
    // rejects it before the parser ever runs.
    expect(await validateBuilt({ encryption: Buffer.from([0x3c, 0xff, 0xfe, 0x21]) })).toEqual({
      status: 'invalid',
      code: 'malformed_xml',
    });
  });
});

// ---------------------------------------------------------------------------

describe('encryption — mixed-reference precedence', () => {
  const COVER = { id: 'cover', href: 'cover.png', mediaType: 'image/png' };
  const FONT = { id: 'f1', href: 'Fonts/a.ttf', mediaType: 'font/ttf' };

  async function classify(specs: CipherSpec[]): Promise<EpubValidation> {
    return validateBuilt({
      packageOptions: { items: [...DEFAULT_ITEMS, COVER, FONT] },
      files: [
        { name: 'OEBPS/cover.png', content: 'png' },
        { name: 'OEBPS/Fonts/a.ttf', content: 'font' },
      ],
      encryption: encryptionXml(specs),
    });
  }

  const COVER_REF: CipherSpec = { uri: 'OEBPS/cover.png' };
  const FONT_REF: CipherSpec = { uri: 'OEBPS/Fonts/a.ttf' };
  const MISSING_URI: CipherSpec = {};
  const TRAVERSAL: CipherSpec = { uri: '../x.ttf' };
  const REMOTE: CipherSpec = { uri: 'https://example.test/x.ttf' };

  const PAIRS: Array<[label: string, specs: CipherSpec[], expected: EpubValidation]> = [
    ['cover + missing URI', [COVER_REF, MISSING_URI], { status: 'invalid', code: 'malformed_xml' }],
    ['cover + traversal', [COVER_REF, TRAVERSAL], { status: 'invalid', code: 'unsafe_entry_path' }],
    ['cover + remote', [COVER_REF, REMOTE], { status: 'invalid', code: 'unsafe_entry_path' }],
    ['missing URI + traversal', [MISSING_URI, TRAVERSAL], { status: 'invalid', code: 'malformed_xml' }],
    ['font + cover', [FONT_REF, COVER_REF], { status: 'drm_protected' }],
    ['font + font', [FONT_REF, FONT_REF], { status: 'available' }],
  ];

  it.each(PAIRS)('resolves %s by the total order', async (_label, specs, expected) => {
    expect(await classify(specs)).toEqual(expected);
  });

  it('scans totally rather than stopping at the first match', async () => {
    // The font reference comes first in document order; a first-match
    // implementation would return `available`.
    expect(await classify([FONT_REF, TRAVERSAL])).toEqual({
      status: 'invalid',
      code: 'unsafe_entry_path',
    });
  });
});

// ---------------------------------------------------------------------------

describe('the inspection budget', () => {
  it('holds the arithmetic that makes cumulative exhaustion unreachable here', () => {
    // `validateEpub` performs at most four mandatory reads — `mimetype`,
    // `container.xml`, the package document, `encryption.xml` — each ceilinged at
    // `MAX_XML_BYTES`. This equality is why the worst case consumes the budget
    // exactly and never crosses it, so `cap-exceeded` is reachable here only from
    // a single oversized read. Retune either constant and that reasoning stops
    // being true — this assertion is what says so.
    expect(4 * MAX_XML_BYTES).toBe(MAX_INSPECTION_BYTES);
  });

  it('charges four exactly-MAX_XML_BYTES reads once each, consuming the budget exactly', async () => {
    // An implementation that double-charges drives the remainder to zero after
    // the second read, caps the third at 0, and returns `limit_exceeded`.
    const result = await validateBuilt({
      mimetype: padTo(EPUB_MEDIA_TYPE, MAX_XML_BYTES),
      container: padTo(containerXml(DEFAULT_PACKAGE), MAX_XML_BYTES),
      packageOptions: { padTo: MAX_XML_BYTES },
      encryption: encryptionXml([], { padTo: MAX_XML_BYTES }),
    });

    expect(result).toEqual({ status: 'available' });
  });
});

// ---------------------------------------------------------------------------

describe('public surface and guardrails', () => {
  it('exports validateEpub and nothing else at runtime', async () => {
    const module = await import('./validate.js');

    // `validateEpub` is the only function this issue adds that accepts a `string`
    // path — and the only runtime export at all. The shared pipeline, the
    // structure, its budget, and the encryption classifier are private, so no
    // caller can name a context, hold one, or close one (Decision 1).
    expect(Object.keys(module)).toEqual(['validateEpub']);
    expect(module.validateEpub.length).toBe(1);
  });

  it('exports no type either, so the internal structure cannot escape the open', async () => {
    // Type-only exports are erased at runtime, so the runtime check above cannot
    // see them — this is the assertion that catches a re-added
    // `export type EpubStructure` or a re-exported continuation seam. The
    // structure is only valid inside `runEpubPipeline`'s callback; an exported
    // continuation with an unconstrained return type would let a caller write
    // `pipeline(path, async (outcome) => outcome)` and receive the structure
    // *after* `withZipSource` ran its closing `finally`.
    const { readFile } = await import('node:fs/promises');
    const source = await readFile(path.join(import.meta.dirname, 'validate.ts'), 'utf8');
    const exported = source
      .split('\n')
      .filter((line) => /^export\b/.test(line))
      .map((line) => line.trim());

    expect(exported).toEqual(['export async function validateEpub(filePath: string): Promise<EpubValidation> {']);
  });

  it('never reads the cover entry while validating', async () => {
    const result = await validateBuilt({
      packageOptions: {
        items: [
          ...DEFAULT_ITEMS,
          { id: 'cover', href: 'cover.png', mediaType: 'image/png', properties: 'cover-image' },
        ],
      },
      files: [{ name: 'OEBPS/cover.png', content: Buffer.from([0x89, 0x50, 0x4e, 0x47]) }],
    });

    expect(result).toEqual({ status: 'available' });
    expect(h.streamed).toEqual(['mimetype', 'META-INF/container.xml', DEFAULT_PACKAGE]);
  });

  it('is picked up by the folder layer guard with no edit to its named-file list', async () => {
    const { readdir, readFile } = await import('node:fs/promises');
    const scanned = (await readdir(import.meta.dirname, { recursive: true })).filter(
      (entry) => entry.endsWith('.ts') && !entry.endsWith('.test.ts'),
    );
    const guard = await readFile(path.join(import.meta.dirname, 'layer-guard.test.ts'), 'utf8');

    expect(scanned).toContain('validate.ts');
    // `arrayContaining` over a named list, so a new production module extends the
    // guard's reach without editing it.
    expect(guard).toContain('expect.arrayContaining');
    expect(guard).not.toContain("'validate.ts'");
  });

  it('leaves the ebook-only search guard byte-for-byte unchanged', async () => {
    const { readFile } = await import('node:fs/promises');
    const source = await readFile(
      path.join(import.meta.dirname, '../../server/services/search-pipeline.ts'),
      'utf8',
    );

    // Narratorr *observes* an ebook the owner placed beside an audiobook; it
    // never *acquires* one. This slate must not relax that gate.
    expect(source).toContain(
      'const EBOOK_FORMAT_RE = /(?<![a-zA-Z\\d])(azw3|epub|pdf|mobi)(?![a-zA-Z\\d])/i;',
    );
  });
});
