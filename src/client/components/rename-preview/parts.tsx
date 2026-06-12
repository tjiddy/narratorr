import { Fragment, useId } from 'react';
import { Link } from 'react-router-dom';
import type { RenameConflictError } from '@/lib/api';

/**
 * Shared building blocks for the rename preview UI. Both the single-book
 * `RenamePreviewModal` and the bulk `BulkRenameModal` compose from these so the
 * diff/banner/conflict rendering has exactly one definition each (see #1406 AC #2).
 */

export function PreviewBanner({
  libraryRoot,
  folderFormat,
  fileFormat,
}: {
  libraryRoot: string;
  folderFormat: string;
  fileFormat: string;
}) {
  return (
    <div className="text-xs space-y-1 text-muted-foreground bg-muted/40 rounded-lg px-4 py-3">
      <p>
        <span className="font-medium text-foreground">All paths are relative to:</span>{' '}
        <code className="font-mono">{libraryRoot}</code>
      </p>
      <p>
        <span className="font-medium text-foreground">Folder pattern:</span>{' '}
        <code className="font-mono">{folderFormat}</code>
      </p>
      <p>
        <span className="font-medium text-foreground">File pattern:</span>{' '}
        <code className="font-mono">{fileFormat}</code>
      </p>
    </div>
  );
}

export function FolderMoveSection({ from, to }: { from: string; to: string }) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId}>
      <h4 id={headingId} className="text-sm font-semibold mb-2">
        Folder
      </h4>
      <DiffRow sign="−" text={from} tone="destructive" />
      <DiffRow sign="+" text={to} tone="success" />
    </section>
  );
}

export function FileRenamesSection({ renames }: { renames: Array<{ from: string; to: string }> }) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId}>
      <h4 id={headingId} className="text-sm font-semibold mb-2">
        Files
      </h4>
      <ul className="space-y-3">
        {renames.map((r, i) => (
          <li key={`${r.from}-${i}`}>
            <DiffRow sign="−" text={r.from} tone="destructive" />
            <DiffRow sign="+" text={r.to} tone="success" />
          </li>
        ))}
      </ul>
    </section>
  );
}

export function DiffRow({ sign, text, tone }: { sign: string; text: string; tone: 'destructive' | 'success' }) {
  const toneClass = tone === 'destructive'
    ? 'text-destructive bg-destructive/5'
    : 'text-success bg-success/5';
  return (
    <div className={`flex gap-2 items-start font-mono text-sm rounded px-2 py-1 ${toneClass}`}>
      <span aria-hidden="true" className="font-semibold select-none">{sign}</span>
      <span className="break-words [overflow-wrap:anywhere]">{text}</span>
    </div>
  );
}

/**
 * Positionally diff a `from`/`to` path pair, segment-by-segment on `/`. Segments
 * that match positionally render dimmed; segments that differ (or have no
 * counterpart in the shorter path) render full-tone — so the eye lands on exactly
 * the rename delta (`The Earthsea Quartet` → `Earthsea Cycle`) instead of scanning
 * an equal-weight red/green wall.
 *
 * Edge cases (see #1439 F5): different segment counts compare up to the shorter
 * length and emphasize the longer path's trailing segments; identical paths dim
 * entirely; a single-segment path (no `/`) is one segment — full-tone unless
 * identical. Empty segments (interior `A//B` or trailing `A/B/`) are `/` artifacts:
 * they're cleaned out before the real segments are compared positionally — so
 * `A//B` vs `A/B` still aligns `B` against `B` instead of shifting it into a
 * changed slot — while an empty segment itself is emphasized only when the other
 * path lacks the same artifact at that position, keeping a meaningful
 * trailing-slash difference (`A/B/` vs `A/B`) visible rather than swallowed.
 */
function diffPathSegments(path: string, other: string): Array<{ text: string; changed: boolean }> {
  const rawOther = other.split('/');
  const cleanedOther = rawOther.filter((s) => s !== '');
  let cleanIdx = 0;
  return path.split('/').map((text, i) => {
    if (text === '') {
      // A `/` artifact — never let it shift real-segment alignment; emphasize only
      // when the other path has no matching empty at this raw position.
      return { text, changed: rawOther[i] !== '' };
    }
    const changed = text !== cleanedOther[cleanIdx];
    cleanIdx += 1;
    return { text, changed };
  });
}

function PathDiffLine({
  sign,
  path,
  other,
  tone,
}: {
  sign: string;
  path: string;
  other: string;
  tone: 'destructive' | 'success';
}) {
  const toneClass = tone === 'destructive'
    ? 'text-destructive bg-destructive/5'
    : 'text-success bg-success/5';
  const segments = diffPathSegments(path, other);
  return (
    <div className={`flex gap-2 items-start font-mono text-sm rounded px-2 py-1 ${toneClass}`}>
      <span aria-hidden="true" className="font-semibold select-none">{sign}</span>
      <span className="break-words [overflow-wrap:anywhere]">
        {segments.map((seg, i) => (
          <Fragment key={i}>
            {i > 0 && <span className="opacity-50 select-none">/</span>}
            <span className={seg.changed ? undefined : 'opacity-50'}>{seg.text}</span>
          </Fragment>
        ))}
      </span>
    </div>
  );
}

/**
 * A from→to path diff that emphasizes only the changed segment(s). Drop-in for a
 * `DiffRow` pair where both texts are `/`-delimited paths (the bulk modal's
 * collapsed folder diff). Renders the `−` from line and `+` to line, each with
 * positionally-unchanged segments dimmed. See {@link diffPathSegments}.
 */
export function PathDiffRow({ from, to }: { from: string; to: string }) {
  return (
    <>
      <PathDiffLine sign="−" path={from} other={to} tone="destructive" />
      <PathDiffLine sign="+" path={to} other={from} tone="success" />
    </>
  );
}

export function ConflictBanner({ conflict }: { conflict: RenameConflictError }) {
  return (
    <div
      role="alert"
      className="text-sm bg-destructive/10 text-destructive rounded-lg px-4 py-3 space-y-1"
    >
      <p className="font-semibold">Target folder is already in use.</p>
      <p>
        The target folder belongs to{' '}
        <Link
          to={`/books/${conflict.conflictingBook.id}`}
          className="underline hover:no-underline"
        >
          {conflict.conflictingBook.title}
        </Link>
        . Fix the conflict before renaming.
      </p>
    </div>
  );
}
