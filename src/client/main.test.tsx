import { describe, it, expect, beforeEach, vi } from 'vitest';

const { applyInstanceBadgeMock, renderMock, createRootMock } = vi.hoisted(() => ({
  applyInstanceBadgeMock: vi.fn(),
  renderMock: vi.fn(),
  createRootMock: vi.fn(() => ({ render: renderMock, unmount: vi.fn() })),
}));

vi.mock('react-dom/client', () => ({
  default: { createRoot: createRootMock },
}));

vi.mock('./lib/apply-instance-badge', () => ({
  applyInstanceBadge: applyInstanceBadgeMock,
}));

describe('main.tsx boot wiring', () => {
  beforeEach(() => {
    vi.resetModules();
    applyInstanceBadgeMock.mockClear();
    createRootMock.mockClear();
    renderMock.mockClear();
    document.body.innerHTML = '<div id="root"></div>';
  });

  it('invokes applyInstanceBadge() once during boot', async () => {
    await import('./main');

    expect(createRootMock).toHaveBeenCalledTimes(1);
    expect(applyInstanceBadgeMock).toHaveBeenCalledTimes(1);
  });
});
