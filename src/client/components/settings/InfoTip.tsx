import { useRef, useState, type ReactNode } from 'react';
import { InfoIcon } from '@/components/icons';
import { useClickOutside } from '@/hooks/useClickOutside';

/** Supplementary details only; required guidance belongs in the row description. */
export function InfoTip({ label = 'More info', children }: { label?: string; children: ReactNode }) {
  // Separate hover and pin state because clicking with a mouse also enters hover.
  const [hovered, setHovered] = useState(false);
  const [pinned, setPinned] = useState(false);
  const open = hovered || pinned;
  const ref = useRef<HTMLSpanElement>(null);
  const closeAll = () => { setHovered(false); setPinned(false); };
  useClickOutside(ref, closeAll, open);

  return (
    <span
      ref={ref}
      className="relative inline-flex align-middle"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <button
        type="button"
        aria-label={label}
        aria-expanded={open}
        onClick={() => setPinned((p) => !p)}
        onKeyDown={(e) => { if (e.key === 'Escape') closeAll(); }}
        className="text-muted-foreground/60 hover:text-muted-foreground transition-colors rounded-full focus-ring"
      >
        <InfoIcon className="w-3.5 h-3.5" />
      </button>
      {open && (
        <span
          role="tooltip"
          className="absolute left-1/2 -translate-x-1/2 bottom-full mb-2 z-50 block w-72 rounded-xl border border-border bg-popover p-3 text-xs leading-relaxed text-popover-foreground shadow-lg"
        >
          {children}
        </span>
      )}
    </span>
  );
}
