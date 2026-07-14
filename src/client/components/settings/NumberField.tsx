import type { Ref } from 'react';
import { errorInputClass } from './formStyles';

interface NumberFieldProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type'> {
  /** Unit shown beside the input (e.g. "kbps", "minutes"). */
  suffix?: string;
  /** Validation message: presence turns the border destructive and renders the text below. */
  error?: string | undefined;
  ref?: Ref<HTMLInputElement>;
}

/**
 * The row-table number input: a compact input + optional unit suffix + error slot, right-alignable
 * inside a `SettingsRow`. The width lives on the WRAPPER div, not the input — `errorInputClass`
 * hardcodes `w-full`, which beats any width utility layered onto the input itself (equal
 * specificity, later in the compiled stylesheet), so `w-24` on the input is dead code. Same
 * mechanism as the select idiom's width wrapper. Never put width classes on the input.
 */
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
