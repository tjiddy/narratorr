import { describe, it, expect } from 'vitest';
import {
  parseLabels,
  replaceLabel,
  removeLabel,
  parseLinkedIssue,
  parseClosingIssues,
  parseAuthor,
  parseSha,
  parseState,
  parseHeadBranch,
  slugify,
  firstLines,
  parseComments,
} from './lib.ts';

describe('parseLabels', () => {
  it('parses comma-separated labels from gh output', () => {
    const output = '#42 [open] Some Issue\nlabels: status/backlog, type/chore | milestone: v0.3';
    expect(parseLabels(output)).toEqual(['status/backlog', 'type/chore']);
  });

  it('parses labels without milestone suffix', () => {
    const output = '#42 [open] Some Issue\nlabels: status/backlog, type/chore';
    expect(parseLabels(output)).toEqual(['status/backlog', 'type/chore']);
  });

  it('handles single label', () => {
    const output = '#42 [open] Title\nlabels: yolo';
    expect(parseLabels(output)).toEqual(['yolo']);
  });

  it('returns empty array when no labels line', () => {
    expect(parseLabels('no labels here')).toEqual([]);
  });

  it('returns empty array for empty string', () => {
    expect(parseLabels('')).toEqual([]);
  });

  it('trims whitespace from label names', () => {
    const output = 'labels:  status/backlog ,  type/chore  ';
    expect(parseLabels(output)).toEqual(['status/backlog', 'type/chore']);
  });
});

describe('replaceLabel', () => {
  it('replaces label with matching prefix', () => {
    expect(replaceLabel(['status/backlog', 'type/chore'], 'status/', 'status/in-progress'))
      .toEqual(['type/chore', 'status/in-progress']);
  });

  it('adds label when prefix not present', () => {
    expect(replaceLabel(['type/chore'], 'status/', 'status/in-progress'))
      .toEqual(['type/chore', 'status/in-progress']);
  });

  it('preserves standalone flags (yolo, blocked) when replacing status/', () => {
    expect(replaceLabel(['status/backlog', 'yolo', 'blocked', 'type/chore'], 'status/', 'status/done'))
      .toEqual(['yolo', 'blocked', 'type/chore', 'status/done']);
  });

  it('allows status + blocked + yolo simultaneously', () => {
    const labels = ['status/in-progress', 'blocked', 'yolo', 'type/feature'];
    expect(replaceLabel(labels, 'status/', 'status/in-review'))
      .toEqual(['blocked', 'yolo', 'type/feature', 'status/in-review']);
  });

  it('replaces multiple labels with same prefix', () => {
    expect(replaceLabel(['status/a', 'status/b', 'type/chore'], 'status/', 'status/done'))
      .toEqual(['type/chore', 'status/done']);
  });
});

describe('removeLabel', () => {
  it('removes label with matching prefix', () => {
    expect(removeLabel(['status/backlog', 'type/chore'], 'status/'))
      .toEqual(['type/chore']);
  });

  it('no-op when prefix not present', () => {
    expect(removeLabel(['type/chore'], 'status/'))
      .toEqual(['type/chore']);
  });

  it('returns empty array when removing last label', () => {
    expect(removeLabel(['status/backlog'], 'status/')).toEqual([]);
  });

  it('handles empty array', () => {
    expect(removeLabel([], 'status/')).toEqual([]);
  });
});

describe('parseLinkedIssue', () => {
  it('extracts issue number from "Refs #123"', () => {
    expect(parseLinkedIssue('Some text\n\nRefs #123\n\nMore text')).toBe('123');
  });

  it('parses closes #123 format', () => {
    expect(parseLinkedIssue('Some text\n\ncloses #123')).toBe('123');
  });

  it('parses fixes #123 format', () => {
    expect(parseLinkedIssue('fixes #789\n\nSome text')).toBe('789');
  });

  it('prefers closing keyword over Refs when both present', () => {
    expect(parseLinkedIssue('Refs #100\n\ncloses #200')).toBe('200');
  });

  it('parses resolves #123 format', () => {
    expect(parseLinkedIssue('resolves #321\n\nSome text')).toBe('321');
  });

  it('is case insensitive', () => {
    expect(parseLinkedIssue('refs #456')).toBe('456');
    expect(parseLinkedIssue('Closes #456')).toBe('456');
    expect(parseLinkedIssue('FIXES #456')).toBe('456');
    expect(parseLinkedIssue('Resolves #456')).toBe('456');
  });

  it('returns null when no linked issue', () => {
    expect(parseLinkedIssue('No issue reference here')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(parseLinkedIssue('')).toBeNull();
  });
});

describe('parseAuthor', () => {
  it('extracts author from gh PR output', () => {
    const output = 'feature/foo → main | author: claude | sha: abc123';
    expect(parseAuthor(output)).toBe('claude');
  });

  it('returns null when no author field', () => {
    expect(parseAuthor('no author here')).toBeNull();
  });
});

describe('parseSha', () => {
  it('extracts SHA from gh PR output', () => {
    const output = 'feature/foo → main | author: claude | sha: abc123def';
    expect(parseSha(output)).toBe('abc123def');
  });

  it('returns null when no sha field', () => {
    expect(parseSha('no sha here')).toBeNull();
  });
});

describe('parseState', () => {
  it('extracts open state from bracket format', () => {
    expect(parseState('#42 [open] Some Issue')).toBe('open');
  });

  it('extracts closed state from bracket format', () => {
    expect(parseState('#42 [closed] Some Issue')).toBe('closed');
  });

  it('works with multiline PR output', () => {
    const output = '#313 [open] RSS Sync\nfeature/rss → main | author: claude';
    expect(parseState(output)).toBe('open');
  });

  it('returns null for malformed input', () => {
    expect(parseState('no state here')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(parseState('')).toBeNull();
  });
});

describe('parseHeadBranch', () => {
  it('extracts branch name before arrow', () => {
    const output = '#313 [open] Title\nfeature/issue-269-rss-sync → main | author: claude';
    expect(parseHeadBranch(output)).toBe('feature/issue-269-rss-sync');
  });

  it('returns null for malformed input', () => {
    expect(parseHeadBranch('no branch here')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(parseHeadBranch('')).toBeNull();
  });
});

describe('slugify', () => {
  it('converts title to lowercase kebab-case', () => {
    expect(slugify('Hello World')).toBe('hello-world');
  });

  it('handles special characters', () => {
    expect(slugify('Fix: API "error" handling!')).toBe('fix-api-error-handling');
  });

  it('handles empty string', () => {
    expect(slugify('')).toBe('');
  });

  it('respects maxLen parameter', () => {
    expect(slugify('A Very Long Title That Exceeds The Limit', 10)).toBe('a-very-lon');
  });

  it('does not end with a hyphen after truncation', () => {
    expect(slugify('hello world foo bar', 12)).toBe('hello-world');
  });

  it('strips leading and trailing hyphens', () => {
    expect(slugify('---hello---')).toBe('hello');
  });
});

describe('parseComments', () => {
  it('parses comment text blocks', () => {
    const output = '--- comment 123 | alice | 2026-03-01T10:00:00Z ---\nHello world\n\n--- comment 456 | bob | 2026-03-02T11:00:00Z ---\nAnother comment';
    const result = parseComments(output);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ id: '123', username: 'alice', date: '2026-03-01T10:00:00Z', body: 'Hello world' });
    expect(result[1]).toEqual({ id: '456', username: 'bob', date: '2026-03-02T11:00:00Z', body: 'Another comment' });
  });

  it('handles single comment', () => {
    const output = '--- comment 789 | user | 2026-01-01T00:00:00Z ---\nBody text';
    const result = parseComments(output);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('789');
  });

  it('handles empty output', () => {
    expect(parseComments('')).toEqual([]);
  });

  it('handles multiline comment bodies', () => {
    const output = '--- comment 1 | alice | 2026-01-01T00:00:00Z ---\nLine 1\nLine 2\nLine 3';
    const result = parseComments(output);
    expect(result[0].body).toBe('Line 1\nLine 2\nLine 3');
  });

  it('skips malformed comment blocks', () => {
    const output = '--- comment badformat\nsome text\n--- comment 1 | alice | 2026-01-01T00:00:00Z ---\nValid';
    const result = parseComments(output);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('1');
  });
});

describe('parseClosingIssues', () => {
  it('returns [123] for Refs #123 (refs is a linked keyword)', () => {
    expect(parseClosingIssues('Refs #123')).toEqual(['123']);
  });

  it('returns [123] for closes #123', () => {
    expect(parseClosingIssues('closes #123')).toEqual(['123']);
  });

  it('returns [123] for fixes #123', () => {
    expect(parseClosingIssues('fixes #123')).toEqual(['123']);
  });

  it('returns [123, 456] for body with closes #123 and closes #456', () => {
    expect(parseClosingIssues('closes #123\nsome text\ncloses #456')).toEqual(['123', '456']);
  });

  it('returns empty array for no issue reference', () => {
    expect(parseClosingIssues('No issue reference here')).toEqual([]);
  });

  it('returns [123] for resolves #123', () => {
    expect(parseClosingIssues('resolves #123')).toEqual(['123']);
  });

  it('is case-insensitive (Closes vs closes vs CLOSES vs Resolves)', () => {
    expect(parseClosingIssues('Closes #1\nfixes #2\nRESOLVES #3')).toEqual(['1', '2', '3']);
  });
});

describe('firstLines', () => {
  it('truncates to N lines', () => {
    expect(firstLines('a\nb\nc\nd', 2)).toBe('a\nb');
  });

  it('returns all lines when input is shorter than N', () => {
    expect(firstLines('a\nb', 5)).toBe('a\nb');
  });

  it('handles empty string', () => {
    expect(firstLines('', 3)).toBe('');
  });

  it('handles single line', () => {
    expect(firstLines('hello', 1)).toBe('hello');
  });
});
