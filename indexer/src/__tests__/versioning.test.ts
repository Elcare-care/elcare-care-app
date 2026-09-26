import { describe, expect, it } from 'vitest';
import { versioningMiddleware, ok, validateResponse, ListingResponseV1 } from '../api/versioning';

describe('versioningMiddleware', () => {
  it('parses version from Accept header', async () => {
    const req: any = { headers: { accept: 'application/vnd.elcarehub.v1+json' }, query: {} };
    const res: any = { setHeader: () => {} };
    const next = () => {};
    versioningMiddleware(req, res, next);
    expect(req.apiVersion).toBe(1);
  });

  it('defaults to version 1 when no version is supplied', async () => {
    const req: any = { headers: {}, query: {} };
    const res: any = { setHeader: () => {} };
    const next = () => {};
    versioningMiddleware(req, res, next);
    expect(req.apiVersion).toBe(1);
  });
});

describe('ok', () => {
  it('wraps data in versioned envelope', async () => {
    const res: any = { json: (body: any) => { res.body = body; } };
    ok(res, { id: '1' });
    expect(res.body.data.id).toBe('1');
    expect(res.body.meta.version).toBe(1);
    expect(res.body.meta.deprecated).toBe(false);
  });
});

describe('validateResponse', () => {
  it('passes when data matches schema', async () => {
    const data = { listingId: '1', artist: 'a', owner: null, price: '10', currency: 'XLM', collection: null, status: 'Active', createdAtLedger: 1, updatedAtLedger: 1 };
    expect(() => validateResponse(ListingResponseV1, data)).not.toThrow();
  });

  it('throws when data is missing required fields', async () => {
    expect(() => validateResponse(ListingResponseV1, {})).toThrow();
  });
});
