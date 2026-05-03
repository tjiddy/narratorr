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

