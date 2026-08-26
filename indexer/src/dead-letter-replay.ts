/**
 * dead-letter-replay.ts — Operator CLI for dead-letter event management.
 *
 * Commands:
 *   --list   [--status=Pending|Replayed|Failed] [--limit=50]
 *   --inspect --id=<n>
 *   --replay [--ids=1,2,3] [--limit=10] [--dry-run]
 *
 * Replay attempts to re-parse the stored raw event topics and value.
 * On success the record is marked Replayed; on failure the attempt count is
 * incremented and the record is marked Failed after three attempts.
 * Replayed events are subject to the normal idempotency constraints because
 * they go through parseMarketplaceEvent, which returns null for unknown types,
 * and through applyDecodedEvents, which upserts on eventHash.
 *
 * Usage (after `npm run prisma:generate`):
 *   tsx src/dead-letter-replay.ts --list
 *   tsx src/dead-letter-replay.ts --inspect --id=42
 *   tsx src/dead-letter-replay.ts --replay --limit=20 --dry-run
 */

import prisma     from './db.js';
import prismaWrite from './prisma-write.js';
import { parseMarketplaceEvent } from './parser.js';

const MAX_REPLAY_ATTEMPTS = 3;

// ── CLI argument parsing ──────────────────────────────────────────────────────

const argv = process.argv.slice(2);

function flag(name: string): boolean {
  return argv.includes(`--${name}`);
}

function option(name: string): string | undefined {
  const prefix = `--${name}=`;
  const found  = argv.find((a) => a.startsWith(prefix));
  return found ? found.slice(prefix.length) : undefined;
}

// ── Commands ──────────────────────────────────────────────────────────────────

async function listRecords() {
  const status = option('status') as any;
  const limit  = parseInt(option('limit') ?? '50', 10);

  const records = await (prisma as any).deadLetterEvent.findMany({
    where:   status ? { status } : {},
    take:    limit,
    orderBy: { createdAt: 'asc' },
    select:  { id: true, status: true, errorCode: true, contractId: true, ledgerSequence: true, attempts: true, createdAt: true },
  });

  if (records.length === 0) {
    console.log('No dead-letter records found.');
    return;
  }

  console.log(`Found ${records.length} record(s):\n`);
  for (const r of records) {
    console.log(
      `  id=${r.id}  status=${r.status}  errorCode=${r.errorCode}` +
      `  contractId=${r.contractId}  ledger=${r.ledgerSequence}` +
      `  attempts=${r.attempts}  created=${new Date(r.createdAt).toISOString()}`
    );
  }
}

async function inspectRecord(id: number) {
  const record = await (prisma as any).deadLetterEvent.findUnique({ where: { id } });
  if (!record) {
    console.error(`No dead-letter record with id=${id}`);
    process.exitCode = 1;
    return;
  }
  console.log(JSON.stringify(record, null, 2));
}

async function replayRecords() {
  const idsRaw = option('ids');
  const limit  = parseInt(option('limit') ?? '10', 10);
  const dryRun = flag('dry-run');

  const where: any = { status: 'Pending' };
  if (idsRaw) {
    where.id = { in: idsRaw.split(',').map((s) => parseInt(s.trim(), 10)) };
  }

  const records = await (prisma as any).deadLetterEvent.findMany({
    where,
    take:    limit,
    orderBy: { createdAt: 'asc' },
  });

  console.log(`Replaying ${records.length} record(s) (dryRun=${dryRun})...\n`);

  let succeeded = 0;
  let failed    = 0;

  for (const record of records) {
    try {
      const topics = Array.isArray(record.rawTopics) ? (record.rawTopics as string[]) : [];
      const decoded = parseMarketplaceEvent(
        topics,
        record.rawValue,
        record.ledgerSequence,
        record.contractId,
        record.txHash,
        record.eventIndex,
      );

      if (!decoded) {
        console.log(`  id=${record.id}: parsed to null (unknown event type) — skipping`);
        continue;
      }

      console.log(`  id=${record.id}: parsed as ${decoded.eventType}${dryRun ? ' [DRY RUN]' : ''}`);

      if (!dryRun) {
        // Mark as Replayed.  The caller is responsible for re-ingesting the
        // event via the backfill system if DB state also needs to be updated.
        await (prismaWrite as any).deadLetterEvent.update({
          where: { id: record.id },
          data:  { status: 'Replayed', attempts: { increment: 1 } },
        });
      }
      succeeded++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  id=${record.id}: failed — ${msg}`);

      if (!dryRun) {
        const nextAttempts = record.attempts + 1;
        await (prismaWrite as any).deadLetterEvent.update({
          where: { id: record.id },
          data:  {
            attempts:     { increment: 1 },
            errorMessage: msg.slice(0, 1000),
            ...(nextAttempts >= MAX_REPLAY_ATTEMPTS ? { status: 'Failed' } : {}),
          },
        });
      }
      failed++;
    }
  }

  console.log(`\nDone. succeeded=${succeeded} failed=${failed}`);
}

// ── Entry point ───────────────────────────────────────────────────────────────

async function main() {
  if (flag('list')) {
    await listRecords();
  } else if (flag('inspect')) {
    const id = parseInt(option('id') ?? '', 10);
    if (isNaN(id)) {
      console.error('--inspect requires --id=<number>');
      process.exitCode = 1;
      return;
    }
    await inspectRecord(id);
  } else if (flag('replay')) {
    await replayRecords();
  } else {
    console.log(
      'Usage:\n' +
      '  tsx src/dead-letter-replay.ts --list [--status=Pending|Replayed|Failed] [--limit=50]\n' +
      '  tsx src/dead-letter-replay.ts --inspect --id=<n>\n' +
      '  tsx src/dead-letter-replay.ts --replay [--ids=1,2,3] [--limit=10] [--dry-run]'
    );
  }
}

main()
  .catch((err) => { console.error(err); process.exitCode = 1; })
  .finally(() => prismaWrite.$disconnect());
