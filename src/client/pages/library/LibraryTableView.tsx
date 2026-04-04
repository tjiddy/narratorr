import { useNavigate } from 'react-router-dom';
import { formatBytes } from '@/lib/api';
import { formatDate } from '@/lib/format';
import { ArrowUpDownIcon } from '@/components/icons';
import type { DisplayBook, SortField, SortDirection } from './helpers.js';
import { computeMbPerHour } from './helpers.js';

function formatMbHr(book: DisplayBook): string {
  const val = computeMbPerHour(book);
  if (val === null) return '—';
  return `${Math.round(val)} MB/hr`;
}

function formatSize(book: DisplayBook): string {
  const size = book.audioTotalSize ?? book.size;
  if (!size) return '—';
  return formatBytes(size);
}

const statusStyles: Record<string, { text: string; bg: string }> = {
  wanted: { text: 'text-amber-500', bg: 'bg-amber-500/10' },
  searching: { text: 'text-blue-400', bg: 'bg-blue-400/10' },
  downloading: { text: 'text-blue-500', bg: 'bg-blue-500/10' },
  importing: { text: 'text-purple-400', bg: 'bg-purple-400/10' },
  imported: { text: 'text-success', bg: 'bg-success/10' },
  missing: { text: 'text-destructive', bg: 'bg-destructive/10' },
  failed: { text: 'text-destructive', bg: 'bg-destructive/10' },
};

type SortableColumn = { field: SortField; label: string; align?: 'right'; hidden?: string };

const columns: SortableColumn[] = [
  { field: 'title', label: 'Title' },
  { field: 'author', label: 'Author', hidden: 'hidden md:table-cell' },
  { field: 'narrator', label: 'Narrator', hidden: 'hidden lg:table-cell' },
  { field: 'series', label: 'Series', hidden: 'hidden lg:table-cell' },
  { field: 'createdAt', label: 'Date Added', align: 'right', hidden: 'hidden sm:table-cell' },
  { field: 'quality', label: 'Quality', align: 'right', hidden: 'hidden sm:table-cell' },
  { field: 'size', label: 'Size', align: 'right', hidden: 'hidden sm:table-cell' },
  { field: 'format', label: 'Format', hidden: 'hidden xl:table-cell' },
];

export function LibraryTableView({
  books,
  selectedIds,
  onSelectionChange,
  sortField,
  sortDirection,
  onSortFieldChange,
  onSortDirectionChange,
}: {
  books: DisplayBook[];
  selectedIds: Set<number>;
  onSelectionChange: (ids: Set<number>) => void;
  sortField: SortField;
  sortDirection: SortDirection;
  onSortFieldChange: (f: SortField) => void;
  onSortDirectionChange: (d: SortDirection) => void;
}) {
  const navigate = useNavigate();
  const allSelected = books.length > 0 && books.every((b) => selectedIds.has(b.id));
  const someSelected = books.some((b) => selectedIds.has(b.id)) && !allSelected;

  function toggleAll() {
    if (allSelected) {
      onSelectionChange(new Set());
    } else {
      onSelectionChange(new Set(books.map((b) => b.id)));
    }
  }

  function toggleOne(id: number) {
    const next = new Set(selectedIds);
    if (next.has(id)) {
      next.delete(id);
    } else {
      next.add(id);
    }
    onSelectionChange(next);
  }

  if (books.length === 0) return null;

  return (
    <div className="glass-card rounded-2xl overflow-hidden animate-fade-in">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border/50 text-left text-xs text-muted-foreground uppercase tracking-wider bg-muted/30 sticky top-0 z-10 backdrop-blur-sm">
              <th className="px-3 py-3 w-10">
                <input
                  type="checkbox"
                  checked={allSelected}
                  ref={(el) => { if (el) el.indeterminate = someSelected; }}
                  onChange={toggleAll}
                  className="rounded border-border text-primary focus:ring-primary"
                  aria-label="Select all books"
                />
              </th>
              <th className="px-3 py-3">Status</th>
              {columns.map((col) => {
                const isActive = sortField === col.field;
                return (
                  <th
                    key={col.field}
                    className={`px-3 py-3 ${col.align === 'right' ? 'text-right' : ''} ${col.hidden ?? ''}`}
                  >
                    <button
                      type="button"
                      onClick={() => {
                        if (isActive) {
                          onSortDirectionChange(sortDirection === 'asc' ? 'desc' : 'asc');
                        } else {
                          onSortFieldChange(col.field);
                        }
                      }}
                      className={`inline-flex items-center gap-1 hover:text-foreground transition-colors ${isActive ? 'text-foreground' : ''}`}
                      aria-label={`Sort by ${col.label}`}
                    >
                      {col.label}
                      {isActive && (
                        <ArrowUpDownIcon className={`w-3 h-3 transition-transform ${sortDirection === 'asc' ? 'rotate-180' : ''}`} />
                      )}
                    </button>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {books.map((book, i) => {
              const selected = selectedIds.has(book.id);
              const style = statusStyles[book.status];
              return (
                <tr
                  key={book.id}
                  className={`
                    border-b border-border/20 transition-colors cursor-pointer
                    ${selected ? 'bg-primary/8 hover:bg-primary/12' : 'hover:bg-muted/40'}
                  `}
                  style={{ animationDelay: `${i * 15}ms` }}
                  onClick={() => navigate(`/books/${book.id}`)}
                >
                  <td className="px-3 py-2.5" onClick={(e) => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      checked={selected}
                      onChange={() => toggleOne(book.id)}
                      className="rounded border-border text-primary focus:ring-primary"
                      aria-label={`Select ${book.title}`}
                    />
                  </td>
                  <td className="px-3 py-2.5">
                    <span className={`inline-flex items-center capitalize text-[11px] font-semibold px-2 py-0.5 rounded-md ${style?.text ?? ''} ${style?.bg ?? ''}`}>
                      {book.status}
                    </span>
                  </td>
                  <td className="px-3 py-2.5">
                    <span className="font-medium truncate block max-w-[240px]">
                      {book.title}
                    </span>
                    {book.collapsedCount !== undefined && book.collapsedCount > 0 && (
                      <span className="ml-1.5 inline-flex items-center justify-center px-1.5 py-0.5 rounded-full bg-primary/10 text-primary text-[10px] font-bold">
                        {book.collapsedCount + 1} books
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2.5 text-muted-foreground truncate max-w-[150px] hidden md:table-cell">{book.authors[0]?.name ?? '—'}</td>
                  <td className="px-3 py-2.5 text-muted-foreground truncate max-w-[150px] hidden lg:table-cell">{book.narrators[0]?.name ?? '—'}</td>
                  <td className="px-3 py-2.5 text-muted-foreground truncate max-w-[150px] hidden lg:table-cell">
                    {book.seriesName ? `${book.seriesName}${book.seriesPosition ? ` #${book.seriesPosition}` : ''}` : '—'}
                  </td>
                  <td className="px-3 py-2.5 text-right text-muted-foreground tabular-nums hidden sm:table-cell">{formatDate(book.createdAt)}</td>
                  <td className="px-3 py-2.5 text-right text-muted-foreground tabular-nums hidden sm:table-cell">{formatMbHr(book)}</td>
                  <td className="px-3 py-2.5 text-right text-muted-foreground tabular-nums hidden sm:table-cell">{formatSize(book)}</td>
                  <td className="px-3 py-2.5 text-muted-foreground uppercase text-[11px] tracking-wide hidden xl:table-cell">{book.audioFileFormat ?? '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
