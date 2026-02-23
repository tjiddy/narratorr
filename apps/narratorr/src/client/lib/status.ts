export const bookStatusConfig: Record<string, { label: string; dotClass: string; textClass: string }> = {
  wanted: {
    label: 'Wanted',
    dotClass: 'bg-amber-500',
    textClass: 'text-amber-600 dark:text-amber-400',
  },
  searching: {
    label: 'Searching',
    dotClass: 'bg-blue-500 animate-pulse',
    textClass: 'text-blue-600 dark:text-blue-400',
  },
  downloading: {
    label: 'Downloading',
    dotClass: 'bg-blue-500 animate-pulse',
    textClass: 'text-blue-600 dark:text-blue-400',
  },
  imported: {
    label: 'Imported',
    dotClass: 'bg-success',
    textClass: 'text-success',
  },
  missing: {
    label: 'Missing',
    dotClass: 'bg-destructive',
    textClass: 'text-destructive',
  },
  failed: {
    label: 'Failed',
    dotClass: 'bg-destructive',
    textClass: 'text-destructive',
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
