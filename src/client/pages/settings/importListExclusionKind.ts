import { IMPORT_LIST_EXCLUSION_KINDS, type ImportListExclusionKind } from '@shared/schemas/import-list-exclusion.js';
import type { TabItem } from '@/components/Tabs';

/**
 * The one operator-facing name per kind. `Record<ImportListExclusionKind, …>` rather than a plain
 * object so a kind added to the shared vocabulary fails to compile until it is worded here.
 */
export const KIND_LABELS: Record<ImportListExclusionKind, string> = {
  deleted: 'Deleted',
  added: 'Added by a list',
};

/** Derived from the vocabulary, in its declared order, so the tabs cannot omit a kind. */
export const KIND_TABS: TabItem[] = IMPORT_LIST_EXCLUSION_KINDS.map((kind) => ({
  value: kind,
  label: KIND_LABELS[kind],
}));
