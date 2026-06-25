import '@testing-library/jest-dom/vitest';
import { afterEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';

// Auto-cleanup DOM between tests
afterEach(cleanup);

// jsdom doesn't implement EventSource — provide a no-op stub
if (typeof globalThis.EventSource === 'undefined') {
  globalThis.EventSource = class MockEventSource {
    url: string;
    onerror: ((event: Event) => void) | null = null;
    constructor(url: string) { this.url = url; }
    addEventListener() { /* stub */ }
    close() { /* stub */ }
  } as unknown as typeof EventSource;
}

// jsdom doesn't implement HTMLMediaElement playback (play/pause/load): calling
// them emits "Not implemented" noise to stderr, and play() returns undefined
// instead of a Promise, which breaks code that awaits it. Provide inert defaults
// so any component that mounts an <audio>/<video> — AudioPreview via BookDetails
// and ImportCard, etc. — is silent on render/unmount. setupFiles run before each
// test file, so this resets to a clean baseline per file. Tests that need actual
// playback behavior (event dispatch, paused toggling) override these per-test —
// see AudioPreview.test.tsx.
if (typeof globalThis.HTMLMediaElement !== 'undefined') {
  Object.defineProperty(globalThis.HTMLMediaElement.prototype, 'play', {
    configurable: true,
    writable: true,
    value: vi.fn().mockResolvedValue(undefined),
  });
  Object.defineProperty(globalThis.HTMLMediaElement.prototype, 'pause', {
    configurable: true,
    writable: true,
    value: vi.fn(),
  });
  Object.defineProperty(globalThis.HTMLMediaElement.prototype, 'load', {
    configurable: true,
    writable: true,
    value: vi.fn(),
  });
}

// jsdom doesn't implement window.matchMedia — provide a default stub
// Guard for node environment where window.matchMedia doesn't exist
if (typeof window !== 'undefined') {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}
