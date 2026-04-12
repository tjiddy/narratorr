/** Static token-to-language map for Usenet newsgroup names. */
const NEWSGROUP_TOKEN_MAP: Record<string, string> = {
  german: 'german',
  deutsch: 'german',
  hoerbuecher: 'german',
  hoerspiele: 'german',
  french: 'french',
  francais: 'french',
  dutch: 'dutch',
  nederlands: 'dutch',
  audioboeken: 'dutch',
  luisterboeken: 'dutch',
  spanish: 'spanish',
  italian: 'italian',
  italiano: 'italian',
  japanese: 'japanese',
  nihongo: 'japanese',
};

/**
 * Detect language from a newsgroup name by splitting on '.' and matching tokens.
 * First match wins. Returns undefined when no language token is found.
 */
export function detectLanguageFromNewsgroup(group: string | undefined): string | undefined {
  if (!group) return undefined;
  const tokens = group.split('.');
  for (const token of tokens) {
    if (!token) continue;
    const lang = NEWSGROUP_TOKEN_MAP[token.toLowerCase()];
    if (lang) return lang;
  }
  return undefined;
}

/** Decode common XML/HTML entities. */
function decodeEntities(text: string): string {
  return text
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&apos;/g, "'");
}

/**
 * Extract the release name from NZB `<meta type="name">` tag.
 * Returns undefined when absent, empty, or whitespace-only.
 */
export function parseNzbName(xml: string): string | undefined {
  const match = /<meta\s+type="name">([^<]+)<\/meta>/i.exec(xml);
  if (!match) return undefined;
  const text = decodeEntities(match[1]).trim();
  return text || undefined;
}

/**
 * Extract the subject from the first `<file subject="...">` attribute.
 * Returns undefined when absent, empty, or whitespace-only.
 */
export function parseNzbFileSubject(xml: string): string | undefined {
  const match = /<file\s[^>]*subject="([^"]*)"/i.exec(xml);
  if (!match) return undefined;
  const text = decodeEntities(match[1]).trim();
  return text || undefined;
}

/**
 * Title-level language tokens for NZB release names.
 * Patterns match common representations including mangled umlauts (? replacing ö/ü).
 */
const NZB_NAME_LANGUAGE_PATTERNS: Array<{ pattern: RegExp; language: string }> = [
  { pattern: /h[öo?]rb[üu?]cher/i, language: 'german' },
  { pattern: /h[öo?]rbuch/i, language: 'german' },
  { pattern: /luisterboek/i, language: 'dutch' },
];

/**
 * Detect language from an NZB release name by scanning for known language tokens.
 * Returns undefined when no language token is found.
 */
export function detectLanguageFromNzbName(name: string | undefined): string | undefined {
  if (!name) return undefined;
  for (const { pattern, language } of NZB_NAME_LANGUAGE_PATTERNS) {
    if (pattern.test(name)) return language;
  }
  return undefined;
}

/**
 * Parse NZB XML and extract all <group> text values.
 * Returns empty array on parse failure or missing groups.
 */
export function parseNzbGroups(xml: string): string[] {
  const groups: string[] = [];
  // Simple regex extraction — NZB <group> tags are plain text, no nesting
  const groupRegex = /<group>([^<]+)<\/group>/gi;
  let match: RegExpExecArray | null;
  while ((match = groupRegex.exec(xml)) !== null) {
    const text = match[1].trim();
    if (text) groups.push(text);
  }
  return groups;
}
