import {
  ClockIcon,
  ArrowDownIcon,
  CheckCircleIcon,
  PackageIcon,
  AlertCircleIcon,
  AlertTriangleIcon,
  ShieldIcon,
  PauseIcon,
} from '@/components/icons';
import { DOWNLOAD_STATUS_REGISTRY, type DownloadStatusMetadata } from '@shared/download-status-registry.js';
import type { DownloadStatus } from '@shared/schemas.js';
import type { DownloadBook } from '@/lib/api';

export interface DownloadStatusConfig {
  icon: React.FC<{ className?: string }>;
  label: string;
  color: string;
  bgColor: string;
  textColor: string;
}

const ICON_COMPONENTS: Record<string, React.FC<{ className?: string }>> = {
  'clock': ClockIcon,
  'arrow-down': ArrowDownIcon,
  'check-circle': CheckCircleIcon,
  'package': PackageIcon,
  'alert-circle': AlertCircleIcon,
  'alert-triangle': AlertTriangleIcon,
  'shield': ShieldIcon,
  'pause': PauseIcon,
};

function toStatusConfig(meta: DownloadStatusMetadata): DownloadStatusConfig {
  return {
    icon: ICON_COMPONENTS[meta.icon] ?? ClockIcon,
    label: meta.label,
    color: meta.color,
    bgColor: meta.bgColor,
    textColor: meta.textColor,
  };
}

export const statusConfig: Record<string, DownloadStatusConfig> = Object.fromEntries(
  (Object.entries(DOWNLOAD_STATUS_REGISTRY) as [DownloadStatus, DownloadStatusMetadata][]).map(
    ([status, meta]) => [status, toStatusConfig(meta)],
  ),
);

/** The byline under a download's book title: "Author, Author · Series #3". Null when there is nothing to say. */
export function describeDownloadBook(book: Pick<DownloadBook, 'authors' | 'seriesName' | 'seriesPosition'>): string | null {
  const parts: string[] = [];
  if (book.authors && book.authors.length > 0) parts.push(book.authors.join(', '));
  if (book.seriesName) parts.push(book.seriesPosition != null ? `${book.seriesName} #${book.seriesPosition}` : book.seriesName);
  return parts.length > 0 ? parts.join(' · ') : null;
}
