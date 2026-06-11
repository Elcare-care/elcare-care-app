import { rpc } from '@stellar/stellar-sdk';
import dotenv from 'dotenv';
import { pathToFileURL } from 'node:url';
import prisma from './db.js';
import { applyDecodedEvents, buildSyncStateLedgerData } from './poller.js';
import { collectMarketplaceEvents } from './event-sync.js';

dotenv.config();

type BackfillArgs = {
  rpcUrl: string;
  startLedger: number;
  endLedger?: number;
};

function getContractIds(): string[] {
  return [
    process.env.MARKETPLACE_CONTRACT_ID || '',
    process.env.LAUNCHPAD_CONTRACT_ID || '',
  ].filter(Boolean);
}

function readFlag(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.slice(2).find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

function parseLedger(value: string | undefined, label: string): number {
  if (!value) {
    throw new Error(`Missing required --${label} flag`);
  }

  const ledger = Number(value);
  if (!Number.isInteger(ledger) || ledger < 0) {
    throw new Error(`Invalid --${label} value: ${value}`);
  }

  return ledger;
}

function parseArgs(): BackfillArgs {
  const endLedgerFlag = readFlag('end');
  const rpcUrl = readFlag('rpc') || process.env.ARCHIVAL_STELLAR_RPC_URL || process.env.STELLAR_RPC_URL || '';
  if (!rpcUrl) {
    throw new Error('Missing archival RPC URL. Set ARCHIVAL_STELLAR_RPC_URL or pass --rpc=<url>.');
  }

  return {
    rpcUrl,
    startLedger: parseLedger(readFlag('start'), 'start'),
    endLedger: endLedgerFlag ? parseLedger(endLedgerFlag, 'end') : undefined,
  };
}

async function fetchLedgerHash(server: rpc.Server, ledger: number): Promise<string | null> {
  try {
    const ledgersRes = await server.getLedgers({
      startLedger: ledger,
      pagination: { limit: 1 },
    });

    return ledgersRes.ledgers?.[0]?.hash ?? null;
  } catch (err) {
    console.error({ msg: 'Failed to fetch ledger hash during backfill', ledger, err });
    return null;
  }
}

export async function runBackfill() {
  const { rpcUrl, startLedger, endLedger } = parseArgs();
  const contractIds = getContractIds();

  if (contractIds.length === 0) {
    throw new Error('At least one of MARKETPLACE_CONTRACT_ID or LAUNCHPAD_CONTRACT_ID must be set');
  }

  const server = new rpc.Server(rpcUrl);
  const networkLatestLedger = endLedger ?? (await server.getLatestLedger()).sequence;

  const decodedEvents = await collectMarketplaceEvents(
    server,
    contractIds,
    startLedger,
    networkLatestLedger
  );

  const processedLedger = decodedEvents.length > 0
    ? Math.max(...decodedEvents.map((event) => event.ledgerSequence))
    : networkLatestLedger;

  const latestHash = await fetchLedgerHash(server, processedLedger);

  const { insertedCount } = await prisma.$transaction(async (tx) => {
    const inserted = await applyDecodedEvents(decodedEvents, tx);
    const ledgerData = buildSyncStateLedgerData(processedLedger, latestHash);
    await tx.syncState.upsert({
      where: { id: 1 },
      create: { id: 1, ...ledgerData },
      update: ledgerData,
    });

    return { insertedCount: inserted.length };
  });

  console.log({
    msg: 'Backfill complete',
    startLedger,
    endLedger: networkLatestLedger,
    insertedCount,
    processedLedger,
  });
}

if (process.argv[1] && process.argv[1].includes('backfill')) {
  runBackfill().catch((err) => {
    console.error({ msg: 'Backfill failed', err: err instanceof Error ? err.message : String(err) });
    process.exit(1);
  });
}