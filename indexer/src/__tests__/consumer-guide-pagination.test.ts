import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { IndexerConsumer } from '../../../frontend/elcarehub-app/src/lib/indexer-consumer-example.js';
import { indexerFixtures, createPagedListingsFetch } from './consumer-guide-fixtures.js';

// Walks the consumer example's pagination against a mocked /listings and
// returns the listing ids it processed plus the query string of each request.
async function walk(scenario: { total: number; pages: unknown[][] }) {
  const mock = createPagedListingsFetch(scenario);
  vi.stubGlobal('fetch', mock.fetch);

  const consumer = new IndexerConsumer({ baseUrl: 'http://indexer.test', supportedApiVersion: '1.0.0' });
  const ids: string[] = [];
  for await (const page of consumer.listAllListings(2)) {
    ids.push(...page.map((listing) => listing.listingId));
  }
  return { ids, queries: mock.queries };
}

describe('consumer example pagination', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('stops at an empty page that follows a full final page', async () => {
    const { ids, queries } = await walk(indexerFixtures.listingsPagesEndingEmpty);

    expect(ids).toEqual(['1', '2', '3', '4']);
    expect(queries).toEqual(['?limit=2&offset=0', '?limit=2&offset=2', '?limit=2&offset=4']);
  });

  it('still processes a partial final page before stopping', async () => {
    const { ids, queries } = await walk(indexerFixtures.listingsPagesEndingPartial);

    expect(ids).toEqual(['1', '2', '3']);
    expect(queries).toEqual(['?limit=2&offset=0', '?limit=2&offset=2', '?limit=2&offset=4']);
  });

  it('keeps going past a page emptied by moderation while total says rows follow', async () => {
    const { ids, queries } = await walk(indexerFixtures.listingsPagesWithModeratedPage);

    expect(ids).toEqual(['3']);
    expect(queries).toEqual(['?limit=2&offset=0', '?limit=2&offset=2', '?limit=2&offset=4']);
  });

  it('stops after one request when there are no listings', async () => {
    const { ids, queries } = await walk({ total: 0, pages: [[]] });

    expect(ids).toEqual([]);
    expect(queries).toEqual(['?limit=2&offset=0']);
  });
});
