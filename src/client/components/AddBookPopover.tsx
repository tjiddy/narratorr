import { useState, useRef, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';
import { PlusIcon, LoadingSpinner } from '@/components/icons';

interface AddBookPopoverProps {
  onAdd: (overrides: { searchImmediately: boolean; monitorForUpgrades: boolean }) => void;
  isPending: boolean;
}

export function AddBookPopover({ onAdd, isPending }: AddBookPopoverProps) {
  const [isOpen, setIsOpen] = useState(false);
  const popoverRef = useRef<HTMLDivElement>(null);

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

  const toggleOpen = () => {
    const next = !isOpen;
    if (next) {
      // Reset overrides so fresh open picks up current settings defaults
      setSearchOverride(null);
      setMonitorOverride(null);
    }
    setIsOpen(next);
  };

  // Close on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    }
    if (isOpen) document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [isOpen]);

  return (
    <div className="relative" ref={popoverRef}>
      <button
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

      {isOpen && (
        <div className="absolute right-0 top-full mt-2 z-50 w-64 glass-card rounded-xl p-4 shadow-lg border border-border animate-fade-in-up">
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
        </div>
      )}
    </div>
  );
}
