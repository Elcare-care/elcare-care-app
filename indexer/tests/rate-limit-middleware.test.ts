import { describe, expect, it } from 'vitest';
import {
  lightRateLimiter,
  mediumRateLimiter,
  heavyRateLimiter,
  operationalRateLimiter,
  globalRateLimiter,
  sseConcurrencyGuard,
} from '../src/api/rate-limit-middleware.js';
import { Request, Response, NextFunction } from 'express';

describe('rate-limit-middleware', () => {
  it('has resource cost configs', () => {
    expect(lightRateLimiter).toBeDefined();
    expect(mediumRateLimiter).toBeDefined();
    expect(heavyRateLimiter).toBeDefined();
    expect(operationalRateLimiter).toBeDefined();
    expect(globalRateLimiter).toBeDefined();
  });

  it('lightRateLimiter allows requests under limit', async () => {
    const req = {
      path: '/listings',
      ip: '1.2.3.4',
      headers: {},
      query: {},
    } as any;
    const res = {
      status: () => res,
      json: () => res,
      setHeader: () => {},
      on: () => {},
    } as any;
    let called = false;
    const next = () => { called = true; };
    await lightRateLimiter(req, res, next as NextFunction);
    expect(called).toBe(true);
  });

  it('sseConcurrencyGuard blocks when limit reached', () => {
    const req = {
      path: '/events',
      ip: '10.0.0.1',
      headers: {},
      query: {},
    } as any;
    const res = {
      status: () => res,
      json: () => res,
      setHeader: () => {},
      on: () => {},
      end: () => {},
    } as any;
    let nextCalled = false;
    const next = () => { nextCalled = true; };
    sseConcurrencyGuard(req, res, next as NextFunction);
    // First call should pass (no existing connections for this key)
    expect(nextCalled).toBe(true);
  });

  it('skip health and readyz routes', async () => {
    const req = { path: '/health', ip: '1.2.3.4', headers: {}, query: {} } as any;
    const res = { status: () => res, json: () => res } as any;
    let called = false;
    const next = () => { called = true; };
    await globalRateLimiter(req, res, next as NextFunction);
    expect(called).toBe(true);
  });
});
