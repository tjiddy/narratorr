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
});
