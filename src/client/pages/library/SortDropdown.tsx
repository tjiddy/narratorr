import { useRef, useState, useEffect, useCallback } from 'react';
import { ChevronDownIcon } from '@/components/icons';
import { ToolbarDropdown } from '@/components/ToolbarDropdown';
import type { SortField, SortDirection } from './helpers.js';

export interface SortProps {
  sortField: SortField;
  onSortFieldChange: (f: SortField) => void;
  sortDirection: SortDirection;
  onSortDirectionChange: (d: SortDirection) => void;
}

const sortFieldLabels: Record<SortField, string> = {
  createdAt: 'Date Added',
  title: 'Title',
  author: 'Author',
  narrator: 'Narrator',
  series: 'Series',
  quality: 'Quality',
  size: 'Size',
  format: 'Format',
};

type DirectionLabel = { asc: string; desc: string };

const sortDirectionLabels: Record<SortField, DirectionLabel> = {
  createdAt: { desc: 'Newest', asc: 'Oldest' },
  title: { asc: 'A→Z', desc: 'Z→A' },
  author: { asc: 'A→Z', desc: 'Z→A' },
  narrator: { asc: 'A→Z', desc: 'Z→A' },
  series: { asc: 'A→Z', desc: 'Z→A' },
  quality: { desc: 'High→Low', asc: 'Low→High' },
  size: { desc: 'Largest', asc: 'Smallest' },
  format: { asc: 'A→Z', desc: 'Z→A' },
};

const sortFields: SortField[] = ['createdAt', 'title', 'author'];

/** Direction order per field: Date Added shows desc (Newest) first; alphabetical fields show asc (A→Z) first. */
const fieldDirections: Record<string, SortDirection[]> = {
  createdAt: ['desc', 'asc'],
};
const defaultDirections: SortDirection[] = ['asc', 'desc'];

type SortOption = { field: SortField; direction: SortDirection; label: string };

const sortOptions: SortOption[] = sortFields.flatMap((field) =>
  (fieldDirections[field] ?? defaultDirections).map((direction) => ({
    field,
    direction,
    label: `${sortFieldLabels[field]} (${sortDirectionLabels[field][direction]})`,
  })),
);

function getTriggerLabel(field: SortField, direction: SortDirection): string {
  return `${sortFieldLabels[field]} (${sortDirectionLabels[field][direction]})`;
}

export function SortDropdown({ sortField, onSortFieldChange, sortDirection, onSortDirectionChange }: SortProps) {
  const [open, setOpen] = useState(false);
  const [focusIndex, setFocusIndex] = useState(0);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // Focus the option at focusIndex when open, or when focusIndex changes while open
  useEffect(() => {
    if (!open) return;
    const buttons = menuRef.current?.querySelectorAll<HTMLButtonElement>('button');
    buttons?.[focusIndex]?.focus();
  }, [focusIndex, open]);

  function handleClose() {
    setFocusIndex(0);
    setOpen(false);
    triggerRef.current?.focus();
  }

  function handleSelect(option: SortOption) {
    onSortFieldChange(option.field);
    onSortDirectionChange(option.direction);
    setFocusIndex(0);
    setOpen(false);
    triggerRef.current?.focus();
  }

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setFocusIndex((i) => (i + 1) % sortOptions.length);
        break;
      case 'ArrowUp':
        e.preventDefault();
        setFocusIndex((i) => (i - 1 + sortOptions.length) % sortOptions.length);
        break;
      case 'Enter':
      case ' ':
        e.preventDefault();
        if (focusIndex < sortOptions.length) {
          onSortFieldChange(sortOptions[focusIndex].field);
          onSortDirectionChange(sortOptions[focusIndex].direction);
          setFocusIndex(0);
          setOpen(false);
          triggerRef.current?.focus();
        }
        break;
    }
  }, [focusIndex, onSortFieldChange, onSortDirectionChange]);

  const triggerLabel = getTriggerLabel(sortField, sortDirection);

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => open ? handleClose() : setOpen(true)}
        aria-label={triggerLabel}
        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-all duration-200 focus-ring"
      >
        <span>{triggerLabel}</span>
        <ChevronDownIcon className={`w-3 h-3 transition-transform duration-200 ${open ? 'rotate-180' : ''}`} />
      </button>

      <ToolbarDropdown triggerRef={triggerRef} open={open} onClose={handleClose}>
        <div
          ref={menuRef}
          role="listbox"
          aria-label="Sort options"
          onKeyDown={handleKeyDown}
          className="min-w-[200px] glass-card rounded-xl overflow-hidden shadow-lg border border-border animate-fade-in"
        >
          {sortOptions.map((option) => {
            const isActive = option.field === sortField && option.direction === sortDirection;
            return (
              <button
                key={`${option.field}-${option.direction}`}
                role="option"
                aria-selected={isActive}
                aria-label={option.label}
                type="button"
                onClick={() => handleSelect(option)}
                className={`
                  flex items-center w-full px-3 py-2 text-xs text-left transition-colors focus-ring
                  ${isActive
                    ? 'bg-muted/80 text-foreground font-medium'
                    : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground'
                  }
                `}
              >
                {option.label}
              </button>
            );
          })}
        </div>
      </ToolbarDropdown>
    </div>
  );
}
