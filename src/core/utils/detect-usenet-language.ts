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

// Decode numeric refs first so escaped text such as `&amp;#246;` remains literal after the named-ref pass.
function decodeEntities(text: string): string {
  return text
    .replace(/&#(x[0-9a-f]+|\d+);/gi, (match, ref: string) => {
      const codePoint =
        ref[0] === 'x' || ref[0] === 'X'
          ? parseInt(ref.slice(1), 16)
          : parseInt(ref, 10);
      if (!Number.isFinite(codePoint) || codePoint < 0 || codePoint > 0x10ffff) return match;
      if (codePoint >= 0xd800 && codePoint <= 0xdfff) return match;
      try {
        return String.fromCodePoint(codePoint);
      } catch {
        return match;
      }
    })
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&apos;/g, "'");
}

export function parseNzbName(xml: string): string | undefined {
  const match = /<meta\s+type="name">([^<]+)<\/meta>/i.exec(xml);
  if (!match) return undefined;
  const text = decodeEntities(match[1]!).trim();
  return text || undefined;
}

export function parseNzbFileSubject(xml: string): string | undefined {
  const match = /<file\s[^>]*subject="([^"]*)"/i.exec(xml);
  if (!match) return undefined;
  const text = decodeEntities(match[1]!).trim();
  return text || undefined;
}

// Accept UTF-8, ASCII digraphs, dropped umlauts, `?`, and mojibake; only the gekürzt family accepts `ue`/no character.
const O_UMLAUT_OR_MOJIBAKE = '(?:[öo?]|Ã¶)';
const U_UMLAUT_OR_MOJIBAKE_PLACEHOLDER = '(?:[üu?]|Ã¼)';
const UE_UMLAUT_FAMILY = '(?:[üu](?:e?)|Ã¼)?';

const LANGUAGE_TEXT_PATTERNS: Array<{ pattern: RegExp; language: string }> = [
  { pattern: new RegExp(`h${O_UMLAUT_OR_MOJIBAKE}rb${U_UMLAUT_OR_MOJIBAKE_PLACEHOLDER}cher`, 'i'), language: 'german' },
  { pattern: new RegExp(`h${O_UMLAUT_OR_MOJIBAKE}rbuch`, 'i'), language: 'german' },
  { pattern: new RegExp(`ungek${UE_UMLAUT_FAMILY}rzt`, 'i'), language: 'german' },
  { pattern: new RegExp(`gek${UE_UMLAUT_FAMILY}rzt`, 'i'), language: 'german' },
  { pattern: /luisterboek/i, language: 'dutch' },
];

export function detectLanguageFromText(text: string | undefined): string | undefined {
  if (!text) return undefined;
  for (const { pattern, language } of LANGUAGE_TEXT_PATTERNS) {
    if (pattern.test(text)) return language;
  }
  return undefined;
}

export function parseNzbGroups(xml: string): string[] {
  const groups: string[] = [];
  const groupRegex = /<group>([^<]+)<\/group>/gi;
  let match: RegExpExecArray | null;
  while ((match = groupRegex.exec(xml)) !== null) {
    const text = match[1]!.trim();
    if (text) groups.push(text);
  }
  return groups;
}
