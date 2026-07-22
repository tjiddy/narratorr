import { Link } from 'react-router-dom';
import type { StagedItemResultDto } from '@/lib/api';

/**
 * Shared detail projection for the import report (#1894). Centralizes, for BOTH
 * the last-import panel and the Activity import-history cards:
 *  - disposition filtering (ATTENTION rows only — held/failed/skipped; accepted is
 *    count-only and rendered by the parent; `pending` is never shown),
 *  - group order held → failed → skipped,
 *  - per-disposition field access (`held.reason`, `failed.message`, `skipped.reason`
 *    + optional collision fields), and
 *  - the reason-specific skipped rendering enumerating every optional-field combo
 *    (F65) — so `reason`/`message` and optional-link handling cannot drift.
 */

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

/** Reason-specific skipped rendering — all optional-field combinations (F65). */
function SkippedTarget({ row }: { row: Skipped }) {
  if (row.reason === 'already-importing') {
    return <span className="text-muted-foreground">already importing</span>;
  }
  // already-in-library — existingBookId and existingTitle are INDEPENDENTLY optional.
  if (row.existingBookId != null && row.existingTitle != null) {
    return bookLink(row.existingBookId, row.existingTitle); // both → title as a link
  }
  if (row.existingBookId == null && row.existingTitle != null) {
    return <span>{row.existingTitle}</span>; // title-only → plain text, no link
  }
  if (row.existingBookId != null) {
    return bookLink(row.existingBookId, 'existing book'); // id-only → link, fallback label
  }
  return <span className="text-muted-foreground">already in library</span>; // neither → generic
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
