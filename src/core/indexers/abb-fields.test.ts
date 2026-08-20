import { describe, it, expect } from 'vitest';
import * as cheerio from 'cheerio';
import { readAbbMetadata } from './abb-fields.js';

/** The structured block ABB annotates with schema.org microdata, as it appears on a real post. */
function metadataBlock(opts: { author?: string | string[]; narrator?: string | string[]; format?: string; bitrate?: string } = {}): string {
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
  if (opts.bitrate !== undefined) {
    parts.push(`Bitrate: <span class="bitrate" itemprop="bitrate">${opts.bitrate}</span>`);
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

    expect(fields).toEqual({ author: 'Carol Cole', narrator: 'James MacNaughton', format: 'm4b', bitrateKbps: 128 });
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

describe('readAbbMetadata — plain-text info lines (no microdata)', () => {
  /**
   * A real listing row captured live 2026-08-19 (trimmed): old posts carry NO itemprop markup at
   * all — Language: sits in .postInfo, Format:/File Size: in a styled paragraph whose <br>s
   * cheerio zero-widths ("2025Format: M4B" in flattened text).
   */
  const LIVE_ROW = `
    <div class="post" id="row">
      <div class="postTitle"><h2><a href="/abss/x/" rel="bookmark">Parque Jurasico (Jurassic Park) - Michael Crichton</a></h2></div>
      <div class="postInfo">Category: Adults&nbsp; Adventure&nbsp; <br />Language: Spanish<span style="margin-left:100px;">Keywords: Jurassic Park&nbsp;</span><br /></div>
      <div class="postContent">
        <p style='text-align:center;'>Posted: 9 Jun 2025<br />Format: <span style='color:#a00;'>M4B</span> / Bitrate: <span style='color:#a00;'>?</span><br />File Size: <span style='color:#00f;'>901.51</span> MBs</p>
      </div>
    </div>`;

  function readRow(html: string) {
    const $ = cheerio.load(`<html><body>${html}</body></html>`);
    return readAbbMetadata($, $('#row'));
  }

  it('reads language, format and size from a real microdata-free listing row', () => {
    expect(readRow(LIVE_ROW)).toEqual({
      language: 'spanish',
      format: 'm4b',
      size: Math.round(901.51 * 1024 * 1024),
      rawSize: '901.51 MBs',
    });
  });

  it('normalizes an English-grouped size and tolerates the ? bitrate', () => {
    const row = LIVE_ROW.replace('901.51', '1,001.51');
    expect(readRow(row)).toMatchObject({ size: Math.round(1001.51 * 1024 * 1024), rawSize: '1,001.51 MBs' });
  });

  it('yields no size for a malformed grouping instead of a thousandth-scale parse', () => {
    // The #2316 trap: parseFloat('1,0') would silently read as 1.
    const row = LIVE_ROW.replace('901.51', '1,0');
    const fields = readRow(row);
    expect(fields.size).toBeUndefined();
    expect(fields.rawSize).toBe('1,0 MBs');
  });

  it('reads GBs with the 1024 multiplier chain', () => {
    const row = LIVE_ROW.replace('901.51</span> MBs', '1.20</span> GBs');
    expect(readRow(row)).toMatchObject({ size: Math.round(1.2 * 1024 * 1024 * 1024) });
  });

  it('yields nothing extra when the info lines are absent', () => {
    const bare = '<div class="post" id="row"><div class="postContent"><p>Free prose only.</p></div></div>';
    expect(readRow(bare)).toEqual({});
  });

  it('lets microdata win over the text lines where both carry a format', () => {
    const both = LIVE_ROW.replace(
      '<p style=\'text-align:center;\'>Posted:',
      `${metadataBlock({ narrator: 'Frank Muller', format: 'MP3' })}<p style='text-align:center;'>Posted:`,
    );
    const fields = readRow(both);
    expect(fields.format).toBe('mp3');
    expect(fields.narrator).toBe('Frank Muller');
    // Text-only fields still fill in beside the microdata.
    expect(fields.language).toBe('spanish');
    expect(fields.size).toBe(Math.round(901.51 * 1024 * 1024));
  });

  describe('bitrate (#2504)', () => {
    /** The live row's own bitrate slot; ABB writes `?` there when the uploader left it blank. */
    const withBitrate = (value: string): string => LIVE_ROW.replace('>?<', `>${value}<`);

    /**
     * After the text lines, not before: the info-line read takes the FIRST `Bitrate:` in the
     * flattened row, so a block placed above would let a text-line read pass as a microdata win.
     */
    const withMicrodata = (row: string, block: string): string => row.replace(' MBs</p>', ` MBs</p>${block}`);

    it('reads the bitrate alongside the other info-line fields', () => {
      expect(readRow(withBitrate('128 Kbps'))).toEqual({
        language: 'spanish',
        format: 'm4b',
        size: Math.round(901.51 * 1024 * 1024),
        rawSize: '901.51 MBs',
        bitrateKbps: 128,
      });
    });

    // Same number throughout, so the table isolates spelling: only the unit's shape varies.
    it.each(['128 Kbps', '128 kbps', '128Kbps', '128 KBPS'])('reads %s as 128', (value) => {
      expect(readRow(withBitrate(value)).bitrateKbps).toBe(128);
    });

    // The case table alone cannot tell a real capture from a hardcoded 128.
    it('reads a differently-valued bitrate rather than echoing a constant', () => {
      expect(readRow(withBitrate('64 Kbps')).bitrateKbps).toBe(64);
    });

    it.each([
      ['?', 'the placeholder the live fixture carries'],
      ['Variable', 'a word where a number belongs'],
      ['VBR', 'the abbreviation of the same'],
      ['Unknown', 'the uploader admitting it'],
      ['', 'an empty span'],
      ['0 Kbps', 'a value no real release has, and one a falsy check would read as unknown'],
      ['64.5 Kbps', 'a fraction, which must not round or truncate'],
      ['1,4 Kbps', 'a malformed grouping, the #2316 thousandth-scale trap'],
    ])('yields no bitrateKbps key for %s — %s', (value) => {
      expect(readRow(withBitrate(value))).not.toHaveProperty('bitrateKbps');
    });

    it('yields no bitrateKbps key for a bare Bitrate: with no value after it', () => {
      const bare = LIVE_ROW.replace('Bitrate: <span style=\'color:#a00;\'>?</span>', 'Bitrate:');

      expect(readRow(bare)).not.toHaveProperty('bitrateKbps');
    });

    it('normalizes an English-grouped bitrate instead of truncating it to its first group', () => {
      const fields = readRow(withBitrate('1,411 Kbps'));

      expect(fields.bitrateKbps).toBe(1411);
      // The named trap: bare parseFloat('1,411') is 1, which is a plausible-looking number.
      expect(fields.bitrateKbps).not.toBe(1);
    });

    /**
     * The row's `<br>`s carry no surrounding whitespace, so the flattened text reads
     * `Bitrate: 128 KbpsFile Size: 901.51 MBs` — the shape a `([^\n]+)` capture would bleed.
     */
    it('reads both bitrate and size out of a run with no separator between them', () => {
      const fields = readRow(withBitrate('128 Kbps'));

      expect(fields.bitrateKbps).toBe(128);
      expect(fields.size).toBe(Math.round(901.51 * 1024 * 1024));
    });

    it('leaves size intact when the bitrate slot is a placeholder in that same run', () => {
      const fields = readRow(LIVE_ROW.replace('901.51', '468.6'));

      expect(fields).not.toHaveProperty('bitrateKbps');
      expect(fields.size).toBe(Math.round(468.6 * 1024 * 1024));
    });

    it('lets a microdata bitrate win over the text line', () => {
      const row = withMicrodata(withBitrate('64 Kbps'), metadataBlock({ bitrate: '128 Kbps' }));

      expect(readRow(row).bitrateKbps).toBe(128);
    });

    // Without this control the assertion above is satisfiable by "always take the microdata".
    it('falls back to the text line when the microdata block carries no bitrate span', () => {
      const row = withMicrodata(withBitrate('64 Kbps'), metadataBlock({ format: 'M4B' }));

      expect(readRow(row).bitrateKbps).toBe(64);
    });

    it('fills from the text line when the microdata bitrate is non-numeric', () => {
      const row = withMicrodata(withBitrate('64 Kbps'), metadataBlock({ bitrate: 'Variable' }));

      expect(readRow(row).bitrateKbps).toBe(64);
    });

    it('takes the first bitrate of a multi-file post', () => {
      expect(readRow(withBitrate('64 Kbps / 128 Kbps')).bitrateKbps).toBe(64);
    });

    it('reads only the scoped row when two rows carry different bitrates', () => {
      const first = withBitrate('64 Kbps');
      const second = withBitrate('128 Kbps').replace('id="row"', 'id="second"');
      const $ = cheerio.load(`<html><body>${first}${second}</body></html>`);

      expect(readAbbMetadata($, $('#second')).bitrateKbps).toBe(128);
      expect(readAbbMetadata($, $('#row')).bitrateKbps).toBe(64);
    });
  });
});
