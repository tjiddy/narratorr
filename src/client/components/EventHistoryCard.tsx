import { useState } from 'react';
import { type BookEvent } from '@/lib/api';
import { formatRelativeDate } from '@/lib/format';
import {
  ArrowDownIcon,
  CheckCircleIcon,
  XCircleIcon,
  PackageIcon,
  TrashIcon,
  RefreshIcon,
  ClockIcon,
  AlertTriangleIcon,
  BookOpenIcon,
} from '@/components/icons';

const ACTIONABLE_TYPES = ['grabbed', 'download_completed', 'download_failed', 'imported', 'import_failed'];

interface EventTypeConfig {
  icon: typeof ArrowDownIcon;
  label: string;
  color: string;
  bgColor: string;
}

const EVENT_CONFIG: Record<string, EventTypeConfig> = {
  grabbed: { icon: ArrowDownIcon, label: 'Grabbed', color: 'text-blue-400', bgColor: 'bg-blue-500/10' },
  download_completed: { icon: CheckCircleIcon, label: 'Download Completed', color: 'text-success', bgColor: 'bg-success/10' },
  download_failed: { icon: XCircleIcon, label: 'Download Failed', color: 'text-destructive', bgColor: 'bg-destructive/10' },
  imported: { icon: PackageIcon, label: 'Imported', color: 'text-success', bgColor: 'bg-success/10' },
  import_failed: { icon: XCircleIcon, label: 'Import Failed', color: 'text-destructive', bgColor: 'bg-destructive/10' },
  upgraded: { icon: RefreshIcon, label: 'Upgraded', color: 'text-violet-400', bgColor: 'bg-violet-500/10' },
  deleted: { icon: TrashIcon, label: 'Deleted', color: 'text-muted-foreground', bgColor: 'bg-muted' },
  renamed: { icon: RefreshIcon, label: 'Renamed', color: 'text-amber-400', bgColor: 'bg-amber-500/10' },
  file_tagged: { icon: CheckCircleIcon, label: 'File Tagged', color: 'text-teal-400', bgColor: 'bg-teal-500/10' },
  held_for_review: { icon: AlertTriangleIcon, label: 'Held for Review', color: 'text-yellow-400', bgColor: 'bg-yellow-500/10' },
  merged: { icon: CheckCircleIcon, label: 'Merged', color: 'text-success', bgColor: 'bg-success/10' },
  merge_started: { icon: RefreshIcon, label: 'Merge Started', color: 'text-blue-400', bgColor: 'bg-blue-500/10' },
  merge_failed: { icon: XCircleIcon, label: 'Merge Failed', color: 'text-destructive', bgColor: 'bg-destructive/10' },
  wrong_release: { icon: XCircleIcon, label: 'Wrong Release', color: 'text-destructive', bgColor: 'bg-destructive/10' },
  book_added: { icon: BookOpenIcon, label: 'Book Added', color: 'text-emerald-400', bgColor: 'bg-emerald-500/10' },
};

const DEFAULT_CONFIG: EventTypeConfig = { icon: ClockIcon, label: 'Unknown', color: 'text-muted-foreground', bgColor: 'bg-muted' };

export function EventHistoryCard({ event, onMarkFailed, isMarkingFailed, onDelete, isDeleting, showBookTitle = true, index = 0 }: {
  event: BookEvent;
  onMarkFailed?: (id: number) => void;
  isMarkingFailed?: boolean;
  onDelete?: (id: number) => void;
  isDeleting?: boolean;
  showBookTitle?: boolean;
  index?: number;
}) {
  const [showReason, setShowReason] = useState(false);
  const config = EVENT_CONFIG[event.eventType] ?? { ...DEFAULT_CONFIG, label: event.eventType };
  const Icon = config.icon;
  const isActionable = ACTIONABLE_TYPES.includes(event.eventType) && event.downloadId != null;

  return (
    <div
      className="glass-card rounded-2xl p-4 hover:border-primary/20 transition-all duration-300 animate-fade-in-up"
      style={{ animationDelay: `${index * 50}ms` }}
    >
      <div className="flex items-start gap-3">
        <div className={`shrink-0 p-2.5 rounded-xl ${config.bgColor}`}>
          <Icon className={`w-4 h-4 ${config.color}`} />
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-semibold">{config.label}</span>
            <span className="text-xs text-muted-foreground/70">{formatRelativeDate(event.createdAt)}</span>
            <span className="text-xs px-1.5 py-0.5 rounded-md bg-muted text-muted-foreground font-medium">
              {event.source}
            </span>
          </div>

          {showBookTitle && (
            <p className="text-sm text-muted-foreground mt-1 truncate">
              {event.bookTitle}
              {event.authorName && <span className="text-muted-foreground/50"> by {event.authorName}</span>}
            </p>
          )}

          {event.reason && (
            <button
              onClick={() => setShowReason(!showReason)}
              className="text-xs text-primary hover:text-primary/80 mt-1.5 font-medium transition-colors"
            >
              {showReason ? 'Hide details' : 'View details'}
            </button>
          )}

          {showReason && event.reason && (
            <pre className="text-xs bg-muted/50 rounded-xl p-3 mt-2 overflow-x-auto text-muted-foreground leading-relaxed">
              {JSON.stringify(event.reason, null, 2)}
            </pre>
          )}
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {isActionable && onMarkFailed && (
            <button
              onClick={() => onMarkFailed(event.id)}
              disabled={isMarkingFailed}
              className="text-xs px-3 py-1.5 rounded-lg bg-destructive/10 text-destructive hover:bg-destructive/20 disabled:opacity-50 font-medium transition-colors"
            >
              Mark Failed
            </button>
          )}
          {onDelete && (
            <button
              type="button"
              onClick={() => onDelete(event.id)}
              disabled={isDeleting}
              className="p-1.5 rounded-lg text-muted-foreground/50 hover:text-destructive hover:bg-destructive/10 disabled:opacity-50 transition-colors"
              aria-label="Delete event"
            >
              <TrashIcon className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
