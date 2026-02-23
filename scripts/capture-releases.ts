#!/usr/bin/env node
/**
 * Captures audiobook release names from Prowlarr indexers to build a parser corpus.
 *
 * Usage:
 *   npx tsx scripts/capture-releases.ts --url http://192.168.0.22:9696 --key <apikey> [--output path]
 *
 * Queries each enabled indexer via Prowlarr's Torznab/Newznab proxy for common audiobook
 * search terms, deduplicates titles, and writes a JSON corpus file for parser development.
 */

import { parseArgs } from 'node:util';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

interface CorpusEntry {
  raw: string;
  source: 'torznab' | 'newznab';
  indexer: string;
  capturedAt: string;
  expected: { author: string; title: string } | null;
}

interface ProwlarrIndexer {
  id: number;
  name: string;
  protocol: string;
  enable: boolean;
  capabilities?: {
    categories?: Array<{
      id: number;
      subCategories?: Array<{ id: number }>;
    }>;
  };
}

const SEARCH_TERMS = [
  'brandon sanderson',
  'stephen king',
  'joe abercrombie',
  'project hail mary',
  'terry pratchett',
  'neil gaiman',
  'audiobook',
  'narrated by',
  'patrick rothfuss',
  'robert jordan',
  'andy weir',
  'tom clancy',
  'discworld',
];

const DEFAULT_OUTPUT = 'packages/core/src/__tests__/fixtures/release-corpus.json';

async function main() {
  const { values } = parseArgs({
    options: {
      url: { type: 'string' },
      key: { type: 'string' },
      output: { type: 'string', default: DEFAULT_OUTPUT },
    },
  });

  if (!values.url || !values.key) {
    console.error('Usage: npx tsx scripts/capture-releases.ts --url <prowlarr-url> --key <api-key> [--output <path>]');
    process.exit(1);
  }

  const baseUrl = values.url.replace(/\/$/, '');
  const apiKey = values.key;
  const outputPath = resolve(values.output!);

  // Load existing corpus to preserve manual entries and expected values
  let existing: CorpusEntry[] = [];
  if (existsSync(outputPath)) {
    existing = JSON.parse(readFileSync(outputPath, 'utf-8'));
    console.log(`Loaded ${existing.length} existing corpus entries`);
  }
  const existingRaw = new Set(existing.map((e) => e.raw));

  // Fetch indexer list
  console.log('Fetching indexer list...');
  const indexerRes = await fetch(`${baseUrl}/api/v1/indexer`, {
    headers: { 'X-Api-Key': apiKey },
  });
  if (!indexerRes.ok) {
    console.error(`Failed to fetch indexers: ${indexerRes.status} ${indexerRes.statusText}`);
    process.exit(1);
  }
  const indexers: ProwlarrIndexer[] = await indexerRes.json();

  // Filter to enabled indexers with audio categories
  const audioIndexers = indexers.filter((i) => {
    if (!i.enable) return false;
    const cats: number[] = [];
    for (const c of i.capabilities?.categories ?? []) {
      cats.push(c.id);
      for (const s of c.subCategories ?? []) cats.push(s.id);
    }
    return cats.some((id) => id >= 3000 && id < 4000);
  });

  console.log(`Found ${audioIndexers.length} audio-capable indexers: ${audioIndexers.map((i) => i.name).join(', ')}`);

  const newEntries: CorpusEntry[] = [];
  const seenTitles = new Set(existingRaw);
  const today = new Date().toISOString().slice(0, 10);

  for (const indexer of audioIndexers) {
    const source = indexer.protocol === 'torrent' ? 'torznab' : 'newznab';

    for (const term of SEARCH_TERMS) {
      const q = encodeURIComponent(term);
      const url = `${baseUrl}/${indexer.id}/api?t=search&q=${q}&cat=3030&limit=20`;

      try {
        const res = await fetch(url, { headers: { 'X-Api-Key': apiKey } });
        if (!res.ok) {
          console.warn(`  ${indexer.name} / "${term}" — HTTP ${res.status}`);
          continue;
        }

        const xml = await res.text();
        // Extract titles from XML using regex (avoid XML parser dep)
        const titleMatches = xml.matchAll(/<item>\s*<title>([^<]+)<\/title>/g);
        for (const match of titleMatches) {
          const raw = match[1]
            .replace(/&amp;/g, '&')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"')
            .replace(/&#39;/g, "'")
            .trim();

          if (!raw || seenTitles.has(raw)) continue;
          seenTitles.add(raw);

          newEntries.push({
            raw,
            source,
            indexer: indexer.name,
            capturedAt: today,
            expected: null,
          });
        }

        console.log(`  ${indexer.name} / "${term}" — ${newEntries.length} total new`);
      } catch (err) {
        console.warn(`  ${indexer.name} / "${term}" — ${err instanceof Error ? err.message : 'unknown error'}`);
      }

      // Rate limit: 200ms between requests
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  // Merge: existing entries first (preserves expected values), then new
  const merged = [...existing, ...newEntries];
  writeFileSync(outputPath, JSON.stringify(merged, null, 2) + '\n');
  console.log(`\nWrote ${merged.length} entries (${newEntries.length} new) to ${outputPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
