import { useState } from 'react';
import type { BookWithAuthor, UpdateBookPayload } from '@/lib/api';
import { XIcon } from '@/components/icons';
import { Modal } from '@/components/Modal';
import { MetadataEditFields } from '@/components/book/MetadataEditFields';

interface BookMetadataModalProps {
  book: BookWithAuthor;
  onSave: (data: UpdateBookPayload, renameFiles: boolean) => void;
  onClose: () => void;
  isSaving: boolean;
  isOpen?: boolean;
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
 * Edit Metadata is a pure MANUAL field editor (#1609). It diffs each stored,
 * author-supplied column against its pre-filled value and sends only what changed:
 * `undefined`/omitted = unchanged, `null` = clear (detail page falls back to the
 * merged provider value), a value = set. Re-pointing a book to a different provider
 * match is Fix Match's job — there is intentionally no embedded search-and-apply
 * here (it previously produced inconsistent "Frankenbook" metadata).
 */
export function BookMetadataModal({ book, onSave, onClose, isSaving, isOpen = true }: BookMetadataModalProps) {
  const [title, setTitle] = useState(book.title);
  const [subtitle, setSubtitle] = useState(book.subtitle ?? '');
  const [author, setAuthor] = useState(book.authors.map((a) => a.name).join(', '));
  const [seriesName, setSeriesName] = useState(book.seriesName ?? '');
  const [seriesPosition, setSeriesPosition] = useState(book.seriesPosition?.toString() ?? '');
  const [narrator, setNarrator] = useState(book.narrators.map((n) => n.name).join(', '));
  const [description, setDescription] = useState(book.description ?? '');
  const [publishedDate, setPublishedDate] = useState(book.publishedDate ?? '');
  const [genres, setGenres] = useState((book.genres ?? []).join(', '));
  const [publisher, setPublisher] = useState(book.publisher ?? '');
  const [renameFiles, setRenameFiles] = useState(false);

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

    const sub = diffTrimmedNullable(subtitle, book.subtitle);
    if (sub !== undefined) data.subtitle = sub;

    // authors.min(1) — when the field is blanked, omit `authors` entirely rather
    // than sending `[]` (which would 400). A required author cannot be cleared here.
    const existingAuthor = book.authors.map((a) => a.name).join(', ');
    if (author.trim() !== existingAuthor) {
      const names = parseList(author);
      if (names.length > 0) data.authors = names.map((name) => ({ name }));
    }

    if (seriesName.trim() !== (book.seriesName ?? '')) data.seriesName = seriesName.trim() || null;

    const pos = diffSeriesPosition(seriesPosition, book.seriesPosition);
    if (pos) data.seriesPosition = pos.value;

    const existingNarrator = book.narrators.map((n) => n.name).join(', ');
    if (narrator.trim() !== existingNarrator) data.narrators = parseList(narrator);

    // Nullable fields — `undefined` = unchanged (omitted), `null` = clear, value = set.
    const desc = diffDescription(description, book.description);
    if (desc !== undefined) data.description = desc;

    const pubDate = diffTrimmedNullable(publishedDate, book.publishedDate);
    if (pubDate !== undefined) data.publishedDate = pubDate;

    const newGenres = diffGenres(genres, book.genres);
    if (newGenres !== undefined) data.genres = newGenres;

    const pub = diffTrimmedNullable(publisher, book.publisher);
    if (pub !== undefined) data.publisher = pub;

    onSave(data, renameFiles);
  };

  return (
    <Modal onClose={onClose} className="w-full max-w-2xl flex flex-col max-h-[85vh]">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="book-metadata-modal-title"
        tabIndex={-1}
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
          onSubtitleChange={setSubtitle}
          author={author}
          onAuthorChange={setAuthor}
          seriesName={seriesName}
          onSeriesNameChange={setSeriesName}
          seriesPosition={seriesPosition}
          onSeriesPositionChange={setSeriesPosition}
          positionError={positionError}
          narrator={narrator}
          onNarratorChange={setNarrator}
          description={description}
          onDescriptionChange={setDescription}
          publishedDate={publishedDate}
          onPublishedDateChange={setPublishedDate}
          genres={genres}
          onGenresChange={setGenres}
          publisher={publisher}
          onPublisherChange={setPublisher}
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
