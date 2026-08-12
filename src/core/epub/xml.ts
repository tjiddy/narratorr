import * as cheerio from 'cheerio';
import type { Cheerio, CheerioAPI } from 'cheerio';
import { MAX_XML_BYTES } from './limits.js';
import type { EpubValidationCode } from './result.js';

/**
 * Pure bounded XML parsing. Cheerio's htmlparser2 backend does not resolve DTDs or
 * entities; swapping parsers requires XXE review. Callers must cap inflation first—
 * the local length check can only bound parsing after bytes already exist.
 */

/** Derived from Cheerio because its transitive domhandler package is not workspace-resolvable. */
type RootChildren = ReturnType<ReturnType<CheerioAPI['root']>['children']>;
export type EpubXmlElement = RootChildren extends Cheerio<infer T> ? T : never;

export type EpubXmlErrorCode = Extract<EpubValidationCode, 'malformed_xml' | 'limit_exceeded'>;

export type EpubXmlRootName = 'container' | 'package' | 'encryption' | 'ncx' | 'html';

export type EpubXmlResult =
  | { kind: 'document'; $: CheerioAPI; root: EpubXmlElement }
  | { kind: 'rejected'; code: EpubXmlErrorCode };

const UTF8: EpubXmlEncoding = 'utf-8';
type EpubXmlEncoding = 'utf-8' | 'utf-16le' | 'utf-16be';

const REJECT_MALFORMED: EpubXmlResult = { kind: 'rejected', code: 'malformed_xml' };

/**
 * Selects UTF-8, UTF-16LE, or UTF-16BE from a BOM, defaulting to UTF-8. Declared
 * encoding labels are ignored: byte evidence decides, and conforming UTF-16 requires a BOM.
 */
function selectEncoding(bytes: Uint8Array): EpubXmlEncoding {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return UTF8;
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return 'utf-16le';
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return 'utf-16be';
  return UTF8;
}

/** Fatally decodes malformed sequences; TextDecoder also strips the selected BOM. */
function decode(bytes: Uint8Array, encoding: EpubXmlEncoding): string | null {
  try {
    return new TextDecoder(encoding, { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/**
 * Returns the suffix after the last namespace colon. Full URI resolution would require
 * hand-written namespace tracking; callers instead scope local-name searches by document role and parent.
 */
export function localName(qualifiedName: string): string {
  const colon = qualifiedName.lastIndexOf(':');
  return colon === -1 ? qualifiedName : qualifiedName.slice(colon + 1);
}

/** Case-sensitive local-name comparison; xmlMode preserves the original tag case. */
export function hasLocalName(element: EpubXmlElement, expected: string): boolean {
  return localName(element.name) === localName(expected);
}

/** Direct matching children in source order; never searches unrelated subtrees. */
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
 * Local-name lookup prefers the exact unprefixed name, then the first prefixed match
 * in parser source order. Use attrByExactName for spec-defined unprefixed attributes.
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

/** Exact lookup for spec-defined unprefixed attributes, where a prefixed spelling is different. */
export function attrByExactName(element: EpubXmlElement, name: string): string | undefined {
  return element.attribs[name];
}

/**
 * `malformed_xml` means no usable single-root document, not strict well-formedness;
 * htmlparser2 repairs tag soup. children() ignores declarations, doctypes, comments, and whitespace.
 */
function checkRoot($: CheerioAPI, expected: EpubXmlRootName): EpubXmlResult {
  const roots = $.root().children().toArray();
  const root = roots[0];
  if (roots.length !== 1 || !root) return REJECT_MALFORMED;
  if (!hasLocalName(root, expected)) return REJECT_MALFORMED;
  return { kind: 'document', $, root };
}

/**
 * Never-throw decode, parse, and root check over Uint8Array or Buffer. The strict `>`
 * size check is defense in depth for parsing; stream accounting must bound inflation.
 */
export function parseEpubXml(bytes: Uint8Array, expectedRoot: EpubXmlRootName): EpubXmlResult {
  if (bytes.length > MAX_XML_BYTES) return { kind: 'rejected', code: 'limit_exceeded' };

  const xml = decode(bytes, selectEncoding(bytes));
  if (xml === null) return REJECT_MALFORMED;

  return checkRoot(cheerio.load(xml, { xmlMode: true }), expectedRoot);
}
