import { SelectWithChevron } from '@/components/settings/SelectWithChevron';

export interface FilterProps {
  authorFilter: string;
  onAuthorFilterChange: (f: string) => void;
  uniqueAuthors: string[];
  seriesFilter: string;
  onSeriesFilterChange: (f: string) => void;
  uniqueSeries: string[];
  narratorFilter: string;
  onNarratorFilterChange: (f: string) => void;
  uniqueNarrators: string[];
}

export function FilterRow({
  authorFilter, onAuthorFilterChange, uniqueAuthors,
  seriesFilter, onSeriesFilterChange, uniqueSeries,
  narratorFilter, onNarratorFilterChange, uniqueNarrators,
}: FilterProps) {
  return (
    <div className="flex flex-wrap items-center gap-3 animate-fade-in">
      {uniqueAuthors.length > 1 && (
        <SelectWithChevron id="author-filter" variant="compact" className="py-1.5 text-xs"
          value={authorFilter} onChange={(e) => onAuthorFilterChange(e.target.value)} aria-label="Filter by author">
          <option value="">All Authors</option>
          {uniqueAuthors.map((name) => (
            <option key={name} value={name}>{name}</option>
          ))}
        </SelectWithChevron>
      )}

      {uniqueSeries.length > 0 && (
        <SelectWithChevron id="series-filter" variant="compact" className="py-1.5 text-xs"
          value={seriesFilter} onChange={(e) => onSeriesFilterChange(e.target.value)} aria-label="Filter by series">
          <option value="">All Series</option>
          {uniqueSeries.map((name) => (
            <option key={name} value={name}>{name}</option>
          ))}
        </SelectWithChevron>
      )}

      {uniqueNarrators.length > 1 && (
        <SelectWithChevron id="narrator-filter" variant="compact" className="py-1.5 text-xs"
          value={narratorFilter} onChange={(e) => onNarratorFilterChange(e.target.value)} aria-label="Filter by narrator">
          <option value="">All Narrators</option>
          {uniqueNarrators.map((name) => (
            <option key={name} value={name}>{name}</option>
          ))}
        </SelectWithChevron>
      )}
    </div>
  );
}
