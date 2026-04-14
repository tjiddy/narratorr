import { describe, it, expect } from 'vitest';
import { manualChunks } from './manual-chunks';

describe('manualChunks', () => {
  it('assigns react to vendor-react chunk', () => {
    expect(manualChunks('/project/node_modules/react/index.js')).toBe('vendor-react');
  });

  it('assigns react-dom to vendor-react chunk', () => {
    expect(manualChunks('/project/node_modules/react-dom/client.js')).toBe('vendor-react');
  });

  it('assigns react-router-dom to vendor-react chunk', () => {
    expect(manualChunks('/project/node_modules/react-router-dom/dist/index.js')).toBe('vendor-react');
  });

  it('assigns react-router to vendor-react chunk', () => {
    expect(manualChunks('/project/node_modules/react-router/dist/index.js')).toBe('vendor-react');
  });

  it('does not assign app modules to vendor chunk', () => {
    expect(manualChunks('/project/src/client/pages/library/LibraryPage.tsx')).toBeUndefined();
  });

  it('does not assign non-react vendor modules to vendor chunk', () => {
    expect(manualChunks('/project/node_modules/@tanstack/react-query/build/index.js')).toBeUndefined();
  });

  it('does not match react substring in non-react packages', () => {
    expect(manualChunks('/project/node_modules/react-icons/lib/index.js')).toBeUndefined();
  });
});
