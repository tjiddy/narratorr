import type { ImportJobType } from '../../../shared/schemas/import-job.js';
import type { ImportAdapter } from './types.js';

const adapters = new Map<ImportJobType, ImportAdapter>();

/**
 * Register an import adapter for a given job type.
 * Called during service wiring in routes/index.ts.
 * Throws if a duplicate type is registered (a wiring bug).
 */
export function registerImportAdapter(adapter: ImportAdapter): void {
  if (adapters.has(adapter.type)) {
    throw new Error(`Import adapter already registered for type "${adapter.type}"`);
  }
  adapters.set(adapter.type, adapter);
}

/** Look up the adapter for a given job type. Returns undefined if not registered. */
export function getImportAdapter(type: ImportJobType): ImportAdapter | undefined {
  return adapters.get(type);
}

/** Clear all registered adapters (for testing). */
export function clearImportAdapters(): void {
  adapters.clear();
}
