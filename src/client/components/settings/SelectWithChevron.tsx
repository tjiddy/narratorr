import { forwardRef, type ReactNode } from 'react';
import { ChevronDownIcon } from '@/components/icons';

interface SelectWithChevronProps extends React.SelectHTMLAttributes<HTMLSelectElement> {
  id: string;
  label?: string;
  error?: boolean;
  children?: ReactNode;
}

export const SelectWithChevron = forwardRef<HTMLSelectElement, SelectWithChevronProps>(
  function SelectWithChevron({ id, label, error, children, className, ...selectProps }, ref) {
    const borderClass = error ? 'border-destructive' : 'border-border';

    return (
      <div>
        {label && (
          <label htmlFor={id} className="block text-xs font-medium text-muted-foreground mb-1">{label}</label>
        )}
        <div className="relative">
          <select
            id={id}
            ref={ref}
            className={`w-full appearance-none px-4 py-3 pr-10 bg-background border ${borderClass} rounded-xl text-sm focus-ring cursor-pointer${className ? ` ${className}` : ''}`}
            {...selectProps}
          >
            {children}
          </select>
          <ChevronDownIcon className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
        </div>
      </div>
    );
  }
);
