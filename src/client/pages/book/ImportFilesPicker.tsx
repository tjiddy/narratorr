import { useState } from 'react';
import { DirectoryBrowserModal } from '@/components/DirectoryBrowserModal';

export type ImportFilesMode = 'copy' | 'move';

interface ImportFilesPickerProps {
  isOpen: boolean;
  isPending: boolean;
  onSubmit: (vars: { path: string; mode: ImportFilesMode }) => void;
  onClose: () => void;
}

const MODES: { value: ImportFilesMode; label: string }[] = [
  { value: 'copy', label: 'Copy' },
  { value: 'move', label: 'Move' },
];

/**
 * #2435 AC19 — pick a manually-obtained file (or its folder) and the mode to place it with.
 *
 * `mode` is mandatory on the wire and defaults to Copy here, matching the vocabulary the
 * manual-import page already offers. File selection is the point of the action: a user with one
 * target M4B beside unrelated audio must be able to attach that file, not the whole folder.
 */
export function ImportFilesPicker({ isOpen, isPending, onSubmit, onClose }: ImportFilesPickerProps) {
  const [mode, setMode] = useState<ImportFilesMode>('copy');

  if (!isOpen) return null;

  return (
    <DirectoryBrowserModal
      isOpen={isOpen}
      initialPath="/"
      selectableFiles
      title="Import Files"
      subtitle="Choose an audio file, or a folder containing one"
      selectLabel={isPending ? 'Importing...' : 'Import'}
      selectDisabled={isPending}
      footerExtra={
        <div role="radiogroup" aria-label="Import mode" className="flex items-center gap-1 mb-1.5">
          {MODES.map((m) => (
            <button
              key={m.value}
              type="button"
              role="radio"
              aria-checked={mode === m.value}
              disabled={isPending}
              onClick={() => setMode(m.value)}
              className={`px-2.5 py-1 text-xs font-medium rounded-lg transition-colors focus-ring disabled:opacity-50 disabled:pointer-events-none ${
                mode === m.value ? 'bg-primary/15 text-primary' : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              {m.label}
            </button>
          ))}
        </div>
      }
      onSelect={(path) => onSubmit({ path, mode })}
      onClose={onClose}
    />
  );
}
