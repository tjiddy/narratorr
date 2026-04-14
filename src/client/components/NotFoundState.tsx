import type { ElementType } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeftIcon } from '@/components/icons';

interface NotFoundStateProps {
  icon: ElementType;
  title: string;
  subtitle: string;
  backTo: string;
  backLabel: string;
}

export function NotFoundState({ icon: Icon, title, subtitle, backTo, backLabel }: NotFoundStateProps) {
  return (
    <div className="flex flex-col items-center justify-center py-24 animate-fade-in-up">
      <div className="relative mb-8">
        <div className="absolute inset-0 bg-primary/20 rounded-full blur-2xl" />
        <div className="relative p-6 bg-gradient-to-br from-primary/10 to-amber-500/10 rounded-full">
          <Icon className="w-16 h-16 text-muted-foreground/50" />
        </div>
      </div>
      <h2 className="font-display text-2xl font-semibold mb-2">{title}</h2>
      <p className="text-muted-foreground mb-6">{subtitle}</p>
      <Link
        to={backTo}
        className="inline-flex items-center gap-2 px-5 py-2.5 text-sm font-medium glass-card rounded-xl hover:border-primary/30 hover:text-primary transition-all focus-ring"
      >
        <ArrowLeftIcon className="w-4 h-4" />
        {backLabel}
      </Link>
    </div>
  );
}
