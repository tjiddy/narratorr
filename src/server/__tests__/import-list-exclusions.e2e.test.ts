import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createE2EApp, type E2EApp } from './e2e-helpers.js';
import { books, importLists } from '@db/schema.js';

// The provider adapter is the one boundary a deterministic sync cannot own; everything below it —
// routes, services, the real migrated database — is the app.
vi.mock('@core/import-lists/index.js', () => ({
  IMPORT_LIST_ADAPTER_FACTORIES: { nyt: vi.fn(), hardcover: vi.fn() },
}));

const { IMPORT_LIST_ADAPTER_FACTORIES } = await import('@core/import-lists/index.js');
const mockFactories = IMPORT_LIST_ADAPTER_FACTORIES as unknown as Record<string, ReturnType<typeof vi.fn>>;

const ITEM = { title: 'The Reckoning', author: 'Jane Doe' };

describe('import-list exclusions — the delete/re-add loop, end to end (#2305)', () => {
  let e2e: E2EApp;
  let listId: number;

  beforeEach(async () => {
    e2e = await createE2EApp();
    mockFactories.nyt!.mockReturnValue({
      fetchItems: vi.fn().mockResolvedValue([ITEM]),
      test: vi.fn().mockResolvedValue({ success: true }),
    });
    // No provider match: the row keeps the list item's own title and author, which is what the
    // exclusion identity is then built from.
    vi.spyOn(e2e.services.metadata, 'resolveBook').mockResolvedValue(null);

    const list = await e2e.services.importList.create({
      name: 'NYT Bestsellers',
      type: 'nyt',
      settings: { apiKey: 'key', list: 'audio-fiction' },
    });
    listId = list.id;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await e2e.cleanup();
  });

  /** Make the list due again and run the scheduled path. */
  async function sync(): Promise<void> {
    await e2e.db.update(importLists).set({ nextRunAt: new Date(Date.now() - 60_000) }).where(eq(importLists.id, listId));
    await e2e.services.importList.syncDueLists();
  }

  async function titlesInLibrary(): Promise<string[]> {
    const rows = await e2e.db.select({ title: books.title }).from(books);
    return rows.map((r) => r.title);
  }

  async function listExclusions() {
    const res = await e2e.app.inject({ method: 'GET', url: '/api/import-list-exclusions' });
    expect(res.statusCode).toBe(200);
    return res.json() as { data: { id: number; title: string; authorName: string | null; importListName: string | null; kind: 'added' | 'deleted' }[]; total: number };
  }

  it('deletes, stays deleted across syncs, and comes back once the exclusion is removed', async () => {
    await sync();
    const [created] = await e2e.db.select().from(books);
    expect(created!.title).toBe('The Reckoning');
    expect(created!.importListId).toBe(listId);

    const deleteRes = await e2e.app.inject({ method: 'DELETE', url: `/api/books/${created!.id}` });
    expect(deleteRes.statusCode).toBe(200);
    expect(await titlesInLibrary()).toEqual([]);

    const { data, total } = await listExclusions();
    expect(total).toBe(1);
    expect(data[0]).toMatchObject({
      title: 'The Reckoning',
      authorName: 'Jane Doe',
      importListName: 'NYT Bestsellers',
    });

    await sync();
    expect(await titlesInLibrary()).toEqual([]);

    const undoRes = await e2e.app.inject({
      method: 'DELETE',
      url: `/api/import-list-exclusions/${data[0]!.id}`,
    });
    expect(undoRes.statusCode).toBe(200);
    expect((await listExclusions()).total).toBe(0);

    await sync();
    expect(await titlesInLibrary()).toEqual(['The Reckoning']);
  });

  it('bulk-deletes a missing book, keeps it deleted across syncs, and brings it back once undone (#2329)', async () => {
    await sync();
    const [created] = await e2e.db.select().from(books);
    await e2e.db.update(books).set({ status: 'missing' }).where(eq(books.id, created!.id));

    const deleteRes = await e2e.app.inject({ method: 'DELETE', url: '/api/books/missing' });
    expect(deleteRes.statusCode).toBe(200);
    expect(deleteRes.json()).toEqual({ deleted: 1, failed: 0 });
    expect(await titlesInLibrary()).toEqual([]);

    const { data, total } = await listExclusions();
    expect(total).toBe(1);
    expect(data[0]).toMatchObject({
      title: 'The Reckoning',
      authorName: 'Jane Doe',
      importListName: 'NYT Bestsellers',
    });

    // `syncDueLists` returns void, so the refusal is counted on the completion log — the same
    // observation point `import-list.service.test.ts` uses for these counters.
    const info = vi.spyOn(e2e.app.log, 'info');
    await sync();
    expect(await titlesInLibrary()).toEqual([]);
    expect(info).toHaveBeenCalledWith(expect.objectContaining({ excludedCount: 1 }), 'Import list sync completed');

    const undoRes = await e2e.app.inject({
      method: 'DELETE',
      url: `/api/import-list-exclusions/${data[0]!.id}`,
    });
    expect(undoRes.statusCode).toBe(200);

    await sync();
    expect(await titlesInLibrary()).toEqual(['The Reckoning']);
  });

  it('records no exclusion when a bulk-deleted missing book was added by hand (#2329)', async () => {
    const res = await e2e.app.inject({
      method: 'POST',
      url: '/api/books',
      payload: { title: 'Hand Added', authors: [{ name: 'Jane Doe' }] },
    });
    const bookId = res.json().id as number;
    await e2e.db.update(books).set({ status: 'missing' }).where(eq(books.id, bookId));

    const deleteRes = await e2e.app.inject({ method: 'DELETE', url: '/api/books/missing' });

    expect(deleteRes.json()).toEqual({ deleted: 1, failed: 0 });
    expect(await titlesInLibrary()).toEqual([]);
    expect((await listExclusions()).total).toBe(0);
  });

  it('refuses the same book from a second list of a different provider type', async () => {
    await sync();
    const [created] = await e2e.db.select().from(books);
    await e2e.app.inject({ method: 'DELETE', url: `/api/books/${created!.id}` });

    mockFactories.hardcover!.mockReturnValue({
      fetchItems: vi.fn().mockResolvedValue([ITEM]),
      test: vi.fn().mockResolvedValue({ success: true }),
    });
    const other = await e2e.services.importList.create({
      name: 'Hardcover Shelf',
      type: 'hardcover',
      settings: { apiKey: 'key' },
    });
    await e2e.db.update(importLists).set({ nextRunAt: new Date(Date.now() - 60_000) }).where(eq(importLists.id, other.id));

    await e2e.services.importList.syncDueLists();

    expect(await titlesInLibrary()).toEqual([]);
  });

  it('still lets the operator add the excluded book by hand through POST /api/books', async () => {
    await sync();
    const [created] = await e2e.db.select().from(books);
    await e2e.app.inject({ method: 'DELETE', url: `/api/books/${created!.id}` });
    expect((await listExclusions()).total).toBe(1);

    const res = await e2e.app.inject({
      method: 'POST',
      url: '/api/books',
      payload: { title: 'The Reckoning', authors: [{ name: 'Jane Doe' }] },
    });

    expect(res.statusCode).toBe(201);
    expect(await titlesInLibrary()).toEqual(['The Reckoning']);
  });

  it('records no exclusion when the operator deletes a manually added book', async () => {
    const res = await e2e.app.inject({
      method: 'POST',
      url: '/api/books',
      payload: { title: 'Hand Added', authors: [{ name: 'Jane Doe' }] },
    });
    const bookId = res.json().id as number;

    await e2e.app.inject({ method: 'DELETE', url: `/api/books/${bookId}` });

    expect((await listExclusions()).total).toBe(0);
  });

  it('keeps the source name readable after the originating list is deleted', async () => {
    await sync();
    const [created] = await e2e.db.select().from(books);
    await e2e.app.inject({ method: 'DELETE', url: `/api/books/${created!.id}` });

    await e2e.db.delete(importLists).where(eq(importLists.id, listId));

    const { data } = await listExclusions();
    expect(data[0]!.importListName).toBe('NYT Bestsellers');
  });

  describe('a list-added book whose identity the operator then edits (#2530)', () => {
    /** The exact mutation that produced the incident: title and author both rewritten. */
    async function renameTo(id: number, title: string, author: string): Promise<void> {
      const res = await e2e.app.inject({
        method: 'PUT',
        url: `/api/books/${id}`,
        payload: { title, authors: [{ name: author }] },
      });
      expect(res.statusCode).toBe(200);
    }

    async function syncedBookId(): Promise<number> {
      await sync();
      const [created] = await e2e.db.select().from(books);
      return created!.id;
    }

    it('does not re-add the book after its title and author are edited', async () => {
      // The regression gate for the whole issue: this case fails against develop, where the sync
      // re-derives "have I added this?" from the book's CURRENT identity.
      const id = await syncedBookId();
      await renameTo(id, 'General Thinking Concepts', 'Shane Parrish');

      await sync();

      expect(await titlesInLibrary()).toEqual(['General Thinking Concepts']);
      expect(await e2e.db.select().from(books)).toHaveLength(1);
    });

    it('re-adds once the operator removes the added entry from the undo page', async () => {
      const id = await syncedBookId();
      await renameTo(id, 'General Thinking Concepts', 'Shane Parrish');

      const { data } = await listExclusions();
      expect(data).toHaveLength(1);
      const undo = await e2e.app.inject({ method: 'DELETE', url: `/api/import-list-exclusions/${data[0]!.id}` });
      expect(undo.statusCode).toBe(200);

      await sync();

      expect((await titlesInLibrary()).sort()).toEqual(['General Thinking Concepts', 'The Reckoning']);
    });

    it('leaves exactly one row, of kind deleted, when an UNRENAMED list-added book is deleted', async () => {
      const id = await syncedBookId();

      const del = await e2e.app.inject({ method: 'DELETE', url: `/api/books/${id}` });
      expect(del.statusCode).toBe(200);

      const { data, total } = await listExclusions();
      expect(total).toBe(1);
      expect(data[0]!.kind).toBe('deleted');

      await sync();
      expect(await titlesInLibrary()).toEqual([]);
    });

    it('keeps both refusals when a RENAMED list-added book is deleted, one per identity', async () => {
      // The tombstone can only key on the identity the book has when it is deleted, so it cannot
      // absorb an add-ledger row written under the pre-rename one. Two rows here is correct, not a
      // hidden block: each card names its own title, and removing either does what its copy says.
      const id = await syncedBookId();
      await renameTo(id, 'General Thinking Concepts', 'Shane Parrish');

      const del = await e2e.app.inject({ method: 'DELETE', url: `/api/books/${id}` });
      expect(del.statusCode).toBe(200);

      const { data } = await listExclusions();
      expect(data.map((r) => [r.title, r.kind]).sort()).toEqual([
        ['General Thinking Concepts', 'deleted'],
        ['The Reckoning', 'added'],
      ]);

      await sync();
      expect(await titlesInLibrary()).toEqual([]);
    });

    it('re-adds the original list item after a fix match moves the book to other metadata', async () => {
      const id = await syncedBookId();
      vi.spyOn(e2e.services.metadata, 'lookupForFixMatch').mockResolvedValue({
        kind: 'ok',
        book: { asin: 'B0NEWMATCH', title: 'A Completely Different Book', authors: [{ name: 'Someone Else' }] },
      } as unknown as Awaited<ReturnType<typeof e2e.services.metadata.lookupForFixMatch>>);

      const res = await e2e.app.inject({
        method: 'POST',
        url: `/api/books/${id}/fix-match`,
        payload: { asin: 'B0NEWMATCH' },
      });
      expect(res.statusCode).toBe(200);

      await sync();

      expect((await titlesInLibrary()).sort()).toEqual(['A Completely Different Book', 'The Reckoning']);
    });

    it('surfaces the entry under kind=added and re-adds only after it is deleted — the whole loop', async () => {
      const id = await syncedBookId();
      await renameTo(id, 'General Thinking Concepts', 'Shane Parrish');
      await sync();
      expect(await titlesInLibrary()).toEqual(['General Thinking Concepts']);

      const addedRes = await e2e.app.inject({ method: 'GET', url: '/api/import-list-exclusions?kind=added' });
      expect(addedRes.statusCode).toBe(200);
      const added = addedRes.json() as { data: { id: number; title: string; kind: string }[]; total: number };
      expect(added.total).toBe(1);
      expect(added.data[0]).toMatchObject({ title: 'The Reckoning', kind: 'added' });

      const deletedRes = await e2e.app.inject({ method: 'GET', url: '/api/import-list-exclusions?kind=deleted' });
      expect((deletedRes.json() as { total: number }).total).toBe(0);

      await e2e.app.inject({ method: 'DELETE', url: `/api/import-list-exclusions/${added.data[0]!.id}` });
      await sync();

      expect((await titlesInLibrary()).sort()).toEqual(['General Thinking Concepts', 'The Reckoning']);
    });

    it('records the SEED identity when the provider is down, and re-adds if a later sync resolves differently', async () => {
      // The one identity-drift window this design does not close, pinned as known rather than left
      // to surface as a field report: an outage-era row is keyed on the list item's own title.
      vi.spyOn(e2e.services.metadata, 'resolveBook').mockRejectedValueOnce(new Error('provider unreachable'));
      await sync();
      expect(await titlesInLibrary()).toEqual(['The Reckoning']);

      const { data } = await listExclusions();
      expect(data[0]).toMatchObject({ title: 'The Reckoning', authorName: 'Jane Doe', kind: 'added' });

      vi.spyOn(e2e.services.metadata, 'resolveBook').mockResolvedValue({
        title: 'Reckoning Day', authors: [{ name: 'Jane Doe' }], asin: 'B0RESOLVED1',
      } as unknown as Awaited<ReturnType<typeof e2e.services.metadata.resolveBook>>);

      await sync();

      expect((await titlesInLibrary()).sort()).toEqual(['Reckoning Day', 'The Reckoning']);
    });

    it('creates one book and one added row when the same item appears twice in a batch', async () => {
      // The gate is advisory and reads once per item, so the backstop for a within-batch repeat is
      // the duplicate decision — assert the outcome, not which arm produced it.
      mockFactories.nyt!.mockReturnValue({
        fetchItems: vi.fn().mockResolvedValue([ITEM, { ...ITEM }]),
        test: vi.fn().mockResolvedValue({ success: true }),
      });

      await sync();

      expect(await e2e.db.select().from(books)).toHaveLength(1);
      const { data } = await listExclusions();
      expect(data).toHaveLength(1);
      expect(data[0]!.kind).toBe('added');
    });
  });

  it('touches no other library row when an exclusion is recorded', async () => {
    await sync();
    const other = await e2e.app.inject({
      method: 'POST',
      url: '/api/books',
      payload: { title: 'The Reckoning', authors: [{ name: 'John Roe' }] },
    });
    const otherId = other.json().id as number;
    const [before] = await e2e.db.select().from(books).where(eq(books.id, otherId));

    const [imported] = await e2e.db.select().from(books).where(eq(books.importListId, listId));
    await e2e.app.inject({ method: 'DELETE', url: `/api/books/${imported!.id}` });

    const [after] = await e2e.db.select().from(books).where(eq(books.id, otherId));
    expect(after).toBeDefined();
    expect(after!.updatedAt).toEqual(before!.updatedAt);
  });
});
