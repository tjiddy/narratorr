interface BookSnapshot {
  title: string;
  authors?: Array<{ name: string }> | null;
  narrators?: Array<{ name: string }> | null;
}

export function snapshotBookForEvent(book: BookSnapshot): {
  bookTitle: string;
  authorName: string | null;
  narratorName: string | null;
} {
  return {
    bookTitle: book.title,
    authorName: book.authors?.length ? book.authors.map(a => a.name).join(', ') : null,
    narratorName: book.narrators?.length ? book.narrators.map(n => n.name).join(', ') : null,
  };
}
