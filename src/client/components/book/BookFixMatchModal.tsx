import { useState, useRef } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { BookWithAuthor, BookMetadata } from '@/lib/api';
import { api, ApiError, type FixMatchPayload } from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';
import { useEscapeKey } from '@/hooks/useEscapeKey';
import { useAudnexusSearch } from '@/hooks/useAudnexusSearch';
import { getErrorMessage } from '@/lib/error-message.js';
import { XIcon, ArrowLeftIcon, BookOpenIcon } from '@/components/icons';
import { Modal } from '@/components/Modal';
import { MetadataSearchView } from '@/components/book/MetadataSearchView';
import { resolveCoverUrl } from '@/lib/url-utils';

type Step = 'search' | 'confirm';

interface BookFixMatchModalProps {
  book: BookWithAuthor;
  onClose: () => void;
  isOpen?: boolean;
}

function formatSeriesLabel(meta: BookMetadata | BookWithAuthor): string {
  const m = meta as { seriesName?: string | null; seriesPosition?: number | null; seriesPrimary?: { name?: string; position?: number | undefined }; series?: Array<{ name?: string; position?: number | undefined }> };
  const primary = m.seriesPrimary ?? m.series?.[0];
  if (primary?.name) {
    const pos = primary.position;
    return pos !== undefined && pos !== null ? `${primary.name} #${pos}` : primary.name;
  }
  if (m.seriesName) {
    const pos = m.seriesPosition;
    return pos !== undefined && pos !== null ? `${m.seriesName} #${pos}` : m.seriesName;
  }
  return 'Standalone';
}

function formatAuthor(meta: BookMetadata | BookWithAuthor): string {
  if ('authors' in meta && Array.isArray(meta.authors)) {
    return meta.authors.map((a) => a.name).join(', ') || '—';
  }
  return '—';
}

function formatNarrator(meta: BookMetadata | BookWithAuthor): string {
  if ('narrators' in meta) {
    if (Array.isArray(meta.narrators)) {
      const names = meta.narrators.map((n) => typeof n === 'string' ? n : n.name);
      return names.join(', ') || '—';
    }
  }
  return '—';
}

function formatYear(meta: BookMetadata | BookWithAuthor): string {
  const date = meta.publishedDate;
  if (typeof date !== 'string') return '—';
  const yearMatch = date.match(/\d{4}/);
  return yearMatch ? yearMatch[0] : '—';
}

function IdentityComparisonRow({ label, oldValue, newValue }: { label: string; oldValue: string; newValue: string }) {
  const changed = oldValue !== newValue;
  return (
    <div className="grid grid-cols-[100px_1fr_1fr] gap-3 text-xs items-baseline">
      <div className="text-muted-foreground/70 font-medium">{label}</div>
      <div className="text-muted-foreground line-through">{oldValue}</div>
      <div className={changed ? 'text-primary font-medium' : 'text-foreground'}>{newValue}</div>
    </div>
  );
}

export function BookFixMatchModal({ book, onClose, isOpen = true }: BookFixMatchModalProps) {
  const modalRef = useRef<HTMLDivElement>(null);
  const queryClient = useQueryClient();
  const [step, setStep] = useState<Step>('search');
  const [selected, setSelected] = useState<BookMetadata | null>(null);
  const [renameFiles, setRenameFiles] = useState(false);
  const [retagFiles, setRetagFiles] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const prefill = [book.title, book.authors[0]?.name ?? ''].filter(Boolean).join(' ').trim();
  const [searchQuery, setSearchQuery] = useState(prefill);
  const { searchResults, hasSearched, searchError, isPending, search } = useAudnexusSearch();

  useEscapeKey(isOpen, onClose, modalRef);

  const fixMatch = useMutation({
    mutationFn: (payload: FixMatchPayload) => api.fixMatchBook(book.id, payload),
    onSuccess: (_data) => {
      const oldAsin = book.asin ?? null;
      const newAsin = selected?.asin ?? null;
      queryClient.invalidateQueries({ queryKey: queryKeys.book(book.id) });
      queryClient.invalidateQueries({ queryKey: queryKeys.books() });
      if (oldAsin) queryClient.invalidateQueries({ queryKey: queryKeys.metadata.book(oldAsin) });
      if (newAsin) queryClient.invalidateQueries({ queryKey: queryKeys.metadata.book(newAsin) });
      queryClient.invalidateQueries({ queryKey: ['book', book.id, 'series'] });
      toast.success('Match replaced');
      onClose();
    },
    onError: (error: unknown) => {
      if (error instanceof ApiError) {
        const body = error.body as { error?: string; retryAfterMs?: number; conflictBookId?: number; conflictTitle?: string } | null;
        if (error.status === 409 && body?.conflictTitle) {
          setErrorMessage(`ASIN already used by "${body.conflictTitle}".`);
          return;
        }
        if (error.status === 503 && body?.retryAfterMs !== undefined) {
          const seconds = Math.ceil((body.retryAfterMs ?? 0) / 1000);
          setErrorMessage(`Provider rate limited — try again in ${seconds}s.`);
          return;
        }
        setErrorMessage(body?.error ?? `Fix Match failed (HTTP ${error.status})`);
        return;
      }
      setErrorMessage(`Fix Match failed: ${getErrorMessage(error)}`);
    },
  });

  if (!isOpen) return null;

  const handleSelect = (meta: BookMetadata) => {
    setSelected(meta);
    setStep('confirm');
    setErrorMessage(null);
  };

  const handleBack = () => {
    setStep('search');
    setErrorMessage(null);
  };

  const handleConfirm = () => {
    if (!selected?.asin) {
      setErrorMessage('Selected record has no ASIN.');
      return;
    }
    setErrorMessage(null);
    const payload: FixMatchPayload = { asin: selected.asin };
    if (renameFiles) payload.renameFiles = true;
    if (retagFiles) payload.retagFiles = true;
    fixMatch.mutate(payload);
  };

  return (
    <Modal onClose={onClose} closeOnBackdropClick={false} className="w-full max-w-2xl flex flex-col max-h-[85vh]">
      <div
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="book-fix-match-modal-title"
        tabIndex={-1}
      >
        <div className="px-6 pt-5 pb-4 flex items-center justify-between shrink-0">
          <div className="flex items-center gap-3">
            {step === 'confirm' && (
              <button
                type="button"
                onClick={handleBack}
                className="p-1.5 text-muted-foreground hover:text-foreground rounded-lg transition-colors focus-ring"
                aria-label="Back to search"
              >
                <ArrowLeftIcon className="w-4 h-4" />
              </button>
            )}
            <h2 id="book-fix-match-modal-title" className="font-display text-lg font-semibold tracking-tight">
              {step === 'search' ? 'Fix Match' : 'Confirm match'}
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 text-muted-foreground hover:text-foreground rounded-lg transition-colors focus-ring"
            aria-label="Close"
          >
            <XIcon className="w-4 h-4" />
          </button>
        </div>
        <div className="border-t border-white/5" />

        {step === 'search' ? (
          <MetadataSearchView
            searchQuery={searchQuery}
            onSearchQueryChange={setSearchQuery}
            isPending={isPending}
            searchResults={searchResults}
            hasSearched={hasSearched}
            searchError={searchError}
            onSearch={() => search(searchQuery)}
            onApplyMetadata={handleSelect}
          />
        ) : selected ? (
          <div className="p-6 space-y-4 overflow-y-auto">
            <div className="flex gap-4">
              <div className="shrink-0 w-24 h-24 rounded-xl overflow-hidden bg-muted flex items-center justify-center ring-1 ring-white/[0.08]">
                {selected.coverUrl ? (
                  <img src={resolveCoverUrl(selected.coverUrl, undefined)} alt={`Cover of ${selected.title}`} className="w-full h-full object-cover" />
                ) : (
                  <BookOpenIcon className="w-10 h-10 text-muted-foreground/30" />
                )}
              </div>
              <div className="flex-1 min-w-0">
                <p className="font-display font-semibold text-base truncate">{selected.title}</p>
                {selected.subtitle && (
                  <p className="text-xs text-muted-foreground italic truncate">{selected.subtitle}</p>
                )}
                <p className="text-xs text-muted-foreground mt-1">{formatAuthor(selected)}</p>
              </div>
            </div>

            <div className="space-y-2 glass-card rounded-xl p-3">
              <IdentityComparisonRow label="Title" oldValue={book.title} newValue={selected.title} />
              <IdentityComparisonRow label="Author" oldValue={formatAuthor(book)} newValue={formatAuthor(selected)} />
              <IdentityComparisonRow label="Narrator" oldValue={formatNarrator(book)} newValue={formatNarrator(selected)} />
              <IdentityComparisonRow label="Series" oldValue={formatSeriesLabel(book)} newValue={formatSeriesLabel(selected)} />
              <IdentityComparisonRow label="Year" oldValue={formatYear(book)} newValue={formatYear(selected)} />
            </div>

            {book.path && (
              <div className="space-y-2">
                <label className="flex items-center gap-2 text-xs text-muted-foreground">
                  <input type="checkbox" checked={renameFiles} onChange={(e) => setRenameFiles(e.target.checked)} className="rounded" />
                  Rename files after rematch
                </label>
                <label className="flex items-center gap-2 text-xs text-muted-foreground">
                  <input type="checkbox" checked={retagFiles} onChange={(e) => setRetagFiles(e.target.checked)} className="rounded" />
                  Re-tag audio files after rematch
                </label>
              </div>
            )}

            {errorMessage && (
              <div role="alert" className="text-xs text-red-400 bg-destructive/10 rounded-lg px-3 py-2">
                {errorMessage}
              </div>
            )}

            <div className="flex justify-end gap-3 pt-2">
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 text-sm font-medium glass-card rounded-xl hover:border-primary/30 transition-all focus-ring"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleConfirm}
                disabled={fixMatch.isPending}
                className="px-5 py-2 text-sm font-medium bg-primary text-primary-foreground rounded-xl hover:opacity-90 transition-all disabled:opacity-40 disabled:cursor-not-allowed focus-ring"
              >
                {fixMatch.isPending ? 'Replacing...' : 'Replace match'}
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </Modal>
  );
}
