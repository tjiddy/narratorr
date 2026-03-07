interface EmptyStateProps {
  icon: React.ReactNode;
  title: string;
  description: string;
  action?: React.ReactNode;
}

export function EmptyState({ icon, title, description, action }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center py-16 sm:py-24 animate-fade-in-up stagger-2">
      <div className="text-muted-foreground/40 mb-6">{icon}</div>
      <h3 className="font-display text-xl sm:text-2xl font-semibold text-center mb-2">
        {title}
      </h3>
      <p className="text-muted-foreground text-center max-w-md">{description}</p>
      {action && <div className="mt-6">{action}</div>}
    </div>
  );
}
