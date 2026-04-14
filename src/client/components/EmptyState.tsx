import type { ElementType, ReactNode } from 'react';

interface EmptyStateProps {
  icon: ElementType;
  title: string;
  subtitle: string;
  children?: ReactNode;
  'data-testid'?: string;
}

export function EmptyState({ icon: Icon, title, subtitle, children, 'data-testid': testId }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center py-16 sm:py-24 animate-fade-in-up stagger-2" data-testid={testId}>
      <div className="relative mb-8">
        <div className="absolute inset-0 bg-primary/20 rounded-full blur-2xl" />
        <div className="relative p-6 bg-gradient-to-br from-primary/10 to-amber-500/10 rounded-full">
          <Icon className="w-16 h-16 text-primary" />
        </div>
      </div>
      <h3 className="font-display text-2xl sm:text-3xl font-semibold text-center mb-3">
        {title}
      </h3>
      <p className="text-muted-foreground text-center max-w-md mb-8">
        {subtitle}
      </p>
      {children}
    </div>
  );
}
