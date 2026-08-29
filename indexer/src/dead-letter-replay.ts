/**
 * dead-letter-replay.ts — Operator CLI for dead-letter event management.
 *
 * Commands:
 *   --list       [--status=Pending|Replayed|Failed] [--limit=50] [--offset=0]
 *   --inspect    --id=<n>
 *   --remediate  --id=<n> --reason="<text>"
 *   --replay     [--ids=1,2,3] [--limit=10] [--dry-run] [--idempotency-key=<k>]
 *   --replay     --id=<n>      [--dry-run] [--idempotency-key=<k>]
 *
 * Every replay attempt is written to DeadLetterReplayAttempt and OperationalAudit.
 * Successful replay commits the projection before setting status=Replayed.
 *
 * Usage (after `npm run prisma:generate`):
 *   tsx src/dead-letter-replay.ts --list
 *   tsx src/dead-letter-replay.ts --list --status=Failed
 *   tsx src/dead-letter-replay.ts --inspect --id=42
 *   tsx src/dead-letter-replay.ts --remediate --id=42 --reason="parser v2.1 fixes this"
 *   tsx src/dead-letter-replay.ts --replay --id=42 --dry-run
 *   tsx src/dead-letter-replay.ts --replay --limit=20 --dry-run
 *   tsx src/dead-letter-replay.ts --replay --ids=1,2,3 --idempotency-key=op-2026-08-29-001
 */

import prismaWrite from './prisma-write.js';
import {
  listDeadLetters,
  inspectDeadLetter,
  remediateDeadLetter,
  replayDeadLetter,
  replayDeadLetterBatch,
} from './dead-letter-service.js';

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

// Derive a CLI actor identifier (non-sensitive)
const CLI_ACTOR = `cli:${process.env.USER ?? process.env.USERNAME ?? 'operator'}`;

// ── Commands ──────────────────────────────────────────────────────────────────

async function cmdList() {
  const status     = option('status') as any;
  const limit      = parseInt(option('limit')  ?? '50', 10);
  const offset     = parseInt(option('offset') ?? '0',  10);
  const contractId = option('contract');

  const { records, total } = await listDeadLetters({ status, limit, offset, contractId });

  if (records.length === 0) {
    console.log('No dead-letter records found.');
    return;
  }

  console.log(`Showing ${records.length} of ${total} record(s):\n`);
  for (const r of records as any[]) {
    const replayCount = r._count?.replayAttempts ?? 0;
    console.log(
      `  id=${r.id}  status=${r.status}  errorCode=${r.errorCode}` +
      `  contractId=${r.contractId}  ledger=${r.ledgerSequence}` +
      `  attempts=${r.attempts}  replayAttempts=${replayCount}` +
      `  remediated=${!!r.remediationReason}` +
      `  created=${new Date(r.createdAt).toISOString()}`,
    );
  }
}

async function cmdInspect(id: number) {
  const record = await inspectDeadLetter(id);
  if (!record) {
    console.error(`No dead-letter record with id=${id}`);
    process.exitCode = 1;
    return;
  }
  // Pretty-print, showing redacted payload
  const { replayAttempts, ...core } = record as any;
  console.log('=== Dead-letter record ===');
  console.log(JSON.stringify(core, null, 2));
  if (replayAttempts?.length) {
    console.log(`\n=== Replay attempts (${replayAttempts.length}) ===`);
    for (const a of replayAttempts) {
      console.log(
        `  id=${a.id}  outcome=${a.outcome}  actor=${a.actor}` +
        `  dryRun=${a.dryRun}  committed=${a.projectionCommitted}` +
        `  at=${new Date(a.attemptedAt).toISOString()}` +
        (a.errorMessage ? `  error=${a.errorMessage}` : ''),
      );
    }
  } else {
    console.log('\nNo replay attempts yet.');
  }
}

async function cmdRemediate(id: number) {
  const reason = option('reason');
  if (!reason || reason.trim().length === 0) {
    console.error('--reason="<text>" is required for --remediate');
    process.exitCode = 1;
    return;
  }

  await remediateDeadLetter(id, {
    remediationReason: reason.trim(),
    actor:             CLI_ACTOR,
  });

  console.log(`✓ Remediation reason set for id=${id}`);
  console.log(`  reason: ${reason.trim()}`);
}

async function cmdReplay() {
  const idOpt         = option('id');
  const idsOpt        = option('ids');
  const limit         = parseInt(option('limit') ?? '10', 10);
  const dryRun        = flag('dry-run');
  const idempotencyKey = option('idempotency-key');

  // Single-record replay
  if (idOpt) {
    const id = parseInt(idOpt, 10);
    if (isNaN(id)) { console.error('--id must be a number'); process.exitCode = 1; return; }

    console.log(`Replaying id=${id} (dryRun=${dryRun})...`);
    const result = await replayDeadLetter(id, {
      actor:          CLI_ACTOR,
      dryRun,
      idempotencyKey: idempotencyKey ?? undefined,
    });

    const icon = result.outcome === 'success' ? '✓' : result.outcome === 'duplicate' ? '⇒' : '✗';
    console.log(
      `  ${icon} id=${id}  outcome=${result.outcome}` +
      (result.parsedEventType ? `  type=${result.parsedEventType}` : '') +
      `  committed=${result.projectionCommitted}  ${result.durationMs}ms`,
    );
    if (result.outcome !== 'success' && result.outcome !== 'duplicate') process.exitCode = 1;
    return;
  }

  // Batch replay
  const ids = idsOpt ? idsOpt.split(',').map((s) => parseInt(s.trim(), 10)).filter((n) => !isNaN(n)) : undefined;

  console.log(`Replaying batch (limit=${limit}, dryRun=${dryRun}${ids ? `, ids=${ids.join(',')}` : ''})...\n`);

  const batch = await replayDeadLetterBatch({
    actor:          CLI_ACTOR,
    dryRun,
    ids,
    limit,
    status:         'Pending',
    idempotencyKey: idempotencyKey ?? undefined,
  });

  for (const { id, result } of batch.results) {
    if ('error' in result) {
      console.log(`  ✗ id=${id}  error=${result.error}`);
    } else {
      const icon = result.outcome === 'success' ? '✓' : result.outcome === 'duplicate' ? '⇒' : '✗';
      console.log(
        `  ${icon} id=${id}  outcome=${result.outcome}` +
        (result.parsedEventType ? `  type=${result.parsedEventType}` : '') +
        `  committed=${result.projectionCommitted}  ${result.durationMs}ms`,
      );
    }
  }

  console.log(`\nDone. total=${batch.total} succeeded=${batch.succeeded} failed=${batch.failed} skipped=${batch.skipped}`);
  if (batch.failed > 0) process.exitCode = 1;
}

// ── Entry point ───────────────────────────────────────────────────────────────

async function main() {
  if (flag('list')) {
    await cmdList();
  } else if (flag('inspect')) {
    const id = parseInt(option('id') ?? '', 10);
    if (isNaN(id)) { console.error('--inspect requires --id=<number>'); process.exitCode = 1; return; }
    await cmdInspect(id);
  } else if (flag('remediate')) {
    const id = parseInt(option('id') ?? '', 10);
    if (isNaN(id)) { console.error('--remediate requires --id=<number>'); process.exitCode = 1; return; }
    await cmdRemediate(id);
  } else if (flag('replay')) {
    await cmdReplay();
  } else {
    console.log(
      'Usage:\n' +
      '  tsx src/dead-letter-replay.ts --list [--status=Pending|Replayed|Failed] [--limit=50] [--offset=0]\n' +
      '  tsx src/dead-letter-replay.ts --inspect --id=<n>\n' +
      '  tsx src/dead-letter-replay.ts --remediate --id=<n> --reason="<text>"\n' +
      '  tsx src/dead-letter-replay.ts --replay --id=<n> [--dry-run] [--idempotency-key=<k>]\n' +
      '  tsx src/dead-letter-replay.ts --replay [--ids=1,2,3] [--limit=10] [--dry-run]',
    );
  }
}

main()
  .catch((err) => { console.error(err); process.exitCode = 1; })
  .finally(() => prismaWrite.$disconnect());
