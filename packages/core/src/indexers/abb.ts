import * as cheerio from 'cheerio';
import type { IndexerAdapter, SearchResult, SearchOptions } from './types.js';
import { buildMagnetUri } from '../utils';

export interface ABBConfig {
  hostname: string; // e.g., 'audiobookbay.lu'
  pageLimit: number; // Max pages to scrape per search
}

const DEFAULT_USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
];

export class AudioBookBayIndexer implements IndexerAdapter {
  readonly type = 'abb';
  readonly name = 'AudioBookBay';

  private baseUrl: string;
  private userAgentIndex = 0;

  constructor(private config: ABBConfig) {
    this.baseUrl = `https://${config.hostname}`;
  }

  async search(query: string, options?: SearchOptions): Promise<SearchResult[]> {
    const results: SearchResult[] = [];
    const encodedQuery = encodeURIComponent(query.toLowerCase()).replace(/%20/g, '+');
    const limit = options?.limit || 50;
    const pageLimit = this.config.pageLimit || 2;

    for (let page = 1; page <= pageLimit; page++) {
      // ABB search URL format: /?s=query&tt=1 (tt=1 filters to audiobooks)
      const url = page === 1
        ? `${this.baseUrl}/?s=${encodedQuery}&tt=1`
        : `${this.baseUrl}/page/${page}/?s=${encodedQuery}&tt=1`;

      try {
        const html = await this.fetchPage(url);
        const pageResults = this.parseSearchPage(html);

        if (pageResults.length === 0) {
          break; // No more results
        }

        // Fetch detail pages to get info hashes (with rate limiting)
        for (const result of pageResults) {
          if (result.detailsUrl) {
            try {
              // Add small delay to avoid rate limiting
              await this.delay(500);
              const detailHtml = await this.fetchPage(result.detailsUrl);
              const details = this.parseDetailPage(detailHtml);
              Object.assign(result, details);
            } catch {
              // Skip detail page failures — result won't have download URL and will be filtered out
            }
          }

          // Only include results with download URLs
          if (result.downloadUrl) {
            results.push(result);
          }

          if (results.length >= limit) {
            return results;
          }
        }
      } catch {
        break; // Stop pagination on fetch failure
      }
    }

    return results;
  }

  private async fetchPage(url: string): Promise<string> {
    const userAgent = this.getNextUserAgent();

    const response = await fetch(url, {
      headers: {
        'User-Agent': userAgent,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        Connection: 'keep-alive',
        'Upgrade-Insecure-Requests': '1',
      },
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    return response.text();
  }

  private parseSearchPage(html: string): SearchResult[] {
    const $ = cheerio.load(html);
    const results: SearchResult[] = [];

    // AudioBookBay uses various structures, try multiple selectors
    const postSelectors = [
      'div.post',
      'article.post',
      '.post-content',
      'div[class*="post"]',
    ];

    let posts = $('');
    for (const selector of postSelectors) {
      posts = $(selector);
      if (posts.length > 0) break;
    }

    posts.each((_, element) => {
      const $el = $(element);

      // Try to find the title and link
      const titleSelectors = [
        '.postTitle h2 a',
        '.postTitle a',
        'h2 a',
        'h3 a',
        '.entry-title a',
        'a[rel="bookmark"]',
      ];

      let titleEl = $('');
      for (const selector of titleSelectors) {
        titleEl = $el.find(selector).first();
        if (titleEl.length > 0) break;
      }

      const title = titleEl.text().trim();
      let detailsUrl = titleEl.attr('href');

      if (!title || !detailsUrl) return;

      // Ensure absolute URL
      if (detailsUrl && !detailsUrl.startsWith('http')) {
        detailsUrl = `${this.baseUrl}${detailsUrl.startsWith('/') ? '' : '/'}${detailsUrl}`;
      }

      // Try to find cover image
      const coverUrl = $el.find('img').first().attr('src') ||
                       $el.find('img').first().attr('data-src');

      // Try to extract metadata from the post
      const postText = $el.text();
      const author = this.extractField(postText, ['Author:', 'Written by:', 'By:']);
      const narrator = this.extractField(postText, ['Narrator:', 'Narrated by:', 'Read by:']);

      results.push({
        title,
        author,
        narrator,
        protocol: 'torrent',
        detailsUrl,
        coverUrl,
        indexer: this.name,
      });
    });

    return results;
  }

  private parseDetailPage(html: string): Partial<SearchResult> {
    const $ = cheerio.load(html);
    const result: Partial<SearchResult> = {};

    // Extract info hash - it's typically displayed as plain text
    // Common patterns: "Info Hash: abc123..." or in a table
    const infoHashPatterns = [
      /Info\s*Hash[:\s]*([a-f0-9]{40})/i,
      /infohash[:\s]*([a-f0-9]{40})/i,
      /hash[:\s]*([a-f0-9]{40})/i,
      /([a-f0-9]{40})/i, // Last resort: any 40-char hex string
    ];

    // First, try to find in specific elements that commonly contain the hash
    const hashContainers = [
      'td:contains("Info Hash")',
      '.torrent-detail',
      '.info-hash',
      '#info-hash',
      'pre',
      'code',
    ];

    let foundHash = false;
    for (const container of hashContainers) {
      const text = $(container).text();
      for (const pattern of infoHashPatterns) {
        const match = text.match(pattern);
        if (match && match[1]) {
          result.infoHash = match[1].toLowerCase();
          foundHash = true;
          break;
        }
      }
      if (foundHash) break;
    }

    // Extract page text once for reuse
    const pageText = $('body').text();

    // If not found in specific containers, search the whole page
    if (!foundHash) {
      for (const pattern of infoHashPatterns) {
        const match = pageText.match(pattern);
        if (match && match[1]) {
          result.infoHash = match[1].toLowerCase();
          break;
        }
      }
    }

    // Build magnet URI (download URL) if we have an info hash
    if (result.infoHash) {
      const title = $('h1, .postTitle h2, article h2').first().text().trim();
      result.downloadUrl = buildMagnetUri(result.infoHash, title || undefined);
    }

    // Extract additional metadata from the detail page

    // Author
    if (!result.author) {
      result.author = this.extractField(pageText, [
        'Author:',
        'Written by:',
        'By:',
      ]);
    }

    // Narrator
    if (!result.narrator) {
      result.narrator = this.extractField(pageText, [
        'Narrator:',
        'Narrated by:',
        'Read by:',
      ]);
    }

    // Size
    const sizeMatch = pageText.match(/Size[:\s]*([\d.]+)\s*(MB|GB|TB)/i);
    if (sizeMatch?.[1] && sizeMatch[2]) {
      result.size = this.parseSize(sizeMatch[1], sizeMatch[2]);
    }

    // Try to find seeders (may not be available on ABB)
    const seedersMatch = pageText.match(/Seeders?[:\s]*(\d+)/i);
    if (seedersMatch) {
      result.seeders = parseInt(seedersMatch[1], 10);
    }

    const leechersMatch = pageText.match(/Leechers?[:\s]*(\d+)/i);
    if (leechersMatch) {
      result.leechers = parseInt(leechersMatch[1], 10);
    }

    return result;
  }

  private extractField(text: string, labels: string[]): string | undefined {
    for (const label of labels) {
      const regex = new RegExp(`${label}\\s*([^\\n]+)`, 'i');
      const match = text.match(regex);
      if (match) {
        return match[1].trim().replace(/^[:\s]+/, '').trim();
      }
    }
    return undefined;
  }

  private parseSize(value: string, unit: string): number {
    const num = parseFloat(value);
    const multipliers: Record<string, number> = {
      KB: 1024,
      MB: 1024 * 1024,
      GB: 1024 * 1024 * 1024,
      TB: 1024 * 1024 * 1024 * 1024,
    };
    return Math.round(num * (multipliers[unit.toUpperCase()] || 1));
  }

  private getNextUserAgent(): string {
    const ua = DEFAULT_USER_AGENTS[this.userAgentIndex];
    this.userAgentIndex = (this.userAgentIndex + 1) % DEFAULT_USER_AGENTS.length;
    return ua;
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async test(): Promise<{ success: boolean; message?: string }> {
    try {
      const response = await fetch(this.baseUrl, {
        method: 'HEAD',
        headers: {
          'User-Agent': this.getNextUserAgent(),
        },
      });

      if (response.ok || response.status === 405) {
        // 405 Method Not Allowed is okay for HEAD requests
        return { success: true, message: `Connected to ${this.config.hostname}` };
      }

      return {
        success: false,
        message: `HTTP ${response.status}: ${response.statusText}`,
      };
    } catch (error) {
      return {
        success: false,
        message: error instanceof Error ? error.message : 'Connection failed',
      };
    }
  }
}
