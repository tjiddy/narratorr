import { useRef, useState, useEffect, useCallback } from 'react';
import { SearchIcon, TrashIcon } from '@/components/icons';

export function BookContextMenu({
  onSearchReleases,
  onRemove,
  onClose,
}: {
  onSearchReleases: () => void;
  onRemove: () => void;
  onClose: () => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [focusIndex, setFocusIndex] = useState(0);
  const actions = [onSearchReleases, onRemove];

  useEffect(() => {
    const buttons = menuRef.current?.querySelectorAll<HTMLButtonElement>('button');
    buttons?.[focusIndex]?.focus();
  }, [focusIndex]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    switch (e.key) {
      case 'Escape':
        e.preventDefault();
        onClose();
        break;
      case 'ArrowDown':
        e.preventDefault();
        setFocusIndex((i) => (i + 1) % actions.length);
        break;
      case 'ArrowUp':
        e.preventDefault();
        setFocusIndex((i) => (i - 1 + actions.length) % actions.length);
        break;
      case 'Enter':
      case ' ':
        e.preventDefault();
        actions[focusIndex]();
        break;
    }
  }, [onClose, actions, focusIndex]);

  return (
    <div
      ref={menuRef}
      role="menu"
      className="absolute right-0 top-full mt-1 w-44 glass-card rounded-xl overflow-hidden shadow-lg z-10 animate-fade-in"
      onClick={(e) => e.stopPropagation()}
      onKeyDown={handleKeyDown}
    >
      <button
        role="menuitem"
        onClick={onSearchReleases}
        className="flex items-center gap-3 w-full px-4 py-2.5 text-sm text-left hover:bg-muted/80 transition-colors focus:bg-muted/80 focus:outline-none"
      >
        <SearchIcon className="w-4 h-4 text-muted-foreground" />
        Search Releases
      </button>
      <div className="border-t border-border/50" />
      <button
        role="menuitem"
        onClick={onRemove}
        className="flex items-center gap-3 w-full px-4 py-2.5 text-sm text-left text-destructive hover:bg-destructive/10 transition-colors focus:bg-destructive/10 focus:outline-none"
      >
        <TrashIcon className="w-4 h-4" />
        Remove from Library
      </button>
    </div>
  );
}
