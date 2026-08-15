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

/**
 * Where the metadata block starts. Both name spans carry `itemprop="author"`, so the class is the
 * discriminator and the annotation only co-selects; the order runs most-unambiguous first, because
 * an uploader byline can carry `class="author"` but never `class="narrator"` or `encodingFormat`.
 */
const BLOCK_ANCHORS = [
  'span.format[itemprop="encodingFormat"]',
  'span.narrator[itemprop="author"]',
  'span.author[itemprop="author"]',
];

/**
 * Read author, narrator and format off the page's own elements. `scope` limits the read to a single
 * search row; omit it for a detail page. Nothing is read from the surrounding text: the paragraph
 * below the block is the post's body — free prose, and where `By:` used to find the uploader.
 */
export function readAbbMetadata($: CheerioAPI, scope?: CheerioSelection): AbbMetadataFields {
  const findIn = (selector: string) => (scope ? scope.find(selector) : $(selector));

  let anchor;
  for (const selector of BLOCK_ANCHORS) {
    const found = findIn(selector).first();
    if (found.length > 0) {
      anchor = found;
      break;
    }
  }
  if (anchor === undefined) return {};

  const paragraph = anchor.closest('p');
  const block: CheerioSelection = paragraph.length > 0 ? paragraph : anchor.parent();
  // A missing element reads as '', so this is a fold to absence rather than a trim.
  const read = (selector: string): string | undefined => block.find(selector).first().text().trim() || undefined;

  const author = read('span.author');
  const narrator = read('span.narrator');
  const format = normalizeFormat(read('span.format'));

  return {
    ...(author !== undefined && { author }),
    ...(narrator !== undefined && { narrator }),
    ...(format !== undefined && { format }),
  };
}
