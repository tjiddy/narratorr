import { ChevronDownIcon, ArrowUpDownIcon } from '@/components/icons';
import type { SortField, SortDirection } from './helpers.js';

const sortLabels: Record<SortField, string> = {
  createdAt: 'Date Added',
  title: 'Title',
  author: 'Author',
  narrator: 'Narrator',
  series: 'Series',
  quality: 'Quality',
  size: 'Size',
  format: 'Format',
};

export interface SortProps {
  sortField: SortField;
  onSortFieldChange: (f: SortField) => void;
  sortDirection: SortDirection;
  onSortDirectionChange: (d: SortDirection) => void;
}

export function SortControls({
  sortField, onSortFieldChange, sortDirection, onSortDirectionChange,
}: SortProps) {
  return (
    <div className="flex items-center gap-1.5">
      <div className="relative">
        <select
          value={sortField}
          onChange={(e) => onSortFieldChange(e.target.value as SortField)}
          className="appearance-none glass-card rounded-lg pl-3 pr-7 py-1.5 text-xs font-medium text-foreground focus-ring cursor-pointer"
        >
          {Object.entries(sortLabels).map(([key, label]) => (
            <option key={key} value={key}>{label}</option>
          ))}
        </select>
        <ChevronDownIcon className="absolute right-2 top-1/2 -translate-y-1/2 w-3 h-3 text-muted-foreground pointer-events-none" />
      </div>
      <button
        onClick={() => onSortDirectionChange(sortDirection === 'asc' ? 'desc' : 'asc')}
        className="glass-card rounded-lg p-1.5 text-muted-foreground hover:text-foreground transition-colors focus-ring"
        title={sortDirection === 'asc' ? 'Sort ascending' : 'Sort descending'}
      >
        <ArrowUpDownIcon className={`w-3.5 h-3.5 transition-transform ${sortDirection === 'asc' ? 'rotate-180' : ''}`} />
      </button>
    </div>
  );
}
