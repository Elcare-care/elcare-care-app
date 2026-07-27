-- Create materialized view: daily_marketplace_stats
-- Aggregates per-day stats from MarketplaceEvent and Listing tables.
--
-- NOTE: the original correlated subqueries were rejected by Postgres with
--       `subquery uses ungrouped column "me.ledgerTimestamp" from outer query`.
--       Rewritten to use LATERAL joins against a per-day Sold-listing aggregate
--       so the outer GROUP BY is the only grouping context.

CREATE MATERIALIZED VIEW IF NOT EXISTS daily_marketplace_stats AS
SELECT
  day,
  sales_count,
  COALESCE(s.sales_volume, 0)::NUMERIC AS sales_volume,
  unique_buyers,
  unique_sellers,
  new_listings,
  COALESCE(s.avg_sale_price, 0)::NUMERIC AS avg_sale_price
FROM (
  SELECT
    DATE(me."ledgerTimestamp") AS day,

    COUNT(*) FILTER (WHERE me."eventType" = 'ARTWORK_SOLD') AS sales_count,

    COUNT(DISTINCT me."data"->>'buyer')
      FILTER (WHERE me."eventType" = 'ARTWORK_SOLD') AS unique_buyers,

    COUNT(DISTINCT me."actor")
      FILTER (WHERE me."eventType" = 'ARTWORK_SOLD') AS unique_sellers,

    COUNT(*) FILTER (WHERE me."eventType" = 'LISTING_CREATED') AS new_listings
  FROM "MarketplaceEvent" me
  GROUP BY DATE(me."ledgerTimestamp")
) e
LEFT JOIN LATERAL (
  SELECT
    SUM(l.price)        AS sales_volume,
    AVG(l.price)        AS avg_sale_price
  FROM "Listing" l
  WHERE l.status = 'Sold'
    AND DATE(l."updatedAt") = e.day
) s ON true
ORDER BY day;

-- Unique index required for concurrent refresh
CREATE UNIQUE INDEX IF NOT EXISTS daily_marketplace_stats_day_idx
  ON daily_marketplace_stats (day);

