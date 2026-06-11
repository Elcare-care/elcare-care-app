import rateLimit from 'express-rate-limit';

/**
 * Rate limiting middleware to prevent DDoS and API abuse
 * Configured for IP-based limits: 100 requests per minute
 */
export const rateLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 minute
    max: 100, // Limit each IP to 100 requests per windowMs
    message: {
        error: 'Too many requests from this IP, please try again later.',
        retryAfter: '1 minute'
    },
    standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
    legacyHeaders: false, // Disable the `X-RateLimit-*` headers
    // Skip rate limiting for health check endpoint
    skip: (req) => req.path === '/health',
});

/**
 * Stricter rate limiter for resource-intensive endpoints
 * 20 requests per minute for endpoints that query large datasets
 */
export const strictRateLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 minute
    max: 20, // Limit each IP to 20 requests per windowMs
    message: {
        error: 'Too many requests to this endpoint, please try again later.',
        retryAfter: '1 minute'
    },
    standardHeaders: true,
    legacyHeaders: false,
});
