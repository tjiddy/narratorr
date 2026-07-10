import type { ReactNode } from 'react';

/**
 * A single settings row: label + optional description on the left, the control on the
 * right. Rows are meant to sit inside a `SettingsTable` (which supplies the border +
 * hairline dividers). The row-table content pattern for the settings redesign — reused
 * by Audio Tools, Post Processing, and (rolling out) other simple key/value sections.
 */
export interface SettingsRowProps {
  label: ReactNode;
  description?: ReactNode;
  /** Control(s) rendered right-aligned. */
  children?: ReactNode;
  htmlFor?: string;
  /** Dim the label/description (e.g. an ffmpeg-gated automation that's unavailable). */
  muted?: boolean;
}

export function SettingsRow({ label, description, children, htmlFor, muted }: SettingsRowProps) {
  return (
    <div className="flex items-start justify-between gap-6 px-4 py-4">
      <div className={`min-w-0 ${muted ? 'opacity-50' : ''}`}>
        <label htmlFor={htmlFor} className="block text-sm font-semibold">{label}</label>
        {description && <p className="text-sm text-muted-foreground mt-0.5">{description}</p>}
      </div>
      {children && <div className="flex items-center gap-2 shrink-0 pt-0.5">{children}</div>}
    </div>
  );
}

/** Bordered container that turns a stack of `SettingsRow`s into the row-table look. */
export function SettingsTable({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-xl border border-border overflow-hidden bg-card/40 divide-y divide-border">
      {children}
    </div>
  );
}
