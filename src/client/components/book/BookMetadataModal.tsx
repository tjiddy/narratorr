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
   * Operator-visible values shared with the header. They seed inputs and diff
   * baselines so provider-only values can be cleared and tombstones reopen blank.
   * Omit only for stored-value compatibility.
   */
  displayed?: DisplayedFields;
}

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

function parseList(value: string): string[] {
  return value.trim() ? value.trim().split(',').map((s) => s.trim()).filter(Boolean) : [];
}

// Diff helpers return undefined to omit, null to clear, or a value to set.

function diffTrimmedNullable(input: string, stored: string | null | undefined): string | null | undefined {
  const trimmed = input.trim();
  if (trimmed === (stored ?? '')) return undefined;
  return trimmed === '' ? null : trimmed;
}

/** Preserve description whitespace; trim only to detect emptiness. */
function diffDescription(input: string, stored: string | null | undefined): string | null | undefined {
  if (input === (stored ?? '')) return undefined;
  return input.trim() === '' ? null : input;
}

/** Clear genres with null, not [], because display resolution uses ?? semantics. */
function diffGenres(input: string, stored: string[] | null | undefined): string[] | null | undefined {
  if (input.trim() === (stored ?? []).join(', ')) return undefined;
  const parsed = parseList(input);
  return parsed.length > 0 ? parsed : null;
}

/** Return null to skip an invalid/unchanged position, or a wrapped value to set. */
function diffSeriesPosition(input: string, stored: number | null | undefined): { value: number | null } | null {
  const trimmed = input.trim();
  const newPos = trimmed ? Number(trimmed) : null;
  if (newPos !== null && isNaN(newPos)) return null;
  if (newPos === (stored ?? null)) return null;
  return { value: newPos };
}

/**
 * Manual editor sending only diffs: undefined omits, null clears, and a value sets.
 * Clearable fields baseline on displayed values; the server owns tombstones, and
 * provider rematching remains Fix Match's responsibility.
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

    // Diff against displayed values; never promote untouched provider fallbacks.
    const sub = diffTrimmedNullable(subtitle, baseline.subtitle);
    if (sub !== undefined) data.subtitle = sub;

    // authors.min(1): blank input is omitted because [] would fail validation.
    const existingAuthor = book.authors.map((a) => a.name).join(', ');
    if (author.trim() !== existingAuthor) {
      const names = parseList(author);
      if (names.length > 0) data.authors = names.map((name) => ({ name }));
    }

    if (seriesName.trim() !== (baseline.seriesName ?? '')) data.seriesName = seriesName.trim() || null;

    // Position has its own resolver baseline; clearing sends only seriesPosition:null.
    const pos = diffSeriesPosition(seriesPosition, baseline.seriesPosition);
    if (pos) data.seriesPosition = pos.value;

    const existingNarrator = book.narrators.map((n) => n.name).join(', ');
    if (narrator.trim() !== existingNarrator) data.narrators = parseList(narrator);

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
      {/* Must join Modal's height-capped flex column so the fields scroll. */}
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="book-metadata-modal-title"
        tabIndex={-1}
        className="flex flex-col min-h-0 flex-1"
      >
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
