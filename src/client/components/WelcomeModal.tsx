import { useEffect, useRef } from 'react';
import { useFocusTrap } from '@/hooks/useFocusTrap.js';

interface WelcomeModalProps {
  isOpen: boolean;
  isPending?: boolean;
  onDismiss: () => void;
}

function AlertIcon({ className = '' }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />
      <path d="M12 9v4" />
      <path d="M12 17h.01" />
    </svg>
  );
}

function BookOpenIcon({ className = '' }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" />
      <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" />
    </svg>
  );
}

function ShieldIcon({ className = '' }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />
    </svg>
  );
}

function GlobeIcon({ className = '' }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <circle cx="12" cy="12" r="10" />
      <path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20" />
      <path d="M2 12h20" />
    </svg>
  );
}

function ImportIcon({ className = '' }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d="M12 3v12" />
      <path d="m8 11 4 4 4-4" />
      <path d="M8 5H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-4" />
    </svg>
  );
}

function FolderInputIcon({ className = '' }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d="M2 9V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H20a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-1" />
      <path d="M2 13h10" />
      <path d="m9 16 3-3-3-3" />
    </svg>
  );
}

function SearchPlusIcon({ className = '' }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <circle cx="11" cy="11" r="8" />
      <path d="m21 21-4.3-4.3" />
      <path d="M11 8v6" />
      <path d="M8 11h6" />
    </svg>
  );
}

function ListIcon({ className = '' }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <line x1="8" x2="21" y1="6" y2="6" />
      <line x1="8" x2="21" y1="12" y2="12" />
      <line x1="8" x2="21" y1="18" y2="18" />
      <line x1="3" x2="3.01" y1="6" y2="6" />
      <line x1="3" x2="3.01" y1="12" y2="12" />
      <line x1="3" x2="3.01" y1="18" y2="18" />
    </svg>
  );
}

function CpuIcon({ className = '' }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <rect width="16" height="16" x="4" y="4" rx="2" />
      <rect width="6" height="6" x="9" y="9" rx="1" />
      <path d="M15 2v2" /><path d="M15 20v2" /><path d="M2 15h2" /><path d="M2 9h2" />
      <path d="M20 15h2" /><path d="M20 9h2" /><path d="M9 2v2" /><path d="M9 20v2" />
    </svg>
  );
}

function NetworkIcon({ className = '' }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <rect x="16" y="16" width="6" height="6" rx="1" />
      <rect x="2" y="16" width="6" height="6" rx="1" />
      <rect x="9" y="2" width="6" height="6" rx="1" />
      <path d="M5 16v-3a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v3" />
      <path d="M12 12V8" />
    </svg>
  );
}

function SparklesIcon({ className = '' }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z" />
      <path d="M5 3v4" /><path d="M19 17v4" /><path d="M3 5h4" /><path d="M17 19h4" />
    </svg>
  );
}

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
