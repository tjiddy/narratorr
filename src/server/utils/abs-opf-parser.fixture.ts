import * as cheerio from 'cheerio';

/**
 * Local Audiobookshelf selection semantics for testing generated OPFs, pinned to commit
 * `de22177dbf7413d8cb128e7c1c0dea941583afbc` (2025-03-13):
 * https://github.com/advplyr/audiobookshelf/blob/de22177dbf7413d8cb128e7c1c0dea941583afbc/server/utils/parsers/parseOpfMetadata.js
 * Cheerio replaces xml2js only as the intermediate representation; role bucketing, scheme case,
 * year projection, genre filtering, description stripping, and series pairing mirror ABS.
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

function attrsOf($: Cheerio, el: El): Record<string, string> {
  return ($(el).attr() as Record<string, string> | undefined) ?? {};
}

/** Match ABS namespace lookup, defaulting undeclared child attributes to the `opf` prefix. */
function nsAttr($: Cheerio, el: El, suffix: string): string | null {
  const attribs = attrsOf($, el);
  const ns = Object.keys(attribs).find((k) => k.startsWith('xmlns:'))?.split(':')[1] ?? 'opf';
  return $(el).attr(`${ns}:${suffix}`) ?? null;
}

const sel = (tag: string): string => tag.replace(':', '\\:');

function tagString($: Cheerio, tag: string): string | null {
  const el = $(sel(tag)).first();
  return el.length ? el.text() : null;
}

/** ABS creators deduplicate raw first-seen values before trimming. */
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

/** Select the first identifier whose namespaced scheme matches case-sensitively. */
function identifier($: Cheerio, scheme: string): string | null {
  let found: string | null = null;
  $('dc\\:identifier').each((_, el) => {
    if (found !== null) return;
    if (!Object.keys(attrsOf($, el)).length) return;
    if (nsAttr($, el, 'scheme') === scheme) found = $(el).text() || null;
  });
  return found;
}

/** Project dc:date to its valid four-digit leading year. */
function publishedYear($: Cheerio): string | null {
  const date = tagString($, 'dc:date');
  if (!date) return null;
  const head = date.split('-')[0] ?? '';
  if (head.length !== 4 || Number.isNaN(Number(head))) return null;
  return head;
}

/** Deduplicate plain-text subjects; xml2js makes attribute-bearing subjects objects that ABS drops. */
function genres($: Cheerio): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  $('dc\\:subject').each((_, el) => {
    if (Object.keys(attrsOf($, el)).length) return;
    const v = $(el).text();
    if (v && !seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  });
  return out;
}

/** Deduplicate dc:tag text for fixture fidelity. */
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

/** Mirror ABS description unescaping followed by complete HTML tag stripping. */
function description($: Cheerio): string | null {
  const raw = tagString($, 'dc:description');
  if (!raw) return null;
  return raw.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/<[^>]*>/g, '');
}

/** Pair adjacent series/index metadata, then apply ABS's lone-series fallback and name dedupe. */
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

/** Return ABS's observable field shape, not merely an XML-validity verdict. */
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
