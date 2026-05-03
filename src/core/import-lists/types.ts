export interface ImportListItem {
  title: string;
  author?: string | undefined;
  asin?: string | undefined;
  isbn?: string | undefined;
}

export interface ImportListProvider {
  readonly type: string;
  readonly name: string;

  fetchItems(): Promise<ImportListItem[]>;
  test(): Promise<{ success: boolean; message?: string | undefined }>;
}
