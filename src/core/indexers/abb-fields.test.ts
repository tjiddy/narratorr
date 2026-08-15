import { describe, it, expect } from 'vitest';
import * as cheerio from 'cheerio';
import { readAbbMetadata } from './abb-fields.js';

/** The structured block ABB annotates with schema.org microdata, as it appears on a real post. */
function metadataBlock(opts: { author?: string; narrator?: string; format?: string } = {}): string {
  const parts: string[] = [];
  if (opts.author !== undefined) {
    parts.push(`Written by <a href="/x/"><span class="author" itemprop="author">${opts.author}</span></a>`);
  }
  if (opts.narrator !== undefined) {
    parts.push(`Read by <a href="/y/"><span class="narrator" itemprop="author">${opts.narrator}</span></a>`);
  }
  if (opts.format !== undefined) {
    parts.push(`Format: <span class="format" itemprop="encodingFormat">${opts.format}</span>`);
  }
  return `<p>${parts.join('<br>')}</p>`;
}

/** An uploader byline carries an `.author`-classed node of its own, above the metadata block. */
const BYLINE = '<div class="postInfo">Shared by: <span class="author"><a href="/member/greads123/">greads123</a></span> On: 12 Dec 2022</div>';

function read(bodyHtml: string) {
  return readAbbMetadata(cheerio.load(`<html><body>${bodyHtml}</body></html>`));
}

describe('readAbbMetadata', () => {
  it('reads author, narrator and format from the structured block', () => {
    const fields = read(metadataBlock({ author: 'Carol Cole', narrator: 'James MacNaughton', format: 'M4B' }));

    expect(fields).toEqual({ author: 'Carol Cole', narrator: 'James MacNaughton', format: 'm4b' });
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
    const annotatedByline = '<div class="postInfo">Shared by: <span class="author" itemprop="author">greads123</span></div>';
    const fields = read(annotatedByline + metadataBlock({ author: 'Carol Cole', narrator: 'James MacNaughton', format: 'M4B' }));

    expect(fields.author).toBe('Carol Cole');
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
    const fields = read(metadataBlock({ author: 'Carol Cole' }));

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
