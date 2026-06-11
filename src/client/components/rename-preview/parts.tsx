import { useId } from 'react';
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
      <span className="break-all">{text}</span>
    </div>
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
