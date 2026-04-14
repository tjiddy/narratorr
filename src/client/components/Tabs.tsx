import { useRef, type ReactNode } from 'react';

export interface TabItem {
  value: string;
  label: string;
  icon?: ReactNode;
  badge?: string;
}

interface TabsProps {
  tabs: TabItem[];
  value: string;
  onChange: (value: string) => void;
  ariaLabel: string;
}

export function Tabs({ tabs, value, onChange, ariaLabel }: TabsProps) {
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);

  function handleKeyDown(e: React.KeyboardEvent<HTMLButtonElement>) {
    const currentIndex = tabs.findIndex(t => t.value === value);
    let nextIndex: number | null = null;
    if (e.key === 'ArrowRight') nextIndex = (currentIndex + 1) % tabs.length;
    if (e.key === 'ArrowLeft') nextIndex = (currentIndex - 1 + tabs.length) % tabs.length;
    if (nextIndex !== null) {
      e.preventDefault();
      onChange(tabs[nextIndex].value);
      tabRefs.current[nextIndex]?.focus();
    }
  }

  return (
    <div role="tablist" aria-label={ariaLabel} className="inline-flex items-center glass-card rounded-xl p-1 gap-1">
      {tabs.map((tab, i) => (
        <button
          key={tab.value}
          ref={(el) => { tabRefs.current[i] = el; }}
          id={`tab-${tab.value}`}
          role="tab"
          aria-selected={value === tab.value}
          aria-controls={`tabpanel-${tab.value}`}
          tabIndex={value === tab.value ? 0 : -1}
          onClick={() => { if (value !== tab.value) onChange(tab.value); }}
          onKeyDown={handleKeyDown}
          className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all duration-200 ${
            value === tab.value
              ? 'bg-primary text-primary-foreground shadow-glow'
              : 'text-muted-foreground hover:text-foreground'
          }`}
        >
          {tab.icon}
          {tab.label}
          {tab.badge && <span className="text-xs opacity-75">{tab.badge}</span>}
        </button>
      ))}
    </div>
  );
}
