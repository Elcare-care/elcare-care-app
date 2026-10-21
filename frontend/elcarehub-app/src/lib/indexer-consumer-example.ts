/**
 * Minimal indexer consumer example — demonstrates reliable API patterns
 * Reference: docs/guides/indexer-consumer-guide.md
 */

interface IndexerConfig {
  baseUrl: string;
  operatorToken?: string;
  supportedApiVersion: string;
}

interface ListingResponse {
  listingId: string;
  price: string; // base units as string
  priceDecimal: string; // human-readable
  token: string;
  status: string;
}

interface RateLimitHeaders {
  limit: number;
  remaining: number;
  reset: number;
}

// GET /listings wraps the page in this envelope whenever limit/offset is set
interface ListingsPage {
  listings: ListingResponse[];
  total: number;
}

class IndexerConsumer {
  private config: IndexerConfig;
  private lastEventId: string | null = null;

  constructor(config: IndexerConfig) {
    this.config = config;
  }

  /**
   * Version negotiation — verify API compatibility at startup
   */
  async checkVersion(): Promise<boolean> {
    const res = await fetch(`${this.config.baseUrl}/health`);
    const version = res.headers.get("X-API-Version");

    if (!version) {
      console.warn("No X-API-Version header");
      return false;
    }

    if (version !== this.config.supportedApiVersion) {
      console.error(
        `Version mismatch: server ${version}, client ${this.config.supportedApiVersion}`
      );
      return false;
    }

    console.log(`✓ API version ${version}`);
    return true;
  }

  /**
   * Fetch listing with ETag caching
   */
  async getListing(
    listingId: string,
    etag?: string
  ): Promise<ListingResponse | null> {
    const headers: Record<string, string> = {};
    if (etag) headers["If-None-Match"] = etag;

    const res = await fetch(`${this.config.baseUrl}/listings/${listingId}`, {
      headers,
    });

    if (res.status === 304) {
      console.log("✓ Listing unchanged (304)");
      return null;
    }

    if (!res.ok) {
      const error = await res.json();
      console.error(`Error: ${error.error.code} (${error.error.requestId})`);
      return null;
    }

    const listing = (await res.json()) as ListingResponse;

    // Verify BigInt fields are strings
    if (typeof listing.price !== "string") {
      throw new Error("price must be string, not number");
    }

    console.log(
      `✓ Listing ${listingId}: ${listing.priceDecimal} ${listing.token}`
    );
    return listing;
  }

  /**
   * One page of listings (offset pagination) with rate limit handling
   */
  async listListings(offset: number = 0, limit: number = 20): Promise<
    ListingsPage & { rateLimits: RateLimitHeaders }
  > {
    const res = await fetch(
      `${this.config.baseUrl}/listings?limit=${limit}&offset=${offset}`
    );

    if (res.status === 429) {
      const retryAfter = res.headers.get("Retry-After");
      console.warn(`Rate limited. Retry after ${retryAfter}s`);
      throw new Error("RATE_LIMITED");
    }

    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const { listings, total } = (await res.json()) as ListingsPage;
    const rateLimits: RateLimitHeaders = {
      limit: parseInt(res.headers.get("RateLimit-Limit") || "0"),
      remaining: parseInt(res.headers.get("RateLimit-Remaining") || "0"),
      reset: parseInt(res.headers.get("RateLimit-Reset") || "0"),
    };

    console.log(
      `✓ Fetched ${listings.length} listings (${rateLimits.remaining}/${rateLimits.limit} remaining)`
    );
    return { listings, total, rateLimits };
  }

  /**
   * Walk every page of listings. Pagination ends at an empty page, so a
   * short (non-empty) final page is still yielded before stopping.
   * The offset and `total` count rows before moderated listings are filtered
   * out, so a page can hold fewer than `limit` items (or none) mid-stream:
   * always advance by `limit`, and only treat an empty page as the end once
   * `total` says no rows follow it.
   * The API caps `offset` at 10 000; for larger catalogues poll by ledger
   * instead (see the guide).
   */
  async *listAllListings(limit: number = 20): AsyncGenerator<ListingResponse[]> {
    for (let offset = 0; ; offset += limit) {
      const { listings, total } = await this.listListings(offset, limit);
      if (listings.length === 0) {
        if (offset + limit >= total) return; // no further records
        continue; // every row on this page was moderated out
      }
      yield listings;
    }
  }

  /**
   * SSE connection with cursor resume and reset handling
   */
  subscribeToEvents(onEvent: (event: any) => void): () => void {
    const connect = () => {
      const headers: Record<string, string> = {};
      if (this.lastEventId) {
        headers["Last-Event-ID"] = this.lastEventId;
      }

      const es = new EventSource(
        `${this.config.baseUrl}/events`,
        { headers } as any
      );

      es.onmessage = (e) => {
        try {
          const data = JSON.parse(e.data);
          this.lastEventId = e.lastEventId || this.lastEventId;

          if (e.type === "reset") {
            console.warn(`Reset event: ${data.reason}`);
            es.close();
            setTimeout(connect, 1000); // Reconnect and refetch
            return;
          }

          onEvent(data);
        } catch (err) {
          console.error("Parse error:", err);
        }
      };

      es.onerror = () => {
        console.warn("SSE connection lost, reconnecting…");
        es.close();
        setTimeout(connect, 5000);
      };

      return () => es.close();
    };

    return connect();
  }

  /**
   * Exponential backoff retry for idempotent GETs
   */
  async retryGet<T>(
    url: string,
    maxAttempts: number = 3
  ): Promise<T | null> {
    let delay = 500;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const res = await fetch(url);

        if (res.status === 429) {
          const retryAfter = parseInt(res.headers.get("Retry-After") || "30");
          delay = retryAfter * 1000;
          console.warn(`Rate limited, waiting ${retryAfter}s`);
        } else if (res.ok) {
          return res.json();
        } else if (res.status >= 500) {
          console.warn(`Server error ${res.status}, retrying…`);
        } else {
          return null; // Client error, don't retry
        }
      } catch (err) {
        console.warn(`Attempt ${attempt} failed:`, err);
      }

      if (attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, delay));
        delay = Math.min(delay * 2, 30000);
      }
    }

    return null;
  }

  /**
   * Authenticated operator call (server-side only)
   */
  async adminCall(endpoint: string, method: string = "GET"): Promise<any> {
    if (!this.config.operatorToken) {
      throw new Error("operatorToken required for admin calls");
    }

    const res = await fetch(`${this.config.baseUrl}${endpoint}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.config.operatorToken}`,
      },
    });

    if (!res.ok) {
      const error = await res.json();
      throw new Error(`${error.error.code}: ${error.error.message}`);
    }

    return res.json();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Usage example (browser-safe, no credentials)
// ─────────────────────────────────────────────────────────────────────────────

async function example() {
  const consumer = new IndexerConsumer({
    baseUrl: "http://localhost:4000",
    supportedApiVersion: "1.0.0",
  });

  // 1. Verify API version
  await consumer.checkVersion();

  // 2. Fetch listing with ETag
  const listing = await consumer.getListing("42");
  if (listing) {
    console.log(`Price: ${listing.priceDecimal} (raw: ${listing.price})`);
  }

  // 3. Paginated list, until an empty page ends pagination
  for await (const page of consumer.listAllListings(10)) {
    console.log(`Fetched ${page.length} listings`);
  }

  // 4. Subscribe to SSE
  const unsubscribe = consumer.subscribeToEvents((event) => {
    console.log("Event:", event);
  });

  // 5. Retry pattern
  const health = await consumer.retryGet("/health");
  console.log("Health:", health);

  // Cleanup
  unsubscribe();
}

export { IndexerConsumer, IndexerConfig, ListingResponse };
