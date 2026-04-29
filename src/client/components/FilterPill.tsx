import type { ReactNode, Ref } from 'react';

type FilterPillVariant = 'primary' | 'toolbar';

const variantClasses: Record<FilterPillVariant, { active: string; inactive: string }> = {
  primary: {
    active: 'bg-primary text-primary-foreground shadow-glow',
    inactive: 'bg-muted text-muted-foreground hover:text-foreground',
  },
  toolbar: {
    active: 'bg-muted/80 text-foreground',
    inactive: 'text-muted-foreground hover:text-foreground hover:bg-muted/50',
  },
};

export interface FilterPillProps {
  label?: string;
  active: boolean;
  onClick: () => void;
  variant?: FilterPillVariant;
  className?: string;
  children?: ReactNode;
  ref?: Ref<HTMLButtonElement>;
  'aria-label'?: string;
  'aria-pressed'?: boolean;
}

export function FilterPill({
  label,
  active,
  onClick,
  variant = 'primary',
  className = '',
  children,
  ref,
  'aria-label': ariaLabel,
  'aria-pressed': ariaPressed,
}: FilterPillProps) {
  const classes = variantClasses[variant];
  return (
    <button
      ref={ref}
      type="button"
      onClick={onClick}
      aria-label={ariaLabel}
      aria-pressed={ariaPressed}
      className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all duration-200 ${
        active ? classes.active : classes.inactive
      } ${className}`}
    >
      {children ?? label}
    </button>
  );
}
