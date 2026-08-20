import type { CheerioAPI } from 'cheerio';
import { normalizeFormat } from './normalize-format.js';
import { normalizeLanguage } from '../utils/language-codes.js';
import { normalizeGrouping } from './mam-helpers.js';

/** cheerio does not re-export domhandler's node types, so name the selection through its own API. */
type CheerioSelection = ReturnType<ReturnType<CheerioAPI['root']>['closest']>;

/** The book's own metadata: microdata when the post carries it, plain-text info lines otherwise. */
export interface AbbMetadataFields {
  author?: string;
  narrator?: string;
  format?: string;
  language?: string;
  size?: number;
  rawSize?: string;
  bitrateKbps?: number;
}

/** The post's own content. ABB writes the `Shared by:` byline outside it, in the post's meta block. */
const CONTENT_REGION = '.postContent';

/**
 * What identifies the metadata block, as opposed to what can be read out of it once found.
 * `span.author` is deliberately absent: both name spans carry `itemprop="author"` and an uploader
 * byline can wear `class="author"` too, so an author span may be READ from a located block but must
 * never LOCATE one — otherwise a block carrying only its author anchors to the byline instead.
 */
const BLOCK_MARKERS = [
  'span.format[itemprop="encodingFormat"]',
  'span.narrator[itemprop="author"]',
];

/**
 * Read the post's metadata. `scope` limits the read to a single search row; omit it for a detail
 * page. Microdata wins wherever both sources carry a field; the plain-text info lines fill the
 * rest — old posts carry no microdata at all (verified against live listing markup 2026-08-19),
 * so without the text fallback their releases are blind: no language for the language filter,
 * no size for the quality gate.
 */
export function readAbbMetadata($: CheerioAPI, scope?: CheerioSelection): AbbMetadataFields {
  const info = readAbbInfoLines((scope ?? $.root()).text());
  const micro = readMicrodataBlock($, scope);
  return { ...info, ...micro };
}

/**
 * The listing rows' plain-text info lines: `Language:` sits in `.postInfo`, `Format:` and
 * `File Size:` in the post body. Values wear style-only spans separated by `<br>`s that cheerio's
 * `.text()` zero-widths (a live row reads `2025Format: M4B`), so every read anchors on its own
 * label and never on element structure or preceding whitespace. `MBs` is read with the 1024
 * multipliers to match the codebase's other size parses; ABB does not say which it means and the
 * quality band tolerates the difference.
 */
const ABB_SIZE_MULTIPLIERS: Record<string, number> = {
  KBS: 1024,
  MBS: 1024 * 1024,
  GBS: 1024 * 1024 * 1024,
  TBS: 1024 * 1024 * 1024 * 1024,
};

/**
 * Digits-and-commas plus a REQUIRED `kbps`: self-terminating, so the flattened run
 * `Bitrate: 128 KbpsFile Size: 901.51 MBs` cannot bleed the next label into the value. The class
 * excludes `.` deliberately — a fractional `64.5 Kbps` is absent rather than rounded or truncated.
 */
const BITRATE_LINE = /Bitrate:\s*([\d,]+)\s*kbps/i;
/** The microdata span holds the value alone, so the label anchor goes and `^…$` takes its place. */
const BITRATE_VALUE = /^([\d,]+)\s*kbps$/i;

/**
 * ABB writes `?`, `Variable`, `VBR` or `Unknown` where an uploader left the bitrate blank, and
 * renders large values grouped. Everything that is not a whole positive count of kbps folds to
 * absence: `0` would read as a known-and-zero release, and bare `parseFloat('1,411')` is 1 (#2316).
 */
function normalizeBitrateKbps(token: string | undefined): number | undefined {
  if (token === undefined) return undefined;
  const normalized = normalizeGrouping(token);
  if (normalized === undefined) return undefined;
  const kbps = Number(normalized);
  return Number.isInteger(kbps) && kbps > 0 ? kbps : undefined;
}

function readAbbInfoLines(text: string): Pick<AbbMetadataFields, 'language' | 'format' | 'size' | 'rawSize' | 'bitrateKbps'> {
  // Case-anchored: the flattened row reads "Language: SpanishKeywords: …" (zero-width <br>), so
  // the capture must stop at the next label's capital rather than eating it.
  const language = normalizeLanguage(/Language:\s*([A-Z][a-z]+)/.exec(text)?.[1]);
  const format = normalizeFormat(/Format:\s*([A-Za-z0-9]+)/.exec(text)?.[1]);
  const bitrateKbps = normalizeBitrateKbps(BITRATE_LINE.exec(text)?.[1]);

  let size: number | undefined;
  let rawSize: string | undefined;
  const sizeMatch = /File\s*Size:\s*([\d.,]+)\s*([KMGT]Bs)/i.exec(text);
  if (sizeMatch) {
    rawSize = `${sizeMatch[1]} ${sizeMatch[2]}`;
    const normalized = normalizeGrouping(sizeMatch[1]!);
    const num = normalized === undefined ? undefined : parseFloat(normalized);
    const multiplier = ABB_SIZE_MULTIPLIERS[sizeMatch[2]!.toUpperCase()];
    if (num !== undefined && num > 0 && isFinite(num) && multiplier !== undefined) {
      size = Math.round(num * multiplier);
    }
  }

  return {
    ...(language !== undefined && { language }),
    ...(format !== undefined && { format }),
    ...(size !== undefined && { size }),
    ...(rawSize !== undefined && { rawSize }),
    ...(bitrateKbps !== undefined && { bitrateKbps }),
  };
}

function readMicrodataBlock($: CheerioAPI, scope?: CheerioSelection): Pick<AbbMetadataFields, 'author' | 'narrator' | 'format' | 'bitrateKbps'> {
  const inScope = (selector: string) => (scope ? scope.find(selector) : $(selector));
  const region = inScope(CONTENT_REGION).first();
  const inRegion = (selector: string) => (region.length > 0 ? region.find(selector) : inScope(selector));

  let block: CheerioSelection | undefined;
  for (const marker of BLOCK_MARKERS) {
    const anchor = inRegion(marker).first();
    if (anchor.length > 0) {
      const paragraph = anchor.closest('p');
      block = paragraph.length > 0 ? paragraph : anchor.parent();
      break;
    }
  }
  // No marker: the content region stands in as the block, so a block carrying only its author still
  // reads. Without a region there is nothing left that a byline cannot satisfy, so read nothing.
  if (block === undefined && region.length > 0) block = region;
  if (block === undefined) return {};

  // A missing element reads as '', so both folds land on absence rather than trimming.
  const readOne = (selector: string): string | undefined => block.find(selector).first().text().trim() || undefined;

  /**
   * Names are routinely multi-valued — 2 authors and 13 narrators observed on real posts — while
   * `SearchResult` holds one string, so join on the separator `parseDoubleEncodedNames` already
   * uses. Never `.text()` the selection: cheerio concatenates matches with no delimiter, and
   * `Yana WeinsteinMegan Sumeracki` reads as one plausible name rather than as a defect.
   */
  const readAll = (selector: string): string | undefined =>
    block.find(selector).map((_, el) => $(el).text().trim()).get().filter(Boolean).join(', ') || undefined;

  const author = readAll('span.author');
  const narrator = readAll('span.narrator');
  const format = normalizeFormat(readOne('span.format'));
  const bitrateKbps = normalizeBitrateKbps(BITRATE_VALUE.exec(readOne('span.bitrate') ?? '')?.[1]);

  return {
    ...(author !== undefined && { author }),
    ...(narrator !== undefined && { narrator }),
    ...(format !== undefined && { format }),
    ...(bitrateKbps !== undefined && { bitrateKbps }),
  };
}
