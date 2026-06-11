import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import express from 'express';
import { rateLimiter, strictRateLimiter } from '../api/rate-limit-middleware.js';

describe('Rate Limiting Middleware', () => {
    let app: express.Application;

    beforeAll(() => {
        app = express();
        app.use(express.json());
        
        // Test route with standard rate limiter
        app.get('/test', rateLimiter, (req, res) => {
            res.json({ message: 'success' });
        });

        // Test route with strict rate limiter
        app.get('/test-strict', strictRateLimiter, (req, res) => {
            res.json({ message: 'success' });
        });
    });

    it('should allow requests under the limit', async () => {
        const response = await request(app).get('/test');
        expect(response.status).toBe(200);
        expect(response.body.message).toBe('success');
    });

    it('should include rate limit headers', async () => {
        const response = await request(app).get('/test');
        expect(response.headers['ratelimit-limit']).toBeDefined();
        expect(response.headers['ratelimit-remaining']).toBeDefined();
        expect(response.headers['ratelimit-reset']).toBeDefined();
    });

    it('should block requests after exceeding the limit', async () => {
        // Make 101 requests to exceed the 100 req/min limit
        const requests = [];
        for (let i = 0; i < 101; i++) {
            requests.push(request(app).get('/test'));
        }
        
        const responses = await Promise.all(requests);
        const blockedResponses = responses.filter(r => r.status === 429);
        
        expect(blockedResponses.length).toBeGreaterThan(0);
    }, 30000); // Increase timeout for this test

    it('should apply stricter limits to strict endpoints', async () => {
        // Make 21 requests to exceed the 20 req/min limit
        const requests = [];
        for (let i = 0; i < 21; i++) {
            requests.push(request(app).get('/test-strict'));
        }
        
        const responses = await Promise.all(requests);
        const blockedResponses = responses.filter(r => r.status === 429);
        
        expect(blockedResponses.length).toBeGreaterThan(0);
    }, 30000); // Increase timeout for this test
});
