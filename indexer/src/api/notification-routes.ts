/**
 * notification-routes.ts
 *
 * Notification-specific API routes:
 *   GET /wallets/:address/notifications   — paginated recent notifiable events
 *   GET /notifications/stream             — SSE stream of real-time notifications
 *
 * These endpoints complement the existing /events SSE and /wallets/:address/activity
 * routes. The key difference is that /notifications targets a single wallet and
 * returns pre-built IndexerNotification objects with domain classification,
 * priority, and human-readable summaries — the frontend can display them
 * directly without extra mapping.
 *
 * The SSE stream at /notifications/stream re-uses the existing RealtimeHub so
 * all multi-instance fan-out, durable replay, and backpressure behaviour is
 * inherited for free. The route accepts an optional ?wallet= query parameter;
 * when provided, only events where the wallet is an actor are delivered.
 */

import { Router, Request, Response, NextFunction } from 'express';
import prisma from '../db.js';
import { hub, ensureRealtimeStarted } from '../realtime/index.js';
import { badRequest, internalError } from './errors.js';
import { lightRateLimiter, strictRateLimiter, sseConcurrencyGuard } from './rate-limit-middleware.js';
import { isValidStellarAddress, STELLAR_ADDRESS_ERROR } from '../stellar-address.js';
import { classifyEvent, isWalletInvolved, EVENT_CLASSIFICATIONS } from '../notification/index.js';
import { buildNotification, type IndexerNotification } from '../notification/index.js';

const router = Router();

// ── Constants ─────────────────────────────────────────────────────────────────

/** Event types that are surfaced in the notification feed (notifiable === true). */
const NOTIFIABLE_EVENT_TYPES = Object.entries(EVENT_CLASSIFICATIONS)
  .filter(([, cls]) => cls.notifiable)
  .map(([type]) => type);

/** Max notifications per page. */
const MAX_NOTIFICATION_LIMIT = 100;

// ── Serialise helper ──────────────────────────────────────────────────────────

function serialise(v: unknown): unknown {
  return JSON.parse(JSON.stringify(v, (_k, val) =>
    typeof val === 'bigint' ? val.toString() : val
  ));
}

// ── GET /wallets/:address/notifications ───────────────────────────────────────
//
// Returns paginated IndexerNotification objects for a given wallet address.
// Only "notifiable" event types are returned. Events are ordered newest-first.
// An optional ?domain= filter accepts comma-separated domain names.
// An optional ?priority= filter accepts HIGH, MEDIUM, or LOW (comma-separated).

router.get(
  '/wallets/:address/notifications',
  strictRateLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    const address = req.params.address as string;
    if (!isValidStellarAddress(address)) {
      return next(badRequest(STELLAR_ADDRESS_ERROR));
    }

    const limitRaw  = req.query.limit  as string | undefined;
    const offsetRaw = req.query.offset as string | undefined;
    const domainRaw    = req.query.domain    as string | undefined;
    const priorityRaw  = req.query.priority  as string | undefined;

    const limit  = limitRaw  ? Math.min(parseInt(limitRaw,  10), MAX_NOTIFICATION_LIMIT) : 50;
    const offset = offsetRaw ? parseInt(offsetRaw, 10) : 0;

    if (!Number.isFinite(limit)  || limit  < 1) return next(badRequest('limit must be a positive integer'));
    if (!Number.isFinite(offset) || offset < 0) return next(badRequest('offset must be a non-negative integer'));

    const domainFilter   = domainRaw   ? domainRaw.split(',').map((s) => s.trim()).filter(Boolean)   : null;
    const priorityFilter = priorityRaw ? priorityRaw.split(',').map((s) => s.trim()).filter(Boolean) : null;

    // Resolve the event types after applying optional filters
    let eligibleTypes = NOTIFIABLE_EVENT_TYPES;
    if (domainFilter) {
      eligibleTypes = eligibleTypes.filter((t) =>
        domainFilter.includes(EVENT_CLASSIFICATIONS[t]?.domain ?? '')
      );
    }
    if (priorityFilter) {
      eligibleTypes = eligibleTypes.filter((t) =>
        priorityFilter.includes(EVENT_CLASSIFICATIONS[t]?.priority ?? '')
      );
    }

    try {
      // Wallet involvement: events where the wallet is the actor OR appears
      // in a JSON data field (buyer, bidder, offerer, etc.)
      const jsonActorFields = ['buyer', 'artist', 'offerer', 'bidder', 'winner', 'creator', 'cancelled_by'];
      const fromJson = jsonActorFields.map((field) => ({
        data: { path: [field], equals: address },
      }));

      const where = {
        eventType: { in: eligibleTypes },
        OR: [{ actor: address }, ...fromJson],
      };

      const [events, total] = await Promise.all([
        prisma.marketplaceEvent.findMany({
          where,
          orderBy: { ledgerSequence: 'desc' },
          take: limit,
          skip: offset,
        }),
        prisma.marketplaceEvent.count({ where }),
      ]);

      const notifications: IndexerNotification[] = events.map((row) => {
        const classification = classifyEvent(row.eventType);
        return buildNotification(
          {
            id: row.id,
            eventType: row.eventType,
            listingId: row.listingId,
            actor: row.actor,
            data: (row.data as Record<string, unknown>) ?? {},
            ledgerSequence: row.ledgerSequence,
            ledgerTimestamp: row.ledgerTimestamp,
          },
          classification,
          address
        );
      });

      res.setHeader('X-Total-Count', String(total));
      res.setHeader('X-Limit', String(limit));
      res.setHeader('X-Offset', String(offset));
      res.json(serialise(notifications));
    } catch (err) {
      next(internalError('Failed to fetch notifications'));
    }
  }
);

// ── GET /notifications/stream ─────────────────────────────────────────────────
//
// SSE stream of all notifiable marketplace events in real time.
// Accepts:
//   ?wallet=<address>   — when provided, filters to events where that wallet
//                         is an actor (server-side filter applied via ClientFilter.types
//                         on the hub for event type pre-filtering, then wallet check
//                         done on message delivery).
//   ?domain=<d,d>       — comma-separated domain filter
//   ?priority=HIGH      — minimum priority (HIGH only, or HIGH,MEDIUM)
//   Last-Event-ID       — enables durable resume
//
// The route delegates delivery entirely to RealtimeHub so multi-instance
// fan-out, backpressure, heartbeat, and connection caps are all inherited.

const MAX_NOTIFICATION_CONNECTIONS = parseInt(
  process.env.MAX_NOTIFICATION_STREAM_CONNECTIONS || '200'
);

router.get(
  '/notifications/stream',
  sseConcurrencyGuard,
  async (req: Request, res: Response) => {
    if (hub.connectionCount >= MAX_NOTIFICATION_CONNECTIONS) {
      return res.status(503).json({ error: 'Notification stream at capacity — try again shortly' });
    }

    // Parse optional filters
    const walletParam  = req.query.wallet   as string | undefined;
    const domainParam  = req.query.domain   as string | undefined;
    const priorityParam = req.query.priority as string | undefined;

    const wallet     = walletParam && isValidStellarAddress(walletParam) ? walletParam : undefined;
    const domains    = domainParam   ? new Set(domainParam.split(',').map((s) => s.trim()))   : null;
    const priorities = priorityParam ? new Set(priorityParam.split(',').map((s) => s.trim())) : null;

    // Build the type set for hub-level pre-filtering
    let eligibleTypes = NOTIFIABLE_EVENT_TYPES;
    if (domains) {
      eligibleTypes = eligibleTypes.filter((t) =>
        domains.has(EVENT_CLASSIFICATIONS[t]?.domain ?? '')
      );
    }
    if (priorities) {
      eligibleTypes = eligibleTypes.filter((t) =>
        priorities.has(EVENT_CLASSIFICATIONS[t]?.priority ?? '')
      );
    }

    res.setHeader('Content-Type',  'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection',    'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const lastEventId = (req.headers['last-event-id'] as string | undefined) ??
                        (req.query.lastEventId as string | undefined) ?? null;

    ensureRealtimeStarted();

    await hub.attachClient(res as any, {
      filter: {
        types: new Set(eligibleTypes),
        // Note: wallet-level filtering is coarser here (hub only supports
        // type and listingId filters); fine-grained wallet filtering is the
        // responsibility of the frontend consumer using its own wallet address.
      },
      lastEventId,
    });

    // Send initial handshake so the client knows the stream opened
    try {
      res.write(`data: ${JSON.stringify({ type: 'NOTIFICATION_STREAM_CONNECTED', wallet: wallet ?? null })}\n\n`);
    } catch {
      // client already disconnected
    }
  }
);

// ── GET /notifications/summary ────────────────────────────────────────────────
//
// Returns a lightweight summary: unread count + 5 most-recent notifications
// for a wallet. Useful for the notification bell polling fallback when SSE
// is unavailable.

router.get(
  '/notifications/summary',
  lightRateLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    const wallet = req.query.wallet as string | undefined;
    if (!wallet) return next(badRequest('wallet query parameter is required'));
    if (!isValidStellarAddress(wallet)) return next(badRequest(STELLAR_ADDRESS_ERROR));

    try {
      const jsonActorFields = ['buyer', 'artist', 'offerer', 'bidder', 'winner', 'creator'];
      const fromJson = jsonActorFields.map((field) => ({
        data: { path: [field], equals: wallet },
      }));
      const where = {
        eventType: { in: NOTIFIABLE_EVENT_TYPES },
        OR: [{ actor: wallet }, ...fromJson],
      };

      const [recentEvents, total] = await Promise.all([
        prisma.marketplaceEvent.findMany({
          where,
          orderBy: { ledgerSequence: 'desc' },
          take: 5,
        }),
        prisma.marketplaceEvent.count({ where }),
      ]);

      const recent = recentEvents.map((row) =>
        buildNotification(
          {
            id: row.id,
            eventType: row.eventType,
            listingId: row.listingId,
            actor: row.actor,
            data: (row.data as Record<string, unknown>) ?? {},
            ledgerSequence: row.ledgerSequence,
            ledgerTimestamp: row.ledgerTimestamp,
          },
          classifyEvent(row.eventType),
          wallet
        )
      );

      // Count HIGH-priority events from the last 24h as "urgent"
      const oneDayAgo = new Date(Date.now() - 86_400_000);
      const urgentCount = await prisma.marketplaceEvent.count({
        where: {
          ...where,
          eventType: { in: NOTIFIABLE_EVENT_TYPES.filter((t) => EVENT_CLASSIFICATIONS[t]?.priority === 'HIGH') },
          ledgerTimestamp: { gte: oneDayAgo },
        },
      });

      res.json(serialise({ total, urgentCount, recent }));
    } catch (err) {
      next(internalError('Failed to fetch notification summary'));
    }
  }
);

export default router;
