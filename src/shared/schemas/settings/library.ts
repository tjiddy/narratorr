import { z } from 'zod';
import { FOLDER_ALLOWED_TOKENS, FILE_ALLOWED_TOKENS } from '../../../core/utils/naming.js';

export const FOLDER_FORMAT_ALLOWED_TOKENS = [...FOLDER_ALLOWED_TOKENS];
export const FILE_FORMAT_ALLOWED_TOKENS = [...FILE_ALLOWED_TOKENS];

function hasTitle(val: string): boolean {
  return /\{title(?:Sort)?(?::\d+)?(?:\?[^}]*)?\}/.test(val);
}

function validateTokens(val: string, allowed: readonly string[]): boolean {
  const tokenPattern = /\{(\w+)(?::\d+)?(?:\?[^}]*)?\}/g;
  let match: RegExpExecArray | null;
  while ((match = tokenPattern.exec(val)) !== null) {
    if (!allowed.includes(match[1])) return false;
  }
  return true;
}

const folderFormatRefinements = (schema: z.ZodString) =>
  schema.refine(
    hasTitle,
    { message: 'Template must include {title} or {titleSort}' },
  ).refine(
    (val) => validateTokens(val, FOLDER_ALLOWED_TOKENS),
    { message: 'Unknown token in template. Allowed: {author}, {authorLastFirst}, {title}, {titleSort}, {series}, {seriesPosition}, {year}, {narrator}, {narratorLastFirst}' },
  );

const fileFormatRefinements = (schema: z.ZodString) =>
  schema.refine(
    hasTitle,
    { message: 'Template must include {title} or {titleSort}' },
  ).refine(
    (val) => validateTokens(val, FILE_ALLOWED_TOKENS),
    { message: 'Unknown token in template. Allowed: {author}, {title}, {trackNumber}, {trackTotal}, {partName}, and more' },
  );

export const folderFormatSchema = folderFormatRefinements(z.string().default('{author}/{title}'));

export const fileFormatSchema = fileFormatRefinements(z.string().default('{author} - {title}'));

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
  folderFormat: folderFormatRefinements(z.string().trim().min(1, 'Folder format is required')),
  fileFormat: fileFormatRefinements(z.string().trim().min(1, 'File format is required')),
  namingSeparator: z.enum(namingSeparatorValues),
  namingCase: z.enum(namingCaseValues),
});
