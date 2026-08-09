// Normalize indexer and MAM identifiers to the app's lowercase full-name format.

import { MAM_LANGUAGES } from '@shared/indexer-registry.js';

const ISO_639_TO_NAME: Record<string, string> = {
  // ISO 639-2/B bibliographic codes used by MAM and most Newznab indexers.
  eng: 'english',
  ger: 'german',
  fre: 'french',
  spa: 'spanish',
  ita: 'italian',
  jpn: 'japanese',
  por: 'portuguese',
  rus: 'russian',
  zho: 'chinese',
  chi: 'chinese',
  kor: 'korean',
  ara: 'arabic',
  hin: 'hindi',
  dut: 'dutch',
  nld: 'dutch',
  swe: 'swedish',
  nor: 'norwegian',
  dan: 'danish',
  fin: 'finnish',
  pol: 'polish',
  tur: 'turkish',
  heb: 'hebrew',
  tha: 'thai',
  vie: 'vietnamese',
  ces: 'czech',
  cze: 'czech',
  hun: 'hungarian',
  ron: 'romanian',
  rum: 'romanian',
  ukr: 'ukrainian',
  cat: 'catalan',
  ell: 'greek',
  gre: 'greek',
  bul: 'bulgarian',
  hrv: 'croatian',
  srp: 'serbian',
  slk: 'slovak',
  slo: 'slovak',
  slv: 'slovenian',
  lit: 'lithuanian',
  lav: 'latvian',
  est: 'estonian',
  // ISO 639-1 codes used by some indexers.
  en: 'english',
  de: 'german',
  fr: 'french',
  es: 'spanish',
  it: 'italian',
  ja: 'japanese',
  pt: 'portuguese',
  ru: 'russian',
  zh: 'chinese',
  ko: 'korean',
  ar: 'arabic',
  hi: 'hindi',
  nl: 'dutch',
  sv: 'swedish',
  no: 'norwegian',
  da: 'danish',
  fi: 'finnish',
  pl: 'polish',
  tr: 'turkish',
  he: 'hebrew',
  th: 'thai',
  vi: 'vietnamese',
  cs: 'czech',
  hu: 'hungarian',
  ro: 'romanian',
  uk: 'ukrainian',
  el: 'greek',
  bg: 'bulgarian',
  hr: 'croatian',
  sr: 'serbian',
  sk: 'slovak',
  sl: 'slovenian',
  lt: 'lithuanian',
  lv: 'latvian',
  et: 'estonian',
};

const KNOWN_NAMES = new Set(Object.values(ISO_639_TO_NAME));

// Derive MAM's numeric codes from the shared registry to prevent UI/API drift.
const MAM_NUMERIC_TO_NAME = new Map<string, string>(
  MAM_LANGUAGES.map((l) => [String(l.id), l.label.toLowerCase()]),
);

/** Unknown values pass through lowercased; blank input returns undefined. */
export function normalizeLanguage(code: string | undefined | null): string | undefined {
  if (!code || !code.trim()) return undefined;
  const lower = code.trim().toLowerCase();
  if (KNOWN_NAMES.has(lower)) return lower;
  const iso = ISO_639_TO_NAME[lower];
  if (iso) return iso;
  const mam = MAM_NUMERIC_TO_NAME.get(lower);
  if (mam) return mam;
  return lower;
}
