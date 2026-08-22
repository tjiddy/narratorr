/**
 * Connected Import Files refusal: the real BookDetails renders against the real `api` client, whose
 * fetch is routed into a real Fastify app backed by a real migrated libSQL database.
 *
 * Nothing on the client↔server seam is mocked, and that seam is the whole defect (#2476): the route
 * suite and the component suite can each stay green while the field the route fills and the field
 * `ApiError` reads disagree — which is exactly how a refusal came to toast `book_has_file` at the
 * operator. Following `series-add-all-connected.test.tsx` (#2200).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/__tests__/helpers';
import { createMockBook } from '@/__tests__/factories';
import { BookDetails } from '@/pages/book/BookDetails';
import { createE2EApp, type E2EApp } from '../../server/__tests__/e2e-helpers.js';
import { books } from '@db/schema.js';
import { eq } from 'drizzle-orm';
import { generatePublicId } from '../../server/utils/public-id.js';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() } }));
import { toast } from 'sonner';

const ORIGINAL_FETCH = globalThis.fetch;

describe('Import Files refusal — connected picker → route → toast (#2476)', () => {
  let e2e: E2EApp;
  let bookId: number;
  /** Every request the client actually put on the wire, so the seam itself is assertable. */
  let apiCalls: Array<{ method: string; url: string; body: string | undefined }>;

  beforeEach(async () => {
    // The sonner double is module-scoped, so its call history would otherwise accumulate.
    vi.clearAllMocks();
    e2e = await createE2EApp();
    apiCalls = [];
    bookId = await seedBookHoldingAFile();
    installConnectedFetch();
  });

  afterEach(async () => {
    globalThis.fetch = ORIGINAL_FETCH;
    await e2e.cleanup();
  });

  /** The row the route reads already owns a library folder — the cheapest refusal to seed. */
  async function seedBookHoldingAFile(): Promise<number> {
    const [book] = await e2e.db.insert(books).values({
      publicId: generatePublicId('bk'),
      title: 'The Way of Kings',
      status: 'imported',
      path: '/library/Brandon Sanderson/The Way of Kings',
    }).returning();
    return book!.id;
  }

  function installConnectedFetch(): void {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      const body = typeof init?.body === 'string' ? init.body : undefined;
      apiCalls.push({ method, url, body });

      const injected = await e2e.app.inject({
        method: method as 'GET' | 'POST',
        url,
        headers: init?.headers as Record<string, string>,
        ...(body !== undefined && { payload: body }),
      });
      return new Response(injected.payload, {
        status: injected.statusCode,
        headers: { 'Content-Type': injected.headers['content-type'] as string ?? 'application/json' },
      });
    }) as typeof globalThis.fetch;
  }

  /**
   * The client's snapshot is deliberately stale — fileless and wanted, so the action is offered —
   * while the row the route reads holds a file. That is the shape every refusal has in production:
   * the server knows something the open page does not.
   */
  function renderStalePage() {
    renderWithProviders(
      <BookDetails libraryBook={createMockBook({ id: bookId, path: null, status: 'wanted' })} />,
    );
  }

  it('toasts the route\'s own sentence, not the machine token behind it', async () => {
    const user = userEvent.setup();
    renderStalePage();

    await user.click(screen.getByLabelText('More actions'));
    await user.click(await screen.findByRole('menuitem', { name: /Import Files/ }));
    await screen.findByText('Import Files', { selector: 'h2' });
    await user.click(screen.getByRole('button', { name: 'Use this folder' }));
    await user.click(screen.getByRole('button', { name: 'Import' }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(
      'Import files failed: This book already has a library folder',
    ));
    // The negative control: the token is what HEAD rendered, and no assertion above forbids it.
    expect(vi.mocked(toast.error).mock.calls.flat().join(' ')).not.toContain('book_has_file');

    // The refusal really came from this route over the wire, with the picker's own body.
    const attachCalls = apiCalls.filter((c) => c.url.includes('/import-files'));
    expect(attachCalls).toEqual([{
      method: 'POST',
      url: `/api/books/${bookId}/import-files`,
      body: JSON.stringify({ path: '/', mode: 'copy' }),
    }]);
    // A refused attach leaves the incumbent row exactly as it was.
    const [row] = await e2e.db.select().from(books).where(eq(books.id, bookId));
    expect(row).toMatchObject({ status: 'imported', path: '/library/Brandon Sanderson/The Way of Kings' });
  });
});
