import type { CheerioAPI } from 'cheerio';
import { normalizeFormat } from './normalize-format.js';

/** cheerio does not re-export domhandler's node types, so name the selection through its own API. */
type CheerioSelection = ReturnType<ReturnType<CheerioAPI['root']>['closest']>;

/** The book's own metadata, read from the block ABB annotates with schema.org microdata. */
export interface AbbMetadataFields {
  author?: string;
  narrator?: string;
  format?: string;
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
 * Read author, narrator and format off the page's own elements. `scope` limits the read to a single
 * search row; omit it for a detail page. Nothing is read from the surrounding text: the paragraph
 * below the block is the post's body — free prose, and where `By:` used to find the uploader.
 */
export function readAbbMetadata($: CheerioAPI, scope?: CheerioSelection): AbbMetadataFields {
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

  return {
    ...(author !== undefined && { author }),
    ...(narrator !== undefined && { narrator }),
    ...(format !== undefined && { format }),
  };
}
