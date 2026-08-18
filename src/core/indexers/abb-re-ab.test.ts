/**
 * #2421 — ABB serves some posts as anti-scraper chaff: the row's markup arrives base64-encoded as
 * the text of a `div.post.re-ab`. The DOM contract lives here; the adapter-level behaviour (drop
 * reasons, counters, ordering through a real search) lives in `abb.test.ts`.
 */
import { describe, it, expect } from 'vitest';
import * as cheerio from 'cheerio';
import { inlineReAbPosts } from './abb-re-ab.js';

const b64 = (markup: string): string => Buffer.from(markup, 'utf-8').toString('base64');

const titleBlock = (href: string, text: string): string =>
  `<div class="postTitle"><h2><a href="${href}" rel="bookmark">${text}</a></h2></div>`;

const TITLE_BLOCK = titleBlock('/audio-books/decoded/', 'Decoded Row');

/** The title as the decoded markup itself carries it — not a restatement of `titleSelectors`. */
const titlesOf = ($: cheerio.CheerioAPI): string[] =>
  $('div.post').map((_, el) => $(el).find('h2 a').first().text()).get();

describe('inlineReAbPosts', () => {
  it('rewrites the element in place, keeping its node identity and every other attribute', () => {
    const $ = cheerio.load(`<div id="row-7" data-post-id="42" class="post re-ab">${b64(TITLE_BLOCK)}</div>`);
    const original = $('div.post.re-ab').get(0);

    inlineReAbPosts($);

    // Object identity is the only assertion a create-and-replace implementation cannot satisfy.
    expect($('div.post').get(0)).toBe(original);
    expect($('div.post.re-ab')).toHaveLength(0);
    expect($('div.post')).toHaveLength(1);
    expect($('div.post').attr('id')).toBe('row-7');
    expect($('div.post').attr('data-post-id')).toBe('42');
    expect(titlesOf($)).toEqual(['Decoded Row']);
  });

  it('preserves document order and the selectable post count', () => {
    const $ = cheerio.load(`<body>
      <div class="post re-ab">${b64(titleBlock('/first/', 'First'))}</div>
      <div class="post">${titleBlock('/second/', 'Second')}</div>
      <div class="post re-ab">${b64(titleBlock('/third/', 'Third'))}</div>
    </body>`);

    expect($('div.post')).toHaveLength(3);

    inlineReAbPosts($);

    expect($('div.post')).toHaveLength(3);
    expect(titlesOf($)).toEqual(['First', 'Second', 'Third']);
  });

  // Cardinality by construction: whatever the blob wraps itself in, the slot keeps contributing the
  // one element it always was, so no two rows can be built from a single `re-ab` post.
  it.each([
    ['no wrapper at all', TITLE_BLOCK],
    ['a div.post wrapper', `<div class="post">${TITLE_BLOCK}</div>`],
    ['an article.post wrapper', `<article class="post">${TITLE_BLOCK}</article>`],
    ['two sibling div.post wrappers', `<div class="post">${TITLE_BLOCK}</div><div class="post">${titleBlock('/other/', 'Other')}</div>`],
  ])('leaves exactly one selectable post for a blob with %s', (_label, markup) => {
    const $ = cheerio.load(`<div class="post re-ab">${b64(markup)}</div>`);

    inlineReAbPosts($);

    expect($('div.post')).toHaveLength(1);
    expect($('.post')).toHaveLength(1);
    expect($('div.post').find('h2 a').first().text()).toBe('Decoded Row');
  });

  it('leaves no stale post or re-ab wrapper when the blob re-wraps itself as a post re-ab', () => {
    const $ = cheerio.load(`<div class="post re-ab">${b64(`<div class="post re-ab">${TITLE_BLOCK}</div>`)}</div>`);

    inlineReAbPosts($);

    expect($('div.post')).toHaveLength(1);
    expect($('div.post.re-ab')).toHaveLength(0);
    expect($('div.post').find('h2 a').first().text()).toBe('Decoded Row');
  });

  it('scrubs the exact post token only, leaving postTitle, postContent and postImg intact', () => {
    const decoded = `<div class="postContent"><div class="postImg"><img src="/cover.jpg"></div>${TITLE_BLOCK}</div>`;
    const $ = cheerio.load(`<div class="post re-ab">${b64(decoded)}</div>`);

    inlineReAbPosts($);

    expect($('.postContent')).toHaveLength(1);
    expect($('.postImg')).toHaveLength(1);
    expect($('.postTitle')).toHaveLength(1);
    expect($('div.post')).toHaveLength(1);
  });

  it('decodes UTF-8 multibyte text as itself, never latin1', () => {
    const $ = cheerio.load(`<div class="post re-ab">${b64(titleBlock('/utf8/', 'Röw — Grüße'))}</div>`);

    inlineReAbPosts($);

    expect($('div.post').find('h2 a').first().text()).toBe('Röw — Grüße');
  });

  /**
   * `Buffer.from(x, 'base64')` never throws — it silently discards invalid characters — so the
   * undecodable verdict is an explicit test, and a `try/catch` cannot be the mechanism. Each row
   * asserts the element came out byte-identical, which a swap-in-an-equivalent-node implementation
   * fails even though a selector-and-text check would pass it.
   */
  describe('an undecodable payload leaves the element untouched', () => {
    it.each([
      ['empty text', ''],
      ['whitespace-only text', '   \n\t  '],
      ['a character outside the base64 alphabet', 'PHA+eDwvcD4!'],
      ['a markup character outside the alphabet', '&lt;div class="post"&gt;'],
      ['more than two padding characters', 'PHA+eDwvcD4==='],
      ['a decode carrying no element node', b64('Hello')],
      ['an alphabet-clean blob decoding to mojibake', Buffer.from([0xff, 0xfe, 0xfd, 0xfc]).toString('base64')],
    ])('%s', (_label, payload) => {
      const $ = cheerio.load(`<div id="row-9" data-post-id="9" class="post re-ab extra">${payload}</div>`);
      const original = $('div.post.re-ab').get(0);
      const before = $.html($('div.post.re-ab'));

      inlineReAbPosts($);

      expect($('div.post.re-ab').get(0)).toBe(original);
      expect($.html($('div.post.re-ab'))).toBe(before);
    });
  });

  // The over-rejection controls: a guard tightened past the alphabet test would silently swallow
  // real rows, and every one of these three is a shape `Buffer` already accepts.
  describe('positive controls the guard must not reject', () => {
    it.each([
      ['a padded blob', b64(TITLE_BLOCK)],
      ['an unpadded blob', b64(TITLE_BLOCK).replace(/=+$/, '')],
      ['a blob split across newlines and indentation', `\n  ${b64(TITLE_BLOCK).replace(/(.{24})/g, '$1\n  ')}\n`],
    ])('decodes %s', (_label, payload) => {
      const $ = cheerio.load(`<div class="post re-ab">${payload}</div>`);

      inlineReAbPosts($);

      expect($('div.post.re-ab')).toHaveLength(0);
      expect($('div.post').find('h2 a').first().text()).toBe('Decoded Row');
    });
  });
});
