import { describe, it, expect, afterEach, vi } from 'vitest';
import { getUserAgent } from './user-agent.js';

describe('getUserAgent', () => {
  afterEach(() => {
    // Restore the ambient GIT_TAG so a stubbed value never leaks into other
    // tests (vitest does not auto-restore env stubs unless unstubEnvs is set).
    vi.unstubAllEnvs();
  });

  it('builds Narratorr/<tag> from a build-injected GIT_TAG', () => {
    vi.stubEnv('GIT_TAG', 'v1.2.3');
    expect(getUserAgent()).toBe('Narratorr/v1.2.3');
  });

  it('falls back to Narratorr/dev when GIT_TAG is the sentinel "unknown"', () => {
    vi.stubEnv('GIT_TAG', 'unknown');
    expect(getUserAgent()).toBe('Narratorr/dev');
  });

  it('falls back to Narratorr/dev when GIT_TAG is unset', () => {
    vi.stubEnv('GIT_TAG', undefined);
    expect(getUserAgent()).toBe('Narratorr/dev');
  });

  it('falls back to Narratorr/dev when GIT_TAG is an empty string', () => {
    vi.stubEnv('GIT_TAG', '');
    expect(getUserAgent()).toBe('Narratorr/dev');
  });

  it('falls back to Narratorr/dev when GIT_TAG is whitespace-only', () => {
    vi.stubEnv('GIT_TAG', ' ');
    expect(getUserAgent()).toBe('Narratorr/dev');
  });

  it('strips CR/LF from GIT_TAG so the header value cannot be split', () => {
    vi.stubEnv('GIT_TAG', 'v1.0\r\n');
    expect(getUserAgent()).toBe('Narratorr/v1.0');
  });

  it('strips non-token unicode characters from GIT_TAG', () => {
    vi.stubEnv('GIT_TAG', 'v1.0—ñ');
    expect(getUserAgent()).toBe('Narratorr/v1.0');
  });

  it('falls back to Narratorr/dev when every GIT_TAG character is stripped', () => {
    vi.stubEnv('GIT_TAG', '———');
    expect(getUserAgent()).toBe('Narratorr/dev');
  });

  it('produces a value accepted by the Headers constructor (no throw)', () => {
    vi.stubEnv('GIT_TAG', 'v1.0\r\n');
    expect(() => new Headers({ 'User-Agent': getUserAgent() })).not.toThrow();
    const headers = new Headers({ 'User-Agent': getUserAgent() });
    expect(headers.get('User-Agent')).toBe('Narratorr/v1.0');
  });
});
