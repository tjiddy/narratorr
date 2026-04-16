import { forwardRef, type ReactNode } from 'react';
import { ChevronDownIcon } from '@/components/icons';

interface SelectWithChevronProps extends React.SelectHTMLAttributes<HTMLSelectElement> {
  id: string;
  label?: string;
  error?: boolean;
  variant?: 'default' | 'compact';
  children?: ReactNode;
}

export const SelectWithChevron = forwardRef<HTMLSelectElement, SelectWithChevronProps>(
  function SelectWithChevron({ id, label, error, variant = 'default', children, className, ...selectProps }, ref) {
    const isCompact = variant === 'compact';
    const borderClass = error ? 'border-destructive' : 'border-border';

    const selectClass = isCompact
      ? `appearance-none glass-card rounded-lg pl-3 pr-7 font-medium text-foreground focus-ring cursor-pointer${className ? ` ${className}` : ''}`
      : `w-full appearance-none px-4 py-3 pr-10 bg-background border ${borderClass} rounded-xl text-sm focus-ring cursor-pointer${className ? ` ${className}` : ''}`;

    const chevronClass = isCompact
      ? 'absolute right-2 top-1/2 -translate-y-1/2 w-3 h-3 text-muted-foreground pointer-events-none'
      : 'absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none';

    return (
      <div>
        {label && (
          <label htmlFor={id} className={isCompact
            ? 'block text-xs font-medium text-muted-foreground mb-1'
            : 'block text-sm font-medium mb-2'
          }>{label}</label>
        )}
        <div className="relative">
          <select
            id={id}
            ref={ref}
            className={selectClass}
            {...selectProps}
          >
            {children}
          </select>
          <ChevronDownIcon className={chevronClass} />
        </div>
      </div>
    );
  }
);
