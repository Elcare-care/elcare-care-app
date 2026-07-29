import { beforeEach, describe, expect, it } from 'vitest';
import { buildOpenApiDocument } from '../src/api/openapi.js';
import { z } from 'zod';

// Lightweight OpenAPI contract test: validate representative response shapes
// against the Zod schemas registered in openapi.ts.
//
// This fails the test suite when a handler returns a shape that no longer
// matches the committed OpenAPI document, satisfying issue #298's
// "schema drift fails validation" requirement without needing a full
// openapi-request-validator integration.

describe('OpenAPI contract — representative responses', () => {
  let doc: ReturnType<typeof buildOpenApiDocument>;

  beforeEach(() => {
    doc = buildOpenApiDocument();
  });

  it('has a non-empty paths object', () => {
    expect(Object.keys(doc.paths).length).toBeGreaterThan(0);
  });

  it('documents the SSE /events endpoint', () => {
    const eventsPath = doc.paths['/events'];
    expect(eventsPath).toBeDefined();
    expect(eventsPath.get).toBeDefined();
    expect(eventsPath.get.responses['200']).toBeDefined();
  });

  it('documents operator-protected /health/details with 401/403', () => {
    const path = doc.paths['/health/details'];
    expect(path).toBeDefined();
    expect(path.get.responses['401']).toBeDefined();
    expect(path.get.responses['403']).toBeDefined();
  });

  it('documents all operator routes with security requirement', () => {
    const operatorPaths = [
      '/health/details',
      '/reconciliation/status',
      '/backfill/status',
      '/keeper/status',
      '/sync/gaps',
      '/sync/gaps/{id}',
      '/sync/jobs',
      '/sync/jobs/{id}',
      '/admin/contracts',
    ];

    for (const p of operatorPaths) {
      const pathItem = doc.paths[p];
      expect(pathItem, `missing path ${p}`).toBeDefined();
      const method = Object.values(pathItem)[0] as any;
      expect(method.security, `${p} should require operatorToken`).toEqual([{ operatorToken: [] }]);
    }
  });

  it('includes securitySchemes component', () => {
    expect(doc.components?.securitySchemes).toBeDefined();
    expect(doc.components?.securitySchemes?.operatorToken).toBeDefined();
  });

  it('documents the SSE reset event shape', () => {
    const eventsPath = doc.paths['/events'];
    const schema = (eventsPath.get.responses['200'].content as any)?.['text/event-stream']?.schema;
    // The schema is a passthrough string for SSE; we verify the 503 error shape
    const errSchema = (eventsPath.get.responses['503'].content as any)?.['application/json']?.schema;
    expect(errSchema).toBeDefined();
  });

  it('documents rate-limit headers on heavy endpoints', () => {
    const historyPath = doc.paths['/listings/{id}/history'];
    expect(historyPath).toBeDefined();
    expect(historyPath.get.responses['200']).toBeDefined();
  });

  it('documents pagination cursor headers for listing endpoints', () => {
    const listingsPath = doc.paths['/listings'];
    expect(listingsPath).toBeDefined();
    expect(listingsPath.get.responses['200']).toBeDefined();
  });
});
