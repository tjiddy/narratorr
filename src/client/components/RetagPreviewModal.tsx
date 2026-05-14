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
import { FIELD_LABELS, canonicalRows, countApplyFiles, effectiveOutcome, visibleDiffOf } from './RetagPreviewModal.utils';
import { ContextBanner, EmptyState, WarningsSection } from './RetagPreviewModal.parts';

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

export function RetagPreviewModal({ bookId, isOpen, onClose, onConfirm }: RetagPreviewModalProps) {
  const modalRef = useRef<HTMLDivElement>(null);
  useEscapeKey(isOpen, onClose, modalRef);

  const [excludeSet, setExcludeSet] = useState<Set<RetagExcludableField>>(() => new Set());
  // `null` = user has not touched the control. `userMode`/`userEmbedCover` hold
  // the user's selection regardless of whether it matches the settings default;
  // the AC requires the apply payload to compare against the captured defaults,
  // not against whether the control was touched (#1098 F2).
  const [userMode, setUserMode] = useState<RetagMode | null>(null);
  const [userEmbedCover, setUserEmbedCover] = useState<boolean | null>(null);
  const [settingsDefaults, setSettingsDefaults] = useState<{ mode: RetagMode; embedCover: boolean } | null>(null);

  const activeOverrides: { mode?: RetagMode; embedCover?: boolean } = {};
  if (settingsDefaults && userMode !== null && userMode !== settingsDefaults.mode) activeOverrides.mode = userMode;
  if (settingsDefaults && userEmbedCover !== null && userEmbedCover !== settingsDefaults.embedCover) activeOverrides.embedCover = userEmbedCover;

  const { data, isLoading, error } = useQuery({
    queryKey: queryKeys.bookRetagPreview(bookId, activeOverrides),
    queryFn: () => api.getBookRetagPreview(bookId, activeOverrides),
    enabled: isOpen,
    staleTime: 0,
    gcTime: 0,
    refetchOnMount: 'always',
    retry: false,
  });

  // Capture settings defaults from the first preview response — that response
  // was fetched with no overrides applied, so it reflects the user's settings.
  // Render-time guarded setState mirrors React's "derive state from props" pattern.
  if (data && settingsDefaults === null && userMode === null && userEmbedCover === null) {
    setSettingsDefaults({ mode: data.mode, embedCover: data.embedCover });
  }

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
    if (activeOverrides.mode !== undefined) payload.mode = activeOverrides.mode;
    if (activeOverrides.embedCover !== undefined) payload.embedCover = activeOverrides.embedCover;
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
              onModeChange={setUserMode}
              onEmbedCoverChange={setUserEmbedCover}
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
