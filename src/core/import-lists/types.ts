export interface ImportListItem {
  title: string;
  author?: string;
  asin?: string;
  isbn?: string;
}

export interface ImportListProvider {
  readonly type: string;
  readonly name: string;

  fetchItems(): Promise<ImportListItem[]>;
  test(): Promise<{ success: boolean; message?: string }>;
}
