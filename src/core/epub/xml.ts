import * as cheerio from 'cheerio';
import type { Cheerio, CheerioAPI } from 'cheerio';
import { MAX_XML_BYTES } from './limits.js';
import type { EpubValidationCode } from './result.js';

/**
 * Bounded XML decoding, parsing, and name matching for companion EPUBs
 * (#1987, design §4).
 *
 * **The parser choice is the security control.** `cheerio` in `xmlMode` runs on
 * htmlparser2, which performs no DTD or entity resolution whatsoever — verified
 * by running `SYSTEM` file-entity, parameter-entity, and billion-laughs payloads
 * through it and getting literal, unexpanded text back. XXE and
 * entity-expansion DoS are therefore not *defended against* here, they are
 * *structurally unavailable*, and there is nothing to configure. Swapping in a
 * real XML parser (`fast-xml-parser`, `libxmljs`, `xml2js`, `sax`,
 * `@xmldom/xmldom`) would silently reintroduce a file-read primitive into a
 * process whose config directory holds `secret.key`. The XXE fixtures in
 * `xml.test.ts` are kept permanently for exactly that reason, even though they
 * pass trivially today.
 *
 * **Pure function over bytes.** This module opens nothing, drains nothing, and
 * classifies no read error. Entry consumption, byte counting, budget charging,
 * and archive-error classification live on the reading side of the boundary
 * (1.1c–1.1e), so `truncated` is not in this module's vocabulary.
 *
 * **Input precondition:** the caller has already bounded the inflated entry at
 * `MAX_XML_BYTES`. The length check below *verifies* that precondition; it
 * cannot *establish* it, because the bytes are already inflated by the time we
 * see them.
 */

/**
 * The element type cheerio hands back, derived from its own API rather than
 * imported from `domhandler` — that package is a transitive dependency of
 * cheerio and is not resolvable from this workspace.
 */
type RootChildren = ReturnType<ReturnType<CheerioAPI['root']>['children']>;
export type EpubXmlElement = RootChildren extends Cheerio<infer T> ? T : never;

/**
 * The two failure codes reachable from this module, drawn from 1.1a's frozen
 * union — no code is minted here.
 */
export type EpubXmlErrorCode = Extract<EpubValidationCode, 'malformed_xml' | 'limit_exceeded'>;

/** The five document roots the slate parses: OCF container, package, encryption, NCX, and nav. */
export type EpubXmlRootName = 'container' | 'package' | 'encryption' | 'ncx' | 'html';

/**
 * `parseEpubXml`'s outcome.
 *
 * Discriminated rather than `CheerioAPI | null`, so a caller cannot mistake a
 * rejection for an empty document and so the two codes stay distinguishable —
 * `limit_exceeded` and `malformed_xml` reach the owner as different sentences.
 */
export type EpubXmlResult =
  | { kind: 'document'; $: CheerioAPI; root: EpubXmlElement }
  | { kind: 'rejected'; code: EpubXmlErrorCode };

const UTF8: EpubXmlEncoding = 'utf-8';
type EpubXmlEncoding = 'utf-8' | 'utf-16le' | 'utf-16be';

const REJECT_MALFORMED: EpubXmlResult = { kind: 'rejected', code: 'malformed_xml' };

/**
 * Pick a decoder from the leading bytes alone — a four-row ladder evaluated top
 * to bottom, total over every buffer of every length because row 4 is an
 * unconditional residual.
 *
 * | # | Leading bytes | Decoder     |
 * |---|---------------|-------------|
 * | 1 | `EF BB BF`    | `utf-8`     |
 * | 2 | `FF FE`       | `utf-16le`  |
 * | 3 | `FE FF`       | `utf-16be`  |
 * | 4 | anything else | `utf-8`     |
 *
 * **The declared `encoding="…"` label is never read.** A BOM is what the bytes
 * *are*; the label is what the author *claimed*. XML 1.0 §4.3.3 requires them to
 * agree, but enforcing that agreement would mark `invalid` a book that decodes
 * and parses perfectly — the exact failure mode §4 exists to prevent. So a
 * document declaring `Shift_JIS` whose bytes are valid UTF-8 parses normally,
 * and one whose bytes are genuinely not UTF-8 is rejected by fatal decoding, on
 * the byte evidence rather than on the label.
 *
 * Rows 1–3 cover every *conforming* UTF-16 document: XML 1.0 Annex F requires a
 * UTF-16 entity to begin with a BOM. A BOM-less UTF-16 document is
 * non-conforming, takes row 4, and is rejected downstream by the root check
 * because its root local name decodes NUL-interleaved. No sniff, no extra row —
 * and none is needed for UTF-32 either: `00 00 FE FF` takes row 4 and fails
 * fatal UTF-8 decoding (`FE`/`FF` are not legal UTF-8 bytes), while
 * `FF FE 00 00` takes row 2 and yields zero root element children.
 */
function selectEncoding(bytes: Uint8Array): EpubXmlEncoding {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return UTF8;
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return 'utf-16le';
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return 'utf-16be';
  return UTF8;
}

/**
 * Decode fatally, so any malformed sequence is a rejection rather than a
 * U+FFFD-substituted document that then parses into something the author never
 * wrote. Fatal mode is real for all three decoders — a lone trailing byte or an
 * unpaired surrogate throws under `utf-16le`/`utf-16be` too, not only `utf-8`.
 *
 * `TextDecoder` strips the BOM (`ignoreBOM` defaults to false), so it never
 * survives into the parsed root name. The catch-and-convert shape follows the
 * merged precedent at `paths.ts:100-107`.
 */
function decode(bytes: Uint8Array, encoding: EpubXmlEncoding): string | null {
  try {
    return new TextDecoder(encoding, { fatal: true }).decode(bytes);
  } catch {
    // The fatal decoder throws `TypeError`; any decode failure is a rejection.
    return null;
  }
}

/**
 * The local part of a qualified XML name — everything after the last colon,
 * prefix ignored.
 *
 * Matching by local name rather than by resolved namespace URI is deliberate
 * (#1987 Decision 2). A conforming `<opf:package>` or a non-`dc`-prefixed title
 * must not be rejected, since XML prefixes are aliases; but full expanded-name
 * matching means tracking `xmlns:*` declarations up the tree, which htmlparser2
 * gives no help with, and that is a hand-written XML mechanism inside the one
 * module whose security argument is that it does nothing clever. The residual
 * risk — an identically-local-named element in an unrelated namespace — is
 * negligible here because every document is already identified *by role* and
 * every selection is scoped to its expected parent.
 */
export function localName(qualifiedName: string): string {
  const colon = qualifiedName.lastIndexOf(':');
  return colon === -1 ? qualifiedName : qualifiedName.slice(colon + 1);
}

/**
 * Whether an element's local name matches `expected`.
 *
 * Both sides run through {@link localName}, so `hasLocalName(el, 'dc:title')`
 * and `hasLocalName(el, 'title')` are the same question. **Case-sensitive**, and
 * that is load-bearing: `xmlMode` leaves `lowerCaseTags` off, so `<OPF:Package>`
 * arrives with its case intact and must not match `package`.
 *
 * This is the only place in the module that reads an element's tag name.
 */
export function hasLocalName(element: EpubXmlElement, expected: string): boolean {
  return localName(element.name) === localName(expected);
}

/**
 * The direct children of `parent` whose local name matches `expected`, in source
 * order.
 *
 * Selection is scoped to the expected parent — never searched document-wide — so
 * a `<title>` buried in an unrelated subtree cannot be mistaken for the
 * package's own.
 */
export function childrenByLocalName(
  $: CheerioAPI,
  parent: EpubXmlElement,
  expected: string,
): EpubXmlElement[] {
  return $(parent)
    .children()
    .toArray()
    .filter((child) => hasLocalName(child, expected));
}

/**
 * An attribute value looked up by local name, or `undefined`.
 *
 * **Collision policy — exact name first, then the first prefixed match in source
 * order.** One element can legally carry `ops:type`, `epub:type`, and a bare
 * `type` at once, and htmlparser2 retains all three. The unprefixed spelling
 * wins because a bare name is the most specific thing the author wrote;
 * otherwise the first prefixed candidate in `attribs` key order wins, and
 * htmlparser2 populates that map in document source order. Stating the rule here
 * is the point: downstream TOC and role classification must depend on a
 * documented policy, not on object key ordering. A genuinely duplicated
 * identical name (`type="a" type="b"`) is collapsed to the first by the parser
 * before this helper ever runs.
 *
 * `expected` may be written qualified (`epub:type`) or bare (`type`) — both are
 * reduced by {@link localName}.
 *
 * Use {@link attrByExactName} for attributes the EPUB specs define as
 * unprefixed; a prefix on one of those denotes a different attribute.
 */
export function attrByLocalName(element: EpubXmlElement, expected: string): string | undefined {
  const wanted = localName(expected);
  const attribs = element.attribs;
  const exact = attribs[wanted];
  if (exact !== undefined) return exact;
  for (const [name, value] of Object.entries(attribs)) {
    if (localName(name) === wanted) return value;
  }
  return undefined;
}

/**
 * An attribute value looked up by its exact name, or `undefined`.
 *
 * For the attributes the EPUB specs define as unprefixed — `properties`,
 * `media-type`, `href`, `id`, `idref`, `full-path`, `URI`, `linear`, `toc` — a
 * prefixed spelling denotes a *different* attribute, so `opf:properties` must
 * not satisfy a `properties` lookup.
 *
 * This and {@link attrByLocalName} are the only places in the module that read
 * an element's attribute map.
 */
export function attrByExactName(element: EpubXmlElement, name: string): string | undefined {
  return element.attribs[name];
}

/**
 * The root check.
 *
 * `malformed_xml` means **"no usable document"**, not "not well-formed".
 * Measured against the pinned stack, `cheerio.load(xml, { xmlMode: true })`
 * never throws on any input — not on an unclosed root, not on mismatched tags,
 * not on binary garbage, not on an unterminated attribute — so a
 * well-formedness verdict is simply not available to us, and adding a
 * hand-written pre-scanner would put a second, disagreeing XML parser inside the
 * module whose whole security argument is that it does nothing clever
 * (Decision 1). The contract is narrowed to what the chosen mechanism can
 * actually decide, using the parse-then-check-the-root shape already in the tree
 * at `src/core/indexers/newznab.ts:127-137`.
 *
 * `$.root().children()` already filters to *element* nodes. That matters: an XML
 * declaration, a `DOCTYPE`, a leading comment, and surrounding whitespace are
 * non-element nodes, and a `.contents()`-based count would reject essentially
 * every conforming EPUB file.
 */
function checkRoot($: CheerioAPI, expected: EpubXmlRootName): EpubXmlResult {
  const roots = $.root().children().toArray();
  const root = roots[0];
  if (roots.length !== 1 || !root) return REJECT_MALFORMED;
  if (!hasLocalName(root, expected)) return REJECT_MALFORMED;
  return { kind: 'document', $, root };
}

/**
 * Decode, parse, and root-check one XML document from already-read bytes.
 *
 * `Uint8Array` covers `Buffer` too — `Buffer` extends it — and nothing here uses
 * a Buffer-only method, so both input shapes behave identically.
 *
 * **Never throws.** The module performs no I/O, so no I/O error can originate
 * here, and the fatal decoder's `TypeError` is caught and converted. Every input
 * yields a result.
 *
 * The `MAX_XML_BYTES` check is **defence in depth, not the enforcement point**:
 * the bytes have already been inflated by the time we see them, so it bounds
 * *parsing* rather than *inflation*. The comparison is strictly `>` — exactly
 * `MAX_XML_BYTES` is accepted — matching the counting transform's boundary
 * (`counting-stream.ts:77-86`) so the two cannot disagree.
 */
export function parseEpubXml(bytes: Uint8Array, expectedRoot: EpubXmlRootName): EpubXmlResult {
  if (bytes.length > MAX_XML_BYTES) return { kind: 'rejected', code: 'limit_exceeded' };

  const xml = decode(bytes, selectEncoding(bytes));
  if (xml === null) return REJECT_MALFORMED;

  return checkRoot(cheerio.load(xml, { xmlMode: true }), expectedRoot);
}
