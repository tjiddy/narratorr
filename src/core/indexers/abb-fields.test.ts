import { describe, it, expect } from 'vitest';
import * as cheerio from 'cheerio';
import { readAbbMetadata } from './abb-fields.js';

/** The structured block ABB annotates with schema.org microdata, as it appears on a real post. */
function metadataBlock(opts: { author?: string | string[]; narrator?: string | string[]; format?: string } = {}): string {
  // ABB renders several names as sibling anchors separated by a literal ', ' — the shape that makes
  // `.text()` on the selection concatenate them into one name.
  const anchors = (names: string | string[], cls: string, href: string): string =>
    (Array.isArray(names) ? names : [names])
      .map((n) => `<a href="${href}"><span class="${cls}" itemprop="author">${n}</span></a>`)
      .join(', ');

  const parts: string[] = [];
  if (opts.author !== undefined) {
    parts.push(`Written by ${anchors(opts.author, 'author', '/x/')}`);
  }
  if (opts.narrator !== undefined) {
    parts.push(`Read by ${anchors(opts.narrator, 'narrator', '/y/')}`);
  }
  if (opts.format !== undefined) {
    parts.push(`Format: <span class="format" itemprop="encodingFormat">${opts.format}</span>`);
  }
  return `<p>${parts.join('<br>')}</p>`;
}

/** An uploader byline carries an `.author`-classed node of its own, above the metadata block. */
const BYLINE = '<div class="postInfo">Shared by: <span class="author"><a href="/member/greads123/">greads123</a></span> On: 12 Dec 2022</div>';

/** The same byline wearing the metadata block's own annotation — the shape class alone cannot reject. */
const ANNOTATED_BYLINE = '<div class="postInfo">Shared by: <span class="author" itemprop="author">greads123</span> On: 12 Dec 2022</div>';

function read(bodyHtml: string) {
  return readAbbMetadata(cheerio.load(`<html><body>${bodyHtml}</body></html>`));
}

/** ABB's real shape: the post's own content sits in `.postContent`, the uploader byline outside it. */
function readPost(contentHtml: string, bylineHtml = '') {
  return read(`<div class="post">${bylineHtml}<div class="postContent">${contentHtml}</div></div>`);
}

describe('readAbbMetadata', () => {
  it('reads author, narrator and format from the structured block', () => {
    const fields = read(metadataBlock({ author: 'Carol Cole', narrator: 'James MacNaughton', format: 'M4B' }));

    expect(fields).toEqual({ author: 'Carol Cole', narrator: 'James MacNaughton', format: 'm4b' });
  });

  it('joins several authors on the separator the repo already uses, rather than taking the first', () => {
    const fields = read(metadataBlock({ author: ['Yana Weinstein', 'Megan Sumeracki'], narrator: 'Dina Pearlman' }));

    expect(fields.author).toBe('Yana Weinstein, Megan Sumeracki');
    // Both failure modes by name: `.first()` silently drops the rest, and `.text()` on the
    // selection concatenates without a delimiter into something that reads as one real person.
    expect(fields.author).not.toBe('Yana Weinstein');
    expect(fields.author).not.toBe('Yana WeinsteinMegan Sumeracki');
  });

  it('keeps every narrator of a full-cast production, in page order', () => {
    const cast = [
      'Toni Collette', 'Kit Harington', 'Jasmine Jobson', 'Calam Lynch', 'Eliot Salt', 'Katy Wix',
      'Lolly Adefope', 'Billy Postlethwaite', 'Vicki Pepperdine', 'Meera Syal', 'La Voix', 'Leo Reich',
      'full cast',
    ];
    const fields = read(metadataBlock({ author: 'Agatha Christie', narrator: cast }));

    // Order and the tail matter: `full cast` is a pseudo-narrator ABB puts last, so a membership or
    // count assertion would pass against an implementation that reorders or dedupes.
    expect(fields.narrator).toBe(cast.join(', '));
    expect(fields.author).toBe('Agatha Christie');
  });

  it('leaves format single-valued — only names are joined', () => {
    const fields = read(metadataBlock({ author: ['A One', 'B Two'], format: 'M4B' }));

    expect(fields.format).toBe('m4b');
  });

  it('distinguishes the author span from the narrator span when they differ', () => {
    const fields = read(metadataBlock({ author: 'Carol Cole', narrator: 'James MacNaughton' }));

    expect(fields.author).toBe('Carol Cole');
    expect(fields.narrator).toBe('James MacNaughton');
  });

  it('reads the block author, not an .author byline node that precedes it', () => {
    const fields = read(BYLINE + metadataBlock({ author: 'Carol Cole', narrator: 'James MacNaughton', format: 'M4B' }));

    expect(fields.author).toBe('Carol Cole');
  });

  it('reads the block author even when the byline node carries the same microdata annotation', () => {
    const fields = read(ANNOTATED_BYLINE + metadataBlock({ author: 'Carol Cole', narrator: 'James MacNaughton', format: 'M4B' }));

    expect(fields.author).toBe('Carol Cole');
  });

  it('reads an author-only block from the post content region past an annotated uploader byline', () => {
    const fields = readPost(metadataBlock({ author: 'Carol Cole' }), ANNOTATED_BYLINE);

    expect(fields.author).toBe('Carol Cole');
    expect(fields).not.toHaveProperty('narrator');
  });

  it('yields nothing rather than the uploader when an author-only block sits outside any content region', () => {
    // No narrator or format to anchor on and no content region to scope to: the only candidate
    // left is an author span that an uploader byline can wear, so absence is the safe answer.
    expect(read(ANNOTATED_BYLINE + metadataBlock({ author: 'Carol Cole' }))).toEqual({});
  });

  it('yields nothing for an author-only block outside a content region even when the byline is unannotated', () => {
    expect(read(BYLINE + metadataBlock({ author: 'Carol Cole' }))).toEqual({});
  });

  it('yields nothing at all when the page has only an uploader byline', () => {
    expect(read(BYLINE)).toEqual({});
  });

  it('ignores the post body prose below the block', () => {
    const body = '<p>By: Someone Else<br>Narrated by: Someone Else</p>';
    const fields = read(metadataBlock({ author: 'Carol Cole', narrator: 'James MacNaughton' }) + body);

    expect(fields.author).toBe('Carol Cole');
    expect(fields.narrator).toBe('James MacNaughton');
  });

  it('reads a narrator-only block without inventing an author', () => {
    const fields = read(BYLINE + metadataBlock({ narrator: 'James MacNaughton' }));

    expect(fields.narrator).toBe('James MacNaughton');
    expect(fields).not.toHaveProperty('author');
  });

  it('reads an author-only block without inventing a narrator or format', () => {
    const fields = readPost(metadataBlock({ author: 'Carol Cole' }));

    expect(fields.author).toBe('Carol Cole');
    expect(fields).not.toHaveProperty('narrator');
    expect(fields).not.toHaveProperty('format');
  });

  it('folds a whitespace-only span to absence rather than an empty string', () => {
    const fields = read(metadataBlock({ author: '   ', narrator: ' ', format: '  ' }));

    expect(fields).not.toHaveProperty('author');
    expect(fields).not.toHaveProperty('narrator');
    expect(fields).not.toHaveProperty('format');
  });

  it('lowercases the container format so both indexers render the same badge', () => {
    expect(read(metadataBlock({ format: 'M4B' })).format).toBe('m4b');
    expect(read(metadataBlock({ format: 'm4b' })).format).toBe('m4b');
  });

  it('takes format from the annotated span, never the abridgement wording beside it', () => {
    const block = '<p>Format: <span class="format" itemprop="encodingFormat">M4B</span><br>Format<br> Unabridged Audiobook</p>';

    expect(read(block).format).toBe('m4b');
  });

  it('survives a block whose <br> separators leave no whitespace in the flattened text', () => {
    const flat = '<p>Written by <span class="author" itemprop="author">Carol Cole</span><br>Read by <span class="narrator" itemprop="author">James MacNaughton</span><br>Format: <span class="format" itemprop="encodingFormat">M4B</span><br>Bitrate: <span class="bitrate" itemprop="bitrate">128 Kbps</span><br><span class="is_abridged">Unabridged</span></p>';
    const fields = read(flat);

    expect(fields).toEqual({ author: 'Carol Cole', narrator: 'James MacNaughton', format: 'm4b' });
  });

  it('falls back to the annotated spans\' immediate parent when the block is not a paragraph', () => {
    const block = '<div>Written by <span class="author" itemprop="author">Carol Cole</span><br>Read by <span class="narrator" itemprop="author">James MacNaughton</span></div>';

    expect(read(BYLINE + block)).toEqual({ author: 'Carol Cole', narrator: 'James MacNaughton' });
  });

  it('reads only within the given scope when one is passed', () => {
    const html = `<html><body>
      <div class="post" id="first">${metadataBlock({ author: 'Carol Cole', narrator: 'James MacNaughton' })}</div>
      <div class="post" id="second">${metadataBlock({ author: 'James Crookes', narrator: 'James Crookes' })}</div>
    </body></html>`;
    const $ = cheerio.load(html);

    expect(readAbbMetadata($, $('#second'))).toEqual({ author: 'James Crookes', narrator: 'James Crookes' });
  });

  it('yields nothing for a scope that carries no structured block', () => {
    const $ = cheerio.load(`<html><body><div class="post" id="row">${BYLINE}</div>${metadataBlock({ author: 'Carol Cole' })}</body></html>`);

    expect(readAbbMetadata($, $('#row'))).toEqual({});
  });
});
