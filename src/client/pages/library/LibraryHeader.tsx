import { type ReactNode } from 'react';
import { PageHeader } from '@/components/PageHeader.js';

export function LibraryHeader({ subtitle, actions }: { subtitle?: string; actions?: ReactNode }) {
  return (
    <div className="flex items-start justify-between">
      <PageHeader title="Library" subtitle={subtitle ?? 'Your audiobook collection'} />
      {actions}
    </div>
  );
}
