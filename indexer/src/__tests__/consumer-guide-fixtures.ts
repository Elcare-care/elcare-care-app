/**
 * Indexer API test fixtures — demonstrates consumer guide patterns
 * Reference: docs/guides/indexer-consumer-guide.md
 */

export const indexerFixtures = {
  /**
   * Health check response with version
   */
  health: {
    status: 200,
    body: {
      status: "healthy",
      lastIndexedLedger: 50000000,
      indexerVersion: "1.0.0",
      uptime: 86400,
    },
    headers: {
      "X-API-Version": "1.0.0",
      "Content-Type": "application/json",
    },
  },

  /**
   * Listing response with decimal fields
   */
  listing: {
    status: 200,
    body: {
      listingId: "42",
      artist: "GABC...XYZ",
      price: "100000000", // 10 XLM in stroops (base units)
      priceDecimal: "10.0000000", // human-readable
      currency: "XLM",
      token: "CDLZ...CYSC",
      status: "Active",
      createdAt: "2026-08-26T10:00:00Z",
      expiresAt: null,
    },
    headers: {
      "X-API-Version": "1.0.0",
      "ETag": '"abc123def456"',
      "Content-Type": "application/json",
    },
  },

  /**
   * Paginated listings response
   */
  listingsList: {
    status: 200,
    body: [
      {
        listingId: "1",
        artist: "GABC...111",
        price: "50000000",
        priceDecimal: "5.0000000",
        token: "CDLZ...CYSC",
        status: "Active",
      },
      {
        listingId: "2",
        artist: "GABC...222",
        price: "200000000",
        priceDecimal: "20.0000000",
        token: "CDLZ...CYSC",
        status: "Active",
      },
    ],
    headers: {
      "X-API-Version": "1.0.0",
      "RateLimit-Limit": "100",
      "RateLimit-Remaining": "95",
      "RateLimit-Reset": "1710000000",
      "Content-Type": "application/json",
    },
  },

  /**
   * Conditional GET (304 Not Modified)
   */
  notModified: {
    status: 304,
    body: null,
    headers: {
      "X-API-Version": "1.0.0",
      "ETag": '"abc123def456"',
    },
  },

  /**
   * Rate limit response (429)
   */
  rateLimited: {
    status: 429,
    body: {
      error: {
        code: "RATE_LIMITED",
        message: "Too many requests",
        class: "client",
        requestId: "req_xyz789",
      },
    },
    headers: {
      "X-API-Version": "1.0.0",
      "Retry-After": "30",
      "RateLimit-Limit": "100",
      "RateLimit-Remaining": "0",
      "RateLimit-Reset": "1710000030",
    },
  },

  /**
   * Error response (404)
   */
  notFound: {
    status: 404,
    body: {
      error: {
        code: "NOT_FOUND",
        message: "Listing not found",
        class: "client",
        requestId: "req_abc123",
      },
    },
    headers: {
      "X-API-Version": "1.0.0",
      "Content-Type": "application/json",
    },
  },

  /**
   * Server error response (500)
   */
  serverError: {
    status: 500,
    body: {
      error: {
        code: "INTERNAL_ERROR",
        message: "Database connection failed",
        class: "server",
        requestId: "req_def456",
      },
    },
    headers: {
      "X-API-Version": "1.0.0",
      "Content-Type": "application/json",
    },
  },

  /**
   * SSE event stream samples
   */
  sseEvents: {
    listingCreated: `event: LISTING_CREATED
id: 1001
data: {"listingId":"42","artist":"GABC...XYZ","price":"100000000","priceDecimal":"10.0000000","token":"CDLZ...CYSC","status":"Active"}`,

    listingUpdated: `event: LISTING_UPDATED
id: 1002
data: {"listingId":"42","price":"150000000","priceDecimal":"15.0000000"}`,

    auctionBid: `event: AUCTION_BID_PLACED
id: 1003
data: {"auctionId":"99","bidder":"GABC...BID","amount":"500000000","amountDecimal":"50.0000000"}`,

    heartbeat: `event: heartbeat
id: 1004
data: :`,

    reset: `event: reset
id: 1005
data: {"reason":"cursor_too_old","since":"42"}`,

    criticalReorg: `event: CRITICAL_REORG
id: 1006
data: {"depth":5,"safeLedger":49999995}`,
  },

  /**
   * Auction response with decimal fields
   */
  auction: {
    status: 200,
    body: {
      auctionId: "99",
      artist: "GABC...ART",
      reservePrice: "100000000",
      reservePriceDecimal: "10.0000000",
      highestBid: "250000000",
      highestBidDecimal: "25.0000000",
      highestBidder: "GABC...BID",
      token: "CDLZ...CYSC",
      status: "Active",
      endsAt: "2026-08-27T10:00:00Z",
    },
    headers: {
      "X-API-Version": "1.0.0",
      "ETag": '"xyz789abc123"',
    },
  },

  /**
   * Offer response with decimal fields
   */
  offer: {
    status: 200,
    body: {
      offerId: "555",
      buyer: "GABC...BUY",
      amount: "75000000",
      amountDecimal: "7.5000000",
      token: "CDLZ...CYSC",
      status: "Pending",
      expiresAt: "2026-08-28T10:00:00Z",
    },
    headers: {
      "X-API-Version": "1.0.0",
    },
  },

  /**
   * Tokens registry response
   */
  tokens: {
    status: 200,
    body: [
      {
        address: "CDLZ...CYSC",
        symbol: "XLM",
        name: "Stellar Lumens",
        decimals: 7,
        whitelisted: true,
      },
      {
        address: "CUSDC...USDC",
        symbol: "USDC",
        name: "USD Coin",
        decimals: 7,
        whitelisted: true,
      },
    ],
    headers: {
      "X-API-Version": "1.0.0",
    },
  },

  /**
   * Unauthorized response (missing operator token)
   */
  unauthorized: {
    status: 401,
    body: {
      error: {
        code: "UNAUTHORIZED",
        message: "Missing or invalid Authorization header",
        class: "client",
        requestId: "req_unauth",
      },
    },
    headers: {
      "X-API-Version": "1.0.0",
    },
  },

  /**
   * Forbidden response (insufficient permissions)
   */
  forbidden: {
    status: 403,
    body: {
      error: {
        code: "FORBIDDEN",
        message: "Operator token lacks admin scope",
        class: "client",
        requestId: "req_forbidden",
      },
    },
    headers: {
      "X-API-Version": "1.0.0",
    },
  },
};

/**
 * Mock fetch for testing consumer code
 */
export function createMockFetch(
  fixtures: Record<string, any>
): (url: string, options?: any) => Promise<Response> {
  return async (url: string, options?: any) => {
    // Route to appropriate fixture
    if (url.includes("/health")) {
      return mockResponse(fixtures.health);
    }
    if (url.includes("/listings/") && !url.includes("?")) {
      return mockResponse(fixtures.listing);
    }
    if (url.includes("/listings?")) {
      return mockResponse(fixtures.listingsList);
    }
    if (url.includes("/auctions/")) {
      return mockResponse(fixtures.auction);
    }
    if (url.includes("/offers/")) {
      return mockResponse(fixtures.offer);
    }
    if (url.includes("/tokens")) {
      return mockResponse(fixtures.tokens);
    }

    // Check for conditional GET
    if (options?.headers?.["If-None-Match"]) {
      return mockResponse(fixtures.notModified);
    }

    // Default 404
    return mockResponse(fixtures.notFound);
  };
}

/**
 * Helper: Create mock Response object
 */
function mockResponse(fixture: any): Response {
  const headers = new Headers(fixture.headers || {});

  return new Response(
    fixture.body ? JSON.stringify(fixture.body) : null,
    {
      status: fixture.status,
      headers,
    }
  );
}

/**
 * Helper: Create mock EventSource for SSE testing
 */
export class MockEventSource {
  url: string;
  onmessage: ((e: any) => void) | null = null;
  onerror: ((e: any) => void) | null = null;

  constructor(url: string) {
    this.url = url;
  }

  close() {
    // Mock close
  }

  // Simulate sending events
  simulateEvent(eventData: string) {
    const lines = eventData.split("\n");
    const event: any = {};

    for (const line of lines) {
      if (line.startsWith("event: ")) {
        event.type = line.slice(7);
      } else if (line.startsWith("id: ")) {
        event.lastEventId = line.slice(4);
      } else if (line.startsWith("data: ")) {
        event.data = line.slice(6);
      }
    }

    if (this.onmessage) {
      this.onmessage(event);
    }
  }

  simulateError() {
    if (this.onerror) {
      this.onerror(new Event("error"));
    }
  }
}

/**
 * Test scenario: Retry with exponential backoff
 */
export const retryScenario = {
  description: "Client retries 429 with exponential backoff",
  steps: [
    { attempt: 1, response: "429 Retry-After: 1", delay: 1000 },
    { attempt: 2, response: "429 Retry-After: 2", delay: 2000 },
    { attempt: 3, response: "200 OK", delay: 0 },
  ],
};

/**
 * Test scenario: SSE reconnect with cursor
 */
export const sseReconnectScenario = {
  description: "Client reconnects SSE with Last-Event-ID",
  steps: [
    { action: "Connect", headers: {} },
    { action: "Receive events", ids: [1001, 1002, 1003] },
    { action: "Connection lost" },
    { action: "Reconnect", headers: { "Last-Event-ID": "1003" } },
    { action: "Receive new events", ids: [1004, 1005] },
  ],
};

/**
 * Test scenario: Reset event handling
 */
export const resetScenario = {
  description: "Client handles reset event and refetches state",
  steps: [
    { action: "Receive reset event", reason: "cursor_too_old" },
    { action: "Clear local cache" },
    { action: "Refetch /listings from REST" },
    { action: "Refetch /auctions from REST" },
    { action: "Reconnect SSE without Last-Event-ID" },
  ],
};
