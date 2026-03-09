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
import { DOWNLOAD_STATUS_REGISTRY, type DownloadStatusMetadata } from '../../../shared/download-status-registry.js';
import type { DownloadStatus } from '../../../shared/schemas.js';

export interface DownloadStatusConfig {
  icon: React.FC<{ className?: string }>;
  label: string;
  color: string;
  bgColor: string;
  textColor: string;
}

/** Map registry icon identifiers to React icon components. */
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
