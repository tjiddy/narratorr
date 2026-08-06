import { useState } from 'react';
import type { BookWithAuthor, UpdateBookPayload } from '@/lib/api';
import { XIcon } from '@/components/icons';
import { Modal } from '@/components/Modal';
import { MetadataEditFields } from '@/components/book/MetadataEditFields';
import type { DisplayedFields } from '@/pages/book/helpers.js';
import { useBaselinedFields } from '@/components/book/useBaselinedFields.js';

interface BookMetadataModalProps {
  book: BookWithAuthor;
  onSave: (data: UpdateBookPayload, renameFiles: boolean) => void;
  onClose: () => void;
  isSaving: boolean;
  isOpen?: boolean;
  /**
   * What the operator SEES for each clearable field — `resolveDisplayedFields`
   * output, the same call the header's meta line derives from (#2069 AC18/AC25).
   * Both the initial input value and the diff baseline come from it, so blanking a
   * value that exists only as a provider fallback produces a real `null` diff and
   * a tombstone, and reopening after a clear shows the field BLANK rather than
   * resurrecting what was just removed.
   *
   * OPTIONAL: with the prop absent the baseline is the stored value and behavior is
   * byte-identical to before.
   */
  displayed?: DisplayedFields;
}

/** The stored-value baseline used when no resolved `displayed` prop is supplied. */
function storedBaseline(book: BookWithAuthor): DisplayedFields {
  return {
    seriesName: book.seriesName ?? undefined,
    seriesPosition: book.seriesPosition ?? undefined,
    subtitle: book.subtitle ?? undefined,
    description: book.description ?? undefined,
    publisher: book.publisher ?? undefined,
    publishedDate: book.publishedDate ?? undefined,
    genres: book.genres ?? undefined,
  };
}

/** Parse a comma-separated input into a trimmed, non-empty list (narrators/authors/genres). */
function parseList(value: string): string[] {
  return value.trim() ? value.trim().split(',').map((s) => s.trim()).filter(Boolean) : [];
}

// Field-diff helpers. Each returns `undefined` when the field is UNCHANGED (so the
// caller omits it), `null` to CLEAR the stored column, or the value to SET.

/** Trimmed nullable string (coverUrl, publishedDate). */
function diffTrimmedNullable(input: string, stored: string | null | undefined): string | null | undefined {
  const trimmed = input.trim();
  if (trimmed === (stored ?? '')) return undefined;
  return trimmed === '' ? null : trimmed;
}

/** Description preserves interior whitespace; only emptiness is trimmed-checked. */
function diffDescription(input: string, stored: string | null | undefined): string | null | undefined {
  if (input === (stored ?? '')) return undefined;
  return input.trim() === '' ? null : input;
}

/** Genres clear with `null` (NOT `[]`) — `mergeBookData` merges genres with `??`. */
function diffGenres(input: string, stored: string[] | null | undefined): string[] | null | undefined {
  if (input.trim() === (stored ?? []).join(', ')) return undefined;
  const parsed = parseList(input);
  return parsed.length > 0 ? parsed : null;
}

/** Series position: `null` to skip (unchanged or invalid), `{ value }` to set. */
function diffSeriesPosition(input: string, stored: number | null | undefined): { value: number | null } | null {
  const trimmed = input.trim();
  const newPos = trimmed ? Number(trimmed) : null;
  if (newPos !== null && isNaN(newPos)) return null; // invalid — leave unchanged
  if (newPos === (stored ?? null)) return null; // unchanged
  return { value: newPos };
}

/**
 * Edit Metadata is a pure MANUAL field editor (#1609). It diffs each clearable
 * field against its pre-filled value and sends only what changed:
 * `undefined`/omitted = unchanged, `null` = clear, a value = set. Re-pointing a
 * book to a different provider match is Fix Match's job — there is intentionally
 * no embedded search-and-apply here (it previously produced inconsistent
 * "Frankenbook" metadata).
 *
 * The pre-filled value and the diff baseline are what the operator SEES — the
 * `displayed` prop (#2069 AC25), not the stored column. That matters because a
 * post-import book sits at `enrichmentStatus: 'enriched'` with `series_name = NULL`
 * indefinitely: its series exists only as a provider fallback, so a stored-value
 * baseline renders the input empty and blanking it produces no diff — the clear is
 * inexpressible for the most common book in the library. It also means a field the
 * operator just cleared reopens BLANK instead of showing the value again.
 *
 * A clear sends only `null` for the field; the server derives and persists the
 * tombstone. Nothing tombstone-shaped is sent from here.
 */
export function BookMetadataModal({ book, onSave, onClose, isSaving, isOpen = true, displayed }: BookMetadataModalProps) {
  const baseline = displayed ?? storedBaseline(book);
  const { values, setField } = useBaselinedFields(baseline);
  const [title, setTitle] = useState(book.title);
  const [author, setAuthor] = useState(book.authors.map((a) => a.name).join(', '));
  const [narrator, setNarrator] = useState(book.narrators.map((n) => n.name).join(', '));
  const [renameFiles, setRenameFiles] = useState(false);
  const { subtitle, seriesName, seriesPosition, description, publishedDate, genres, publisher } = values;

  if (!isOpen) return null;

  const canSave = title.trim().length > 0 && !isSaving;
  const hasPath = !!book.path;
  const positionError = seriesPosition.trim() !== '' && isNaN(Number(seriesPosition.trim()))
    ? 'Must be a number'
    : null;

  const handleSave = () => {
    if (!canSave) return;

    const data: UpdateBookPayload = {};

    if (title.trim() !== book.title) data.title = title.trim();

    // Every clearable field diffs against `baseline` — the DISPLAYED value — so an
    // untouched field sends nothing (a provider value is never silently promoted
    // into the DB by an unrelated edit), a blanked one sends `null` even when the
    // stored column was already NULL, and a replaced one sends the new value.
    const sub = diffTrimmedNullable(subtitle, baseline.subtitle);
    if (sub !== undefined) data.subtitle = sub;

    // authors.min(1) — when the field is blanked, omit `authors` entirely rather
    // than sending `[]` (which would 400). A required author cannot be cleared here.
    const existingAuthor = book.authors.map((a) => a.name).join(', ');
    if (author.trim() !== existingAuthor) {
      const names = parseList(author);
      if (names.length > 0) data.authors = names.map((name) => ({ name }));
    }

    if (seriesName.trim() !== (baseline.seriesName ?? '')) data.seriesName = seriesName.trim() || null;

    // `seriesPosition` follows `seriesName` (the pair rule) — it is never baselined
    // against the provider independently, so it inherits whatever the resolver
    // decided for the pair.
    const pos = diffSeriesPosition(seriesPosition, baseline.seriesPosition);
    if (pos) data.seriesPosition = pos.value;

    const existingNarrator = book.narrators.map((n) => n.name).join(', ');
    if (narrator.trim() !== existingNarrator) data.narrators = parseList(narrator);

    // Nullable fields — `undefined` = unchanged (omitted), `null` = clear, value = set.
    const desc = diffDescription(description, baseline.description);
    if (desc !== undefined) data.description = desc;

    const pubDate = diffTrimmedNullable(publishedDate, baseline.publishedDate);
    if (pubDate !== undefined) data.publishedDate = pubDate;

    const newGenres = diffGenres(genres, baseline.genres);
    if (newGenres !== undefined) data.genres = newGenres;

    const pub = diffTrimmedNullable(publisher, baseline.publisher);
    if (pub !== undefined) data.publisher = pub;

    onSave(data, renameFiles);
  };

  return (
    <Modal onClose={onClose} className="w-full max-w-2xl flex flex-col max-h-[85vh]">
      {/* Must participate in the Modal's height-capped flex column (`flex-1 min-h-0`), or the
          fields' overflow-y-auto never activates and the footer renders past the card on short
          viewports. Mirrors SearchReleasesModal's proven shape. */}
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="book-metadata-modal-title"
        tabIndex={-1}
        className="flex flex-col min-h-0 flex-1"
      >
        {/* Header */}
        <div className="px-6 pt-5 pb-4 flex items-center justify-between shrink-0">
          <h2 id="book-metadata-modal-title" className="font-display text-lg font-semibold tracking-tight">
            Edit Metadata
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 text-muted-foreground hover:text-foreground rounded-lg transition-colors focus-ring"
            aria-label="Close"
          >
            <XIcon className="w-4 h-4" />
          </button>
        </div>

        <div className="border-t border-white/5" />

        <MetadataEditFields
          title={title}
          onTitleChange={setTitle}
          subtitle={subtitle}
          onSubtitleChange={(v) => setField('subtitle', v)}
          author={author}
          onAuthorChange={setAuthor}
          seriesName={seriesName}
          onSeriesNameChange={(v) => setField('seriesName', v)}
          seriesPosition={seriesPosition}
          onSeriesPositionChange={(v) => setField('seriesPosition', v)}
          positionError={positionError}
          narrator={narrator}
          onNarratorChange={setNarrator}
          description={description}
          onDescriptionChange={(v) => setField('description', v)}
          publishedDate={publishedDate}
          onPublishedDateChange={(v) => setField('publishedDate', v)}
          genres={genres}
          onGenresChange={(v) => setField('genres', v)}
          publisher={publisher}
          onPublisherChange={(v) => setField('publisher', v)}
          renameFiles={renameFiles}
          onRenameFilesChange={setRenameFiles}
          hasPath={hasPath}
        />

        {/* Footer */}
        <div className="px-6 py-4 border-t border-white/5 flex justify-end gap-3 shrink-0">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-sm font-medium glass-card rounded-xl hover:border-primary/30 transition-all focus-ring"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={!canSave}
            className="px-5 py-2 text-sm font-medium bg-primary text-primary-foreground rounded-xl hover:opacity-90 transition-all disabled:opacity-40 disabled:cursor-not-allowed focus-ring"
          >
            {isSaving ? 'Saving...' : 'Save'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
