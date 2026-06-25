interface MetadataEditFieldsProps {
  title: string;
  onTitleChange: (value: string) => void;
  subtitle: string;
  onSubtitleChange: (value: string) => void;
  author: string;
  onAuthorChange: (value: string) => void;
  seriesName: string;
  onSeriesNameChange: (value: string) => void;
  seriesPosition: string;
  onSeriesPositionChange: (value: string) => void;
  positionError: string | null;
  narrator: string;
  onNarratorChange: (value: string) => void;
  description: string;
  onDescriptionChange: (value: string) => void;
  publishedDate: string;
  onPublishedDateChange: (value: string) => void;
  genres: string;
  onGenresChange: (value: string) => void;
  publisher: string;
  onPublisherChange: (value: string) => void;
  renameFiles: boolean;
  onRenameFilesChange: (value: boolean) => void;
  hasPath: boolean;
}

const INPUT_CLASS = 'w-full px-3 py-2 glass-card rounded-xl text-sm focus-ring';
const LABEL_CLASS = 'block text-xs font-medium text-muted-foreground mb-1.5';

/** A labelled single-line text input — the repeated field shape in this editor. */
function TextField({ id, label, value, onChange, placeholder }: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}) {
  return (
    <div>
      <label htmlFor={id} className={LABEL_CLASS}>{label}</label>
      <input
        id={id}
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={INPUT_CLASS}
      />
    </div>
  );
}

// Edit Metadata is a pure MANUAL field editor (#1609). It edits only the stored,
// author-supplied columns the detail page renders (now including subtitle and
// publisher, promoted to stored columns in #1614). Intentionally excluded:
//   - duration — scanner-derived from the audio files (import/scan), not
//     author-supplied; manual edits would desync it from the files.
// Re-matching a book to different provider metadata is Fix Match's job (it
// re-fetches the full canonical record); there is intentionally no embedded
// search-and-apply here — that path silently produced inconsistent "Frankenbook"
// metadata by applying only a subset of a match.
export function MetadataEditFields({
  title,
  onTitleChange,
  subtitle,
  onSubtitleChange,
  author,
  onAuthorChange,
  seriesName,
  onSeriesNameChange,
  seriesPosition,
  onSeriesPositionChange,
  positionError,
  narrator,
  onNarratorChange,
  description,
  onDescriptionChange,
  publishedDate,
  onPublishedDateChange,
  genres,
  onGenresChange,
  publisher,
  onPublisherChange,
  renameFiles,
  onRenameFilesChange,
  hasPath,
}: MetadataEditFieldsProps) {
  return (
    <div className="p-6 space-y-4 overflow-y-auto">
      <div>
        <label htmlFor="edit-title" className={LABEL_CLASS}>
          Title <span className="text-red-400">*</span>
        </label>
        <input
          id="edit-title"
          type="text"
          value={title}
          onChange={(e) => onTitleChange(e.target.value)}
          className={INPUT_CLASS}
          autoFocus
        />
      </div>

      <TextField id="edit-subtitle" label="Subtitle" value={subtitle} onChange={onSubtitleChange} placeholder="e.g. Book One of the Stormlight Archive" />

      <TextField id="edit-author" label="Author" value={author} onChange={onAuthorChange} placeholder="e.g. Brandon Sanderson" />

      <div className="grid grid-cols-2 gap-3">
        <TextField id="edit-series" label="Series" value={seriesName} onChange={onSeriesNameChange} placeholder="e.g. Harry Potter" />
        <div>
          <label htmlFor="edit-series-position" className={LABEL_CLASS}>
            Position
          </label>
          <input
            id="edit-series-position"
            type="text"
            inputMode="decimal"
            value={seriesPosition}
            onChange={(e) => onSeriesPositionChange(e.target.value)}
            placeholder="e.g. 1"
            className={`${INPUT_CLASS}${positionError ? ' border-red-400/50' : ''}`}
          />
          {positionError && (
            <p className="text-xs text-red-400 mt-1">{positionError}</p>
          )}
        </div>
      </div>

      <TextField id="edit-narrator" label="Narrator" value={narrator} onChange={onNarratorChange} />

      <div className="grid grid-cols-2 gap-3">
        <TextField id="edit-published-date" label="Published date (year or full date)" value={publishedDate} onChange={onPublishedDateChange} placeholder="e.g. 2010 or 2010-08-31" />
        <TextField id="edit-genres" label="Genres" value={genres} onChange={onGenresChange} placeholder="e.g. Fantasy, Epic" />
      </div>

      <TextField id="edit-publisher" label="Publisher" value={publisher} onChange={onPublisherChange} placeholder="e.g. Macmillan Audio" />

      <div>
        <label htmlFor="edit-description" className={LABEL_CLASS}>
          Description
        </label>
        <textarea
          id="edit-description"
          value={description}
          onChange={(e) => onDescriptionChange(e.target.value)}
          rows={4}
          className={`${INPUT_CLASS} resize-y`}
        />
      </div>

      {/* Duration is scanner-derived from the audio files, not author-supplied, so
          it is intentionally not editable here (#1609 / #1614). */}
      <p className="text-xs text-muted-foreground/50">
        Duration is read from the audio files.
      </p>

      {hasPath && (
        <div className="pt-1">
          <div className="border-t border-white/5 mb-4" />
          <label className="flex items-center gap-3 cursor-pointer group">
            <input
              type="checkbox"
              checked={renameFiles}
              onChange={(e) => onRenameFilesChange(e.target.checked)}
              className="w-4 h-4 rounded border-white/20 bg-transparent text-primary focus:ring-primary/30 focus:ring-offset-0"
            />
            <div>
              <span className="text-sm text-muted-foreground group-hover:text-foreground transition-colors">
                Rename files after saving
              </span>
              <p className="text-xs text-muted-foreground/50 mt-0.5">
                Reorganize folder and filenames to match format templates
              </p>
            </div>
          </label>
        </div>
      )}
    </div>
  );
}
