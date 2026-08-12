/** Keeps large, stable shared dependencies separate; route-specific and app code stay automatic. */
export function manualChunks(id: string): string | undefined {
  if (id.includes('node_modules/react-dom')) return 'vendor-react';
  if (id.includes('node_modules/react-router')) return 'vendor-react';
  if (id.includes('node_modules/react/')) return 'vendor-react';
  if (id.includes('node_modules/@tanstack/react-query/')) return 'vendor-tanstack-query';
  if (id.includes('node_modules/@tanstack/query-core/')) return 'vendor-tanstack-query';
}
