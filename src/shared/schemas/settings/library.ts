import { z } from 'zod';
import { FOLDER_ALLOWED_TOKENS, FILE_ALLOWED_TOKENS } from '../../../core/utils/naming.js';

export const FOLDER_FORMAT_ALLOWED_TOKENS = [...FOLDER_ALLOWED_TOKENS];
export const FILE_FORMAT_ALLOWED_TOKENS = [...FILE_ALLOWED_TOKENS];

export function hasTitle(val: string): boolean {
  return /\{title(?:Sort)?(?::\d+)?(?:\?[^}]*)?\}/.test(val);
}

export function hasAuthor(val: string): boolean {
  return /\{author(?:LastFirst)?(?::\d+)?(?:\?[^}]*)?\}/.test(val);
}

export function validateTokens(val: string, allowed: readonly string[]): boolean {
  const tokenPattern = /\{(\w+)(?::\d+)?(?:\?[^}]*)?\}/g;
  let match: RegExpExecArray | null;
  while ((match = tokenPattern.exec(val)) !== null) {
    if (!allowed.includes(match[1])) return false;
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

export const namingSeparatorValues = ['space', 'period', 'underscore', 'dash'] as const;
export type NamingSeparator = (typeof namingSeparatorValues)[number];
export const namingSeparatorSchema = z.enum(namingSeparatorValues).default('space');

export const namingCaseValues = ['default', 'lower', 'upper', 'title'] as const;
export type NamingCase = (typeof namingCaseValues)[number];
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
