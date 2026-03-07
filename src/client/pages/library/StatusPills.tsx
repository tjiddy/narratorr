import { type StatusFilter, filterTabs } from './helpers.js';

interface StatusPillsProps {
  statusFilter: StatusFilter;
  onStatusFilterChange: (f: StatusFilter) => void;
  statusCounts: Record<StatusFilter, number>;
}

export function StatusPills({ statusFilter, onStatusFilterChange, statusCounts }: StatusPillsProps) {
  return (
    <div className="flex items-center gap-1.5">
      {filterTabs.map((tab) => {
        const isActive = statusFilter === tab.key;
        const count = statusCounts[tab.key];
        return (
          <button
            key={tab.key}
            onClick={() => onStatusFilterChange(tab.key)}
            className={`
              flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-medium
              transition-all duration-200 focus-ring whitespace-nowrap
              ${isActive
                ? 'bg-primary text-primary-foreground shadow-glow'
                : 'text-muted-foreground hover:text-foreground hover:bg-muted/50'
              }
            `}
          >
            {tab.label}
            <span className={`text-[10px] ${isActive ? 'opacity-75' : 'opacity-50'}`}>
              {count}
            </span>
          </button>
        );
      })}
    </div>
  );
}
