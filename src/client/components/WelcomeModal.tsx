import { useEffect, useRef } from 'react';
import {
  AlertTriangleIcon as AlertIcon,
  HeadphonesIcon,
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
import { Modal } from '@/components/Modal';

interface WelcomeModalProps {
  isOpen: boolean;
  isPending?: boolean;
  onDismiss: () => void;
}

interface InfoCardProps {
  icon: React.ReactNode;
  title: string;
  description: React.ReactNode;
  href: string;
  badge?: React.ReactNode;
}

function InfoCard({ icon, title, description, href, badge }: InfoCardProps) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="relative flex flex-col gap-3 p-4 rounded-xl border border-border/50 bg-muted/30 cursor-pointer hover:bg-white/5 transition-colors"
    >
      {badge && (
        <div className="absolute -top-2 -right-2">
          {badge}
        </div>
      )}
      <div className="flex items-center gap-3">
        <div className="shrink-0 w-9 h-9 flex items-center justify-center rounded-lg bg-primary/10">
          {icon}
        </div>
        <h4 className="text-sm font-semibold leading-tight whitespace-pre-line">{title}</h4>
      </div>
      <p className="text-xs text-muted-foreground leading-relaxed">{description}</p>
    </a>
  );
}

function FeaturesSection() {
  return (
    <section className="mb-8 [@media(max-height:60rem)]:hidden">
      <h3 className="font-display text-xs font-semibold uppercase tracking-widest text-muted-foreground mb-3">
        Features Worth Knowing
      </h3>
      <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
        <InfoCard href="https://docs.narratorr.dev/guides/import-lists/" icon={<ListIcon className="w-5 h-5 text-primary" />} title="List Importing" description="Bulk-import books from lists and monitor them automatically." />
        <InfoCard href="https://docs.narratorr.dev/guides/audio-processing/" icon={<CpuIcon className="w-5 h-5 text-primary" />} title="Post Processing" description="Auto-convert to M4B after import. Chapters, cover art, and more." />
        <InfoCard href="https://docs.narratorr.dev/configuration/indexers/" icon={<NetworkIcon className="w-5 h-5 text-primary" />} title="Prowlarr Support" description="Connect Prowlarr to manage all your indexers from one place." />
        <InfoCard href="https://docs.narratorr.dev/guides/discovery/" icon={<SparklesIcon className="w-5 h-5 text-primary" />} title="Recommendations" description="Personalised suggestions based on your library. Discover what to read next." />
      </div>
    </section>
  );
}

function WarningBadge() {
  return (
    <span
      className="flex items-center justify-center w-5 h-5 rounded-full bg-red-500 text-white text-[10px] font-bold shadow-sm"
      aria-label="Important"
    >
      !
    </span>
  );
}

export function WelcomeModal({ isOpen, isPending = false, onDismiss }: WelcomeModalProps) {
  const modalRef = useRef<HTMLDivElement>(null);
  const scrollableRef = useRef<HTMLDivElement>(null);
  // Scroll lock: prevent background page from scrolling behind the modal
  useEffect(() => {
    if (!isOpen) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, [isOpen]);
  // Scroll-to-top: reset inner scrollable container when modal opens
  useEffect(() => {
    if (!isOpen) return;
    if (scrollableRef.current) {
      scrollableRef.current.scrollTop = 0;
    }
  }, [isOpen]);
  // When pending, pull focus back to the dialog container so card links are
  // not reachable via Tab while saving (regression guard from issue #169)
  useEffect(() => {
    if (isOpen && isPending && modalRef.current) {
      modalRef.current.focus();
    }
  }, [isOpen, isPending]);
  if (!isOpen) return null;
  return (
    <Modal className="w-full max-w-4xl flex flex-col max-h-[85vh]">
      <div
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="welcome-modal-title"
        tabIndex={-1}
        className="flex flex-col min-h-0 flex-1 overflow-hidden outline-none"
      >
        {/* Scrollable content */}
        <div ref={scrollableRef} data-testid="modal-content" className="flex-1 overflow-y-auto p-6 sm:p-8 [@media(max-height:60rem)]:p-5">
        {/* Header */}
        <div className="text-center mb-8 [@media(max-height:60rem)]:mb-4">
          <div data-testid="welcome-header-icon" className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-gradient-to-br from-primary to-amber-500 mb-4 [@media(max-height:60rem)]:mb-2 shadow-glow">
            <HeadphonesIcon className="w-7 h-7 text-primary-foreground" />
          </div>
          <h2 id="welcome-modal-title" className="font-display text-2xl sm:text-3xl [@media(max-height:60rem)]:text-2xl font-semibold mb-2">
            Welcome to narratorr
          </h2>
          <p className="text-muted-foreground text-sm sm:text-base max-w-lg mx-auto">
            Your self-hosted audiobook manager. Here's what to know before you dive in.
          </p>
        </div>

        {/* Row 1 — Read This */}
        <section className="mb-6 [@media(max-height:60rem)]:mb-3">
          <h3 className="font-display text-xs font-semibold uppercase tracking-widest text-muted-foreground mb-3">
            Read This First
          </h3>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <InfoCard
              href="https://docs.narratorr.dev/configuration/security/"
              icon={<ShieldIcon className="w-5 h-5 text-primary" />}
              title="Authentication is off"
              description={<>Auth is disabled by default. Enable it in <span className="whitespace-nowrap">Settings → Security</span> to protect your instance.</>}
              badge={<WarningBadge />}
            />
            <InfoCard
              href="https://docs.narratorr.dev/configuration/metadata/"
              icon={<GlobeIcon className="w-5 h-5 text-primary" />}
              title={"Region: US\nLanguage: English"}
              description={<>Metadata defaults to US region and English language. Change in <span className="whitespace-nowrap">Settings → Search → Filtering</span>.</>}
              badge={<WarningBadge />}
            />
            <InfoCard
              href="https://docs.narratorr.dev/configuration/library/"
              icon={<AlertIcon className="w-5 h-5 text-primary" />}
              title="Library path: /audiobooks"
              description={<>Files are stored at /audiobooks. If your Docker mount differs, update it in <span className="whitespace-nowrap">Settings → Library</span>.</>}
              badge={<WarningBadge />}
            />
          </div>
        </section>

        {/* Row 2 — First Steps */}
        <section className="mb-6 [@media(max-height:60rem)]:mb-3">
          <h3 className="font-display text-xs font-semibold uppercase tracking-widest text-muted-foreground mb-3">
            First Steps
          </h3>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <InfoCard
              href="https://docs.narratorr.dev/guides/library-import/"
              icon={<ImportIcon className="w-5 h-5 text-primary" />}
              title="Library Import"
              description="Already have audiobooks? Scan your existing folders to add them to your library."
            />
            <InfoCard
              href="https://docs.narratorr.dev/guides/manual-import/"
              icon={<FolderInputIcon className="w-5 h-5 text-primary" />}
              title="Manual Import"
              description="Import from a specific folder — useful for one-off additions outside your library path."
            />
            <InfoCard
              href="https://docs.narratorr.dev/getting-started/first-run/"
              icon={<SearchPlusIcon className="w-5 h-5 text-primary" />}
              title="Add a Book"
              description="Search for a book and send it to your download client directly from narratorr."
            />
          </div>
        </section>

        {/* Row 3–4 — Feature Highlights */}
        <FeaturesSection />

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
        </div>{/* end scrollable content */}
      </div>
    </Modal>
  );
}
