import type { BookStatus, LibraryFilterBucket } from '@shared/schemas/book.js';

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

/** Deliberately separate, higher-contrast palette for compact table chips. */
export const bookStatusChipStyles: Record<BookStatus, BookStatusChipStyle> = {
  wanted: { text: 'text-amber-500', bg: 'bg-amber-500/10' },
  searching: { text: 'text-blue-400', bg: 'bg-blue-400/10' },
  downloading: { text: 'text-blue-500', bg: 'bg-blue-500/10' },
  importing: { text: 'text-purple-400', bg: 'bg-purple-400/10' },
  imported: { text: 'text-success', bg: 'bg-success/10' },
  missing: { text: 'text-destructive', bg: 'bg-destructive/10' },
  failed: { text: 'text-destructive', bg: 'bg-destructive/10' },
};


export interface SeriesMemberBucketStyle {
  label: string;
  textClass: string;
}

/**
 * Series member badges key on the bucket, not the status, so the label holds steady across the
 * searching→downloading and importing→imported transitions. `imported` reproduces the pre-#2541
 * static badge exactly; the rest borrow this file's per-status tones.
 */
export const seriesMemberBucketStyles: Record<LibraryFilterBucket, SeriesMemberBucketStyle> = {
  wanted: { label: 'Wanted', textClass: 'text-stone-500 dark:text-stone-400' },
  downloading: { label: 'Downloading', textClass: 'text-violet-600 dark:text-violet-400' },
  imported: { label: 'In Library', textClass: 'text-emerald-500' },
  failed: { label: 'Failed', textClass: 'text-rose-600 dark:text-rose-400' },
  missing: { label: 'Missing', textClass: 'text-rose-600 dark:text-rose-400' },
};
