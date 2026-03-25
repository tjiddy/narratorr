import { useRef, useState } from 'react';
import { ChevronDownIcon } from '@/components/icons';
import { ToolbarDropdown } from '@/components/ToolbarDropdown';
import { filterTabs, type StatusFilter } from './helpers.js';

export function StatusDropdown({
  statusFilter,
  onStatusFilterChange,
  statusCounts,
}: {
  statusFilter: StatusFilter;
  onStatusFilterChange: (f: StatusFilter) => void;
  statusCounts: Record<StatusFilter, number>;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const currentTab = filterTabs.find((t) => t.key === statusFilter) ?? filterTabs[0];
  const currentCount = statusCounts[statusFilter] ?? 0;

  function handleSelect(key: StatusFilter) {
    onStatusFilterChange(key);
    setOpen(false);
  }

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label={`${currentTab.label} (${currentCount})`}
        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-all duration-200 focus-ring"
      >
        <span>{currentTab.label}</span>
        <span className="opacity-60">({currentCount})</span>
        <ChevronDownIcon className={`w-3 h-3 transition-transform duration-200 ${open ? 'rotate-180' : ''}`} />
      </button>

      <ToolbarDropdown triggerRef={triggerRef} open={open} onClose={() => setOpen(false)}>
        <div
          role="listbox"
          aria-label="Status filter"
          className="min-w-[160px] glass-card rounded-xl overflow-hidden shadow-lg border border-border animate-fade-in"
        >
          {filterTabs.map((tab) => {
            const count = statusCounts[tab.key] ?? 0;
            const isActive = tab.key === statusFilter;
            return (
              <button
                key={tab.key}
                role="option"
                aria-selected={isActive}
                aria-label={`${tab.label} (${count})`}
                type="button"
                onClick={() => handleSelect(tab.key)}
                className={`
                  flex items-center justify-between w-full px-3 py-2 text-xs text-left transition-colors
                  ${isActive
                    ? 'bg-muted/80 text-foreground font-medium'
                    : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground'
                  }
                `}
              >
                <span>{tab.label}</span>
                <span className="opacity-60 ml-2">{count}</span>
              </button>
            );
          })}
        </div>
      </ToolbarDropdown>
    </div>
  );
}
