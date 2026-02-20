import {
  ClockIcon,
  ArrowDownIcon,
  CheckCircleIcon,
  PackageIcon,
  AlertCircleIcon,
  PauseIcon,
} from '@/components/icons';

export interface DownloadStatusConfig {
  icon: React.FC<{ className?: string }>;
  label: string;
  color: string;
  bgColor: string;
  textColor: string;
}

export const statusConfig: Record<string, DownloadStatusConfig> = {
  queued: {
    icon: ClockIcon,
    label: 'Queued',
    color: 'text-amber-500',
    bgColor: 'bg-amber-500/10',
    textColor: 'text-amber-600 dark:text-amber-400',
  },
  downloading: {
    icon: ArrowDownIcon,
    label: 'Downloading',
    color: 'text-blue-500',
    bgColor: 'bg-blue-500/10',
    textColor: 'text-blue-600 dark:text-blue-400',
  },
  paused: {
    icon: PauseIcon,
    label: 'Paused',
    color: 'text-muted-foreground',
    bgColor: 'bg-muted',
    textColor: 'text-muted-foreground',
  },
  completed: {
    icon: CheckCircleIcon,
    label: 'Completed',
    color: 'text-success',
    bgColor: 'bg-success/10',
    textColor: 'text-success',
  },
  importing: {
    icon: PackageIcon,
    label: 'Importing',
    color: 'text-violet-500',
    bgColor: 'bg-violet-500/10',
    textColor: 'text-violet-600 dark:text-violet-400',
  },
  imported: {
    icon: CheckCircleIcon,
    label: 'Imported',
    color: 'text-success',
    bgColor: 'bg-success/10',
    textColor: 'text-success',
  },
  failed: {
    icon: AlertCircleIcon,
    label: 'Failed',
    color: 'text-destructive',
    bgColor: 'bg-destructive/10',
    textColor: 'text-destructive',
  },
};
