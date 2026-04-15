export interface PageHeaderProps {
  title: string;
  subtitle?: string;
}

export function PageHeader({ title, subtitle }: PageHeaderProps) {
  return (
    <div className="animate-fade-in-up">
      <h1 className="font-display text-3xl sm:text-4xl font-bold tracking-tight">
        {title}
      </h1>
      {subtitle && (
        <p className="text-muted-foreground mt-1">{subtitle}</p>
      )}
    </div>
  );
}
