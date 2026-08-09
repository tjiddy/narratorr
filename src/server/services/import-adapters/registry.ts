import type { ImportJobType } from '@shared/schemas/import-job.js';
import type { ImportAdapter } from './types.js';

const adapters = new Map<ImportJobType, ImportAdapter>();

export function registerImportAdapter(adapter: ImportAdapter): void {
  if (adapters.has(adapter.type)) {
    throw new Error(`Import adapter already registered for type "${adapter.type}"`);
  }
  adapters.set(adapter.type, adapter);
}

export function getImportAdapter(type: ImportJobType): ImportAdapter | undefined {
  return adapters.get(type);
}

export function clearImportAdapters(): void {
  adapters.clear();
}
