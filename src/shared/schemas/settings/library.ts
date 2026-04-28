import { z } from 'zod';
import {
  FOLDER_ALLOWED_TOKENS,
  FILE_ALLOWED_TOKENS,
  TOKEN_PATTERN_SOURCE,
  namingSeparatorValues,
  namingCaseValues,
  type NamingSeparator,
  type NamingCase,
} from '../../naming-constants.js';

export { namingSeparatorValues, namingCaseValues, type NamingSeparator, type NamingCase };

export const FOLDER_FORMAT_ALLOWED_TOKENS = [...FOLDER_ALLOWED_TOKENS];
export const FILE_FORMAT_ALLOWED_TOKENS = [...FILE_ALLOWED_TOKENS];

/**
 * Extract disambiguated token names from a template string.
 * Shares the suffix-first precedence logic with validateTokens/parseTemplate.
 */
function extractTokenNames(val: string, allowedTokens: ReadonlySet<string>): string[] {
  const tokenPattern = new RegExp(TOKEN_PATTERN_SOURCE, 'g');
  const names: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = tokenPattern.exec(val)) !== null) {
    const candidatePrefix = match[1];
    const candidateName = match[2];
    let tokenName = candidateName;
    if (candidatePrefix) {
      const firstWordMatch = candidatePrefix.match(/\w+/);
      if (firstWordMatch && allowedTokens.has(firstWordMatch[0])) {
        tokenName = firstWordMatch[0];
      }
    }
    names.push(tokenName);
  }
  return names;
}

/** All known tokens for disambiguation (superset — used by hasTitle/hasAuthor). */
const ALL_TOKENS = new Set<string>([...FILE_ALLOWED_TOKENS]);

export function hasTitle(val: string): boolean {
  const names = extractTokenNames(val, ALL_TOKENS);
  return names.some(n => n === 'title' || n === 'titleSort');
}

export function hasAuthor(val: string): boolean {
  const names = extractTokenNames(val, ALL_TOKENS);
  return names.some(n => n === 'author' || n === 'authorLastFirst');
}

export function validateTokens(val: string, allowed: readonly string[]): boolean {
  const allowedSet = new Set(allowed);
  const tokenPattern = new RegExp(TOKEN_PATTERN_SOURCE, 'g');
  let match: RegExpExecArray | null;
  while ((match = tokenPattern.exec(val)) !== null) {
    // Groups: (1) optional prefix, (2) token candidate, (3) pad spec, (4) optional suffix
    const candidatePrefix = match[1];
    const candidateName = match[2];

    // Suffix-first disambiguation: if candidate prefix contains a known token name,
    // the real token is that word (suffix syntax). Otherwise, candidateName is the token (prefix syntax).
    let tokenName = candidateName;
    if (candidatePrefix) {
      const firstWordMatch = candidatePrefix.match(/\w+/);
      if (firstWordMatch && allowedSet.has(firstWordMatch[0])) {
        tokenName = firstWordMatch[0];
      }
    }

    if (!allowedSet.has(tokenName)) return false;
  }
  return true;
}

export const FOLDER_TITLE_MSG = 'Template must include {title} or {titleSort}';
export const FOLDER_TOKEN_MSG = 'Unknown token in template. Allowed: {author}, {authorLastFirst}, {title}, {titleSort}, {series}, {seriesPosition}, {year}, {narrator}, {narratorLastFirst}';
export const FILE_TITLE_MSG = FOLDER_TITLE_MSG;
export const FILE_TOKEN_MSG = 'Unknown token in template. Allowed: {author}, {title}, {trackNumber}, {trackTotal}, {partName}, and more';
export const AUTHOR_ADVISORY_MSG = 'Consider including {author} for better organization';

export const folderFormatSchema = z.string().default('{author}/{title}').refine(
  hasTitle, { message: FOLDER_TITLE_MSG },
).refine(
  (val) => validateTokens(val, FOLDER_ALLOWED_TOKENS), { message: FOLDER_TOKEN_MSG },
);

export const fileFormatSchema = z.string().default('{author} - {title}').refine(
  hasTitle, { message: FILE_TITLE_MSG },
).refine(
  (val) => validateTokens(val, FILE_ALLOWED_TOKENS), { message: FILE_TOKEN_MSG },
);

export const namingSeparatorSchema = z.enum(namingSeparatorValues).default('space');

export const namingCaseSchema = z.enum(namingCaseValues).default('default');

export const librarySettingsSchema = z.object({
  path: z.string().trim().min(1, 'Library path is required'),
  folderFormat: folderFormatSchema,
  fileFormat: fileFormatSchema,
  namingSeparator: namingSeparatorSchema,
  namingCase: namingCaseSchema,
});

export const libraryFormSchema = z.object({
  path: z.string().trim().min(1, 'Library path is required'),
  folderFormat: z.string().trim().min(1, 'Folder format is required').refine(
    hasTitle, { message: FOLDER_TITLE_MSG },
  ).refine(
    (val) => validateTokens(val, FOLDER_ALLOWED_TOKENS), { message: FOLDER_TOKEN_MSG },
  ),
  fileFormat: z.string().trim().min(1, 'File format is required').refine(
    hasTitle, { message: FILE_TITLE_MSG },
  ).refine(
    (val) => validateTokens(val, FILE_ALLOWED_TOKENS), { message: FILE_TOKEN_MSG },
  ),
  namingSeparator: z.enum(namingSeparatorValues),
  namingCase: z.enum(namingCaseValues),
});

export const namingFormSchema = libraryFormSchema.pick({
  folderFormat: true,
  fileFormat: true,
  namingSeparator: true,
  namingCase: true,
});
