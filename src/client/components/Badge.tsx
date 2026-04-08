import type { ReactNode, ElementType } from 'react';

export type BadgeVariant = 'success' | 'warning' | 'danger' | 'info' | 'muted';

const variantClasses: Record<BadgeVariant, string> = {
  success: 'bg-emerald-500/15 text-emerald-400 ring-1 ring-emerald-500/20',
  warning: 'bg-amber-500/15 text-amber-400 ring-1 ring-amber-500/20',
  danger: 'bg-red-500/15 text-red-400 ring-1 ring-red-500/20',
  info: 'bg-blue-500/15 text-blue-400 ring-1 ring-blue-500/20',
  muted: 'bg-muted/50 text-muted-foreground ring-1 ring-border/20',
};

interface BadgeProps {
  variant: BadgeVariant;
  icon?: ElementType;
  className?: string;
  title?: string;
  children: ReactNode;
}

export function Badge({ variant, icon: Icon, className, title, children }: BadgeProps) {
  return (
    <span
      data-testid="badge"
      title={title}
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium ${variantClasses[variant]}${className ? ` ${className}` : ''}`}
    >
      {Icon && <Icon className="w-3 h-3" />}
      {children}
    </span>
  );
}
