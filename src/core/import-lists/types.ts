export interface ImportListItem {
  title: string;
  author?: string | undefined;
  asin?: string | undefined;
  /** Other ASINs naming the same recording, for the resolver to fall through to when `asin` misses. */
  alternateAsins?: string[] | undefined;
  isbn?: string | undefined;
  coverUrl?: string | undefined;
  description?: string | undefined;
}

export interface ImportListProvider {
  readonly type: string;
  readonly name: string;

  fetchItems(): Promise<ImportListItem[]>;
  test(): Promise<{ success: boolean; message?: string | undefined }>;
}
