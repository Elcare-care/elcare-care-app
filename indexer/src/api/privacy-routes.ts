/**
 * privacy-routes.ts
 *
 * Issue #543 — Account deletion and data export controls.
 *
 *   POST /privacy/requests            — create an EXPORT or DELETION request
 *   GET  /privacy/requests            — list the caller's own requests
 *   GET  /privacy/requests/:id        — status (and export payload once COMPLETED)
 *
 * Wallet identity uses the same trust model as the rest of this API's
 * "authenticated" route class (see auth-middleware.ts `extractWallet` /
 * AUTHENTICATED_ROUTES): the caller supplies X-Wallet-Address (or ?wallet=)
 * and that value is treated as the caller's identity. There is no signature
 * challenge anywhere else in this API, so none is invented here — a request
 * is scoped to whichever wallet address made it, and any request whose
 * `walletAddress` does not match the caller's supplied wallet is rejected
 * with 403, exactly like the caller would be locked out of another wallet's
 * data on the existing /wallets/:address/* routes if they didn't know the
 * address in the first place.
 *
 * Data inventory (see docs/PRIVACY_POLICY.md sections 1, 4, 6 for the full
 * picture across the whole app):
 *
 *   ELIGIBLE (exported + deletable by this flow):
 *     - Previously generated PrivacyRequest.exportPayload documents for this
 *       wallet. These are the only off-chain, wallet-linked documents this
 *       service persists outside canonical on-chain mirrors.
 *
 *   RETAINED (exported for informational completeness, never deleted):
 *     - Listing / Auction / Offer / Bid / RoyaltyPayment / MarketplaceEvent
 *       rows referencing the wallet — these mirror the public Stellar
 *       ledger and are not this application's data to delete.
 *     - OperationalAudit rows where the wallet is the actor — retained as an
 *       operator accountability record (see docs/PRIVACY_POLICY.md section 5).
 *
 *   OUT OF SCOPE for this server-side flow (documented, not silently dropped):
 *     - Frontend support reports (frontend/elcarehub-app/src/lib/support.ts)
 *       live in an in-memory MVP store on the Next.js server, not in this
 *       database, and are not queryable per-wallet today. Noted explicitly
 *       in every generated export so users aren't told data was checked when
 *       it wasn't.
 *     - Browser-only state (analytics consent, admin sessionStorage audit
 *       log, wallet-connector preference) never reaches this backend and
 *       must be cleared client-side (Settings → Privacy, or clearing site
 *       data) — also noted in the export.
 *
 * No private keys, signatures, or secrets are ever accepted, stored, or
 * returned by this router.
 */

import { Router, Request, Response, NextFunction } from 'express';
import { randomUUID } from 'crypto';
import prisma from '../db.js';
import { ApiError, badRequest, unauthorized, forbidden, notFound, internalError } from './errors.js';
import { lightRateLimiter, strictRateLimiter } from './rate-limit-middleware.js';
import { isValidStellarAddress, STELLAR_ADDRESS_ERROR } from '../stellar-address.js';
import { Prisma } from '@prisma/client';
import type { PrivacyRequestType } from '@prisma/client';

const router = Router();

// ── Constants ─────────────────────────────────────────────────────────────────

const REQUEST_TYPES: PrivacyRequestType[] = ['EXPORT', 'DELETION'];
const MAX_LIST_LIMIT = 50;

// ── Wallet extraction ────────────────────────────────────────────────────────
//
// Mirrors auth-middleware.ts extractWallet(): X-Wallet-Address header first,
// then ?wallet= query param. Unlike the read-only /wallets/:address/* routes
// (where the address is public and taken from the URL), privacy requests are
// scoped to "whoever the caller claims to be" — so the wallet is required
// here rather than optional.

function extractWallet(req: Request): string | undefined {
  const header = req.headers['x-wallet-address'];
  if (typeof header === 'string' && header.length > 0) return header;
  const query = req.query.wallet;
  if (typeof query === 'string' && query.length > 0) return query;
  return undefined;
}

function requireWallet(req: Request): string {
  const wallet = extractWallet(req);
  if (!wallet) {
    throw unauthorized('X-Wallet-Address header (or ?wallet= query param) is required');
  }
  if (!isValidStellarAddress(wallet)) {
    throw badRequest(STELLAR_ADDRESS_ERROR);
  }
  return wallet;
}

// ── ID generation ────────────────────────────────────────────────────────────
//
// Mirrors the "SUP-xxxxxxxx" convention from frontend/elcarehub-app/src/lib/support.ts.

function generatePrivacyRequestId(): string {
  return `PRIV-${randomUUID().slice(0, 8).toUpperCase()}`;
}

// ── Serialise helper ──────────────────────────────────────────────────────────

function serialise(v: unknown): unknown {
  return JSON.parse(JSON.stringify(v, (_k, val) => (typeof val === 'bigint' ? val.toString() : val)));
}

// ── Export generation ─────────────────────────────────────────────────────────
//
// Gathers ELIGIBLE off-chain records for a wallet plus a RETAINED section
// listing canonical on-chain-mirrored records by reference. Synchronous —
// there is no job queue; the per-wallet row counts here are small enough
// that generating inline is fine for this MVP pass.

export interface PrivacyExportDocument {
  format: 'elcarehub.privacy-export.v1';
  generatedAt: string;
  walletAddress: string;
  eligible: {
    priorExportPayloads: Array<{ requestId: string; requestedAt: string; completedAt: string | null }>;
  };
  retained: {
    note: string;
    listings: Array<{ listingId: string; status: string; createdAtLedger: number }>;
    auctions: Array<{ auctionId: string; status: string; createdAtLedger: number }>;
    offersMade: Array<{ offerId: string; listingId: string; status: string }>;
    bidsPlaced: Array<{ auctionId: string; amount: string; ledgerSequence: number }>;
    royaltiesReceived: Array<{ id: number; amount: string; ledgerSequence: number }>;
    operationalAuditEvents: number;
  };
  outOfScope: string[];
}

const OUT_OF_SCOPE_NOTES = [
  'Frontend support reports (Settings/Support center) are stored in an in-memory ' +
    'development store on the web server, not in this database, and are not ' +
    'queryable per-wallet by this endpoint today.',
  'Analytics consent, the admin audit log, and wallet-connector preferences are ' +
    'stored only in your browser (localStorage/sessionStorage) and are never sent ' +
    'to this backend — clear them from Settings → Privacy or your browser\'s site data.',
  'Blockchain transactions and IPFS-pinned metadata are public and permanent; ' +
    'see docs/PRIVACY_POLICY.md section 4.',
];

export async function generateExportForWallet(walletAddress: string): Promise<PrivacyExportDocument> {
  const [priorExports, listings, auctions, offers, bids, royalties, auditCount] = await Promise.all([
    prisma.privacyRequest.findMany({
      where: { walletAddress, type: 'EXPORT', status: 'COMPLETED' },
      select: { id: true, requestedAt: true, completedAt: true },
      orderBy: { requestedAt: 'desc' },
    }),
    prisma.listing.findMany({
      where: { OR: [{ artist: walletAddress }, { owner: walletAddress }, { originalCreator: walletAddress }] },
      select: { listingId: true, status: true, createdAtLedger: true },
    }),
    prisma.auction.findMany({
      where: { OR: [{ creator: walletAddress }, { highestBidder: walletAddress }] },
      select: { auctionId: true, status: true, createdAtLedger: true },
    }),
    prisma.offer.findMany({
      where: { offerer: walletAddress },
      select: { offerId: true, listingId: true, status: true },
    }),
    prisma.bid.findMany({
      where: { bidder: walletAddress },
      select: { auctionId: true, amount: true, ledgerSequence: true },
    }),
    prisma.royaltyPayment.findMany({
      where: { recipient: walletAddress },
      select: { id: true, amount: true, ledgerSequence: true },
    }),
    prisma.operationalAudit.count({ where: { actor: walletAddress } }),
  ]);

  const doc: PrivacyExportDocument = {
    format: 'elcarehub.privacy-export.v1',
    generatedAt: new Date().toISOString(),
    walletAddress,
    eligible: {
      priorExportPayloads: priorExports.map((r) => ({
        requestId: r.id,
        requestedAt: r.requestedAt.toISOString(),
        completedAt: r.completedAt ? r.completedAt.toISOString() : null,
      })),
    },
    retained: {
      note:
        'These records mirror public Stellar ledger state and/or operator audit ' +
        'requirements and cannot be deleted (docs/PRIVACY_POLICY.md sections 4 and 6). ' +
        'They are included here for informational completeness only.',
      listings: listings.map((l) => ({
        listingId: l.listingId.toString(),
        status: l.status,
        createdAtLedger: l.createdAtLedger,
      })),
      auctions: auctions.map((a) => ({
        auctionId: a.auctionId.toString(),
        status: a.status,
        createdAtLedger: a.createdAtLedger,
      })),
      offersMade: offers.map((o) => ({
        offerId: o.offerId.toString(),
        listingId: o.listingId.toString(),
        status: o.status,
      })),
      bidsPlaced: bids.map((b) => ({
        auctionId: b.auctionId.toString(),
        amount: b.amount.toString(),
        ledgerSequence: b.ledgerSequence,
      })),
      royaltiesReceived: royalties.map((r) => ({
        id: r.id,
        amount: r.amount.toString(),
        ledgerSequence: r.ledgerSequence,
      })),
      operationalAuditEvents: auditCount,
    },
    outOfScope: OUT_OF_SCOPE_NOTES,
  };

  return doc;
}

// ── Deletion processing ────────────────────────────────────────────────────────
//
// Deletes/anonymises ELIGIBLE off-chain rows for the wallet. Today the only
// such rows are previously generated export payloads (see module doc above) —
// their JSON body is cleared while the request metadata (id, timestamps,
// status) is kept so the deletion itself remains auditable. Canonical mirror
// tables are never touched here.

export async function processDeletionForWallet(
  walletAddress: string,
  currentRequestId: string
): Promise<{ purgedExportPayloads: number; retainedRecordsNote: string }> {
  const purge = await prisma.privacyRequest.updateMany({
    where: {
      walletAddress,
      type: 'EXPORT',
      exportPayload: { not: Prisma.JsonNull },
      id: { not: currentRequestId },
    },
    data: { exportPayload: Prisma.JsonNull },
  });

  const [listingCount, auctionCount, offerCount, bidCount, royaltyCount, auditCount] = await Promise.all([
    prisma.listing.count({ where: { OR: [{ artist: walletAddress }, { owner: walletAddress }, { originalCreator: walletAddress }] } }),
    prisma.auction.count({ where: { OR: [{ creator: walletAddress }, { highestBidder: walletAddress }] } }),
    prisma.offer.count({ where: { offerer: walletAddress } }),
    prisma.bid.count({ where: { bidder: walletAddress } }),
    prisma.royaltyPayment.count({ where: { recipient: walletAddress } }),
    prisma.operationalAudit.count({ where: { actor: walletAddress } }),
  ]);

  const retainedRecordsNote =
    `Retained (not deleted) because they mirror the public Stellar ledger or are ` +
    `operator audit records required by docs/PRIVACY_POLICY.md sections 4 and 6: ` +
    `${listingCount} listing(s), ${auctionCount} auction(s), ${offerCount} offer(s), ` +
    `${bidCount} bid(s), ${royaltyCount} royalty payment(s), ${auditCount} operational ` +
    `audit event(s). ${purge.count} previously generated export payload(s) for this ` +
    `wallet were purged. Blockchain transactions and IPFS-pinned metadata cannot be ` +
    `deleted by any party (docs/PRIVACY_POLICY.md section 4). Frontend support reports ` +
    `and browser-stored preferences are outside this backend's reach — see the export ` +
    `document's outOfScope notes.`;

  return { purgedExportPayloads: purge.count, retainedRecordsNote };
}

// ── POST /privacy/requests ─────────────────────────────────────────────────────

router.post('/privacy/requests', strictRateLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const walletAddress = requireWallet(req);

    const body = (req.body ?? {}) as { type?: unknown };
    if (typeof body.type !== 'string' || !REQUEST_TYPES.includes(body.type as PrivacyRequestType)) {
      return next(badRequest(`Field 'type' must be one of: ${REQUEST_TYPES.join(', ')}`));
    }
    const type = body.type as PrivacyRequestType;

    const id = generatePrivacyRequestId();
    const now = new Date();

    // Wallet identity is already the verification for this API (see module
    // doc) so requests move straight from PENDING to VERIFIED on creation.
    let record = await prisma.privacyRequest.create({
      data: {
        id,
        walletAddress,
        type,
        status: 'VERIFIED',
        verifiedAt: now,
        auditNote: 'Verified via wallet-scoped request (no separate proof step in this trust model).',
      },
    });

    // Process synchronously — no job queue for this MVP pass (see class doc).
    try {
      record = await prisma.privacyRequest.update({
        where: { id },
        data: { status: 'PROCESSING' },
      });

      if (type === 'EXPORT') {
        const exportPayload = await generateExportForWallet(walletAddress);
        record = await prisma.privacyRequest.update({
          where: { id },
          data: {
            status: 'COMPLETED',
            completedAt: new Date(),
            exportPayload: exportPayload as unknown as Prisma.InputJsonValue,
          },
        });
      } else {
        const { retainedRecordsNote } = await processDeletionForWallet(walletAddress, id);
        record = await prisma.privacyRequest.update({
          where: { id },
          data: {
            status: 'COMPLETED',
            completedAt: new Date(),
            retainedRecordsNote,
          },
        });
      }
    } catch (processingErr) {
      record = await prisma.privacyRequest.update({
        where: { id },
        data: {
          status: 'FAILED',
          auditNote: 'Automated processing failed; see server logs for the request id.',
        },
      });
      throw processingErr;
    }

    res.status(201).json(serialise(toPublicRequest(record)));
  } catch (err) {
    next(err instanceof ApiError ? err : internalError('Failed to create privacy request'));
  }
});

// ── GET /privacy/requests ───────────────────────────────────────────────────────

router.get('/privacy/requests', lightRateLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const walletAddress = requireWallet(req);
    const limitRaw = req.query.limit as string | undefined;
    const limit = limitRaw ? Math.min(parseInt(limitRaw, 10), MAX_LIST_LIMIT) : MAX_LIST_LIMIT;
    if (!Number.isFinite(limit) || limit < 1) return next(badRequest('limit must be a positive integer'));

    const records = await prisma.privacyRequest.findMany({
      where: { walletAddress },
      orderBy: { requestedAt: 'desc' },
      take: limit,
    });

    res.json(serialise(records.map(toPublicRequest)));
  } catch (err) {
    next(err instanceof ApiError ? err : internalError('Failed to list privacy requests'));
  }
});

// ── GET /privacy/requests/:id ────────────────────────────────────────────────────

router.get('/privacy/requests/:id', lightRateLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const walletAddress = requireWallet(req);
    const id = req.params.id as string;

    const record = await prisma.privacyRequest.findUnique({ where: { id } });
    if (!record) return next(notFound('Privacy request not found'));
    if (record.walletAddress !== walletAddress) {
      return next(forbidden('This privacy request does not belong to the requesting wallet'));
    }

    res.json(serialise(toPublicRequest(record)));
  } catch (err) {
    next(err instanceof ApiError ? err : internalError('Failed to fetch privacy request'));
  }
});

// ── Public shape ──────────────────────────────────────────────────────────────
//
// Never leaks anything beyond the wallet that owns the request (enforced by
// the scoping above) — no secrets are stored on this model in the first place.

function toPublicRequest(record: {
  id: string;
  walletAddress: string;
  type: PrivacyRequestType;
  status: string;
  requestedAt: Date;
  verifiedAt: Date | null;
  completedAt: Date | null;
  exportPayload: unknown;
  retainedRecordsNote: string | null;
  auditNote: string | null;
}) {
  return {
    id: record.id,
    walletAddress: record.walletAddress,
    type: record.type,
    status: record.status,
    requestedAt: record.requestedAt,
    verifiedAt: record.verifiedAt,
    completedAt: record.completedAt,
    // Only surface the export payload once the request has actually completed.
    exportPayload: record.status === 'COMPLETED' ? record.exportPayload ?? null : null,
    retainedRecordsNote: record.retainedRecordsNote,
    auditNote: record.auditNote,
  };
}

export default router;
