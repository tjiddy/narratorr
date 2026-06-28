import * as cheerio from 'cheerio';

/**
 * Faithful local reimplementation of Audiobookshelf's OPF metadata parser, used by
 * `opf-writer.test.ts` so narratorr's generated `metadata.opf` can be asserted against the ACTUAL
 * ABS field-mapping contract — not generic XML well-formedness ("a selector found the tag").
 *
 * Pinned to upstream ABS `server/utils/parsers/parseOpfMetadata.js` at commit
 * `de22177dbf7413d8cb128e7c1c0dea941583afbc` (2025-03-13):
 *   https://github.com/advplyr/audiobookshelf/blob/de22177dbf7413d8cb128e7c1c0dea941583afbc/server/utils/parsers/parseOpfMetadata.js
 * A bare `master` reference is intentionally avoided — the upstream parser drifts independently, so
 * the SHA above is the source of truth for the semantics encoded here. Re-pin when intentionally
 * tracking new ABS behavior.
 *
 * Upstream parses XML via xml2js into a `{ '_': value, '$': attrs }` shape; this fixture reads the
 * same fields via cheerio but replicates ABS's SELECTION semantics, not its intermediate shape:
 *  - creators bucketed by the (namespaced) `role` attribute and deduplicated via `new Set`
 *    (first-seen order), then trimmed;
 *  - identifiers selected by a case-sensitive `scheme` match, exposed as flat `asin`/`isbn`;
 *  - `dc:date` reduced to its 4-digit year (`publishedYear`);
 *  - `dc:subject` → `genres`, deduplicated; attribute-bearing subjects are ignored (xml2js renders
 *    plain-text subjects as strings, which is all ABS keeps);
 *  - `dc:description` un-escapes `&lt;`/`&gt;` then strips all HTML tags (mirrors `fetchDescription`);
 *  - series read from the `<meta>` array with adjacency preferred plus the single-series
 *    non-adjacent `calibre:series_index` fallback; `sequence` is a trimmed string (or `null`).
 *
 * narratorr emits neither `dc:language` nor `dc:tag`, so `language`/`tags` are parsed for fidelity
 * but are never the subject of an assertion.
 */
export interface AbsParsedOpf {
  title: string | null;
  subtitle: string | null;
  authors: string[];
  narrators: string[];
  publishedYear: string | null;
  publisher: string | null;
  isbn: string | null;
  asin: string | null;
  description: string | null;
  genres: string[];
  language: string | null;
  series: { name: string; sequence: string | null }[];
  tags: string[];
}

type Cheerio = ReturnType<typeof cheerio.load>;
type El = NonNullable<ReturnType<Cheerio>['0']>;

/** All literal attributes on an element (cheerio returns `{}` for an attribute-less node). */
function attrsOf($: Cheerio, el: El): Record<string, string> {
  return ($(el).attr() as Record<string, string> | undefined) ?? {};
}

/**
 * Read a namespaced attribute the way ABS does: the namespace prefix is taken from an `xmlns:*`
 * attribute declared on the element itself, defaulting to `opf` when none is present (narratorr's
 * writer declares `xmlns:opf` on `<metadata>` and uses bare `opf:`-prefixed attrs on the children).
 */
function nsAttr($: Cheerio, el: El, suffix: string): string | null {
  const attribs = attrsOf($, el);
  const ns = Object.keys(attribs).find((k) => k.startsWith('xmlns:'))?.split(':')[1] ?? 'opf';
  return $(el).attr(`${ns}:${suffix}`) ?? null;
}

const sel = (tag: string): string => tag.replace(':', '\\:');

/** `fetchTagString`: text of the first matching element, or null. */
function tagString($: Cheerio, tag: string): string | null {
  const el = $(sel(tag)).first();
  return el.length ? el.text() : null;
}

/** `fetchCreators`: role-bucketed, `new Set`-deduped on the raw value (first-seen), then trimmed. */
function creators($: Cheerio, role: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  $('dc\\:creator').each((_, el) => {
    const value = $(el).text();
    if (nsAttr($, el, 'role') === role && value && !seen.has(value)) {
      seen.add(value);
      const trimmed = value.trim();
      if (trimmed) out.push(trimmed);
    }
  });
  return out;
}

/** `fetchIdentifier`: first `dc:identifier` whose (namespaced) scheme matches case-sensitively. */
function identifier($: Cheerio, scheme: string): string | null {
  let found: string | null = null;
  $('dc\\:identifier').each((_, el) => {
    if (found !== null) return;
    if (!Object.keys(attrsOf($, el)).length) return; // ABS skips identifiers with no attrs
    if (nsAttr($, el, 'scheme') === scheme) found = $(el).text() || null;
  });
  return found;
}

/** `fetchDate`: the leading 4-digit year of `dc:date`, or null when it is not a 4-digit number. */
function publishedYear($: Cheerio): string | null {
  const date = tagString($, 'dc:date');
  if (!date) return null;
  const head = date.split('-')[0] ?? '';
  if (head.length !== 4 || Number.isNaN(Number(head))) return null;
  return head;
}

/** `fetchGenres`: `dc:subject` text, deduped; attribute-bearing subjects are dropped (object form). */
function genres($: Cheerio): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  $('dc\\:subject').each((_, el) => {
    if (Object.keys(attrsOf($, el)).length) return; // xml2js: only plain-text subjects are strings
    const v = $(el).text();
    if (v && !seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  });
  return out;
}

/** `fetchTags`: `dc:tag` text, deduped (narratorr emits none, so this is always []). */
function tags($: Cheerio): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  $('dc\\:tag').each((_, el) => {
    const v = $(el).text();
    if (v && !seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  });
  return out;
}

/**
 * `fetchDescription`: un-escape calibre's `&lt;`/`&gt;` (already-decoded text may carry them) then
 * strip all HTML tags. The tag-strip mirrors ABS's `htmlSanitizer.stripAllTags` for the observable
 * markup-removal effect — plain text passes through unchanged.
 */
function description($: Cheerio): string | null {
  const raw = tagString($, 'dc:description');
  if (!raw) return null;
  return raw.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/<[^>]*>/g, '');
}

/**
 * `fetchSeries`: iterate the `<meta>` elements in document order. Each `calibre:series` with
 * non-empty trimmed content becomes a `{ name, sequence }`; `sequence` is the adjacent next
 * element's content when that element is a `calibre:series_index`. Fallback: a lone series with no
 * sequence adopts the first `calibre:series_index` found anywhere. Finally dedupe by name.
 */
function series($: Cheerio): { name: string; sequence: string | null }[] {
  const metas = $('meta').toArray();
  const name = (el: El): string | undefined => $(el).attr('name');
  const content = (el: El): string | undefined => $(el).attr('content')?.trim() || undefined;

  const result: { name: string; sequence: string | null }[] = [];
  for (let i = 0; i < metas.length; i++) {
    const cur = metas[i];
    if (!cur) continue;
    const c = content(cur);
    if (name(cur) === 'calibre:series' && c) {
      const next = metas[i + 1];
      const sequence = next && name(next) === 'calibre:series_index' ? content(next) ?? null : null;
      result.push({ name: c, sequence });
    }
  }

  const only = result[0];
  if (result.length === 1 && only && !only.sequence) {
    const idx = metas.find((m) => name(m) === 'calibre:series_index' && content(m));
    if (idx) only.sequence = content(idx) ?? null;
  }

  return result.filter((se, idx) => result.findIndex((s) => s.name === se.name) === idx);
}

/**
 * Parse an OPF XML string the way Audiobookshelf would, returning ABS's actual field shape. This is
 * the authoritative compatibility check for `generateOpf` — drift in the OPF shape that breaks ABS's
 * field mapping changes this output even when the XML stays well-formed.
 */
export function parseOpfMetadata(opf: string): AbsParsedOpf {
  const $ = cheerio.load(opf, { xmlMode: true });
  return {
    title: tagString($, 'dc:title'),
    subtitle: tagString($, 'dc:subtitle'),
    authors: creators($, 'aut'),
    narrators: creators($, 'nrt'),
    publishedYear: publishedYear($),
    publisher: tagString($, 'dc:publisher'),
    isbn: identifier($, 'ISBN'),
    asin: identifier($, 'ASIN'),
    description: description($),
    genres: genres($),
    language: tagString($, 'dc:language'),
    series: series($),
    tags: tags($),
  };
}
