import type { ReactNode } from 'react';

/**
 * A single settings row: label + optional description, plus the control. Rows are meant to sit
 * inside a `SettingsTable` (which supplies the border + hairline dividers). The row-table content
 * pattern for the settings redesign — reused by Audio Tools, Post Processing, and (rolling out)
 * other simple key/value sections.
 *
 * Layouts: `row` (default) puts the control right-aligned beside the label — for short controls
 * (toggle, select, number). `stacked` puts the control full-width below the label — for wide
 * content (long text inputs, checkbox grids, input+button clusters).
 */
export interface SettingsRowProps {
  label: ReactNode;
  description?: ReactNode;
  /** Control(s): right-aligned in `row`, full-width below the header in `stacked`. */
  children?: ReactNode;
  htmlFor?: string;
  /** Dim the label/description (e.g. an ffmpeg-gated automation that's unavailable). */
  muted?: boolean;
  layout?: 'row' | 'stacked';
}

export function SettingsRow({ label, description, children, htmlFor, muted, layout = 'row' }: SettingsRowProps) {
  // Group content (a checkbox grid, a multi-control cluster) has no single control to point a
  // label at — an htmlFor-less <label> would be associated with nothing, so render a <span>.
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

/**
 * Bordered container that turns a stack of `SettingsRow`s into the row-table look.
 * Deliberately NOT overflow-hidden: rows carry no background (the container paints bg-card/40
 * itself, so the rounded corners need no clipping), and clipping would decapitate absolutely-
 * positioned popovers escaping a row (an InfoTip in a top row opens upward past the table edge).
 * If a row ever gains its own background, round/clip that row — don't re-add overflow here.
 */
export function SettingsTable({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-xl border border-border bg-card/40 divide-y divide-border">
      {children}
    </div>
  );
}
