import { describe, it, expect } from 'vitest';
import { FOLDER_ALLOWED_TOKENS } from '../../../core/utils/naming.js';
import {
  hasTitle,
  hasAuthor,
  validateTokens,
  FOLDER_TITLE_MSG,
  FOLDER_TOKEN_MSG,
  FILE_TITLE_MSG,
  FILE_TOKEN_MSG,
  FILE_FORMAT_ALLOWED_TOKENS,
  libraryFormSchema,
  namingFormSchema,
} from './library.js';

describe('hasTitle', () => {
  it('returns true for {title}', () => {
    expect(hasTitle('{title}')).toBe(true);
  });

  it('returns true for {titleSort}', () => {
    expect(hasTitle('{titleSort}')).toBe(true);
  });

  it('returns true for {title:20} (truncation modifier)', () => {
    expect(hasTitle('{title:20}')).toBe(true);
  });

  it('returns true for {title?fallback} (conditional)', () => {
    expect(hasTitle('{title?fallback}')).toBe(true);
  });

  it('returns false for empty string', () => {
    expect(hasTitle('')).toBe(false);
  });

  it('returns false for {author} (not a title token)', () => {
    expect(hasTitle('{author}')).toBe(false);
  });

  it('returns false for {Title} (case-sensitive)', () => {
    expect(hasTitle('{Title}')).toBe(false);
  });
});

describe('hasAuthor', () => {
  it('returns true for {author}', () => {
    expect(hasAuthor('{author}')).toBe(true);
  });

  it('returns true for {authorLastFirst}', () => {
    expect(hasAuthor('{authorLastFirst}')).toBe(true);
  });

  it('returns false for empty string', () => {
    expect(hasAuthor('')).toBe(false);
  });

  it('returns false for {title}', () => {
    expect(hasAuthor('{title}')).toBe(false);
  });
});

describe('validateTokens', () => {
  it('returns true for {author}/{title} against folder allowed tokens', () => {
    expect(validateTokens('{author}/{title}', FOLDER_ALLOWED_TOKENS)).toBe(true);
  });

  it('returns false for {unknownToken} against folder allowed tokens', () => {
    expect(validateTokens('{unknownToken}', FOLDER_ALLOWED_TOKENS)).toBe(false);
  });

  it('returns true for empty string (no tokens to validate)', () => {
    expect(validateTokens('', FOLDER_ALLOWED_TOKENS)).toBe(true);
  });

  it('returns true for {title:20} with truncation modifier', () => {
    expect(validateTokens('{title:20}', FOLDER_ALLOWED_TOKENS)).toBe(true);
  });

  it('returns true for plain text with no tokens', () => {
    expect(validateTokens('just text', FOLDER_ALLOWED_TOKENS)).toBe(true);
  });
});

describe('hasTitle — prefix conditional syntax', () => {
  it('returns true for {pre?title} (prefix syntax with title token)', () => {
    expect(hasTitle('{pre?title}')).toBe(true);
  });

  it('returns true for { - ?title} (prefix syntax)', () => {
    expect(hasTitle('{ - ?title}')).toBe(true);
  });

  it('returns true for {pre?titleSort} (prefix syntax with titleSort)', () => {
    expect(hasTitle('{pre?titleSort}')).toBe(true);
  });

  it('returns false for {author?title} — suffix-first: "author" is a known token, "title" is suffix text', () => {
    expect(hasTitle('{author?title}')).toBe(false);
  });

  it('returns false for {series?titleSort} — suffix-first: "series" is a known token', () => {
    expect(hasTitle('{series?titleSort}')).toBe(false);
  });
});

describe('hasAuthor — prefix conditional syntax', () => {
  it('returns true for {pre?author} (prefix syntax with author token)', () => {
    expect(hasAuthor('{pre?author}')).toBe(true);
  });

  it('returns true for {pre?authorLastFirst}', () => {
    expect(hasAuthor('{pre?authorLastFirst}')).toBe(true);
  });

  it('returns false for {title?author} — suffix-first: "title" is a known token, "author" is suffix text', () => {
    expect(hasAuthor('{title?author}')).toBe(false);
  });
});

describe('validateTokens — prefix conditional syntax', () => {
  it('extracts token name from prefix syntax, not prefix text', () => {
    expect(validateTokens('{ - pt?trackNumber:00}', FILE_FORMAT_ALLOWED_TOKENS)).toBe(true);
  });

  it('accepts {title}{ - pt?trackNumber:00} as valid file format', () => {
    expect(validateTokens('{title}{ - pt?trackNumber:00}', FILE_FORMAT_ALLOWED_TOKENS)).toBe(true);
  });

  it('rejects prefix syntax with unknown token name', () => {
    expect(validateTokens('{pre?unknownToken}', FOLDER_ALLOWED_TOKENS)).toBe(false);
  });
});

describe('error message constants', () => {
  it('exports folder title message', () => {
    expect(FOLDER_TITLE_MSG).toBe('Template must include {title} or {titleSort}');
  });

  it('exports folder token message', () => {
    expect(FOLDER_TOKEN_MSG).toContain('Unknown token in template');
  });

  it('exports file title message', () => {
    expect(FILE_TITLE_MSG).toBe(FOLDER_TITLE_MSG);
  });

  it('exports file token message', () => {
    expect(FILE_TOKEN_MSG).toContain('Unknown token in template');
  });
});

describe('libraryFormSchema', () => {
  it('rejects template missing {title}', () => {
    const result = libraryFormSchema.safeParse({
      path: '/lib',
      folderFormat: '{author}',
      fileFormat: '{title}',
      namingSeparator: 'space',
      namingCase: 'default',
    });
    expect(result.success).toBe(false);
  });

  it('rejects unknown token in folder format', () => {
    const result = libraryFormSchema.safeParse({
      path: '/lib',
      folderFormat: '{title}/{badToken}',
      fileFormat: '{title}',
      namingSeparator: 'space',
      namingCase: 'default',
    });
    expect(result.success).toBe(false);
  });

  it('accepts valid folder and file formats', () => {
    const result = libraryFormSchema.safeParse({
      path: '/lib',
      folderFormat: '{author}/{title}',
      fileFormat: '{author} - {title}',
      namingSeparator: 'space',
      namingCase: 'default',
    });
    expect(result.success).toBe(true);
  });

  it('rejects empty folder format', () => {
    const result = libraryFormSchema.safeParse({
      path: '/lib',
      folderFormat: '',
      fileFormat: '{title}',
      namingSeparator: 'space',
      namingCase: 'default',
    });
    expect(result.success).toBe(false);
  });

  it('rejects whitespace-only folder format', () => {
    const result = libraryFormSchema.safeParse({
      path: '/lib',
      folderFormat: '   ',
      fileFormat: '{title}',
      namingSeparator: 'space',
      namingCase: 'default',
    });
    expect(result.success).toBe(false);
  });
});

describe('namingFormSchema via .pick()', () => {
  it('rejects {unknownToken} identically to inline schema', () => {
    const result = namingFormSchema.safeParse({
      folderFormat: '{title}/{badToken}',
      fileFormat: '{title}',
      namingSeparator: 'space',
      namingCase: 'default',
    });
    expect(result.success).toBe(false);
  });

  it('rejects empty string folder format', () => {
    const result = namingFormSchema.safeParse({
      folderFormat: '',
      fileFormat: '{title}',
      namingSeparator: 'space',
      namingCase: 'default',
    });
    expect(result.success).toBe(false);
  });

  it('accepts valid naming configuration', () => {
    const result = namingFormSchema.safeParse({
      folderFormat: '{author}/{title}',
      fileFormat: '{author} - {title}',
      namingSeparator: 'dash',
      namingCase: 'lower',
    });
    expect(result.success).toBe(true);
  });

  it('only includes folderFormat, fileFormat, namingSeparator, namingCase', () => {
    const result = namingFormSchema.safeParse({
      folderFormat: '{author}/{title}',
      fileFormat: '{title}',
      namingSeparator: 'space',
      namingCase: 'default',
      path: '/lib', // extra field from libraryFormSchema
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).not.toHaveProperty('path');
    }
  });
});
