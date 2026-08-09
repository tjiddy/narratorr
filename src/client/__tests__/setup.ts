import '@testing-library/jest-dom/vitest';
import { afterEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';

afterEach(cleanup);

// jsdom omits EventSource.
if (typeof globalThis.EventSource === 'undefined') {
  globalThis.EventSource = class MockEventSource {
    url: string;
    onerror: ((event: Event) => void) | null = null;
    constructor(url: string) { this.url = url; }
    addEventListener() {}
    close() {}
  } as unknown as typeof EventSource;
}

// jsdom media methods are noisy stubs, and play() must remain awaitable. Playback
// tests override these inert defaults.
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

// jsdom omits matchMedia.
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
