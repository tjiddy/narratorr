import type { Ref } from 'react';

type ToggleSwitchSize = 'full' | 'compact';

interface ToggleSwitchProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'size'> {
  size?: ToggleSwitchSize;
  ref?: Ref<HTMLInputElement>;
}

const sizeStyles = {
  full: {
    track: 'w-11 h-6',
    thumb: 'after:h-5 after:w-5 peer-checked:after:translate-x-full',
  },
  compact: {
    track: 'w-9 h-5',
    thumb: 'after:h-4 after:w-4 peer-checked:after:translate-x-4',
  },
} as const;

/**
 * The visible track is a plain <div>; only this wrapping <label> forwards clicks on it to the
 * sr-only checkbox. The component owns that label so a bare `<ToggleSwitch />` is always clickable
 * — call sites must NOT add their own wrapping <label> (nested labels are invalid HTML). A
 * separate text label may still target the input via htmlFor/id.
 */
export function ToggleSwitch({ size = 'full', className, disabled, ref, ...inputProps }: ToggleSwitchProps) {
  const s = sizeStyles[size];

  return (
    <label className={`inline-flex items-center ${disabled ? 'cursor-not-allowed' : 'cursor-pointer'}`}>
      <input
        type="checkbox"
        ref={ref}
        disabled={disabled}
        className={`sr-only peer${className ? ` ${className}` : ''}`}
        {...inputProps}
      />
      <div
        className={`${s.track} relative bg-muted rounded-full peer peer-checked:bg-primary transition-colors duration-200 peer-focus-visible:ring-2 peer-focus-visible:ring-primary after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full ${s.thumb} after:transition-transform after:duration-200 after:ease-out${disabled ? ' opacity-50' : ''}`}
      />
    </label>
  );
}
