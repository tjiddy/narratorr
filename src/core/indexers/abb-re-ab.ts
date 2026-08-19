import * as cheerio from 'cheerio';
import type { CheerioAPI } from 'cheerio';

/**
 * ABB serves some posts as anti-scraper chaff: the row's markup arrives base64-encoded as the text
 * of a `div.post.re-ab`, which the row parser then drops for having no title. Jackett's
 * `AudioBookBay.cs::ParseHtmlDocument` decodes the same shape.
 */

/** Base64 with optional padding. Whitespace is stripped first — `Buffer` tolerates it, so do we. */
const BASE64_PAYLOAD = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * Decodes every `div.post.re-ab` in place: drops the `re-ab` class, installs the decoded markup,
 * and neutralizes any nested post wrapper. An undecodable element is left untouched — its surviving
 * `re-ab` class is what tells the row loop which drop reason to record.
 *
 * Rewriting the element rather than replacing it is what keeps `parseSearchPage`'s first-non-empty
 * selector chain and `itemsObserved` invariant: no element is created, removed, moved or re-familied.
 */
export function inlineReAbPosts($: CheerioAPI): void {
  $('div.post.re-ab').each((_, element) => {
    const $el = $(element);
    const decoded = decodePayload($el.text());
    if (decoded === undefined) return;

    $el.removeClass('re-ab').html(decoded);
    // Cardinality: a blob that wraps itself in a post element would otherwise make one slot yield
    // two rows sharing a guid. The exact `post` token only — ABB's own `postTitle`/`postContent`/
    // `postImg`/`postInfo` are different tokens and stay intact.
    $el.find('.post').removeClass('post');
  });
}

/**
 * The decoded markup, or `undefined` when the payload is not one. Explicit rather than a caught
 * exception: `Buffer.from(x, 'base64')` never throws — it silently discards invalid characters and
 * returns mojibake — so a `try/catch` would guard nothing. (.NET's `Convert.FromBase64String`, which
 * Jackett leans on, does throw.)
 */
function decodePayload(text: string): string | undefined {
  const payload = text.replace(/\s+/g, '');
  if (payload.length === 0 || !BASE64_PAYLOAD.test(payload)) return undefined;

  const decoded = Buffer.from(payload, 'base64').toString('utf-8');
  // A text-only or garbage decode carries no element for the row parser to read.
  if (cheerio.load(decoded, null, false)('*').length === 0) return undefined;
  return decoded;
}
