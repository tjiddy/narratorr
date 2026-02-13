import { LoadingSpinner, ZapIcon } from '@/components/icons';

interface TestButtonProps {
  testing: boolean;
  onClick: () => void;
  variant: 'form' | 'inline';
}

export function TestButton({ testing, onClick, variant }: TestButtonProps) {
  if (variant === 'inline') {
    return (
      <button
        onClick={onClick}
        disabled={testing}
        className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium border border-border rounded-xl hover:bg-muted disabled:opacity-50 transition-all focus-ring"
      >
        {testing ? <LoadingSpinner className="w-4 h-4" /> : <ZapIcon className="w-4 h-4" />}
        <span className="hidden sm:inline">Test</span>
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={testing}
      className="flex items-center gap-2 px-4 py-3 font-medium border border-border rounded-xl hover:bg-muted disabled:opacity-50 transition-all focus-ring"
    >
      {testing ? (
        <>
          <LoadingSpinner className="w-4 h-4" />
          Testing...
        </>
      ) : (
        <>
          <ZapIcon className="w-4 h-4" />
          Test
        </>
      )}
    </button>
  );
}
