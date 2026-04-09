import { useRef, useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { resolveCoverUrl } from '@/lib/url-utils';
import { ArrowLeftIcon, SearchIcon, BookOpenIcon, PencilIcon, RefreshIcon, TagIcon, PackageIcon, TrashIcon, XCircleIcon, MoreVerticalIcon, UploadIcon, CheckIcon, XIcon } from '@/components/icons';
import { ToolbarDropdown } from '@/components/ToolbarDropdown';

interface BookHeroProps {
  title: string;
  subtitle?: string;
  authorName?: string;
  authorAsin?: string | null;
  narratorNames?: string;
  coverUrl?: string;
  updatedAt?: string;
  metaDots: string[];
  statusLabel: string;
  statusDotClass: string;
  hasPath: boolean;
  onBackClick: () => void;
  onSearchClick: () => void;
  onEditClick: () => void;
  onRenameClick: () => void;
  isRenaming: boolean;
  onRetagClick: () => void;
  isRetagging: boolean;
  retagDisabled: boolean;
  retagTooltip?: string;
  onRefreshScanClick?: () => void;
  isRefreshingScanning?: boolean;
  showRefreshScan?: boolean;
  onMergeClick: () => void;
  isMerging: boolean;
  mergePhase?: string;
  canMerge: boolean;
  mergeDisabled: boolean;
  mergeTooltip?: string;
  onRemoveClick: () => void;
  isRemoving: boolean;
  showWrongRelease?: boolean;
  onWrongReleaseClick?: () => void;
  isWrongReleasing?: boolean;
  importListName?: string | null;
  monitorForUpgrades: boolean;
  onMonitorToggle: () => void;
  isMonitorToggling: boolean;
  /** Preview object URL from file picker or paste. Null when no preview active. */
  previewUrl?: string | null;
  /** Called when user selects a file via the file picker. */
  onCoverFileSelect?: (file: File) => void;
  /** Called when user confirms the preview (checkmark). */
  onCoverConfirm?: () => void;
  /** Called when user cancels the preview (X). */
  onCoverCancel?: () => void;
  /** Whether a cover upload is in progress. */
  isUploadingCover?: boolean;
  children?: React.ReactNode;
}

// eslint-disable-next-line complexity, max-lines-per-function -- flat JSX conditionals for optional props, no branching logic; overflow menu adds state hooks
export function BookHero({
  title, subtitle, authorName, authorAsin, narratorNames,
  coverUrl, updatedAt, metaDots, statusLabel, statusDotClass,
  hasPath, onBackClick, onSearchClick, onEditClick, onRenameClick, isRenaming,
  onRetagClick, isRetagging, retagDisabled, retagTooltip,
  onRefreshScanClick, isRefreshingScanning, showRefreshScan,
  onMergeClick, isMerging, mergePhase, canMerge, mergeDisabled, mergeTooltip,
  onRemoveClick, isRemoving,
  showWrongRelease, onWrongReleaseClick, isWrongReleasing,
  importListName, monitorForUpgrades, onMonitorToggle, isMonitorToggling,
  previewUrl, onCoverFileSelect, onCoverConfirm, onCoverCancel, isUploadingCover,
  children,
}: BookHeroProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [focusIndex, setFocusIndex] = useState(0);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const items = Array.from(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])') ?? []);
    items[focusIndex]?.focus();
  }, [focusIndex, menuOpen]);

  function handleMenuClose() {
    setFocusIndex(0);
    setMenuOpen(false);
    triggerRef.current?.focus();
  }

  function handleMenuAction(fn: () => void) {
    fn();
    handleMenuClose();
  }

  const handleMenuKeyDown = useCallback((e: React.KeyboardEvent) => {
    const items = Array.from(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])') ?? []);
    const count = items.length;
    if (count === 0) return;
    switch (e.key) {
      case 'ArrowDown': e.preventDefault(); setFocusIndex((i) => (i + 1) % count); break;
      case 'ArrowUp': e.preventDefault(); setFocusIndex((i) => (i - 1 + count) % count); break;
      case 'Enter': e.preventDefault(); items[focusIndex]?.click(); break;
      case ' ': e.preventDefault(); items[focusIndex]?.click(); break;
    }
  }, [focusIndex]);

  return (
    <div className="relative -mx-4 sm:-mx-6 lg:-mx-8 -mt-4 sm:-mt-6 px-4 sm:px-6 lg:px-8 pt-6 pb-6 overflow-hidden">
      {coverUrl && (
        <div className="absolute inset-0 -z-10">
          <img src={resolveCoverUrl(coverUrl, updatedAt)} alt="" aria-hidden="true" className="w-full h-full object-cover blur-3xl opacity-20 scale-110" />
          <div className="absolute inset-0 bg-gradient-to-b from-background/60 via-background/80 to-background" />
        </div>
      )}

      <button
        onClick={onBackClick}
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors mb-6 focus-ring rounded-lg px-1 -ml-1 animate-fade-in-up cursor-pointer"
      >
        <ArrowLeftIcon className="w-4 h-4" />
        Library
      </button>

      <div className="flex flex-col sm:flex-row gap-6 sm:gap-8">
        <div className="shrink-0 mx-auto sm:mx-0 animate-fade-in-up stagger-1">
          <div className="relative w-44 sm:w-48 lg:w-56 aspect-square rounded-2xl overflow-hidden shadow-card-hover ring-1 ring-white/[0.08] group">
            {previewUrl ? (
              <img src={previewUrl} alt="Cover preview" className="w-full h-full object-cover animate-fade-in" />
            ) : coverUrl ? (
              <img src={resolveCoverUrl(coverUrl, updatedAt)} alt={`Cover of ${title}`} className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-105" loading="lazy" />
            ) : (
              <div className="w-full h-full flex items-center justify-center bg-muted">
                <BookOpenIcon className="w-16 h-16 text-muted-foreground/30" />
              </div>
            )}
            <div className="absolute inset-0 ring-1 ring-inset ring-white/[0.08] rounded-2xl" />

            {/* Cover upload overlay — confirm/cancel when preview active, upload button on hover otherwise */}
            {previewUrl && onCoverConfirm && onCoverCancel ? (
              <div className="absolute inset-0 flex flex-col items-center justify-end bg-gradient-to-t from-black/70 via-black/20 to-transparent animate-fade-in">
                {isUploadingCover && (
                  <div className="absolute inset-0 flex items-center justify-center">
                    <RefreshIcon className="w-8 h-8 text-white animate-spin drop-shadow-lg" />
                  </div>
                )}
                <div className="flex items-center gap-2.5 pb-3">
                  <button
                    type="button"
                    aria-label="Confirm cover"
                    disabled={isUploadingCover}
                    onClick={onCoverConfirm}
                    className="flex items-center justify-center w-9 h-9 rounded-xl bg-primary/90 text-primary-foreground hover:bg-primary transition-all duration-200 shadow-glow hover:shadow-glow-lg disabled:opacity-40 disabled:pointer-events-none backdrop-blur-sm"
                  >
                    <CheckIcon className="w-4.5 h-4.5" />
                  </button>
                  <button
                    type="button"
                    aria-label="Cancel cover"
                    disabled={isUploadingCover}
                    onClick={onCoverCancel}
                    className="flex items-center justify-center w-9 h-9 rounded-xl bg-card/60 text-muted-foreground hover:text-foreground hover:bg-card/80 transition-all duration-200 shadow-lg disabled:opacity-40 disabled:pointer-events-none backdrop-blur-sm border border-border/30"
                  >
                    <XIcon className="w-4.5 h-4.5" />
                  </button>
                </div>
              </div>
            ) : hasPath && onCoverFileSelect && (
              <button
                type="button"
                aria-label="Upload cover"
                onClick={() => fileInputRef.current?.click()}
                className="absolute inset-0 flex items-center justify-center bg-black/0 hover:bg-black/40 transition-all duration-300 opacity-0 group-hover:opacity-100 no-hover:opacity-100 cursor-pointer"
              >
                <div className="flex items-center justify-center w-11 h-11 rounded-2xl bg-card/60 backdrop-blur-sm border border-border/30 shadow-lg transition-transform duration-300 group-hover:scale-100 scale-90 no-hover:scale-100">
                  <UploadIcon className="w-5 h-5 text-foreground" />
                </div>
              </button>
            )}
          </div>

          {/* Hidden file input for cover upload */}
          {hasPath && onCoverFileSelect && (
            <input
              ref={fileInputRef}
              type="file"
              accept="image/jpeg,image/png,image/webp"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) onCoverFileSelect(file);
                // Reset so re-selecting the same file triggers change
                e.target.value = '';
              }}
            />
          )}
        </div>

        <div className="flex-1 min-w-0 text-center sm:text-left">
          <h1 className="font-display text-2xl sm:text-3xl lg:text-4xl font-bold tracking-tight animate-fade-in-up stagger-2">
            {title}
          </h1>

          {subtitle && (
            <p className="text-muted-foreground italic mt-1 text-lg animate-fade-in-up stagger-2">{subtitle}</p>
          )}

          {authorName && (
            <div className="mt-3 animate-fade-in-up stagger-3">
              <span className="text-muted-foreground text-sm">by </span>
              {authorAsin ? (
                <Link to={`/authors/${authorAsin}`} className="text-primary hover:underline font-medium">{authorName}</Link>
              ) : (
                <span className="font-medium">{authorName}</span>
              )}
            </div>
          )}

          {narratorNames && (
            <p className="text-muted-foreground text-sm mt-1 animate-fade-in-up stagger-3">Narrated by {narratorNames}</p>
          )}

          {metaDots.length > 0 && (
            <p className="text-muted-foreground text-sm mt-2 animate-fade-in-up stagger-3">{metaDots.join(' \u00B7 ')}</p>
          )}

          {children && <div className="mt-4">{children}</div>}

          <div className="flex flex-wrap items-center gap-3 mt-6 justify-center sm:justify-start animate-fade-in-up stagger-4">
            <span className="inline-flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium glass-card">
              <span className={`w-2 h-2 rounded-full ${statusDotClass}`} />
              {statusLabel}
            </span>
            {importListName && (
              <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-medium glass-card text-muted-foreground">
                Added via {importListName}
              </span>
            )}
            <button
              onClick={onMonitorToggle}
              disabled={isMonitorToggling}
              className={`inline-flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-medium transition-all duration-200 focus-ring disabled:opacity-40 disabled:cursor-not-allowed ${
                monitorForUpgrades
                  ? 'glass-card border-primary/30 text-primary'
                  : 'glass-card text-muted-foreground hover:text-foreground hover:border-primary/30'
              }`}
              title={monitorForUpgrades ? 'Monitoring for quality upgrades' : 'Not monitoring for upgrades'}
            >
              <span className={`w-1.5 h-1.5 rounded-full ${monitorForUpgrades ? 'bg-primary animate-pulse' : 'bg-muted-foreground/40'}`} />
              {monitorForUpgrades ? 'Monitoring' : 'Monitor'}
            </button>
            <button
              onClick={onSearchClick}
              className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-medium glass-card hover:border-primary/30 hover:text-primary transition-all duration-200 focus-ring"
            >
              <SearchIcon className="w-4 h-4" />
              Search Releases
            </button>
            <div className="relative">
              <button
                ref={triggerRef}
                type="button"
                aria-label="More actions"
                onClick={() => menuOpen ? handleMenuClose() : setMenuOpen(true)}
                className="flex items-center justify-center w-9 h-9 rounded-xl text-muted-foreground hover:text-foreground glass-card hover:border-primary/30 transition-all duration-200 focus-ring"
              >
                <MoreVerticalIcon className="w-4 h-4" />
              </button>
              <ToolbarDropdown triggerRef={triggerRef} open={menuOpen} onClose={handleMenuClose}>
                <div ref={menuRef} role="menu" onKeyDown={handleMenuKeyDown} className="min-w-[160px] glass-card rounded-xl overflow-hidden shadow-lg border border-border animate-fade-in">
                  <button role="menuitem" type="button" onClick={() => handleMenuAction(onEditClick)} className="flex items-center gap-2.5 w-full px-3 py-2.5 text-xs text-left text-muted-foreground hover:bg-muted/50 hover:text-foreground transition-colors focus:bg-muted/50 focus-ring">
                    <PencilIcon className="w-3.5 h-3.5" />
                    Edit
                  </button>
                  {hasPath && (
                    <button role="menuitem" type="button" onClick={() => handleMenuAction(onRenameClick)} disabled={isRenaming} className="flex items-center gap-2.5 w-full px-3 py-2.5 text-xs text-left text-muted-foreground hover:bg-muted/50 hover:text-foreground transition-colors disabled:opacity-50 disabled:pointer-events-none focus:bg-muted/50 focus-ring">
                      <RefreshIcon className={`w-3.5 h-3.5 ${isRenaming ? 'animate-spin' : ''}`} />
                      {isRenaming ? 'Renaming...' : 'Rename'}
                    </button>
                  )}
                  {hasPath && (
                    <button role="menuitem" type="button" onClick={() => handleMenuAction(onRetagClick)} disabled={isRetagging || retagDisabled} title={retagDisabled ? retagTooltip : undefined} className="flex items-center gap-2.5 w-full px-3 py-2.5 text-xs text-left text-muted-foreground hover:bg-muted/50 hover:text-foreground transition-colors disabled:opacity-50 disabled:pointer-events-none focus:bg-muted/50 focus-ring">
                      <TagIcon className={`w-3.5 h-3.5 ${isRetagging ? 'animate-spin' : ''}`} />
                      {isRetagging ? 'Re-tagging...' : 'Re-tag files'}
                    </button>
                  )}
                  {showRefreshScan && onRefreshScanClick && (
                    <button role="menuitem" type="button" onClick={() => { if (!isRefreshingScanning) onRefreshScanClick(); }} disabled={isRefreshingScanning} className="flex items-center gap-2.5 w-full px-3 py-2.5 text-xs text-left text-muted-foreground hover:bg-muted/50 hover:text-foreground transition-colors disabled:opacity-50 disabled:pointer-events-none focus:bg-muted/50 focus-ring">
                      <RefreshIcon className={`w-3.5 h-3.5 ${isRefreshingScanning ? 'animate-spin' : ''}`} />
                      {isRefreshingScanning ? 'Scanning...' : 'Refresh & Scan'}
                    </button>
                  )}
                  {hasPath && canMerge && (
                    <button role="menuitem" type="button" onClick={() => handleMenuAction(onMergeClick)} disabled={isMerging || mergeDisabled} title={mergeDisabled ? mergeTooltip : undefined} className="flex items-center gap-2.5 w-full px-3 py-2.5 text-xs text-left text-muted-foreground hover:bg-muted/50 hover:text-foreground transition-colors disabled:opacity-50 disabled:pointer-events-none focus:bg-muted/50 focus-ring">
                      <PackageIcon className={`w-3.5 h-3.5 ${isMerging && mergePhase !== 'queued' ? 'animate-spin' : ''}`} />
                      {isMerging ? (mergePhase === 'queued' ? 'Queued...' : 'Merging...') : 'Merge to M4B'}
                    </button>
                  )}
                  {showWrongRelease && onWrongReleaseClick && (
                    <button role="menuitem" type="button" onClick={() => handleMenuAction(onWrongReleaseClick)} disabled={isWrongReleasing} className="flex items-center gap-2.5 w-full px-3 py-2.5 text-xs text-left text-destructive hover:bg-destructive/10 transition-colors disabled:opacity-50 disabled:pointer-events-none focus:bg-destructive/10 focus-ring">
                      <XCircleIcon className={`w-3.5 h-3.5 ${isWrongReleasing ? 'animate-spin' : ''}`} />
                      {isWrongReleasing ? 'Rejecting...' : 'Wrong Release'}
                    </button>
                  )}
                  <button role="menuitem" type="button" onClick={() => handleMenuAction(onRemoveClick)} disabled={isRemoving} className="flex items-center gap-2.5 w-full px-3 py-2.5 text-xs text-left text-destructive hover:bg-destructive/10 transition-colors disabled:opacity-50 disabled:pointer-events-none focus:bg-destructive/10 focus-ring">
                    <TrashIcon className="w-3.5 h-3.5" />
                    {isRemoving ? 'Removing...' : 'Remove'}
                  </button>
                </div>
              </ToolbarDropdown>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
