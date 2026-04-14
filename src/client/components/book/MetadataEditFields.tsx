import { SearchIcon } from '@/components/icons';

interface MetadataEditFieldsProps {
  title: string;
  onTitleChange: (value: string) => void;
  seriesName: string;
  onSeriesNameChange: (value: string) => void;
  seriesPosition: string;
  onSeriesPositionChange: (value: string) => void;
  positionError: string | null;
  narrator: string;
  onNarratorChange: (value: string) => void;
  renameFiles: boolean;
  onRenameFilesChange: (value: boolean) => void;
  hasPath: boolean;
  onOpenSearch: () => void;
}

export function MetadataEditFields({
  title,
  onTitleChange,
  seriesName,
  onSeriesNameChange,
  seriesPosition,
  onSeriesPositionChange,
  positionError,
  narrator,
  onNarratorChange,
  renameFiles,
  onRenameFilesChange,
  hasPath,
  onOpenSearch,
}: MetadataEditFieldsProps) {
  return (
    <div className="p-6 space-y-4 overflow-y-auto">
      <div>
        <label htmlFor="edit-title" className="block text-xs font-medium text-muted-foreground mb-1.5">
          Title <span className="text-red-400">*</span>
        </label>
        <input
          id="edit-title"
          type="text"
          value={title}
          onChange={(e) => onTitleChange(e.target.value)}
          className="w-full px-3 py-2 glass-card rounded-xl text-sm focus-ring"
          autoFocus
        />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label htmlFor="edit-series" className="block text-xs font-medium text-muted-foreground mb-1.5">
            Series
          </label>
          <input
            id="edit-series"
            type="text"
            value={seriesName}
            onChange={(e) => onSeriesNameChange(e.target.value)}
            placeholder="e.g. Harry Potter"
            className="w-full px-3 py-2 glass-card rounded-xl text-sm focus-ring"
          />
        </div>
        <div>
          <label htmlFor="edit-series-position" className="block text-xs font-medium text-muted-foreground mb-1.5">
            Position
          </label>
          <input
            id="edit-series-position"
            type="text"
            inputMode="decimal"
            value={seriesPosition}
            onChange={(e) => onSeriesPositionChange(e.target.value)}
            placeholder="e.g. 1"
            className={`w-full px-3 py-2 glass-card rounded-xl text-sm focus-ring${positionError ? ' border-red-400/50' : ''}`}
          />
          {positionError && (
            <p className="text-xs text-red-400 mt-1">{positionError}</p>
          )}
        </div>
      </div>

      <div>
        <label htmlFor="edit-narrator" className="block text-xs font-medium text-muted-foreground mb-1.5">
          Narrator
        </label>
        <input
          id="edit-narrator"
          type="text"
          value={narrator}
          onChange={(e) => onNarratorChange(e.target.value)}
          className="w-full px-3 py-2 glass-card rounded-xl text-sm focus-ring"
        />
      </div>

      <div className="pt-1">
        <div className="border-t border-white/5 mb-3" />
        <button
          type="button"
          onClick={onOpenSearch}
          className="w-full flex items-center justify-center gap-2 px-3 py-2 text-xs font-medium glass-card rounded-xl hover:border-primary/30 hover:text-primary transition-all focus-ring"
        >
          <SearchIcon className="w-3.5 h-3.5" />
          Search for metadata
        </button>
      </div>

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
