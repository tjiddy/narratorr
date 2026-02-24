import { useState, useRef } from 'react';
import { useEscapeKey } from '@/hooks/useEscapeKey';
import { XIcon } from '@/components/icons';
import type { BookWithAuthor, UpdateBookPayload } from '@/lib/api';

interface BookMetadataModalProps {
  book: BookWithAuthor;
  onSave: (data: UpdateBookPayload, renameFiles: boolean) => void;
  onClose: () => void;
  isSaving: boolean;
}

export function BookMetadataModal({ book, onSave, onClose, isSaving }: BookMetadataModalProps) {
  const modalRef = useRef<HTMLDivElement>(null);
  const [title, setTitle] = useState(book.title);
  const [seriesName, setSeriesName] = useState(book.seriesName ?? '');
  const [seriesPosition, setSeriesPosition] = useState(book.seriesPosition?.toString() ?? '');
  const [narrator, setNarrator] = useState(book.narrator ?? '');
  const [renameFiles, setRenameFiles] = useState(false);

  useEscapeKey(true, onClose, modalRef);

  const canSave = title.trim().length > 0 && !isSaving;
  const hasPath = !!book.path;

  const handleSave = () => {
    if (!canSave) return;

    const data: UpdateBookPayload = {};

    if (title.trim() !== book.title) data.title = title.trim();
    if (seriesName.trim() !== (book.seriesName ?? '')) {
      data.seriesName = seriesName.trim() || null;
    }

    const newPos = seriesPosition.trim() ? parseFloat(seriesPosition.trim()) : null;
    if (newPos !== (book.seriesPosition ?? null)) {
      data.seriesPosition = newPos;
    }

    if (narrator.trim() !== (book.narrator ?? '')) {
      data.narrator = narrator.trim() || undefined;
    }

    onSave(data, renameFiles);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 animate-fade-in">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-label="Edit book metadata"
        className="relative w-full max-w-md flex flex-col glass-card rounded-2xl shadow-2xl animate-fade-in-up"
        onClick={(e) => e.stopPropagation()}
        tabIndex={-1}
      >
        {/* Header */}
        <div className="px-6 pt-5 pb-4 flex items-center justify-between">
          <h2 className="font-display text-lg font-semibold tracking-tight">Edit Metadata</h2>
          <button
            onClick={onClose}
            className="p-1.5 text-muted-foreground hover:text-foreground rounded-lg transition-colors focus-ring"
            aria-label="Close"
          >
            <XIcon className="w-4 h-4" />
          </button>
        </div>

        <div className="border-t border-white/5" />

        {/* Fields */}
        <div className="p-6 space-y-4">
          <div>
            <label htmlFor="edit-title" className="block text-xs font-medium text-muted-foreground mb-1.5">
              Title <span className="text-red-400">*</span>
            </label>
            <input
              id="edit-title"
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
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
                onChange={(e) => setSeriesName(e.target.value)}
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
                onChange={(e) => setSeriesPosition(e.target.value)}
                placeholder="e.g. 1"
                className="w-full px-3 py-2 glass-card rounded-xl text-sm focus-ring"
              />
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
              onChange={(e) => setNarrator(e.target.value)}
              className="w-full px-3 py-2 glass-card rounded-xl text-sm focus-ring"
            />
          </div>

          {/* Rename files checkbox */}
          {hasPath && (
            <div className="pt-1">
              <div className="border-t border-white/5 mb-4" />
              <label className="flex items-center gap-3 cursor-pointer group">
                <input
                  type="checkbox"
                  checked={renameFiles}
                  onChange={(e) => setRenameFiles(e.target.checked)}
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

        {/* Footer */}
        <div className="px-6 py-4 border-t border-white/5 flex justify-end gap-3">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm font-medium glass-card rounded-xl hover:border-primary/30 transition-all focus-ring"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={!canSave}
            className="px-5 py-2 text-sm font-medium bg-primary text-primary-foreground rounded-xl hover:opacity-90 transition-all disabled:opacity-40 disabled:cursor-not-allowed focus-ring"
          >
            {isSaving ? 'Saving...' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
