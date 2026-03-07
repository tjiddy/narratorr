import { ChevronDownIcon } from '@/components/icons';

interface FilterRowProps {
  authorFilter: string;
  onAuthorFilterChange: (f: string) => void;
  uniqueAuthors: string[];
  seriesFilter: string;
  onSeriesFilterChange: (f: string) => void;
  uniqueSeries: string[];
}

export function FilterRow({
  authorFilter, onAuthorFilterChange, uniqueAuthors,
  seriesFilter, onSeriesFilterChange, uniqueSeries,
}: FilterRowProps) {
  return (
    <div className="flex flex-wrap items-center gap-3 animate-fade-in">
      {uniqueAuthors.length > 1 && (
        <div className="relative">
          <select
            value={authorFilter}
            onChange={(e) => onAuthorFilterChange(e.target.value)}
            className="appearance-none glass-card rounded-lg pl-3 pr-7 py-1.5 text-xs font-medium text-foreground focus-ring cursor-pointer"
          >
            <option value="">All Authors</option>
            {uniqueAuthors.map((name) => (
              <option key={name} value={name}>{name}</option>
            ))}
          </select>
          <ChevronDownIcon className="absolute right-2 top-1/2 -translate-y-1/2 w-3 h-3 text-muted-foreground pointer-events-none" />
        </div>
      )}

      {uniqueSeries.length > 0 && (
        <div className="relative">
          <select
            value={seriesFilter}
            onChange={(e) => onSeriesFilterChange(e.target.value)}
            className="appearance-none glass-card rounded-lg pl-3 pr-7 py-1.5 text-xs font-medium text-foreground focus-ring cursor-pointer"
          >
            <option value="">All Series</option>
            {uniqueSeries.map((name) => (
              <option key={name} value={name}>{name}</option>
            ))}
          </select>
          <ChevronDownIcon className="absolute right-2 top-1/2 -translate-y-1/2 w-3 h-3 text-muted-foreground pointer-events-none" />
        </div>
      )}
    </div>
  );
}
