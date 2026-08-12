import { useEffect, useRef, useState } from 'react';
import { ConfirmModal } from '@/components/ConfirmModal';
import { useDirtyFormsState } from '@/hooks/dirty-forms';

// Mounted once by SettingsLayout, document capture intercepts anchor/area exits before
// React Router, including global chrome. Discard replays the original click so Router
// preserves replace/state/scroll/basename semantics. POP, programmatic, and non-link
// navigation intentionally remain unguarded.

interface CapturedTarget {
  node: HTMLAnchorElement | HTMLAreaElement;
  href: string;
  target: string | null;
  download: boolean;
}

function findAnchor(event: MouseEvent): HTMLAnchorElement | HTMLAreaElement | null {
  for (const el of event.composedPath()) {
    if (
      (el instanceof HTMLAnchorElement || el instanceof HTMLAreaElement) &&
      el.hasAttribute('href')
    ) {
      return el;
    }
  }
  return null;
}

// Match React Router eligibility; true means bypass this guard.
function shouldLetClickThrough(event: MouseEvent, anchor: HTMLAnchorElement | HTMLAreaElement): boolean {
  if (event.defaultPrevented || !event.cancelable) return true;
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
    return true;
  }
  // HTML browsing-context keywords are ASCII case-insensitive: `_SELF` === `_self`.
  const target = anchor.getAttribute('target');
  if (target && target.toLowerCase() !== '_self') return true;
  if (anchor.hasAttribute('download')) return true;
  let url: URL;
  try {
    url = new URL(anchor.href, window.location.href);
  } catch {
    return true;
  }
  if (url.origin !== window.location.origin) return true;
  // Both paths include the basename, so equality is a navigation no-op.
  if (url.pathname === window.location.pathname) return true;
  return false;
}

function buildMessage(dirtyLabels: string[]): string {
  if (dirtyLabels.length === 0) {
    return 'You have unsaved changes. Leave without saving?';
  }
  const list = dirtyLabels.join(', ');
  const noun = dirtyLabels.length === 1 ? 'card has' : 'cards have';
  return `The ${list} ${noun} unsaved changes. Leave without saving?`;
}

export function UnsavedChangesGuard() {
  const { dirtyLabels, anyPending } = useDirtyFormsState();
  const isBlocking = dirtyLabels.length > 0 || anyPending;

  const [pendingTarget, setPendingTarget] = useState<CapturedTarget | null>(null);

  // Save/revert can clear every blocker while open. React's guarded derive-state
  // pattern closes the modal without an effect.
  if (pendingTarget !== null && !isBlocking) {
    setPendingTarget(null);
  }

  // Click replay and beforeunload need separate one-shot flags: propagation consumes
  // the click flag before a document navigation fires beforeunload.
  const bypassNextClick = useRef(false);
  const suppressNextBeforeunload = useRef(false);

  // Imperative listeners need the latest committed blocking state.
  const isBlockingRef = useRef(isBlocking);
  useEffect(() => {
    isBlockingRef.current = isBlocking;
  }, [isBlocking]);

  useEffect(() => {
    function handleClick(event: MouseEvent) {
      // Let the Discard replay pass through to Router.
      if (bypassNextClick.current) {
        bypassNextClick.current = false;
        return;
      }
      if (!isBlockingRef.current) return;
      const anchor = findAnchor(event);
      if (!anchor) return;
      if (shouldLetClickThrough(event, anchor)) return;

      event.preventDefault();
      event.stopPropagation();
      setPendingTarget({
        node: anchor,
        href: anchor.href,
        target: anchor.getAttribute('target'),
        download: anchor.hasAttribute('download'),
      });
    }
    document.addEventListener('click', handleClick, { capture: true });
    return () => document.removeEventListener('click', handleClick, { capture: true });
  }, []);

  useEffect(() => {
    function handleBeforeunload(event: BeforeUnloadEvent) {
      if (suppressNextBeforeunload.current) {
        // Discard already confirmed this navigation; suppress exactly one prompt.
        suppressNextBeforeunload.current = false;
        return;
      }
      if (!isBlockingRef.current) return;
      event.preventDefault();
      event.returnValue = '';
    }
    window.addEventListener('beforeunload', handleBeforeunload);
    return () => window.removeEventListener('beforeunload', handleBeforeunload);
  }, []);

  function handleStay() {
    setPendingTarget(null);
  }

  function handleDiscard() {
    const captured = pendingTarget;
    setPendingTarget(null);
    if (!captured) return;

    // Replay only the connected, unchanged node. Any href/target/download mutation
    // safely cancels and clears both one-shot flags.
    const { node } = captured;
    const stillValid =
      node.isConnected &&
      node.href === captured.href &&
      node.getAttribute('target') === captured.target &&
      node.hasAttribute('download') === captured.download;
    if (!stillValid) {
      bypassNextClick.current = false;
      suppressNextBeforeunload.current = false;
      return;
    }

    // Arm before dispatch because Chromium may fire beforeunload synchronously during
    // native activation. Router prevents default, so only plain anchors retain suppression.
    bypassNextClick.current = true;
    suppressNextBeforeunload.current = true;
    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    node.dispatchEvent(event);
    if (event.defaultPrevented) {
      suppressNextBeforeunload.current = false;
    }
  }

  return (
    <ConfirmModal
      isOpen={pendingTarget !== null}
      title="Unsaved changes"
      message={buildMessage(dirtyLabels)}
      confirmLabel="Discard changes"
      cancelLabel="Stay on page"
      cancelVariant="primary"
      confirmVariant="secondary"
      confirmDisabled={anyPending}
      onConfirm={handleDiscard}
      onCancel={handleStay}
    />
  );
}
