import { useState, useRef } from 'react';
import type { FieldError, UseFormRegisterReturn } from 'react-hook-form';
import { FolderIcon } from '@/components/icons';
import { DirectoryBrowserModal } from './DirectoryBrowserModal.js';

interface PathInputProps {
  value: string;
  onChange?: (path: string) => void;
  registration?: UseFormRegisterReturn;
  id?: string;
  placeholder?: string;
  error?: FieldError;
  className?: string;
  fallbackBrowsePath?: string;
  onKeyDown?: React.KeyboardEventHandler<HTMLInputElement>;
  autoFocus?: boolean;
}

export function PathInput({
  value,
  onChange,
  registration,
  id,
  placeholder,
  error,
  className,
  fallbackBrowsePath,
  onKeyDown,
  autoFocus,
}: PathInputProps) {
  const [browseOpen, setBrowseOpen] = useState(false);
  const browseButtonRef = useRef<HTMLButtonElement>(null);

  function handleSelect(path: string) {
    onChange?.(path);
    // Drive RHF directly so registration-only callers get Browse updates.
    // Must include `name` in the synthetic target — RHF reads event.target.name to look up the field.
    if (registration) {
      void registration.onChange({
        target: { name: registration.name, value: path },
      } as React.ChangeEvent<HTMLInputElement>);
    }
    setBrowseOpen(false);
    browseButtonRef.current?.focus();
  }

  function handleClose() {
    setBrowseOpen(false);
    browseButtonRef.current?.focus();
  }

  const initialPath = value || fallbackBrowsePath || '/';

  return (
    <div className={className}>
      <div className="relative flex items-center">
        <span
          data-testid="path-input-icon"
          aria-hidden="true"
          className="absolute left-3 flex items-center pointer-events-none text-muted-foreground"
        >
          <FolderIcon className="w-4 h-4" />
        </span>
        <input
          id={id}
          type="text"
          value={value}
          onChange={(e) => onChange?.(e.target.value)}
          onKeyDown={onKeyDown}
          autoFocus={autoFocus}
          placeholder={placeholder}
          className={`w-full pl-10 pr-20 py-3 glass-card rounded-xl text-sm focus-ring${error ? ' border-destructive' : ''}`}
          {...registration}
        />
        <button
          ref={browseButtonRef}
          type="button"
          onClick={() => setBrowseOpen(true)}
          className="absolute right-2 px-3 py-1.5 text-xs font-medium glass-card rounded-lg hover:border-primary/30 transition-all focus-ring"
        >
          Browse
        </button>
      </div>
      {error && (
        <p className="text-sm text-destructive mt-1">{error.message}</p>
      )}
      <DirectoryBrowserModal
        isOpen={browseOpen}
        initialPath={initialPath}
        onSelect={handleSelect}
        onClose={handleClose}
      />
    </div>
  );
}
