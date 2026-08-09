import type { ReactNode } from 'react';

/** Row right-aligns compact controls; stacked puts wide controls below the header. */
export interface SettingsRowProps {
  label: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  htmlFor?: string;
  muted?: boolean;
  layout?: 'row' | 'stacked';
}

export function SettingsRow({ label, description, children, htmlFor, muted, layout = 'row' }: SettingsRowProps) {
  // Without htmlFor there is no single control, so use a span instead of an unbound label.
  const header = (
    <div className={`min-w-0 ${muted ? 'opacity-50' : ''}`}>
      {htmlFor ? (
        <label htmlFor={htmlFor} className="block text-sm font-semibold">{label}</label>
      ) : (
        <span className="block text-sm font-semibold">{label}</span>
      )}
      {description && <p className="text-sm text-muted-foreground mt-0.5">{description}</p>}
    </div>
  );

  if (layout === 'stacked') {
    return (
      <div className="px-4 py-4">
        {header}
        {children && <div className="mt-3">{children}</div>}
      </div>
    );
  }

  return (
    <div className="flex items-start justify-between gap-6 px-4 py-4">
      {header}
      {children && <div className="flex items-center gap-2 shrink-0 pt-0.5">{children}</div>}
    </div>
  );
}

/** Do not add overflow-hidden: it clips row popovers, and the container background needs no clipping. */
export function SettingsTable({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-xl border border-border bg-card/40 divide-y divide-border">
      {children}
    </div>
  );
}
