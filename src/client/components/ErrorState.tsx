import type { ElementType } from 'react';
import { AlertCircleIcon, RefreshIcon } from '@/components/icons';

export interface ErrorStateProps {
  title: string;
  description: string;
  icon?: ElementType;
  onRetry?: () => void;
  'data-testid'?: string;
}

export function ErrorState({ title, description, icon: Icon = AlertCircleIcon, onRetry, 'data-testid': testId }: ErrorStateProps) {
  return (
    <div className="flex flex-col items-center justify-center py-16 sm:py-24 text-center animate-fade-in-up" data-testid={testId}>
      <div className="relative mb-8">
        <div className="absolute inset-0 bg-destructive/20 rounded-full blur-2xl" />
        <div className="relative p-6 bg-gradient-to-br from-destructive/10 to-red-500/10 rounded-full">
          <Icon className="w-16 h-16 text-destructive" />
        </div>
      </div>
      <h3 className="font-display text-2xl sm:text-3xl font-semibold mb-3">{title}</h3>
      <p className="text-muted-foreground max-w-md">{description}</p>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="mt-6 inline-flex items-center gap-2 px-5 py-2.5 text-sm font-medium glass-card rounded-xl hover:border-primary/30 hover:text-primary transition-all focus-ring"
        >
          <RefreshIcon className="w-4 h-4" />
          Retry
        </button>
      )}
    </div>
  );
}
