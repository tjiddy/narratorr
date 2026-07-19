import { useEffect, useRef, useState } from 'react';
import { ConfirmModal } from '@/components/ConfirmModal';
import { useDirtyFormsState } from '@/hooks/dirty-forms';

// Guards navigation away from a settings page while any tracked form holds
// unsaved edits. Mounted once by SettingsLayout — because every tracked form
// renders under `/settings/*`, a document-level capture listener mounted here
// sees every reachable dirty-navigation click (including out-of-layout chrome
// like the global header, sidebar, logo, and health indicator).
//
// Mechanism: a capture-phase `click` listener on `document` fires before React
// Router's `#root`-delegated handler, so preventDefault()+stopPropagation()
// beats the Link's SPA navigation. On Discard we *replay* the captured click so
// the untouched Router pipeline preserves replace/state/scroll/basename
// semantics — we never reconstruct the destination by hand.
//
// NOTE: only anchor/area activation is intercepted. Back/forward (POP),
// programmatic navigate() (auth-expiry redirect), and non-link nav affordances
// bypass this guard by design — every such hole degrades to today's behavior
// (silent draft loss), never worse.

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

// Mirror React Router's link-eligibility semantics: let the click through
// (return true) when this is not an in-app SPA navigation we should guard.
function shouldLetClickThrough(event: MouseEvent, anchor: HTMLAnchorElement | HTMLAreaElement): boolean {
  if (event.defaultPrevented || !event.cancelable) return true;
  // Modified click / non-left button → browser handles it (new tab, etc.).
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
  // Same-path click (both include basename) is a no-op navigation — not guarded.
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

  // Two independent one-shot flags (see AC5). `bypassNextClick` governs only the
  // SPA click-interception path; `suppressNextBeforeunload` governs only the
  // native document-unload prompt. A single shared flag is unsound: the click
  // handler consumes it during propagation, so it is already cleared by the time
  // a document navigation's `beforeunload` runs.
  const bypassNextClick = useRef(false);
  const suppressNextBeforeunload = useRef(false);

  // Latest blocking state for the imperative listeners, synced in commit phase.
  const isBlockingRef = useRef(isBlocking);
  useEffect(() => {
    isBlockingRef.current = isBlocking;
  }, [isBlocking]);

  useEffect(() => {
    function handleClick(event: MouseEvent) {
      // Replayed click from Discard — let this one pass to the Router pipeline.
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
        // A Discard-confirmed document navigation already resolved intent — do
        // not double-prompt. Consume the flag so a later genuine reload prompts.
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

  // Save success (or a revert to clean) while the modal is open → nothing is
  // dirty/pending anymore; close the modal and stay on the page.
  useEffect(() => {
    if (pendingTarget && !isBlocking) {
      setPendingTarget(null);
    }
  }, [pendingTarget, isBlocking]);

  function handleStay() {
    setPendingTarget(null);
  }

  function handleDiscard() {
    const captured = pendingTarget;
    setPendingTarget(null);
    if (!captured) return;

    // Captured-target validity contract: the node must still be connected and
    // every eligibility-critical attribute unchanged since interception. A stale
    // or mutated node → safe-cancel (clear both flags, stay), never a blind
    // replay that could navigate natively or leave a flag armed to swallow a
    // later genuine click/reload.
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

    // Replay the captured click through the live Router/native pipeline.
    bypassNextClick.current = true;
    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    node.dispatchEvent(event);
    // Distinguish SPA replay from document navigation by the replay's outcome,
    // not a timer: React Router calls preventDefault() (defaultPrevented ===
    // true) so no unload occurs; a plain-anchor/reloadDocument navigation leaves
    // defaultPrevented === false, meaning a document unload is now committed —
    // arm suppression so its single ensuing beforeunload is not double-prompted.
    if (!event.defaultPrevented) {
      suppressNextBeforeunload.current = true;
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
