import { describe, it } from 'vitest';

describe('formatDate', () => {
  it.todo('returns locale-formatted absolute date string for valid ISO input');
  it.todo('returns "Invalid Date" for invalid date string input');
  it.todo('handles ISO string with timezone offset');
});

describe('formatRelativeDate', () => {
  it.todo('returns "Just now" for timestamps less than 1 minute ago');
  it.todo('returns "5m ago" for timestamps 5 minutes ago');
  it.todo('returns "3h ago" for timestamps 3 hours ago');
  it.todo('returns "2d ago" for timestamps 2 days ago');
  it.todo('falls back to absolute date for timestamps 8+ days ago');
  it.todo('boundary: exactly 60 minutes returns "1h ago" not "60m ago"');
  it.todo('boundary: exactly 24 hours returns "1d ago" not "24h ago"');
  it.todo('boundary: exactly 7 days falls back to absolute date not "7d ago"');
});
