import DOMPurify from 'dompurify';

export function BookDescription({ description }: { description: string }) {
  return (
    <div>
      <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground mb-3">
        About This Book
      </h2>
      <div className="glass-card rounded-2xl p-6">
        <div
          className="prose prose-sm dark:prose-invert max-w-none"
          dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(description) }}
        />
      </div>
    </div>
  );
}
