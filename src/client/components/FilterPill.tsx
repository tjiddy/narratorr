import type { ReactNode } from 'react';

interface FilterPillProps {
  label?: string;
  active: boolean;
  onClick: () => void;
  className?: string;
  children?: ReactNode;
}

export function FilterPill({ label, active, onClick, className = '', children }: FilterPillProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
        active
          ? 'bg-primary text-primary-foreground shadow-glow'
          : 'bg-muted text-muted-foreground hover:text-foreground'
      } ${className}`}
    >
      {children ?? label}
    </button>
  );
}
