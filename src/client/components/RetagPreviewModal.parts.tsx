import type { RetagExcludableField, RetagMode, RetagPlan } from '@/lib/api';
import { canonicalRows } from './RetagPreviewModal.utils';

export function ContextBanner({
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
          <ModeOption label="Populate missing" value="populate_missing" current={plan.mode} onChange={onModeChange} />
          <ModeOption label="Overwrite" value="overwrite" current={plan.mode} onChange={onModeChange} />
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

export function WarningsSection({ warnings }: { warnings: string[] }) {
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

export function EmptyState({ plan, excludeSet }: { plan: RetagPlan; excludeSet: Set<RetagExcludableField> }) {
  const hasAudioFiles = plan.files.length > 0;
  const checkboxFields = canonicalRows(plan).map(r => r.field);
  const allExcluded = checkboxFields.length > 0 && checkboxFields.every(f => excludeSet.has(f));
  const unsupportedFiles = plan.files.filter(f => f.outcome === 'skip-unsupported');
  const allUnsupported = hasAudioFiles && unsupportedFiles.length === plan.files.length;

  if (!hasAudioFiles) {
    return <p className="text-sm text-muted-foreground text-center py-4">No taggable audio files were found in this book’s folder.</p>;
  }
  if (allUnsupported) {
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
