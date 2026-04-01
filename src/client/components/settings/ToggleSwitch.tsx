import { forwardRef } from 'react';

type ToggleSwitchSize = 'full' | 'compact';

interface ToggleSwitchProps extends React.InputHTMLAttributes<HTMLInputElement> {
  size?: ToggleSwitchSize;
}

const sizeStyles = {
  full: {
    track: 'w-11 h-6',
    thumb: 'after:h-5 after:w-5 peer-checked:after:translate-x-full',
  },
  compact: {
    track: 'w-9 h-5',
    thumb: 'after:h-4 after:w-4 peer-checked:after:translate-x-4 relative',
  },
} as const;

export const ToggleSwitch = forwardRef<HTMLInputElement, ToggleSwitchProps>(
  function ToggleSwitch({ size = 'full', className, disabled, ...inputProps }, ref) {
    const s = sizeStyles[size];

    return (
      <>
        <input
          type="checkbox"
          ref={ref}
          disabled={disabled}
          className={`sr-only peer${className ? ` ${className}` : ''}`}
          {...inputProps}
        />
        <div
          className={`${s.track} bg-muted rounded-full peer peer-checked:bg-primary transition-colors peer-focus-visible:ring-2 peer-focus-visible:ring-primary after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full ${s.thumb} after:transition-all${disabled ? ' opacity-50 cursor-not-allowed' : ''}`}
        />
      </>
    );
  }
);
