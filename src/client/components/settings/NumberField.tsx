import type { Ref } from 'react';
import { errorInputClass } from './formStyles';

interface NumberFieldProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type'> {
  suffix?: string;
  error?: string | undefined;
  ref?: Ref<HTMLInputElement>;
}

/** Keep width on the wrapper: errorInputClass's later w-full overrides input width utilities. */
export function NumberField({ suffix, error, className, ref, ...inputProps }: NumberFieldProps) {
  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center gap-2">
        <div className="w-24">
          <input
            type="number"
            ref={ref}
            className={`text-center ${errorInputClass(!!error)} disabled:cursor-not-allowed disabled:opacity-50${className ? ` ${className}` : ''}`}
            {...inputProps}
          />
        </div>
        {suffix && <span className="text-sm text-muted-foreground">{suffix}</span>}
      </div>
      {error && <span className="text-xs text-destructive text-right">{error}</span>}
    </div>
  );
}
