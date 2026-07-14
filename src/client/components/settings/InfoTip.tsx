import { useRef, useState, type ReactNode } from 'react';
import { InfoIcon } from '@/components/icons';
import { useClickOutside } from '@/hooks/useClickOutside';

/**
 * Inline "more info" affordance for row descriptions: keeps the visible copy down to the
 * load-bearing sentence and tucks reference material (env-var lists, format details) behind a
 * small icon. Opens on hover AND on click/keyboard (touch devices have no hover), closes on
 * outside click / Escape / mouse leave. The popover is inside the hover wrapper, so moving the
 * pointer into it keeps it open — its content stays selectable/copyable.
 *
 * Only for SUPPLEMENTARY detail — anything required to fill the field correctly belongs in the
 * always-visible description, not in here.
 */
export function InfoTip({ label = 'More info', children }: { label?: string; children: ReactNode }) {
  // Hover and click are SEPARATE states, or they fight: a mouse click is always preceded by
  // mouseenter, so a single click-toggled state would open-on-hover then instantly close-on-click.
  // Open while hovered OR pinned; click toggles the pin (touch/keyboard), Escape/outside clears both.
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
