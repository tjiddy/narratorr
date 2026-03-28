import { useState } from 'react';
import { ChevronDownIcon } from '@/components/icons';

export function UnsupportedSection({ titles, count }: { titles: string[]; count: number }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="border border-dashed border-border/40 rounded-xl bg-muted/20 overflow-hidden">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-2 w-full px-4 py-2.5 text-xs text-muted-foreground/70 hover:text-muted-foreground hover:bg-muted/30 transition-colors duration-200"
      >
        <ChevronDownIcon className={`w-3 h-3 shrink-0 transition-transform duration-200 ${expanded ? '' : '-rotate-90'}`} />
        <span>Found, but unsupported format ({count})</span>
      </button>
      {expanded && (
        <div className="px-4 pb-3 pt-0 space-y-0.5 border-t border-border/20">
          {titles.map((title, i) => (
            <p key={`${title}-${i}`} className="text-xs text-muted-foreground/50 font-mono truncate" title={title}>
              {title}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}
