import { useState, useRef, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';
import { PlusIcon, LoadingSpinner } from '@/components/icons';

interface AddBookPopoverProps {
  onAdd: (overrides: { searchImmediately: boolean; monitorForUpgrades: boolean }) => void;
  isPending: boolean;
}

const PANEL_WIDTH = 256; // w-64 = 16rem = 256px

function computePosition(triggerRect: DOMRect) {
  const top = triggerRect.bottom + 8; // mt-2 equivalent
  const right = triggerRect.right;
  // Right-align: panel's right edge matches trigger's right edge
  let left = right - PANEL_WIDTH;
  // Clamp to viewport so panel doesn't overflow off-screen
  const maxLeft = window.innerWidth - PANEL_WIDTH;
  left = Math.min(left, maxLeft);
  left = Math.max(left, 0);
  return { top, left };
}

export function AddBookPopover({ onAdd, isPending }: AddBookPopoverProps) {
  const [isOpen, setIsOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ top: 0, left: 0 });

  const { data: settings } = useQuery({
    queryKey: queryKeys.settings(),
    queryFn: api.getSettings,
  });

  const qualityDefaults = settings?.quality;

  // Track user overrides separately from defaults.
  // null = user hasn't touched it yet, use the default from settings.
  const [searchOverride, setSearchOverride] = useState<boolean | null>(null);
  const [monitorOverride, setMonitorOverride] = useState<boolean | null>(null);

  // Resolved values: user override wins, then settings default, then false
  const searchImmediately = searchOverride ?? qualityDefaults?.searchImmediately ?? false;
  const monitorForUpgrades = monitorOverride ?? qualityDefaults?.monitorForUpgrades ?? false;

  const updatePosition = useCallback(() => {
    if (triggerRef.current) {
      setPosition(computePosition(triggerRef.current.getBoundingClientRect()));
    }
  }, []);

  const toggleOpen = () => {
    const next = !isOpen;
    if (next) {
      // Reset overrides so fresh open picks up current settings defaults
      setSearchOverride(null);
      setMonitorOverride(null);
      // Compute initial position before opening
      if (triggerRef.current) {
        setPosition(computePosition(triggerRef.current.getBoundingClientRect()));
      }
    }
    setIsOpen(next);
  };

  // Close on outside click — dual-ref: close only when click is outside BOTH trigger and panel
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      const target = e.target as Node;
      const insideTrigger = triggerRef.current?.contains(target);
      const insidePanel = panelRef.current?.contains(target);
      if (!insideTrigger && !insidePanel) {
        setIsOpen(false);
      }
    }
    if (isOpen) document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [isOpen]);

  // Reposition on scroll/resize while open
  useEffect(() => {
    if (!isOpen) return;
    window.addEventListener('scroll', updatePosition, true);
    window.addEventListener('resize', updatePosition);
    return () => {
      window.removeEventListener('scroll', updatePosition, true);
      window.removeEventListener('resize', updatePosition);
    };
  }, [isOpen, updatePosition]);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={toggleOpen}
        disabled={isPending}
        className="
          flex items-center gap-2 px-4 py-2.5
          bg-primary text-primary-foreground font-medium rounded-xl
          hover:opacity-90 hover:shadow-glow
          disabled:opacity-50 disabled:cursor-not-allowed
          transition-all duration-200 focus-ring
        "
      >
        {isPending ? (
          <>
            <LoadingSpinner className="w-4 h-4" />
            <span className="hidden sm:inline">Adding...</span>
          </>
        ) : (
          <>
            <PlusIcon className="w-4 h-4" />
            <span className="hidden sm:inline">Add</span>
          </>
        )}
      </button>

      {isOpen && createPortal(
        <div
          ref={panelRef}
          data-popover-portal
          className="fixed z-50 w-64 glass-card rounded-xl p-4 shadow-lg border border-border animate-fade-in-up"
          style={{ top: `${position.top}px`, left: `${position.left}px` }}
        >
          <div className="space-y-3">
            <label className="flex items-center gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={searchImmediately}
                onChange={(e) => setSearchOverride(e.target.checked)}
                className="w-4 h-4 rounded border-white/20 bg-transparent text-primary focus:ring-primary/30 focus:ring-offset-0"
              />
              <span className="text-sm font-medium">Search immediately</span>
            </label>

            <label className="flex items-center gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={monitorForUpgrades}
                onChange={(e) => setMonitorOverride(e.target.checked)}
                className="w-4 h-4 rounded border-white/20 bg-transparent text-primary focus:ring-primary/30 focus:ring-offset-0"
              />
              <span className="text-sm font-medium">Monitor for upgrades</span>
            </label>

            <button
              type="button"
              onClick={() => {
                onAdd({ searchImmediately, monitorForUpgrades });
                setIsOpen(false);
              }}
              disabled={isPending}
              className="w-full flex items-center justify-center gap-2 px-3 py-2 bg-primary text-primary-foreground font-medium rounded-lg hover:opacity-90 disabled:opacity-50 transition-all text-sm"
            >
              <PlusIcon className="w-3.5 h-3.5" />
              Add to Library
            </button>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
