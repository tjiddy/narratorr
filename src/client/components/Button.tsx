import type { ButtonHTMLAttributes, ElementType, ReactNode } from 'react';
import { LoadingSpinner } from '@/components/icons';

export type ButtonVariant = 'primary' | 'secondary' | 'destructive' | 'success' | 'ghost' | 'glass';
export type ButtonSize = 'sm' | 'md';

const variantClasses: Record<ButtonVariant, string> = {
  primary: 'bg-primary text-primary-foreground hover:opacity-90',
  secondary: 'border border-border hover:bg-muted',
  destructive: 'bg-destructive text-destructive-foreground hover:opacity-90',
  success: 'bg-success text-success-foreground hover:opacity-90',
  ghost: 'hover:bg-muted',
  glass: 'glass-card hover:opacity-90',
};

const sizeClasses: Record<ButtonSize, string> = {
  sm: 'px-3 py-2 text-sm',
  md: 'px-4 py-3',
};

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant: ButtonVariant;
  size?: ButtonSize;
  icon?: ElementType;
  loading?: boolean;
  children?: ReactNode;
}

export function Button({
  variant,
  size = 'md',
  icon: Icon,
  loading = false,
  disabled,
  className,
  type = 'button',
  children,
  ...rest
}: ButtonProps) {
  const isDisabled = disabled || loading;

  return (
    <button
      type={type}
      disabled={isDisabled}
      className={`inline-flex items-center gap-1.5 font-medium rounded-xl transition-all focus-ring disabled:opacity-50 disabled:cursor-not-allowed ${sizeClasses[size]} ${variantClasses[variant]}${className ? ` ${className}` : ''}`}
      {...rest}
    >
      {loading ? (
        <LoadingSpinner className="w-4 h-4" />
      ) : (
        Icon && <Icon className="w-4 h-4" />
      )}
      {children}
    </button>
  );
}
