import { Link } from 'react-router';
import type { StagedItemResultDto } from '@/lib/api';

/** Shared held/failed/skipped projection for last-import and Activity views. */

type Held = Extract<StagedItemResultDto, { disposition: 'held' }>;
type Failed = Extract<StagedItemResultDto, { disposition: 'failed' }>;
type Skipped = Extract<StagedItemResultDto, { disposition: 'skipped' }>;

function bookLink(existingBookId: number, label: string) {
  return (
    <Link to={`/books/${existingBookId}`} className="text-primary hover:underline">
      {label}
    </Link>
  );
}

/** ID and title are independently optional after the referenced book is deleted. */
function IncumbentLabel({ row }: { row: Skipped }) {
  if (row.existingBookId != null && row.existingTitle != null) {
    return bookLink(row.existingBookId, row.existingTitle);
  }
  if (row.existingBookId == null && row.existingTitle != null) {
    return <span>{row.existingTitle}</span>;
  }
  if (row.existingBookId != null) {
    return bookLink(row.existingBookId, 'existing book');
  }
  return <span className="text-muted-foreground">already in library</span>;
}

function SkippedTarget({ row }: { row: Skipped }) {
  if (row.reason === 'already-importing') {
    return <span className="text-muted-foreground">already importing</span>;
  }
  // #2091: the point of the distinct reason is that BOTH folders are named — the candidate that
  // was skipped and the library copy it duplicates. The path is a snapshot, so it survives the
  // incumbent's deletion even when the id and title do not.
  if (row.reason === 'duplicate-copy-at-other-path') {
    return (
      <>
        duplicate copy at <span className="break-all">{row.path}</span>
        {' — library copy is '}
        <IncumbentLabel row={row} />
        {row.existingPath != null && <> at <span className="break-all">{row.existingPath}</span></>}
      </>
    );
  }
  return <IncumbentLabel row={row} />;
}

function AttentionRow({ label, title, children }: { label: string; title: string; children: React.ReactNode }) {
  return (
    <li className="flex flex-col gap-0.5 py-1 text-sm">
      <span className="font-medium">{title}</span>
      <span className="text-xs text-muted-foreground">
        <span className="font-semibold">{label}</span> {children}
      </span>
    </li>
  );
}

export function ImportAttentionRows({ items }: { items: StagedItemResultDto[] }) {
  const held = items.filter((i): i is Held => i.disposition === 'held');
  const failed = items.filter((i): i is Failed => i.disposition === 'failed');
  const skipped = items.filter((i): i is Skipped => i.disposition === 'skipped');

  if (held.length + failed.length + skipped.length === 0) return null;

  return (
    <ul className="divide-y divide-border/50" data-testid="import-attention-rows">
      {held.map((row) => (
        <AttentionRow key={`h-${row.ordinal}`} label="Held" title={row.title}>
          needs recording review
        </AttentionRow>
      ))}
      {failed.map((row) => (
        <AttentionRow key={`f-${row.ordinal}`} label="Failed" title={row.title}>
          {row.message}
        </AttentionRow>
      ))}
      {skipped.map((row) => (
        <AttentionRow key={`s-${row.ordinal}`} label="Skipped" title={row.title}>
          <SkippedTarget row={row} />
        </AttentionRow>
      ))}
    </ul>
  );
}
