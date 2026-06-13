import type { BookStatus } from '../../shared/schemas/book.js';

export interface BookStatusStyle {
  label: string;
  dotClass: string;
  textClass: string;
  barClass: string;
}

export const bookStatusConfig: Record<BookStatus, BookStatusStyle> = {
  wanted: {
    label: 'Wanted',
    dotClass: 'bg-stone-400/70',
    textClass: 'text-stone-500 dark:text-stone-400',
    barClass: 'bg-stone-400/70',
  },
  searching: {
    label: 'Searching',
    dotClass: 'bg-sky-400 animate-pulse',
    textClass: 'text-sky-600 dark:text-sky-400',
    barClass: 'bg-sky-400 status-bar-shimmer',
  },
  downloading: {
    label: 'Downloading',
    dotClass: 'bg-violet-500 animate-pulse',
    textClass: 'text-violet-600 dark:text-violet-400',
    barClass: 'bg-violet-500 status-bar-shimmer',
  },
  importing: {
    label: 'Importing',
    dotClass: 'bg-amber-500 animate-pulse',
    textClass: 'text-amber-600 dark:text-amber-400',
    barClass: 'bg-amber-500 status-bar-shimmer',
  },
  imported: {
    label: 'Imported',
    dotClass: 'bg-emerald-500',
    textClass: 'text-emerald-600 dark:text-emerald-400',
    barClass: 'bg-emerald-500',
  },
  missing: {
    label: 'Missing',
    dotClass: 'bg-rose-500',
    textClass: 'text-rose-600 dark:text-rose-400',
    barClass: 'bg-rose-500',
  },
  failed: {
    label: 'Failed',
    dotClass: 'bg-rose-500',
    textClass: 'text-rose-600 dark:text-rose-400',
    barClass: 'bg-rose-500',
  },
};

export interface BookStatusChipStyle {
  text: string;
  bg: string;
}

/**
 * Compact chip styling for the library **table** view (#1447 / S2d). A separate
 * palette from `bookStatusConfig` (the grid/detail dot+bar styling) on purpose —
 * the table chip is a denser, higher-contrast treatment. Typed
 * `Record<BookStatus, …>` and drift-guarded (status.test.ts set-equality) so the
 * chip renders every first-class canonical status directly, with no empty-style
 * or roll-up fallback.
 */
export const bookStatusChipStyles: Record<BookStatus, BookStatusChipStyle> = {
  wanted: { text: 'text-amber-500', bg: 'bg-amber-500/10' },
  searching: { text: 'text-blue-400', bg: 'bg-blue-400/10' },
  downloading: { text: 'text-blue-500', bg: 'bg-blue-500/10' },
  importing: { text: 'text-purple-400', bg: 'bg-purple-400/10' },
  imported: { text: 'text-success', bg: 'bg-success/10' },
  missing: { text: 'text-destructive', bg: 'bg-destructive/10' },
  failed: { text: 'text-destructive', bg: 'bg-destructive/10' },
};

