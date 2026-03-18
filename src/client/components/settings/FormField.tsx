import type { ReactNode } from 'react';
import type { FieldError, UseFormRegisterReturn } from 'react-hook-form';

const baseInputClass = 'w-full px-4 py-3 bg-background border rounded-xl focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent transition-all';

interface FormFieldProps {
  id: string;
  label: string;
  registration: UseFormRegisterReturn;
  error?: FieldError;
  type?: 'text' | 'number' | 'password' | 'url';
  placeholder?: string;
  readOnly?: boolean;
  disabled?: boolean;
  min?: number;
  max?: number;
  className?: string;
  hint?: ReactNode;
}

export function FormField({
  id,
  label,
  registration,
  error,
  type = 'text',
  placeholder,
  readOnly,
  disabled,
  min,
  max,
  className,
  hint,
}: FormFieldProps) {
  return (
    <div>
      <label htmlFor={id} className="block text-sm font-medium mb-2">{label}</label>
      <input
        id={id}
        type={type}
        {...registration}
        readOnly={readOnly}
        disabled={disabled}
        min={min}
        max={max}
        className={`${baseInputClass} ${error ? 'border-destructive' : 'border-border'} ${readOnly ? 'opacity-60 cursor-not-allowed' : ''} ${disabled ? 'disabled:cursor-not-allowed' : ''} ${className ?? ''}`}
        placeholder={placeholder}
      />
      {error && <p className="text-sm text-destructive mt-1">{error.message}</p>}
      {hint && !error && <p className="text-sm text-muted-foreground mt-1">{hint}</p>}
    </div>
  );
}
