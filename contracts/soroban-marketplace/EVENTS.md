# Soroban Marketplace Event Catalog

This document serves as the definitive catalog of all events emitted by the `soroban-marketplace` smart contract.

## Event Definitions

The JSON block below defines the exact topics and data schemas for all events. It is automatically parsed by the indexer's CI tests to ensure parser completeness.

```json
{
  "LISTING_CREATED": {
    "topic": "listing_created",
    "data_schema": {
      "listing_id": "u64",
      "artist": "Address",
      "price": "i128",
      "currency": "Symbol",
      "collection": "Address",
      "token_id": "u64",
      "ledger_sequence": "u32"
    }
  },
  "ARTWORK_SOLD": {
    "topic": "artwork_sold",
    "data_schema": {
      "listing_id": "u64",
      "artist": "Address",
      "buyer": "Address",
      "price": "i128",
      "currency": "Symbol",
      "ledger_sequence": "u32"
    }
  },
  "LISTING_CANCELLED": {
    "topic": "listing_cancelled",
    "data_schema": {
      "listing_id": "u64",
      "cancelled_by": "Address",
      "reason": "CancelReason",
      "ledger_sequence": "u32"
    }
  },
  "LISTING_UPDATED": {
    "topic": "listing_updated",
    "data_schema": {
      "listing_id": "u64",
      "artist": "Address",
      "new_price": "i128",
      "collection": "Address",
      "token_id": "u64",
      "ledger_sequence": "u32"
    }
  },
  "BID_PLACED": {
    "topic": "bid_placed",
    "data_schema": {
      "auction_id": "u64",
      "bidder": "Address",
      "bid_amount": "i128"
    }
  },
  "AUCTION_RESOLVED": {
    "topic": "auction_resolved",
    "data_schema": {
      "auction_id": "u64",
      "winner": "Option<Address>",
      "amount": "i128"
    }
  },
  "AUCTION_CREATED": {
    "topic": "auction_created",
    "data_schema": {
      "auction_id": "u64",
      "creator": "Address",
      "reserve_price": "i128",
      "token": "Address",
      "collection": "Address",
      "token_id": "u64",
      "end_time": "u64"
    }
  },
  "OFFER_MADE": {
    "topic": "offer_made",
    "data_schema": {
      "offer_id": "u64",
      "listing_id": "u64",
      "offerer": "Address",
      "amount": "i128",
      "token": "Address"
    }
  },
  "OFFER_ACCEPTED": {
    "topic": "offer_accepted",
    "data_schema": {
      "offer_id": "u64",
      "listing_id": "u64",
      "offerer": "Address",
      "amount": "i128"
    }
  },
  "OFFER_REJECTED": {
    "topic": "offer_rejected",
    "data_schema": {
      "offer_id": "u64",
      "listing_id": "u64",
      "offerer": "Address"
    }
  },
  "OFFER_WITHDRAWN": {
    "topic": "offer_withdrawn",
    "data_schema": {
      "offer_id": "u64",
      "listing_id": "u64",
      "offerer": "Address"
    }
  },
  "ROYALTY_PAID": {
    "topic": "royalty_paid",
    "data_schema": {
      "listing_id": "u64",
      "artist": "Address",
      "amount": "i128",
      "token": "Address"
    }
  },
  "ADMIN_TRANSFER_PROPOSED": {
    "topic": "admin_transfer_proposed",
    "data_schema": {
      "current_admin": "Address",
      "proposed_admin": "Address"
    }
  },
  "ADMIN_TRANSFERRED": {
    "topic": "admin_transferred",
    "data_schema": {
      "old_admin": "Address",
      "new_admin": "Address"
    }
  },
  "ARTIST_REVOKED": {
    "topic": "artist_revoked",
    "data_schema": {
      "artist": "Address"
    }
  },
  "ARTIST_REINSTATED": {
    "topic": "artist_reinstated",
    "data_schema": {
      "artist": "Address"
    }
  },
  "CONTRACT_PAUSED": {
    "topic": "contract_paused",
    "data_schema": {}
  },
  "CONTRACT_UNPAUSED": {
    "topic": "contract_unpaused",
    "data_schema": {}
  },
  "LISTING_PRICE_UPDATED": {
    "topic": "listing_price_updated",
    "data_schema": {
      "listing_id": "u64",
      "old_price": "i128",
      "new_price": "i128",
      "updated_by": "Address"
    }
  },
  "LISTING_EXPIRED": {
    "topic": "listing_expired",
    "data_schema": {
      "listing_id": "u64",
      "expired_at": "u64",
      "ledger_sequence": "u32"
    }
  },
  "AUCTION_EXTENDED": {
    "topic": "auction_extended",
    "data_schema": {
      "auction_id": "u64",
      "new_end_time": "u64"
    }
  },
  "AUCTION_CANCELLED": {
    "topic": "auction_cancelled",
    "data_schema": {
      "auction_id": "u64",
      "cancelled_by": "Address"
    }
  },
  "PROTOCOL_FEE_COLLECTED": {
    "topic": "protocol_fee_collected",
    "data_schema": {
      "listing_id": "u64",
      "amount": "i128",
      "token": "Address",
      "treasury": "Address"
    }
  },
  "OFFER_RECLAIMED": {
    "topic": "offer_reclaimed",
    "data_schema": {
      "offer_id": "u64",
      "listing_id": "u64",
      "offerer": "Address",
      "amount": "i128"
    }
  }
}
```
