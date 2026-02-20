import { useState } from 'react';
import DOMPurify from 'dompurify';

const DESCRIPTION_COLLAPSE_LENGTH = 300;

export function BookDescription({ description }: { description: string }) {
  const [expanded, setExpanded] = useState(false);
  const isLong = description.length > DESCRIPTION_COLLAPSE_LENGTH;

  return (
    <div className="animate-fade-in-up stagger-5">
      <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground mb-3">
        About This Book
      </h2>
      <div className="glass-card rounded-2xl p-6">
        <div
          className={`prose prose-sm dark:prose-invert max-w-none ${!expanded && isLong ? 'line-clamp-4' : ''}`}
          dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(description) }}
        />
        {isLong && (
          <button
            onClick={() => setExpanded(!expanded)}
            className="text-primary text-sm font-medium hover:underline mt-2 focus-ring rounded"
          >
            {expanded ? 'Show less' : 'Show more'}
          </button>
        )}
      </div>
    </div>
  );
}
