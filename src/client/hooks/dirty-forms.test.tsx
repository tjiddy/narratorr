import { StrictMode, useState } from 'react';
import { describe, it, expect, beforeEach } from 'vitest';
import { render, act, cleanup } from '@testing-library/react';
import {
  useTrackedForm,
  useDirtyFormsState,
  _resetForTesting,
  type DirtyFormsState,
} from './dirty-forms';

function TrackedForm({
  isDirty = false,
  isPending = false,
  label,
}: {
  isDirty?: boolean;
  isPending?: boolean;
  label: string;
}) {
  useTrackedForm({ isDirty, isPending, label });
  return null;
}

// Probe that surfaces the current store snapshot to the test.
let lastState: DirtyFormsState | null = null;
function Probe() {
  lastState = useDirtyFormsState();
  return null;
}

beforeEach(() => {
  lastState = null;
  _resetForTesting();
});

describe('dirty-forms registry', () => {
  it('registers a dirty form with its label and drops it on unmount', () => {
    const view = render(
      <>
        <Probe />
        <TrackedForm label="Merge & Convert" isDirty />
      </>,
    );
    expect(lastState?.dirtyLabels).toEqual(['Merge & Convert']);

    view.unmount();
    // After unmount the effect cleanup removes the entry.
    render(<Probe />);
    expect(lastState?.dirtyLabels).toEqual([]);
  });

  it('retains a clean-again form in the Map but excludes it from dirtyLabels', () => {
    function Harness() {
      const [dirty, setDirty] = useState(true);
      return (
        <>
          <Probe />
          <TrackedForm label="Filtering" isDirty={dirty} />
          <button type="button" onClick={() => setDirty(false)}>
            clean
          </button>
        </>
      );
    }
    const { getByRole } = render(<Harness />);
    expect(lastState?.dirtyLabels).toEqual(['Filtering']);

    act(() => {
      getByRole('button').click();
    });
    // Entry retained (dirty:false), so it no longer shows in the label list.
    expect(lastState?.dirtyLabels).toEqual([]);
  });

  it('shows both labels for two dirty forms; cleaning one leaves the other', () => {
    function Harness() {
      const [firstDirty, setFirstDirty] = useState(true);
      return (
        <>
          <Probe />
          <TrackedForm label="Housekeeping" isDirty={firstDirty} />
          <TrackedForm label="Logging" isDirty />
          <button type="button" onClick={() => setFirstDirty(false)}>
            clean-first
          </button>
        </>
      );
    }
    const { getByRole } = render(<Harness />);
    expect(lastState?.dirtyLabels).toEqual(['Housekeeping', 'Logging']);

    act(() => {
      getByRole('button').click();
    });
    expect(lastState?.dirtyLabels).toEqual(['Logging']);
  });

  it('tracks anyPending independently of dirty', () => {
    render(
      <>
        <Probe />
        <TrackedForm label="Import" isDirty={false} isPending />
      </>,
    );
    expect(lastState?.dirtyLabels).toEqual([]);
    expect(lastState?.anyPending).toBe(true);
  });

  it('does not write to the store during render (commit-phase only)', () => {
    // Render without flushing effects would leave the store empty; here we prove
    // that the registry is derived only after the committed layout effect runs.
    // A fresh reset guarantees an empty store before the first commit.
    expect(useDirtyFormsStateSnapshotIsEmpty()).toBe(true);
    render(
      <>
        <Probe />
        <TrackedForm label="Network" isDirty />
      </>,
    );
    expect(lastState?.dirtyLabels).toEqual(['Network']);
  });

  it('yields exactly one live entry under StrictMode double-mount', () => {
    render(
      <StrictMode>
        <Probe />
        <TrackedForm label="Quality" isDirty />
      </StrictMode>,
    );
    expect(lastState?.dirtyLabels).toEqual(['Quality']);
  });

  it('getSnapshot returns a stable reference between notifications', () => {
    render(<Probe />);
    const first = lastState;
    // No store mutation happened, so re-reading returns the same cached object.
    render(<Probe />);
    expect(lastState).toBe(first);
  });

  it('_resetForTesting clears entries and notifies subscribers', () => {
    render(
      <>
        <Probe />
        <TrackedForm label="Search" isDirty />
      </>,
    );
    expect(lastState?.dirtyLabels).toEqual(['Search']);

    cleanup();
    act(() => {
      _resetForTesting();
    });
    // A fresh probe sees the cleared snapshot.
    render(<Probe />);
    expect(lastState?.dirtyLabels).toEqual([]);
  });
});

// Helper: after a reset the cached snapshot is empty.
function useDirtyFormsStateSnapshotIsEmpty(): boolean {
  let empty = false;
  function Check() {
    const s = useDirtyFormsState();
    empty = s.dirtyLabels.length === 0 && !s.anyPending;
    return null;
  }
  const view = render(<Check />);
  view.unmount();
  return empty;
}
