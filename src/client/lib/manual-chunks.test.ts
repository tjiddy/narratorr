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

  it('assigns @tanstack/react-query to tanstack-query chunk', () => {
    expect(manualChunks('/project/node_modules/@tanstack/react-query/build/index.js')).toBe('vendor-tanstack-query');
  });

  it('assigns @tanstack/query-core to tanstack-query chunk', () => {
    expect(manualChunks('/project/node_modules/@tanstack/query-core/build/index.js')).toBe('vendor-tanstack-query');
  });

  it('assigns @tanstack/react-query sub-paths to tanstack-query chunk', () => {
    expect(manualChunks('/project/node_modules/@tanstack/react-query/build/modern/index.js')).toBe('vendor-tanstack-query');
  });

  it('does not assign unrelated @tanstack packages to tanstack-query chunk', () => {
    expect(manualChunks('/project/node_modules/@tanstack/react-table/build/index.js')).toBeUndefined();
  });

  it('does not assign @tanstack/react-query-devtools to tanstack-query chunk', () => {
    expect(manualChunks('/project/node_modules/@tanstack/react-query-devtools/build/index.js')).toBeUndefined();
  });

  it('does not match react substring in non-react packages', () => {
    expect(manualChunks('/project/node_modules/react-icons/lib/index.js')).toBeUndefined();
  });

  it('does not assign app modules to vendor chunk', () => {
    expect(manualChunks('/project/src/client/pages/library/LibraryPage.tsx')).toBeUndefined();
  });
});
