# Hardcover API Spec — Narratorr Reference

> Distilled API surface for the Narratorr metadata provider.  
> Full docs: https://docs.hardcover.app  
> Status: API is in beta and may change.

---

## Connection

| Item | Value |
|------|-------|
| Endpoint | `https://api.hardcover.app/v1/graphql` |
| Protocol | GraphQL (POST JSON, `{ query, variables }`) |
| Auth header | `authorization: <token>` (bare token, **not** `Bearer`) |
| Token source | User's account → https://hardcover.app/account/api |
| Rate limit | 60 requests/minute |
| Query timeout | 30 seconds |
| Max query depth | 3 |
| Token expiry | Resets annually on Jan 1 |

### Minimal fetch example

```typescript
async function hardcoverQuery<T>(query: string, variables?: Record<string, unknown>, apiKey: string): Promise<T> {
  const res = await fetch('https://api.hardcover.app/v1/graphql', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: apiKey,
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`Hardcover ${res.status}: ${res.statusText}`);
  const json = await res.json();
  if (json.errors?.length) throw new Error(json.errors[0].message);
  return json.data as T;
}
```

No GraphQL client library needed — plain `fetch` + query strings is sufficient.

---

## 1. Search (Typesense-backed)

Single `search()` field; change `query_type` for books, authors, or series.

### Query

```graphql
query Search($q: String!, $type: String!, $perPage: Int, $page: Int) {
  search(
    query: $q
    query_type: $type
    per_page: $perPage
    page: $page
  ) {
    results
  }
}
```

### Variables

| Param | Type | Default | Notes |
|-------|------|---------|-------|
| `query` | String! | — | Search term |
| `query_type` | String | `"Book"` | `"Book"`, `"Author"`, `"Series"` (case-insensitive) |
| `per_page` | Int | 25 | Max results per page |
| `page` | Int | 1 | 1-indexed |
| `sort` | String | relevance | e.g. `"users_count:desc"`, `"activities_count:desc"` |
| `fields` | String | varies | Comma-separated searchable fields |
| `weights` | String | varies | Comma-separated weights matching fields |

### Response shape

```json
{
  "data": {
    "search": {
      "results": [ { "document": { ... }, "text_match": 123 }, ... ]
    }
  }
}
```

Each item in `results` is a Typesense hit. The `document` contains the fields listed below.

### Book search document fields

| Field | Type | Notes |
|-------|------|-------|
| `id` | number | Hardcover book ID |
| `title` | string | |
| `subtitle` | string | |
| `slug` | string | URL path: `https://hardcover.app/books/{slug}` |
| `author_names` | string[] | |
| `series_names` | string[] | |
| `description` | string | |
| `release_year` | number | |
| `pages` | number | |
| `audio_seconds` | number | Audiobook duration (seconds); 0 or absent = no audiobook |
| `has_audiobook` | boolean | |
| `has_ebook` | boolean | |
| `rating` | number | 0–5 |
| `ratings_count` | number | |
| `users_count` | number | Users who shelved this book |
| `genres` | string[] | Top 5 user-generated genre tags |
| `isbns` | string[] | All known ISBNs |
| `image` | string or object | Cover URL or `{ url }` (inspect at runtime) |
| `contributions` | object[] | `[{ author: { name, slug, id } }]` |
| `featured_series` | object or null | `{ name, slug, id, position }` |

Default search fields: `title, isbns, series_names, author_names, alternative_titles`  
Default weights: `5, 5, 3, 1, 1`  
Default sort: `_text_match:desc, users_count:desc`

### Author search document fields

| Field | Type | Notes |
|-------|------|-------|
| `id` | number | Hardcover author ID |
| `name` | string | |
| `name_personal` | string | First/personal name |
| `slug` | string | `https://hardcover.app/authors/{slug}` |
| `books_count` | number | |
| `books` | string[] | Titles of top 5 books |
| `series_names` | string[] | |
| `image` | object | `{ url, width, height, color }` |

### Series search document fields

| Field | Type | Notes |
|-------|------|-------|
| `id` | number | Hardcover series ID |
| `name` | string | |
| `slug` | string | `https://hardcover.app/series/{slug}` |
| `author_name` | string | Primary author |
| `books_count` | number | |
| `primary_books_count` | number | Main entries (excludes 0.5, etc.) |
| `books` | string[] | Book titles |
| `readers_count` | number | Sum of read counts |

---

## 2. Get Book by ID

Use when you have a Hardcover `id` (from search results).

```graphql
query GetBook($id: Int!) {
  books(where: { id: { _eq: $id } }, limit: 1) {
    id
    title
    subtitle
    slug
    description
    release_date
    release_year
    pages
    audio_seconds
    rating
    cached_image
    cached_tags
    cached_contributors
    contributions {
      contribution   # "Author", "Narrator", etc.
      author {
        id
        name
        slug
        cached_image
      }
    }
    featured_book_series {
      position
      series {
        id
        name
        slug
      }
    }
    default_audio_edition {
      id
      asin
      isbn_13
      audio_seconds
      publisher { name }
      release_date
    }
    editions(
      where: { reading_format_id: { _eq: 2 } }
      order_by: { users_count: desc }
      limit: 5
    ) {
      id
      asin
      isbn_13
      audio_seconds
      publisher { name }
      release_date
    }
  }
}
```

### Key fields

| Field | Type | Notes |
|-------|------|-------|
| `cached_image` | jsonb | `{ url: "https://...", width, height, color }` |
| `cached_tags` | json | `{ "Genre": ["Fantasy", ...], "Mood": [...] }` |
| `cached_contributors` | json | `[{ id, name, contribution, image }]` — fast alternative to `contributions` |
| `contributions[].contribution` | string | Role: `"Author"`, `"Narrator"`, `"Illustrator"`, etc. |
| `featured_book_series` | object | `{ position: number, series: { id, name, slug } }` |
| `default_audio_edition` | object or null | Best audiobook edition; has `asin`, `isbn_13`, `audio_seconds` |
| `editions` | array | Filter by `reading_format_id: 2` for audiobooks |

### Reading format IDs

| ID | Format |
|----|--------|
| 1 | Physical |
| 2 | Audio |
| 3 | EBook |

---

## 3. Get Author by ID

```graphql
query GetAuthor($id: Int!) {
  authors(where: { id: { _eq: $id } }, limit: 1) {
    id
    name
    slug
    bio
    books_count
    cached_image
    contributions(
      where: { contributable_type: { _eq: "Book" } }
      order_by: { book: { users_count: desc } }
      limit: 50
    ) {
      contribution
      book {
        id
        title
        slug
        release_year
        audio_seconds
        rating
        cached_image
        featured_book_series {
          position
          series {
            id
            name
            slug
          }
        }
      }
    }
  }
}
```

### Notes
- `cached_image`: `{ url, width, height, color }`.
- `contributions` with `contributable_type: "Book"` returns book-level contributions.
- Filter `contribution: "Author"` to get books they wrote (vs narrated/illustrated).

---

## 4. Get Series by ID

```graphql
query GetSeries($id: Int!) {
  series(where: { id: { _eq: $id } }, limit: 1) {
    id
    name
    slug
    description
    books_count
    primary_books_count
    author {
      id
      name
      slug
    }
    book_series(
      where: {
        book: { compilation: { _eq: false } }
      }
      order_by: { position: asc }
    ) {
      position
      book {
        id
        title
        slug
        release_year
        audio_seconds
        rating
        cached_image
        cached_contributors
      }
    }
  }
}
```

### Notes
- `book_series` is the join table; `position` is the book's number in the series (float — can be 0.5, 1, 1.5, etc.).
- Filter `compilation: false` to skip anthologies/omnibus editions.
- Duplicates may exist (same position, different title); prefer the entry with higher `users_read_count`.

---

## 5. Mapping to Narratorr schemas

| Narratorr field | Hardcover source |
|-----------------|-----------------|
| **BookMetadata.title** | `title` |
| **BookMetadata.subtitle** | `subtitle` |
| **BookMetadata.authors** | `contributions` where `contribution == "Author"` → `[{ name, asin? }]`; or `cached_contributors` → filter by role |
| **BookMetadata.narrators** | `contributions` where `contribution == "Narrator"` → `name[]`; or `cached_contributors` |
| **BookMetadata.series** | `featured_book_series` → `[{ name, position }]` |
| **BookMetadata.description** | `description` |
| **BookMetadata.publisher** | `default_audio_edition.publisher.name` |
| **BookMetadata.publishedDate** | `release_date` or `release_year` |
| **BookMetadata.coverUrl** | `cached_image.url` (or search `image`) |
| **BookMetadata.duration** | `audio_seconds / 60` (schema expects minutes) |
| **BookMetadata.genres** | `cached_tags["Genre"]` or search `genres` |
| **BookMetadata.asin** | `default_audio_edition.asin` or from `editions` |
| **BookMetadata.isbn** | `default_audio_edition.isbn_13` or `isbns[0]` |
| **AuthorMetadata.name** | `name` |
| **AuthorMetadata.description** | `bio` |
| **AuthorMetadata.imageUrl** | `cached_image.url` |
| **AuthorMetadata.genres** | From search: `series_names` or aggregate from books |
| **SeriesMetadata.name** | `name` |
| **SeriesMetadata.description** | `description` |
| **SeriesMetadata.books** | `book_series[].book` mapped to BookMetadata[] |

### IDs

Hardcover uses integer IDs (not ASINs). The `MetadataProvider` interface currently uses `string` for `getBook(id)`, `getAuthor(id)`, etc. Pass Hardcover IDs as strings (e.g. `"328491"`). ASINs are available from `editions.asin` when present.

---

## 6. Limitations / gotchas

- **No `_like`/`_ilike`/regex** — use the `search()` endpoint for text search, not `where` clauses.
- **Max depth 3** — can't nest relationships more than 3 levels deep.
- **Rate limit** — 60 req/min. Batch where possible (search returns 25 results per call).
- **Search returns raw Typesense hits** — `results` is an opaque JSON blob, not typed GraphQL. Parse at runtime.
- **`cached_image`** — JSON object with `{ url, width, height, color }`. The `url` may be a CDN path.
- **Audiobook data quality** — Not all books have `audio_seconds` or audiobook editions. Use `has_audiobook` from search to filter.
- **Token format** — Bare token in `authorization` header (not `Bearer <token>`). Some blog posts show `Bearer`; test both if issues arise.
- **Duplicates in series** — `book_series` can have multiple entries at the same position; dedupe by `users_read_count`.
