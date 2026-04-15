/**
 * Vite/Rollup manual chunk assignment.
 *
 * Packages that are large, stable, and shared across many routes get their own
 * vendor chunk so that app-code changes don't invalidate the cached vendor bundle.
 *
 * Criteria for a dedicated chunk:
 *  - Used on most pages (shared infrastructure, not page-specific)
 *  - Changes infrequently relative to app code
 *  - Large enough that splitting saves meaningful cache bandwidth
 *
 * Packages that don't meet all three stay in the default Rollup chunks.
 * Route-level code splitting is handled separately via React.lazy in App.tsx.
 *
 * The largest unlabeled shared chunk (~163 kB) is Rollup's automatic split of
 * application code shared across multiple lazy-loaded routes (settings pages,
 * library import, formatters). It is intentionally not assigned here because it
 * contains app code that changes with the application, not stable vendor code.
 */
export function manualChunks(id: string): string | undefined {
  if (id.includes('node_modules/react-dom')) return 'vendor-react';
  if (id.includes('node_modules/react-router')) return 'vendor-react';
  if (id.includes('node_modules/react/')) return 'vendor-react';
  if (id.includes('node_modules/@tanstack/react-query/')) return 'vendor-tanstack-query';
  if (id.includes('node_modules/@tanstack/query-core/')) return 'vendor-tanstack-query';
}
