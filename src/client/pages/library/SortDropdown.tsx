import { useRef, useState } from 'react';
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

const sortFields: SortField[] = ['createdAt', 'title', 'author', 'narrator', 'series'];
const directions: SortDirection[] = ['desc', 'asc'];

type SortOption = { field: SortField; direction: SortDirection; label: string };

const sortOptions: SortOption[] = sortFields.flatMap((field) =>
  directions.map((direction) => ({
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
  const triggerRef = useRef<HTMLButtonElement>(null);

  function handleSelect(option: SortOption) {
    onSortFieldChange(option.field);
    onSortDirectionChange(option.direction);
    setOpen(false);
  }

  const triggerLabel = getTriggerLabel(sortField, sortDirection);

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label={triggerLabel}
        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-all duration-200 focus-ring"
      >
        <span>{triggerLabel}</span>
        <ChevronDownIcon className={`w-3 h-3 transition-transform duration-200 ${open ? 'rotate-180' : ''}`} />
      </button>

      <ToolbarDropdown triggerRef={triggerRef} open={open} onClose={() => setOpen(false)}>
        <div
          role="listbox"
          aria-label="Sort options"
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
                  flex items-center w-full px-3 py-2 text-xs text-left transition-colors
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
