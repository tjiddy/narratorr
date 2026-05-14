import { useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  api,
  RetagFfmpegNotConfiguredError,
  type RetagExcludableField,
  type RetagMode,
  type RetagPlan,
  type RetagPlanFile,
  type RetagPlanFileDiff,
} from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';
import { useEscapeKey } from '@/hooks/useEscapeKey';
import { Modal } from '@/components/Modal';
import { Button } from '@/components/Button';
import { LoadingSpinner } from '@/components/icons';
import { getErrorMessage } from '@/lib/error-message.js';
import { countApplyFiles, effectiveOutcome, visibleDiffOf } from './RetagPreviewModal.utils';

export interface RetagConfirmPayload {
  excludeFields: RetagExcludableField[];
  mode?: RetagMode;
  embedCover?: boolean;
}

interface RetagPreviewModalProps {
  bookId: number;
  isOpen: boolean;
  onClose: () => void;
  onConfirm: (payload: RetagConfirmPayload) => void;
}

const FIELD_LABELS: Record<RetagExcludableField, string> = {
  artist: 'Artist',
  albumArtist: 'Album Artist',
  album: 'Album',
  title: 'Title',
  composer: 'Composer',
  grouping: 'Grouping',
  track: 'Track',
};

/** Display order for the canonical card AND per-file diff rows. */
const FIELD_ORDER: RetagExcludableField[] = [
  'artist',
  'albumArtist',
  'album',
  'title',
  'composer',
  'grouping',
  'track',
];

export function RetagPreviewModal({ bookId, isOpen, onClose, onConfirm }: RetagPreviewModalProps) {
  const modalRef = useRef<HTMLDivElement>(null);
  useEscapeKey(isOpen, onClose, modalRef);

  const [excludeSet, setExcludeSet] = useState<Set<RetagExcludableField>>(() => new Set());
  // Undefined overrides = "use settings default" — the wire payload only carries
  // the override fields the user has explicitly touched.
  const [modeOverride, setModeOverride] = useState<RetagMode | undefined>(undefined);
  const [embedCoverOverride, setEmbedCoverOverride] = useState<boolean | undefined>(undefined);

  const overridesForFetch: { mode?: RetagMode; embedCover?: boolean } = {};
  if (modeOverride !== undefined) overridesForFetch.mode = modeOverride;
  if (embedCoverOverride !== undefined) overridesForFetch.embedCover = embedCoverOverride;

  const { data, isLoading, error } = useQuery({
    queryKey: queryKeys.bookRetagPreview(bookId, overridesForFetch),
    queryFn: () => api.getBookRetagPreview(bookId, overridesForFetch),
    enabled: isOpen,
    staleTime: 0,
    gcTime: 0,
    refetchOnMount: 'always',
    retry: false,
  });

  if (!isOpen) return null;

  const ffmpegError = error instanceof RetagFfmpegNotConfiguredError ? error : null;
  const otherError = error && !ffmpegError ? error : null;

  const toggle = (field: RetagExcludableField) => {
    setExcludeSet(prev => {
      const next = new Set(prev);
      if (next.has(field)) next.delete(field);
      else next.add(field);
      return next;
    });
  };

  const handleConfirm = () => {
    onClose();
    const payload: RetagConfirmPayload = { excludeFields: Array.from(excludeSet) };
    if (modeOverride !== undefined) payload.mode = modeOverride;
    if (embedCoverOverride !== undefined) payload.embedCover = embedCoverOverride;
    onConfirm(payload);
  };

  return (
    <Modal onClose={onClose} className="w-full max-w-3xl p-6" scrollable>
      <div
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="retag-preview-modal-title"
        tabIndex={-1}
        className="flex flex-col min-h-0"
      >
        <div className="text-center mb-4 shrink-0">
          <h3 id="retag-preview-modal-title" className="font-display text-xl font-semibold">
            Re-tag audio files?
          </h3>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto">
          {isLoading && (
            <div className="flex items-center justify-center py-12 text-muted-foreground">
              <LoadingSpinner className="w-5 h-5" />
              <span className="ml-2 text-sm">Building preview…</span>
            </div>
          )}

          {ffmpegError && (
            <p
              role="alert"
              className="text-sm text-destructive bg-destructive/10 rounded-lg px-4 py-3"
            >
              ffmpeg isn’t configured. Set the ffmpeg path in <strong>Settings → Post Processing</strong> to enable re-tagging.
            </p>
          )}

          {otherError && (
            <p
              role="alert"
              className="text-sm text-destructive bg-destructive/10 rounded-lg px-4 py-3"
            >
              {getErrorMessage(otherError)}
            </p>
          )}

          {data && (
            <PreviewBody
              plan={data}
              excludeSet={excludeSet}
              onToggle={toggle}
              onModeChange={setModeOverride}
              onEmbedCoverChange={setEmbedCoverOverride}
            />
          )}
        </div>

        <ModalFooter
          plan={data}
          ffmpegError={!!ffmpegError}
          excludeSet={excludeSet}
          onClose={onClose}
          onConfirm={handleConfirm}
        />
      </div>
    </Modal>
  );
}

function ModalFooter({
  plan,
  ffmpegError,
  excludeSet,
  onClose,
  onConfirm,
}: {
  plan: RetagPlan | undefined;
  ffmpegError: boolean;
  excludeSet: Set<RetagExcludableField>;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const applyCount = useMemo(() => plan ? countApplyFiles(plan, excludeSet) : 0, [plan, excludeSet]);
  const showApply = plan !== undefined && !ffmpegError;
  return (
    <div className="flex flex-col-reverse sm:flex-row gap-3 mt-6 shrink-0">
      <Button variant="secondary" size="md" type="button" onClick={onClose} className="flex-1 text-sm">
        Cancel
      </Button>
      {showApply && (
        <Button
          variant="primary"
          size="md"
          type="button"
          onClick={onConfirm}
          disabled={applyCount === 0}
          className="flex-1 text-sm"
        >
          Re-tag {applyCount} {applyCount === 1 ? 'file' : 'files'}
        </Button>
      )}
    </div>
  );
}

function PreviewBody({
  plan,
  excludeSet,
  onToggle,
  onModeChange,
  onEmbedCoverChange,
}: {
  plan: RetagPlan;
  excludeSet: Set<RetagExcludableField>;
  onToggle: (f: RetagExcludableField) => void;
  onModeChange: (m: RetagMode) => void;
  onEmbedCoverChange: (v: boolean) => void;
}) {
  const isEmpty = countApplyFiles(plan, excludeSet) === 0;

  return (
    <div className="space-y-5">
      <ContextBanner plan={plan} onModeChange={onModeChange} onEmbedCoverChange={onEmbedCoverChange} />
      {plan.warnings.length > 0 && <WarningsSection warnings={plan.warnings} />}
      <CanonicalCard plan={plan} excludeSet={excludeSet} onToggle={onToggle} />
      {isEmpty ? (
        <EmptyState plan={plan} excludeSet={excludeSet} />
      ) : (
        <FilesSection plan={plan} excludeSet={excludeSet} />
      )}
    </div>
  );
}

function ContextBanner({
  plan,
  onModeChange,
  onEmbedCoverChange,
}: {
  plan: RetagPlan;
  onModeChange: (m: RetagMode) => void;
  onEmbedCoverChange: (v: boolean) => void;
}) {
  const embedCoverDisabled = !plan.hasCoverFile && !plan.embedCover;
  const embedTooltip = embedCoverDisabled ? 'No cover image found in book folder' : undefined;

  return (
    <div
      role="group"
      aria-label="Re-tag options"
      className="text-xs space-y-2 text-muted-foreground bg-muted/40 rounded-lg px-4 py-3"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-foreground">Mode:</span>
        <div role="radiogroup" aria-label="Mode" className="inline-flex rounded-md border border-border overflow-hidden">
          <ModeOption
            label="Populate missing"
            value="populate_missing"
            current={plan.mode}
            onChange={onModeChange}
          />
          <ModeOption
            label="Overwrite"
            value="overwrite"
            current={plan.mode}
            onChange={onModeChange}
          />
        </div>
        <span>
          ({plan.mode === 'overwrite'
            ? 'replace existing tags with new values'
            : 'only fill in tags that are currently empty'})
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <label className="inline-flex items-center gap-2" title={embedTooltip}>
          <input
            type="checkbox"
            checked={plan.embedCover}
            disabled={embedCoverDisabled}
            onChange={e => onEmbedCoverChange(e.target.checked)}
            aria-label="Embed cover art"
          />
          <span className="font-medium text-foreground">Embed cover art</span>
        </label>
        {plan.embedCover && !plan.hasCoverFile && (
          <span className="text-amber-600 dark:text-amber-400">no cover image found</span>
        )}
      </div>
    </div>
  );
}

function ModeOption({
  label,
  value,
  current,
  onChange,
}: {
  label: string;
  value: RetagMode;
  current: RetagMode;
  onChange: (m: RetagMode) => void;
}) {
  const active = current === value;
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      onClick={() => onChange(value)}
      className={`px-2.5 py-1 text-xs font-medium ${active ? 'bg-primary text-primary-foreground' : 'bg-transparent text-muted-foreground hover:bg-muted'}`}
    >
      {label}
    </button>
  );
}

function WarningsSection({ warnings }: { warnings: string[] }) {
  return (
    <div
      role="alert"
      className="text-xs space-y-1 text-amber-700 dark:text-amber-400 bg-amber-500/10 rounded-lg px-4 py-3"
    >
      {warnings.map((w, i) => (
        <p key={`${w}-${i}`}>{w}</p>
      ))}
    </div>
  );
}

function CanonicalCard({
  plan,
  excludeSet,
  onToggle,
}: {
  plan: RetagPlan;
  excludeSet: Set<RetagExcludableField>;
  onToggle: (f: RetagExcludableField) => void;
}) {
  const rows = canonicalRows(plan);
  return (
    <section aria-labelledby="retag-preview-canonical-heading">
      <h4 id="retag-preview-canonical-heading" className="text-sm font-semibold mb-2">
        These values will be written
      </h4>
      <ul className="space-y-1 rounded-lg border border-border bg-muted/20 p-3">
        {rows.map(({ field, value }) => (
          <li key={field}>
            <label className="flex items-center gap-3 text-sm cursor-pointer">
              <input
                type="checkbox"
                checked={!excludeSet.has(field)}
                onChange={() => onToggle(field)}
                aria-label={`Include ${FIELD_LABELS[field]}`}
              />
              <span className="w-28 text-muted-foreground">{FIELD_LABELS[field]}</span>
              <code className="font-mono break-all">{value}</code>
            </label>
          </li>
        ))}
      </ul>
    </section>
  );
}

function canonicalRows(plan: RetagPlan): { field: RetagExcludableField; value: string }[] {
  const rows: { field: RetagExcludableField; value: string }[] = [];
  for (const field of FIELD_ORDER) {
    if (field === 'track') {
      if (plan.isSingleFile) continue;
      rows.push({ field, value: 'sequential per file' });
      continue;
    }
    const value = plan.canonical[field];
    if (value !== undefined) rows.push({ field, value });
  }
  return rows;
}

function FilesSection({
  plan,
  excludeSet,
}: {
  plan: RetagPlan;
  excludeSet: Set<RetagExcludableField>;
}) {
  const [open, setOpen] = useState(plan.isSingleFile);
  return (
    <section aria-labelledby="retag-preview-files-heading">
      <button
        type="button"
        className="flex items-center gap-2 text-sm font-semibold mb-2 hover:underline"
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
      >
        <span aria-hidden="true">{open ? '▾' : '▸'}</span>
        <span id="retag-preview-files-heading">
          {open ? 'Hide' : 'Show'} per-file changes ({plan.files.length} {plan.files.length === 1 ? 'file' : 'files'})
        </span>
      </button>
      {open && (
        <ul className="space-y-2">
          {plan.files.map(file => (
            <FileRow key={file.file} file={file} excludeSet={excludeSet} />
          ))}
        </ul>
      )}
    </section>
  );
}

function FileRow({
  file,
  excludeSet,
}: {
  file: RetagPlanFile;
  excludeSet: Set<RetagExcludableField>;
}) {
  const outcome = effectiveOutcome(file, excludeSet);
  const outcomeLabel = formatOutcome(outcome);
  const visibleDiff = visibleDiffOf(file, excludeSet);
  const dimmedDiff = (file.diff ?? []).filter(d => excludeSet.has(d.field));
  const isCoverOnly = outcome === 'will-tag' && visibleDiff.length === 0 && file.coverPending;

  return (
    <li className="rounded-lg border border-border bg-card/40 p-3">
      <div className="flex items-center justify-between gap-3 text-sm">
        <code className="font-mono break-all">{file.file}</code>
        <span className="text-xs text-muted-foreground shrink-0">{outcomeLabel}</span>
      </div>
      {file.outcome === 'will-tag' && (visibleDiff.length > 0 || dimmedDiff.length > 0) && (
        <ul className="mt-2 space-y-1">
          {visibleDiff.map(d => <DiffRow key={d.field} diff={d} dimmed={false} />)}
          {dimmedDiff.map(d => <DiffRow key={d.field} diff={d} dimmed={true} />)}
        </ul>
      )}
      {isCoverOnly && (
        <p className="mt-2 text-xs text-muted-foreground">Cover art will be embedded; no metadata changes.</p>
      )}
    </li>
  );
}

function DiffRow({ diff, dimmed }: { diff: RetagPlanFileDiff; dimmed: boolean }) {
  // minmax(0,1fr) lets the value cells shrink past min-content so truncation works
  // at modal width — `1fr` alone expanded to fit content, which forced row wrap.
  return (
    <li className={`text-xs grid grid-cols-[5rem_minmax(0,1fr)_auto_minmax(0,1fr)] gap-2 items-center font-mono ${dimmed ? 'opacity-40' : ''}`}>
      <span className="text-muted-foreground truncate">{FIELD_LABELS[diff.field]}</span>
      <span className="text-destructive truncate" title={diff.current ?? undefined}>{diff.current ?? '(empty)'}</span>
      <span aria-hidden="true" className="text-muted-foreground">→</span>
      <span className="text-success truncate" title={diff.next ?? undefined}>{diff.next ?? '(empty)'}</span>
    </li>
  );
}

function formatOutcome(outcome: RetagPlanFile['outcome']): string {
  switch (outcome) {
    case 'will-tag': return 'Will tag';
    case 'skip-populated': return 'Skip — already populated';
    case 'skip-unsupported': return 'Skip — unsupported format';
  }
}

function EmptyState({ plan, excludeSet }: { plan: RetagPlan; excludeSet: Set<RetagExcludableField> }) {
  const hasAudioFiles = plan.files.length > 0;
  // Only fields that actually have a checkbox in the canonical card count toward "all excluded".
  const checkboxFields = canonicalRows(plan).map(r => r.field);
  const allExcluded = checkboxFields.length > 0 && checkboxFields.every(f => excludeSet.has(f));
  const unsupportedFiles = plan.files.filter(f => f.outcome === 'skip-unsupported');
  const allUnsupported = hasAudioFiles && unsupportedFiles.length === plan.files.length;

  if (!hasAudioFiles) {
    return <p className="text-sm text-muted-foreground text-center py-4">No taggable audio files were found in this book’s folder.</p>;
  }
  if (allUnsupported) {
    // Tailored message + name the files so the user knows which formats are in the way.
    return (
      <div className="text-sm text-muted-foreground py-4 space-y-2 text-center">
        <p>None of the audio files in this folder are in a taggable format. Re-tagging supports <code className="font-mono">.mp3</code>, <code className="font-mono">.m4a</code>, and <code className="font-mono">.m4b</code>.</p>
        <ul className="font-mono text-xs space-y-0.5">
          {unsupportedFiles.map(f => <li key={f.file}>{f.file}</li>)}
        </ul>
      </div>
    );
  }
  const message = allExcluded
    ? 'You’ve unchecked every field. Include at least one field to re-tag.'
    : 'All included fields are already populated. Switch to overwrite mode to replace existing values, or include a field that has differing values.';
  return <p className="text-sm text-muted-foreground text-center py-4">{message}</p>;
}
