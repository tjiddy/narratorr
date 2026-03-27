import { useEffect, useRef } from 'react';
import {
  AlertTriangleIcon as AlertIcon,
  BookOpenIcon,
  ShieldIcon,
  GlobeIcon,
  ImportIcon,
  FolderInputIcon,
  SearchPlusIcon,
  ListIcon,
  CpuIcon,
  NetworkIcon,
  SparklesIcon,
} from '@/components/icons.js';
import { useFocusTrap } from '@/hooks/useFocusTrap.js';

interface InfoCardProps {
  icon: React.ReactNode;
  title: string;
  description: string;
  badge?: React.ReactNode;
}

function InfoCard({ icon, title, description, badge }: InfoCardProps) {
  return (
    <div className="relative flex flex-col gap-3 p-4 rounded-xl border border-border/50 bg-muted/30">
      {badge && (
        <div className="absolute -top-2 -right-2">
          {badge}
        </div>
      )}
      <div className="flex items-center gap-3">
        <div className="shrink-0 w-9 h-9 flex items-center justify-center rounded-lg bg-primary/10">
          {icon}
        </div>
        <h4 className="text-sm font-semibold leading-tight">{title}</h4>
      </div>
      <p className="text-xs text-muted-foreground leading-relaxed">{description}</p>
    </div>
  );
}

function WarningBadge() {
  return (
    <span
      className="flex items-center justify-center w-5 h-5 rounded-full bg-destructive text-destructive-foreground text-[10px] font-bold shadow-sm"
      aria-label="Important"
    >
      !
    </span>
  );
}

export function WelcomeModal({ isOpen, isPending = false, onDismiss }: WelcomeModalProps) {
  const modalRef = useRef<HTMLDivElement>(null);

  // Scroll lock: prevent background page from scrolling behind the modal
  useEffect(() => {
    if (!isOpen) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, [isOpen]);

  // Focus trap: keep keyboard focus inside the modal; no escape-to-dismiss
  // (onboarding requires explicit "Get Started" action)
  useFocusTrap(isOpen, modalRef);

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center p-4 sm:p-6 overflow-y-auto animate-fade-in"
      role="presentation"
    >
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />

      {/* Modal */}
      <div
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="welcome-modal-title"
        className="relative w-full max-w-4xl my-auto glass-card rounded-2xl p-6 sm:p-8 shadow-2xl animate-fade-in-up"
        tabIndex={-1}
      >
        {/* Header */}
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-gradient-to-br from-primary to-amber-500 mb-4 shadow-glow">
            <BookOpenIcon className="w-7 h-7 text-primary-foreground" />
          </div>
          <h2 id="welcome-modal-title" className="font-display text-2xl sm:text-3xl font-semibold mb-2">
            Welcome to narratorr
          </h2>
          <p className="text-muted-foreground text-sm sm:text-base max-w-lg mx-auto">
            Your self-hosted audiobook manager. Here's what to know before you dive in.
          </p>
        </div>

        {/* Row 1 — Read This */}
        <section className="mb-6">
          <h3 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground mb-3">
            Read This First
          </h3>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <InfoCard
              icon={<ShieldIcon className="w-5 h-5 text-primary" />}
              title="Authentication is off"
              description="Auth is disabled by default. Enable it in Settings → Security to protect your instance."
              badge={<WarningBadge />}
            />
            <InfoCard
              icon={<GlobeIcon className="w-5 h-5 text-primary" />}
              title="Audible region: US"
              description="Metadata searches default to the US Audible store. Change it in Settings → Metadata for your region."
              badge={<WarningBadge />}
            />
            <InfoCard
              icon={<AlertIcon className="w-5 h-5 text-primary" />}
              title="Library path: /audiobooks"
              description="Files are stored at /audiobooks. If your Docker mount differs, update it in Settings → Library."
              badge={<WarningBadge />}
            />
          </div>
        </section>

        {/* Row 2 — First Steps */}
        <section className="mb-6">
          <h3 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground mb-3">
            First Steps
          </h3>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <InfoCard
              icon={<ImportIcon className="w-5 h-5 text-primary" />}
              title="Library Import"
              description="Already have audiobooks? Scan your existing folders to add them to your library."
            />
            <InfoCard
              icon={<FolderInputIcon className="w-5 h-5 text-primary" />}
              title="Manual Import"
              description="Import from a specific folder — useful for one-off additions outside your library path."
            />
            <InfoCard
              icon={<SearchPlusIcon className="w-5 h-5 text-primary" />}
              title="Add a Book"
              description="Search for a book and send it to your download client directly from narratorr."
            />
          </div>
        </section>

        {/* Row 3–4 — Feature Highlights */}
        <section className="mb-8">
          <h3 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground mb-3">
            Features Worth Knowing
          </h3>
          <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
            <InfoCard
              icon={<ListIcon className="w-5 h-5 text-primary" />}
              title="List Importing"
              description="Bulk-import books from lists — monitor a whole reading list automatically."
            />
            <InfoCard
              icon={<CpuIcon className="w-5 h-5 text-primary" />}
              title="Post Processing"
              description="Auto-convert to M4B with ffmpeg after import. Chapters, cover art, and more."
            />
            <InfoCard
              icon={<NetworkIcon className="w-5 h-5 text-primary" />}
              title="Prowlarr Support"
              description="Connect Prowlarr to manage all your indexers from one place."
            />
            <InfoCard
              icon={<SparklesIcon className="w-5 h-5 text-primary" />}
              title="Recommendations"
              description="Personalised suggestions based on your library — discover what to read next."
            />
          </div>
        </section>

        {/* Footer */}
        <div className="flex flex-col items-center gap-3">
          <button
            type="button"
            onClick={onDismiss}
            disabled={isPending}
            className="px-8 py-3 bg-primary text-primary-foreground font-semibold rounded-xl hover:opacity-90 disabled:opacity-50 transition-all text-sm shadow-glow focus-ring"
          >
            {isPending ? 'Saving...' : 'Get Started'}
          </button>
          <p className="text-xs text-muted-foreground">
            You can view this again anytime in Settings
          </p>
        </div>
      </div>
    </div>
  );
}
