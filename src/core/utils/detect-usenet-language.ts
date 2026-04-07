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
