import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { MAX_XML_BYTES } from './limits.js';
import {
  parseEpubXml,
  localName,
  hasLocalName,
  childrenByLocalName,
  attrByLocalName,
  attrByExactName,
  type EpubXmlResult,
} from './xml.js';

/**
 * `xml.ts` takes bytes, so every fixture below is a buffer built inline — no
 * archive, no fixture builder, no stream harness (#1987 Decision 6).
 */

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const UTF16LE_BOM = Buffer.from([0xff, 0xfe]);
const UTF16BE_BOM = Buffer.from([0xfe, 0xff]);

const utf8 = (doc: string): Buffer => Buffer.from(doc, 'utf8');
const utf8WithBom = (doc: string): Buffer => Buffer.concat([UTF8_BOM, utf8(doc)]);
const utf16le = (doc: string): Buffer => Buffer.concat([UTF16LE_BOM, Buffer.from(doc, 'utf16le')]);
const utf16be = (doc: string): Buffer =>
  Buffer.concat([UTF16BE_BOM, Buffer.from(doc, 'utf16le').swap16()]);

const PACKAGE_DOC = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="pub-id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>Sample Title</dc:title>
  </metadata>
  <manifest>
    <item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
  </manifest>
  <spine><itemref idref="c1" linear="yes"/></spine>
</package>`;

const CONTAINER_DOC = `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`;

/** Read the package title through the exported helpers — this also exercises parent-scoped selection. */
function readTitle(result: EpubXmlResult): string | null {
  if (result.kind !== 'document') return null;
  const metadata = childrenByLocalName(result.$, result.root, 'metadata')[0];
  if (!metadata) return null;
  const title = childrenByLocalName(result.$, metadata, 'title')[0];
  return title ? result.$(title).text() : null;
}

/** The single element of a one-element document, for the helper-level tests. */
function soleElement(doc: string) {
  const result = parseEpubXml(utf8(doc), 'package');
  if (result.kind !== 'document') throw new Error(`fixture did not parse: ${result.code}`);
  return { $: result.$, root: result.root };
}

describe('parseEpubXml — the encoding ladder', () => {
  // One case per row of the four-row ladder. All four carry the same document
  // and must produce the same parse; row 1 is explicit and separate because it
  // is the row most easily lost to "UTF-8 is the default anyway".
  const rows: Array<[label: string, encode: (doc: string) => Buffer]> = [
    ['row 1 — UTF-8 BOM', utf8WithBom],
    ['row 2 — UTF-16LE BOM', utf16le],
    ['row 3 — UTF-16BE BOM', utf16be],
    ['row 4 — no BOM', utf8],
  ];

  it.each(rows)('%s parses a package document identically', (_label, encode) => {
    const result = parseEpubXml(encode(PACKAGE_DOC), 'package');
    expect(result.kind).toBe('document');
    expect(readTitle(result)).toBe('Sample Title');
  });

  it.each(rows)('%s parses a container document identically', (_label, encode) => {
    const result = parseEpubXml(encode(CONTAINER_DOC), 'container');
    expect(result.kind).toBe('document');
  });

  it('never lets a BOM survive into the parsed root name', () => {
    // `TextDecoder` strips the BOM (`ignoreBOM` defaults to false); a surviving
    // U+FEFF would survive into the root local name and fail this assertion.
    for (const [, encode] of rows) {
      const result = parseEpubXml(encode('<package/>'), 'package');
      if (result.kind !== 'document') throw new Error('expected a document');
      expect(result.root.name).toBe('package');
    }
  });
});

describe('parseEpubXml — the declared encoding label is never read', () => {
  // Decision 5. An earlier revision of this spec scanned the XML declaration and
  // kept an alias allowlist; doing so marked `invalid` books that decode and
  // parse perfectly, which is the exact failure mode §4 exists to prevent. The
  // bytes are the evidence; the label is only what the author claimed.
  const misleading: Array<[label: string, declaration: string]> = [
    ["Shift_JIS in single quotes", `<?xml version='1.0' encoding='Shift_JIS'?>`],
    ['ISO-8859-1', `<?xml version="1.0" encoding="ISO-8859-1"?>`],
    ['UTF-16', `<?xml version="1.0" encoding="UTF-16"?>`],
  ];

  it.each(misleading)('parses ASCII bytes declaring %s', (_label, declaration) => {
    const declared = parseEpubXml(utf8(`${declaration}<package><metadata><dc:title>Sample Title</dc:title></metadata></package>`), 'package');
    const twin = parseEpubXml(utf8(`<package><metadata><dc:title>Sample Title</dc:title></metadata></package>`), 'package');
    expect(declared.kind).toBe('document');
    expect(readTitle(declared)).toBe(readTitle(twin));
  });

  it('rejects real Latin-1 bytes on the byte evidence, not on the label', () => {
    // Declares ISO-8859-1 and actually carries 0xE9. Rejected by fatal UTF-8
    // decoding — the label plays no part in the decision either way.
    const bytes = Buffer.concat([
      utf8(`<?xml version="1.0" encoding="ISO-8859-1"?><package><metadata><dc:title>Caf`),
      Buffer.from([0xe9]),
      utf8(`</dc:title></metadata></package>`),
    ]);
    expect(parseEpubXml(bytes, 'package')).toEqual({ kind: 'rejected', code: 'malformed_xml' });
  });
});

describe('parseEpubXml — decoding is fatal', () => {
  const fatal: Array<[label: string, bytes: Buffer]> = [
    ['a UTF-8 document with an invalid byte sequence', Buffer.concat([utf8('<package>'), Buffer.from([0xc3, 0x28]), utf8('</package>')])],
    ['a UTF-16LE-BOM buffer of odd length', Buffer.concat([UTF16LE_BOM, Buffer.from([0x3c, 0x00, 0x61])])],
    ['a UTF-16LE-BOM buffer with an unpaired surrogate', Buffer.concat([UTF16LE_BOM, Buffer.from([0x3c, 0x00, 0x00, 0xd8])])],
    // Pins that fatal mode bites on the big-endian decoder too, not only utf-8.
    ['a UTF-16BE-BOM buffer with a lone trailing byte', Buffer.concat([UTF16BE_BOM, Buffer.from([0x00, 0x3c, 0x00])])],
  ];

  it.each(fatal)('rejects %s as malformed_xml', (_label, bytes) => {
    expect(parseEpubXml(bytes, 'package')).toEqual({ kind: 'rejected', code: 'malformed_xml' });
  });
});

describe('parseEpubXml — row 4 needs no companion row', () => {
  // These three exist to prove the unconditional residual arm handles every
  // NUL-leading and UTF-32-shaped input without a special case.
  it('rejects a UTF-32BE BOM through fatal UTF-8 decoding', () => {
    // `00 00 FE FF` takes row 4, and `FE`/`FF` are not legal UTF-8 bytes.
    const bytes = Buffer.concat([Buffer.from([0x00, 0x00, 0xfe, 0xff]), utf8('<package/>')]);
    expect(parseEpubXml(bytes, 'package')).toEqual({ kind: 'rejected', code: 'malformed_xml' });
  });

  it('rejects a UTF-32LE BOM through the root check', () => {
    // `FF FE 00 00` takes row 2 and decodes to leading NUL characters, which
    // yield zero root element children.
    const bytes = Buffer.from([0xff, 0xfe, 0x00, 0x00]);
    expect(parseEpubXml(bytes, 'package')).toEqual({ kind: 'rejected', code: 'malformed_xml' });
  });

  it('rejects BOM-less UTF-16, deliberately', () => {
    // XML 1.0 Annex F requires a UTF-16 entity to begin with a BOM, so this
    // document is non-conforming. It takes row 4, decodes as UTF-8 into a
    // NUL-interleaved string, and its root local name is not `package`.
    const bytes = Buffer.from('<package/>', 'utf16le');
    const nulInterleaved = '\u0000p\u0000a\u0000c\u0000k\u0000a\u0000g\u0000e\u0000';
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    expect(decoded.startsWith(`<${nulInterleaved}`)).toBe(true);
    expect(localName(nulInterleaved)).not.toBe('package');
    expect(parseEpubXml(bytes, 'package')).toEqual({ kind: 'rejected', code: 'malformed_xml' });
  });
});

describe('parseEpubXml — the byte cap', () => {
  // Defence in depth only. It fires after the bytes exist, so it bounds parsing
  // rather than inflation and cannot prove the 4 MiB inflated-before-parse
  // invariant — that belongs to whichever issue closes the slate's read-cap
  // obligation (#1987 "Unassigned slate obligation").
  const HEAD = '<package><metadata><dc:title>T</dc:title></metadata>';
  const TAIL = '</package>';

  function documentOfExactly(bytes: number): Buffer {
    const buffer = utf8(HEAD + ' '.repeat(bytes - HEAD.length - TAIL.length) + TAIL);
    expect(buffer.length).toBe(bytes);
    return buffer;
  }

  it('accepts a document of exactly MAX_XML_BYTES', () => {
    const result = parseEpubXml(documentOfExactly(MAX_XML_BYTES), 'package');
    expect(result.kind).toBe('document');
    expect(readTitle(result)).toBe('T');
  });

  it('rejects one byte over as limit_exceeded, not malformed_xml', () => {
    // Strictly `>`, matching `counting-stream.ts:77-86` so the two cannot disagree.
    expect(parseEpubXml(documentOfExactly(MAX_XML_BYTES + 1), 'package')).toEqual({
      kind: 'rejected',
      code: 'limit_exceeded',
    });
  });
});

describe('parseEpubXml — the root check', () => {
  const malformed: Array<[label: string, bytes: Buffer]> = [
    ['plain text with no markup', utf8('hello world')],
    ['empty content', utf8('')],
    ['binary bytes', Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00])],
    ['an unterminated attribute', utf8('<package foo="bar>')],
    ['two sibling root elements', utf8('<package/><package/>')],
  ];

  it.each(malformed)('rejects %s', (_label, bytes) => {
    expect(parseEpubXml(bytes, 'package')).toEqual({ kind: 'rejected', code: 'malformed_xml' });
  });

  it('rejects a root whose local name is not the expected one', () => {
    expect(parseEpubXml(utf8('<html/>'), 'package')).toEqual({ kind: 'rejected', code: 'malformed_xml' });
  });

  it('counts element children only, so a prolog does not reject a real EPUB file', () => {
    // An XML declaration, a DOCTYPE, a comment, and leading whitespace are all
    // non-element nodes. Every real EPUB document carries at least the first.
    const doc = `<?xml version="1.0" encoding="utf-8"?>\n<!DOCTYPE package>\n<!-- generated -->\n  <package/>`;
    const result = parseEpubXml(utf8(doc), 'package');
    expect(result.kind).toBe('document');
  });

  it('accepts every expected root name across the slate', () => {
    const roots: Array<['container' | 'package' | 'encryption' | 'ncx' | 'html', string]> = [
      ['container', '<container/>'],
      ['package', '<package/>'],
      ['encryption', '<encryption/>'],
      ['ncx', '<ncx/>'],
      ['html', '<html/>'],
    ];
    for (const [expected, doc] of roots) {
      expect(parseEpubXml(utf8(doc), expected).kind).toBe('document');
    }
  });

  it('accepts a repaired unclosed root that still presents its content', () => {
    // htmlparser2 silently repairs this and cannot report the damage, so a
    // well-formedness verdict is not available to us (Decision 1). Tag-soup
    // tolerance is also the product-correct answer — a readable book must not
    // be marked `invalid`.
    const doc = `<package><metadata><dc:title>Repaired</dc:title></metadata><manifest><item id="c1"/></manifest><spine><itemref idref="c1"/>`;
    const result = parseEpubXml(utf8(doc), 'package');
    expect(result.kind).toBe('document');
    expect(readTitle(result)).toBe('Repaired');
    if (result.kind !== 'document') throw new Error('expected a document');
    expect(childrenByLocalName(result.$, result.root, 'manifest')).toHaveLength(1);
    expect(childrenByLocalName(result.$, result.root, 'spine')).toHaveLength(1);
  });
});

describe('parseEpubXml — never throws', () => {
  const hostile: Array<[label: string, bytes: Buffer]> = [
    ['plain text', utf8('hello world')],
    ['an empty buffer', Buffer.alloc(0)],
    ['a one-byte buffer', Buffer.from([0x41])],
    ['a lone <', utf8('<')],
    ['a lone >', utf8('>')],
    ['an unterminated attribute', utf8('<package foo="bar>')],
    ['two sibling roots', utf8('<a/><b/>')],
    ['random bytes', Buffer.from([0xde, 0xad, 0xbe, 0xef, 0x00, 0xff, 0x7f, 0x80])],
    ['NUL bytes', Buffer.alloc(64)],
    ['a UTF-16LE BOM alone', UTF16LE_BOM],
    ['a UTF-16BE BOM alone', UTF16BE_BOM],
    ['a UTF-8 BOM alone', UTF8_BOM],
  ];

  it.each(hostile)('returns a result for %s', (_label, bytes) => {
    const result = parseEpubXml(bytes, 'package');
    expect(['document', 'rejected']).toContain(result.kind);
  });
});

describe('parseEpubXml — plain Uint8Array input', () => {
  // `Buffer` extends `Uint8Array` while also exposing Buffer-only methods, so a
  // Buffer-only suite would pass even if the module accidentally depended on
  // one. Both arms are exercised with a value that is not a Buffer.
  it('parses a plain Uint8Array identically to the Buffer twin', () => {
    const buffer = utf8(PACKAGE_DOC);
    const plain = new Uint8Array(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength));
    expect(Buffer.isBuffer(plain)).toBe(false);
    expect(readTitle(parseEpubXml(plain, 'package'))).toBe('Sample Title');
  });

  it('rejects a plain Uint8Array on the failure path identically', () => {
    const plain = new Uint8Array([0x3c, 0x2f]); // `</`
    expect(Buffer.isBuffer(plain)).toBe(false);
    expect(parseEpubXml(plain, 'package')).toEqual({ kind: 'rejected', code: 'malformed_xml' });
  });
});

describe('localName', () => {
  it.each([
    ['package', 'package'],
    ['opf:package', 'package'],
    ['dc:title', 'title'],
    ['a:b:c', 'c'],
    [':leading', 'leading'],
    ['trailing:', ''],
  ])('reduces %s to %s', (qualified, expected) => {
    expect(localName(qualified)).toBe(expected);
  });
});

describe('element matching by local name', () => {
  const prefixed: Array<[label: string, root: 'container' | 'package' | 'encryption' | 'ncx' | 'html', doc: string]> = [
    ['a prefixed package', 'package', '<opf:package xmlns:opf="http://www.idpf.org/2007/opf"><opf:manifest/><opf:spine/></opf:package>'],
    ['a prefixed container', 'container', '<ocf:container xmlns:ocf="urn:oasis:names:tc:opendocument:xmlns:container"><ocf:rootfiles/></ocf:container>'],
    ['a prefixed encryption document', 'encryption', '<enc:encryption xmlns:enc="urn:oasis:names:tc:opendocument:xmlns:container"/>'],
    ['a prefixed NCX', 'ncx', '<ncx:ncx xmlns:ncx="http://www.daisy.org/z3986/2005/ncx/"/>'],
  ];

  it.each(prefixed)('%s parses exactly as its unprefixed twin', (_label, root, doc) => {
    expect(parseEpubXml(utf8(doc), root).kind).toBe('document');
  });

  it('matches a dcterms-prefixed title through the same scoped lookup', () => {
    const result = parseEpubXml(
      utf8('<package><metadata xmlns:dcterms="http://purl.org/dc/terms/"><dcterms:title>Prefixed</dcterms:title></metadata></package>'),
      'package',
    );
    expect(readTitle(result)).toBe('Prefixed');
  });

  it('matches an unprefixed title through the same scoped lookup', () => {
    const result = parseEpubXml(utf8('<package><metadata><title>Bare</title></metadata></package>'), 'package');
    expect(readTitle(result)).toBe('Bare');
  });

  it('compares case-sensitively', () => {
    // `xmlMode` leaves `lowerCaseTags` off, so `OPF:Package` reaches the helper
    // with its case intact. This test fails loudly if that is ever switched on.
    expect(parseEpubXml(utf8('<OPF:Package/>'), 'package')).toEqual({ kind: 'rejected', code: 'malformed_xml' });
    const { root } = soleElement('<package/>');
    expect(hasLocalName(root, 'package')).toBe(true);
    expect(hasLocalName(root, 'Package')).toBe(false);
  });

  it('accepts a qualified expected name on either side', () => {
    const { root } = soleElement('<opf:package/>');
    expect(hasLocalName(root, 'package')).toBe(true);
    expect(hasLocalName(root, 'x:package')).toBe(true);
  });
});

describe('childrenByLocalName — selection is scoped to the expected parent', () => {
  it('does not return a title that is not a direct child of metadata', () => {
    const result = parseEpubXml(
      utf8('<package><metadata/><other><title>Not mine</title></other></package>'),
      'package',
    );
    if (result.kind !== 'document') throw new Error('expected a document');
    const metadata = childrenByLocalName(result.$, result.root, 'metadata')[0]!;
    expect(childrenByLocalName(result.$, metadata, 'title')).toEqual([]);
    expect(readTitle(result)).toBeNull();
  });

  it('does not reach through an intermediate element', () => {
    const result = parseEpubXml(
      utf8('<package><metadata><wrapper><dc:title>Buried</dc:title></wrapper></metadata></package>'),
      'package',
    );
    expect(readTitle(result)).toBeNull();
  });

  it('returns every matching direct child in source order', () => {
    const { $, root } = soleElement('<package><metadata><dc:title>One</dc:title><title>Two</title></metadata></package>');
    const metadata = childrenByLocalName($, root, 'metadata')[0]!;
    expect(childrenByLocalName($, metadata, 'title').map((el) => $(el).text())).toEqual(['One', 'Two']);
  });
});

describe('attribute matching', () => {
  it('matches a prefixed attribute by local name', () => {
    const { $, root } = soleElement('<package><nav ops:type="toc"/></package>');
    const nav = childrenByLocalName($, root, 'nav')[0]!;
    expect(attrByLocalName(nav, 'epub:type')).toBe('toc');
    expect(attrByLocalName(nav, 'type')).toBe('toc');
  });

  it('matches a bare attribute by local name', () => {
    const { $, root } = soleElement('<package><nav type="toc"/></package>');
    const nav = childrenByLocalName($, root, 'nav')[0]!;
    expect(attrByLocalName(nav, 'epub:type')).toBe('toc');
  });

  it('matches a prefixed role by local name', () => {
    const { $, root } = soleElement('<package><contributor opf:role="nrt"/></package>');
    const contributor = childrenByLocalName($, root, 'contributor')[0]!;
    expect(attrByLocalName(contributor, 'role')).toBe('nrt');
  });

  it('returns undefined when nothing matches', () => {
    const { $, root } = soleElement('<package><nav id="x"/></package>');
    const nav = childrenByLocalName($, root, 'nav')[0]!;
    expect(attrByLocalName(nav, 'type')).toBeUndefined();
  });

  it('reads spec-unprefixed attributes by their exact name', () => {
    // `properties` is spec-defined unprefixed, so `opf:properties` denotes a
    // different attribute and must not satisfy a `properties` lookup.
    const { $, root } = soleElement('<package><item opf:properties="nav" href="nav.xhtml"/></package>');
    const item = childrenByLocalName($, root, 'item')[0]!;
    expect(attrByExactName(item, 'properties')).toBeUndefined();
    expect(attrByExactName(item, 'href')).toBe('nav.xhtml');
  });
});

describe('attribute local-name collisions resolve deterministically', () => {
  // One element can legally carry `ops:type`, `epub:type`, and bare `type` at
  // once and the parser retains all three. This group exists so 1.1e's TOC and
  // role classification depends on a documented policy rather than on
  // htmlparser2's object key ordering.
  function navAttr(markup: string): string | undefined {
    const { $, root } = soleElement(`<package>${markup}</package>`);
    const nav = childrenByLocalName($, root, 'nav')[0]!;
    return attrByLocalName(nav, 'type');
  }

  it('prefers the exact unprefixed name over every prefixed candidate', () => {
    expect(navAttr('<nav ops:type="a" epub:type="b" type="c"/>')).toBe('c');
  });

  it('falls back to the first prefixed candidate in source order', () => {
    expect(navAttr('<nav ops:type="a" epub:type="b"/>')).toBe('a');
    expect(navAttr('<nav epub:type="b" ops:type="a"/>')).toBe('b');
  });
});

describe('XXE regression guards', () => {
  // These three pass trivially today: cheerio's backend (htmlparser2) performs
  // no DTD or entity resolution at all. They are kept permanently to fail
  // loudly if the parser is ever swapped for one that does — that would
  // reintroduce a file-read primitive into a process whose config directory
  // holds `secret.key` (design §4).
  let scratchDir: string | null = null;

  afterEach(async () => {
    if (scratchDir) await rm(scratchDir, { recursive: true, force: true });
    scratchDir = null;
  });

  it('does not expand a SYSTEM file entity', async () => {
    scratchDir = await mkdtemp(path.join(tmpdir(), 'narratorr-xxe-'));
    const secretPath = path.join(scratchDir, 'secret.key');
    const secret = 'TOP-SECRET-KEY-MATERIAL';
    await writeFile(secretPath, secret, 'utf8');
    // `pathToFileURL` so a Windows backslash cannot break the fixture.
    const url = pathToFileURL(secretPath).href;

    const doc = `<?xml version="1.0"?><!DOCTYPE package [<!ENTITY xxe SYSTEM "${url}">]><package><metadata><dc:title>&xxe;</dc:title></metadata></package>`;
    const result = parseEpubXml(utf8(doc), 'package');

    expect(result.kind).toBe('document');
    expect(readTitle(result)).toBe('&xxe;');
    if (result.kind !== 'document') throw new Error('expected a document');
    expect(result.$.root().text()).not.toContain(secret);
    // The file is still on disk — the parser simply never read it.
    expect(await readFile(secretPath, 'utf8')).toBe(secret);
  });

  it('does not expand a parameter entity', () => {
    const doc = `<?xml version="1.0"?><!DOCTYPE package [<!ENTITY % pe "<!ENTITY leaked 'expanded'>">%pe;]><package><metadata><dc:title>&leaked;</dc:title></metadata></package>`;
    const result = parseEpubXml(utf8(doc), 'package');
    expect(readTitle(result)).toBe('&leaked;');
  });

  it('does not expand a billion-laughs bomb', () => {
    const doc = `<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;"><!ENTITY lol3 "&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;"><!ENTITY lol4 "&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;">]><package><metadata><dc:title>&lol4;</dc:title></metadata></package>`;
    const result = parseEpubXml(utf8(doc), 'package');
    expect(readTitle(result)).toBe('&lol4;');
  });
});

describe('no stream surface', () => {
  // Pins Decision 6 — this module takes bytes and classifies no read error, so
  // the stream-ownership boundary cannot drift back in without a deliberate edit.
  it.each([['createCountingStream'], ['classifyEpubReadError'], ['Readable']])(
    'does not mention %s',
    async (symbol) => {
      const source = await readFile(path.join(import.meta.dirname, 'xml.ts'), 'utf8');
      expect(source).not.toContain(symbol);
    },
  );
});
