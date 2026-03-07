import { z } from 'zod';

export const FOLDER_FORMAT_ALLOWED_TOKENS = [
  'author', 'authorLastFirst',
  'title', 'titleSort',
  'series', 'seriesPosition',
  'year',
  'narrator', 'narratorLastFirst',
];

export const FILE_FORMAT_ALLOWED_TOKENS = [
  ...FOLDER_FORMAT_ALLOWED_TOKENS,
  'trackNumber', 'trackTotal', 'partName',
];

function hasTitle(val: string): boolean {
  return /\{title(?:Sort)?(?::\d+)?(?:\?[^}]*)?\}/.test(val);
}

function validateTokens(val: string, allowed: string[]): boolean {
  const tokenPattern = /\{(\w+)(?::\d+)?(?:\?[^}]*)?\}/g;
  let match: RegExpExecArray | null;
  while ((match = tokenPattern.exec(val)) !== null) {
    if (!allowed.includes(match[1])) return false;
  }
  return true;
}

export const folderFormatSchema = z.string().default('{author}/{title}').refine(
  hasTitle,
  { message: 'Template must include {title} or {titleSort}' },
).refine(
  (val) => validateTokens(val, FOLDER_FORMAT_ALLOWED_TOKENS),
  { message: 'Unknown token in template. Allowed: {author}, {authorLastFirst}, {title}, {titleSort}, {series}, {seriesPosition}, {year}, {narrator}, {narratorLastFirst}' },
);

export const fileFormatSchema = z.string().default('{author} - {title}').refine(
  hasTitle,
  { message: 'Template must include {title} or {titleSort}' },
).refine(
  (val) => validateTokens(val, FILE_FORMAT_ALLOWED_TOKENS),
  { message: 'Unknown token in template. Allowed: {author}, {title}, {trackNumber}, {trackTotal}, {partName}, and more' },
);

export const librarySettingsSchema = z.object({
  path: z.string().min(1, 'Library path is required'),
  folderFormat: folderFormatSchema,
  fileFormat: fileFormatSchema,
});

export const libraryFormSchema = z.object({
  path: z.string().min(1, 'Library path is required'),
  folderFormat: z.string().min(1, 'Folder format is required').refine(
    hasTitle,
    { message: 'Template must include {title} or {titleSort}' },
  ).refine(
    (val) => validateTokens(val, FOLDER_FORMAT_ALLOWED_TOKENS),
    { message: 'Unknown token in template' },
  ),
  fileFormat: z.string().min(1, 'File format is required').refine(
    hasTitle,
    { message: 'Template must include {title} or {titleSort}' },
  ).refine(
    (val) => validateTokens(val, FILE_FORMAT_ALLOWED_TOKENS),
    { message: 'Unknown token in file template' },
  ),
});
