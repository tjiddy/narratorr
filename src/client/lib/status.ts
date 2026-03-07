export interface BookStatusStyle {
  label: string;
  dotClass: string;
  textClass: string;
  barClass: string;
}

export const bookStatusConfig: Record<string, BookStatusStyle> = {
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

export const downloadStatusConfig: Record<
  string,
  {
    icon: string;
    label: string;
    color: string;
    bgColor: string;
    textColor: string;
  }
> = {
  queued: {
    icon: 'clock',
    label: 'Queued',
    color: 'text-amber-500',
    bgColor: 'bg-amber-500/10',
    textColor: 'text-amber-600 dark:text-amber-400',
  },
  downloading: {
    icon: 'arrow-down',
    label: 'Downloading',
    color: 'text-blue-500',
    bgColor: 'bg-blue-500/10',
    textColor: 'text-blue-600 dark:text-blue-400',
  },
  paused: {
    icon: 'pause',
    label: 'Paused',
    color: 'text-muted-foreground',
    bgColor: 'bg-muted',
    textColor: 'text-muted-foreground',
  },
  completed: {
    icon: 'check-circle',
    label: 'Completed',
    color: 'text-success',
    bgColor: 'bg-success/10',
    textColor: 'text-success',
  },
  importing: {
    icon: 'package',
    label: 'Importing',
    color: 'text-violet-500',
    bgColor: 'bg-violet-500/10',
    textColor: 'text-violet-600 dark:text-violet-400',
  },
  imported: {
    icon: 'check-circle',
    label: 'Imported',
    color: 'text-success',
    bgColor: 'bg-success/10',
    textColor: 'text-success',
  },
  failed: {
    icon: 'alert-circle',
    label: 'Failed',
    color: 'text-destructive',
    bgColor: 'bg-destructive/10',
    textColor: 'text-destructive',
  },
};
