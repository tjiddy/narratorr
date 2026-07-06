import { useRef, useState, useEffect, useCallback, type ReactNode, type RefObject, type KeyboardEvent } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import {
  ChevronDownIcon,
  SearchIcon,
  RefreshIcon,
  LoadingSpinner,
  TrashIcon,
  ImportIcon,
  FolderInputIcon,
  PencilIcon,
  TagIcon,
  PackageIcon,
} from '@/components/icons';
import { ToolbarDropdown } from '@/components/ToolbarDropdown';
import { ConfirmModal } from '@/components/ConfirmModal';
import { BulkRenameModal } from '@/components/library/BulkRenameModal';
import { api, type BulkOpType } from '@/lib/api';
import { getErrorMessage } from '@/lib/error-message.js';
import { useBulkOperation } from '@/hooks/useBulkOperation';

type PendingOp = 'rename' | 'retag' | 'writeSidecars' | null;

interface BulkProgress {
  completed: number;
  total: number;
  failures: number;
}

const ITEM_CLASS =
  'flex items-center gap-2.5 w-full px-3 py-2.5 text-xs text-left text-muted-foreground hover:bg-muted/50 hover:text-foreground transition-colors disabled:opacity-50 disabled:pointer-events-none focus:bg-muted/50 focus-ring';
const DESTRUCTIVE_ITEM_CLASS =
  'flex items-center gap-2.5 w-full px-3 py-2.5 text-xs text-left text-red-400 hover:bg-red-500/10 hover:text-red-300 transition-colors focus:bg-red-500/10 focus-ring';
const DIVIDER_CLASS = 'border-t border-border/50 mx-2';

function runningVerb(jobType: BulkOpType | null): string {
  switch (jobType) {
    case 'rename': return 'Renaming';
    case 'retag': return 'Re-tagging';
    case 'write_metadata_sidecars': return 'Writing sidecars';
    case 'convert': return 'Converting';
    default: return 'Running';
  }
}

function ActionButton({ icon, label, disabled, onClick }: {
  icon: ReactNode;
  label: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button role="menuitem" type="button" disabled={disabled} onClick={onClick} className={ITEM_CLASS}>
      {icon}
      {label}
    </button>
  );
}

function ActionLink({ icon, label, to, onClick }: {
  icon: ReactNode;
  label: string;
  to: string;
  onClick: () => void;
}) {
  return (
    <Link role="menuitem" to={to} onClick={onClick} className={ITEM_CLASS}>
      {icon}
      {label}
    </Link>
  );
}

function BulkItem({ icon, label, runningLabel, isThisRunning, anyBulkBusy, progress, onClick }: {
  icon: ReactNode;
  label: string;
  runningLabel: string;
  isThisRunning: boolean;
  anyBulkBusy: boolean;
  progress: BulkProgress;
  onClick: () => void;
}) {
  const title = anyBulkBusy && !isThisRunning ? 'A bulk operation is already running.' : undefined;
  return (
    <button role="menuitem" type="button" disabled={anyBulkBusy} title={title} onClick={onClick} className={ITEM_CLASS}>
      {isThisRunning ? <LoadingSpinner className="w-3.5 h-3.5" /> : icon}
      {isThisRunning ? `${runningLabel} ${progress.completed}/${progress.total}` : label}
    </button>
  );
}

interface ActionMenuItemsProps {
  onCloseMenu: () => void;
  isRescanning: boolean;
  onRefresh: () => void;
  isSearchingAllWanted: boolean;
  onSearch: () => void;
  anyBulkBusy: boolean;
  isRunning: boolean;
  jobType: BulkOpType | null;
  progress: BulkProgress;
  onRename: () => void;
  onRetag: () => void;
  writeOpf: boolean;
  onWriteSidecars: () => void;
  missingCount: number;
  onRemoveMissing: () => void;
}

/** The grouped menu items — extracted to bound the main component's length. */
function ActionMenuItems(props: ActionMenuItemsProps) {
  const { isRunning, jobType, progress, anyBulkBusy } = props;
  return (
    <>
      <ActionLink icon={<ImportIcon className="w-3.5 h-3.5" />} label="Import Files" to="/import" onClick={props.onCloseMenu} />
      <ActionLink icon={<FolderInputIcon className="w-3.5 h-3.5" />} label="Import Existing Library" to="/library-import" onClick={props.onCloseMenu} />

      <div className={DIVIDER_CLASS} />

      <ActionButton
        icon={props.isRescanning ? <LoadingSpinner className="w-3.5 h-3.5" /> : <RefreshIcon className="w-3.5 h-3.5" />}
        label="Refresh Library"
        disabled={props.isRescanning}
        onClick={props.onRefresh}
      />
      <ActionButton
        icon={props.isSearchingAllWanted ? <LoadingSpinner className="w-3.5 h-3.5" /> : <SearchIcon className="w-3.5 h-3.5" />}
        label="Search Wanted"
        disabled={props.isSearchingAllWanted}
        onClick={props.onSearch}
      />

      <div className={DIVIDER_CLASS} />

      <BulkItem
        icon={<PencilIcon className="w-3.5 h-3.5" />}
        label="Rename All Books"
        runningLabel="Renaming..."
        isThisRunning={isRunning && jobType === 'rename'}
        anyBulkBusy={anyBulkBusy}
        progress={progress}
        onClick={props.onRename}
      />
      <BulkItem
        icon={<TagIcon className="w-3.5 h-3.5" />}
        label="Re-tag All Books"
        runningLabel="Re-tagging..."
        isThisRunning={isRunning && jobType === 'retag'}
        anyBulkBusy={anyBulkBusy}
        progress={progress}
        onClick={props.onRetag}
      />
      {props.writeOpf && (
        <BulkItem
          icon={<PackageIcon className="w-3.5 h-3.5" />}
          label="Write / refresh sidecars"
          runningLabel="Writing sidecars..."
          isThisRunning={isRunning && jobType === 'write_metadata_sidecars'}
          anyBulkBusy={anyBulkBusy}
          progress={progress}
          onClick={props.onWriteSidecars}
        />
      )}

      {props.missingCount > 0 && (
        <>
          <div className={DIVIDER_CLASS} />
          <button
            role="menuitem"
            type="button"
            onClick={props.onRemoveMissing}
            className={DESTRUCTIVE_ITEM_CLASS}
          >
            <TrashIcon className="w-3.5 h-3.5" />
            Remove Missing Books
          </button>
        </>
      )}
    </>
  );
}

interface RovingMenu {
  open: boolean;
  setOpen: (open: boolean) => void;
  triggerRef: RefObject<HTMLButtonElement | null>;
  menuRef: RefObject<HTMLDivElement | null>;
  close: () => void;
  handleKeyDown: (e: KeyboardEvent) => void;
}

const MENUITEM_QUERY = '[role="menuitem"]:not([disabled])';

/** Open/focus state + arrow-key roving focus for the dropdown, mirroring the prior OverflowMenu. */
function useRovingMenu(): RovingMenu {
  const [open, setOpen] = useState(false);
  const [focusIndex, setFocusIndex] = useState(0);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    menuRef.current?.querySelectorAll<HTMLElement>(MENUITEM_QUERY)[focusIndex]?.focus();
  }, [focusIndex, open]);

  const close = useCallback(() => {
    setFocusIndex(0);
    setOpen(false);
    triggerRef.current?.focus();
  }, []);

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    const items = Array.from(menuRef.current?.querySelectorAll<HTMLElement>(MENUITEM_QUERY) ?? []);
    const count = items.length;
    if (count === 0) return;
    switch (e.key) {
      case 'ArrowDown': e.preventDefault(); setFocusIndex((i) => (i + 1) % count); break;
      case 'ArrowUp': e.preventDefault(); setFocusIndex((i) => (i - 1 + count) % count); break;
      case 'Enter': e.preventDefault(); items[focusIndex]?.click(); break;
      case ' ':
        e.preventDefault();
        if (items[focusIndex]?.tagName !== 'A') items[focusIndex]?.click();
        break;
    }
  }, [focusIndex]);

  return { open, setOpen, triggerRef, menuRef, close, handleKeyDown };
}

/** Rename/retag/write-sidecars confirmations — kept separate to bound the menu's complexity. */
function BulkActionModals({ pendingOp, retagCount, onStartRename, onConfirm, onCancel }: {
  pendingOp: PendingOp;
  retagCount: number | null;
  onStartRename: () => void;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  if (pendingOp === 'rename') {
    return <BulkRenameModal isOpen onClose={onCancel} onConfirm={onStartRename} />;
  }
  if (pendingOp === 'retag') {
    const n = retagCount ?? 0;
    return (
      <ConfirmModal
        isOpen
        title="Re-tag All Books?"
        message={`This will re-write audio tags for ${n} ${n !== 1 ? 'books' : 'book'}.`}
        confirmLabel="Re-tag All"
        cancelLabel="Cancel"
        onConfirm={onConfirm}
        onCancel={onCancel}
      />
    );
  }
  if (pendingOp === 'writeSidecars') {
    return (
      <ConfirmModal
        isOpen
        title="Write Metadata Sidecars?"
        message="Write a metadata.opf into each imported book's folder, refreshing it from the current library data, and download any cover that hasn't been saved locally yet. Foreign metadata.opf files are left untouched. This helps media servers like Audiobookshelf and Plex read your metadata."
        confirmLabel="Write Sidecars"
        cancelLabel="Cancel"
        onConfirm={onConfirm}
        onCancel={onCancel}
      />
    );
  }
  return null;
}

export interface LibraryActionsMenuProps {
  missingCount: number;
  onRemoveMissing: () => void;
  onSearchAllWanted: () => void;
  isSearchingAllWanted: boolean;
  onRescan: () => void;
  isRescanning: boolean;
  /** Gate for the sidecar action — present only when tagging.writeOpf is enabled. */
  writeOpf: boolean;
}

export function LibraryActionsMenu({
  missingCount,
  onRemoveMissing,
  onSearchAllWanted,
  isSearchingAllWanted,
  onRescan,
  isRescanning,
  writeOpf,
}: LibraryActionsMenuProps) {
  const { open, setOpen, triggerRef, menuRef, close, handleKeyDown } = useRovingMenu();

  const { isRunning, jobType, progress, startJob } = useBulkOperation();
  const [pendingOp, setPendingOp] = useState<PendingOp>(null);
  const [retagCount, setRetagCount] = useState<number | null>(null);
  const [isLoadingCount, setIsLoadingCount] = useState(false);
  const anyBulkBusy = isRunning || isLoadingCount;

  // Run a non-navigation action: close the menu, refocus the trigger, then act.
  function runAction(fn: () => void) {
    close();
    fn();
  }

  // Retag pre-fetches a count for its count-only confirm; the trigger shows a
  // busy state while the count loads so there's no silent gap before the modal.
  async function handleRetag() {
    close();
    setIsLoadingCount(true);
    try {
      const { total } = await api.getBulkRetagCount();
      setRetagCount(total);
      setPendingOp('retag');
    } catch (error: unknown) {
      toast.error(getErrorMessage(error));
    } finally {
      setIsLoadingCount(false);
    }
  }

  function handleConfirm() {
    if (pendingOp === 'retag') {
      setPendingOp(null);
      setRetagCount(null);
      void startJob('retag');
      return;
    }
    if (pendingOp === 'writeSidecars') {
      setPendingOp(null);
      void startJob('write_metadata_sidecars');
    }
  }

  const triggerLabel = isLoadingCount
    ? 'Loading…'
    : isRunning
      ? `${runningVerb(jobType)} ${progress.completed}/${progress.total}`
      : 'Library Actions';

  return (
    <div className="relative flex items-center gap-2">
      {progress.failures > 0 && (
        <span className="text-xs text-destructive">
          {progress.failures} failure{progress.failures !== 1 ? 's' : ''}
        </span>
      )}
      <button
        ref={triggerRef}
        type="button"
        aria-label="Library Actions"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => (open ? close() : setOpen(true))}
        className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-muted-foreground rounded-xl hover:text-foreground hover:bg-white/5 hover:border hover:border-white/10 transition-all focus-ring"
      >
        {anyBulkBusy && <LoadingSpinner className="w-4 h-4" />}
        <span>{triggerLabel}</span>
        <ChevronDownIcon className={`w-4 h-4 transition-transform duration-200 ${open ? 'rotate-180' : ''}`} />
      </button>

      <ToolbarDropdown triggerRef={triggerRef} open={open} onClose={close}>
        <div
          ref={menuRef}
          role="menu"
          onKeyDown={handleKeyDown}
          className="min-w-[200px] glass-card rounded-xl overflow-hidden shadow-lg border border-border animate-fade-in"
        >
          <ActionMenuItems
            onCloseMenu={() => setOpen(false)}
            isRescanning={isRescanning}
            onRefresh={() => runAction(onRescan)}
            isSearchingAllWanted={isSearchingAllWanted}
            onSearch={() => runAction(onSearchAllWanted)}
            anyBulkBusy={anyBulkBusy}
            isRunning={isRunning}
            jobType={jobType}
            progress={progress}
            onRename={() => runAction(() => setPendingOp('rename'))}
            onRetag={handleRetag}
            writeOpf={writeOpf}
            onWriteSidecars={() => runAction(() => setPendingOp('writeSidecars'))}
            missingCount={missingCount}
            onRemoveMissing={() => runAction(onRemoveMissing)}
          />
        </div>
      </ToolbarDropdown>

      <BulkActionModals
        pendingOp={pendingOp}
        retagCount={retagCount}
        onStartRename={() => {
          setPendingOp(null);
          void startJob('rename');
        }}
        onConfirm={handleConfirm}
        onCancel={() => {
          setPendingOp(null);
          setRetagCount(null);
        }}
      />
    </div>
  );
}
