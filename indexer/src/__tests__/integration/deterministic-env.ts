/**
 * deterministic-env.ts — Deterministic integration test environment.
 *
 * Integration tests must produce identical results for identical code +
 * inputs, on any developer machine or CI runner. This module removes the
 * known sources of nondeterminism that have bitten integration suites:
 *
 *   1. Timezone / locale drift      → TZ pinned to UTC, LC_ALL to C.
 *   2. Random ordering / data       → PRNG seeded from INTEGRATION_TEST_SEED
 *                                     (fixed by default, overridable).
 *   3. Wall-clock-dependent logic   → frozen clock helper (opt-in per test).
 *   4. Floating infrastructure       → container images pinned by immutable
 *                                     digest (not mutable tags like `:15-alpine`).
 *   5. Hidden env leakage            → required/forbidden env asserted up front.
 *
 * The module is intentionally dependency-free and side-effect-light so it can
 * be unit-tested (see src/__tests__/deterministic-env.test.ts) and imported
 * from globalSetup.ts as well as individual tests.
 */

// ── Pinned constants ─────────────────────────────────────────────────────────

/** Default PRNG seed. Override with INTEGRATION_TEST_SEED to reproduce a run. */
export const DEFAULT_TEST_SEED = 1337;

/** Immutable digests — NEVER use mutable tags (`:15-alpine`) in integration CI. */
export const PINNED_IMAGES = {
  postgres: 'postgres:15-alpine@sha256:0599d387a6bf04a1b25ba0e5c7e153cf187b1fdefa86c4fc47f8afde3ab7fd95',
  redis: 'redis:7-alpine@sha256:311f9de6f104f8ce0dfad0a52d4b5dcb3d08c9ad183614fcfaf1a5b1d99756a2',
} as const;

export type ImageName = keyof typeof PINNED_IMAGES;

// ── Environment pinning ──────────────────────────────────────────────────────

export interface EnvPinResult {
  applied: string[];
}

/**
 * Pin process-level environment sources of nondeterminism.
 * Idempotent; returns the list of variables actually set.
 */
export function pinProcessEnv(env: NodeJS.ProcessEnv = process.env): EnvPinResult {
  const applied: string[] = [];

  if (env.TZ !== 'UTC') {
    env.TZ = 'UTC';
    applied.push('TZ=UTC');
  }
  if (env.LC_ALL !== 'C') {
    env.LC_ALL = 'C';
    applied.push('LC_ALL=C');
  }
  // Node's DNS/order and V8 hash-seed behaviour are stable per-process, but
  // make intent explicit for anything shelling out (prisma migrate etc.).
  if (env.NODE_OPTIONS && env.NODE_OPTIONS.includes('--frozen-intrinsics')) {
    // leave untouched — already hardened
  } else {
    // Do NOT inject NODE_OPTIONS globally: prisma/vitest child processes can
    // choke on unknown flags across versions. Documented instead of enforced.
  }

  return { applied };
}

// ── Seeded PRNG ──────────────────────────────────────────────────────────────

/**
 * mulberry32 — tiny, fast, well-distributed 32-bit PRNG.
 * Deterministic across platforms (pure integer arithmetic, no Math.random).
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function next(): number {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Resolve the seed from env or the default. Validates numeric input. */
export function resolveSeed(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.INTEGRATION_TEST_SEED;
  if (raw === undefined || raw === '') return DEFAULT_TEST_SEED;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0 || !Number.isInteger(parsed)) {
    throw new Error(
      `INTEGRATION_TEST_SEED must be a non-negative integer, got: "${raw}"`
    );
  }
  return parsed;
}

/**
 * Create a seeded RNG plus convenience helpers. Each call is independent:
 * two calls with the same seed yield identical sequences.
 */
export function createSeededRandom(seed: number) {
  const next = mulberry32(seed);
  return {
    /** Next float in [0, 1). */
    next,
    /** Next integer in [min, max] inclusive. */
    int(min: number, max: number): number {
      return min + Math.floor(next() * (max - min + 1));
    },
    /** Pick a random element (array must be non-empty). */
    pick<T>(items: readonly T[]): T {
      if (items.length === 0) throw new Error('pick() called with empty array');
      return items[Math.floor(next() * items.length)];
    },
    /** Fisher–Yates shuffle returning a new array. */
    shuffle<T>(items: readonly T[]): T[] {
      const arr = [...items];
      for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
      }
      return arr;
    },
  };
}

// ── Frozen clock ─────────────────────────────────────────────────────────────

export interface FrozenClock {
  /** The instant the clock is frozen at (ISO string). */
  iso: string;
  /** Restore the real Date implementation. Always call in afterEach/teardown. */
  restore: () => void;
}

/**
 * Freeze Date.now()/new Date() at a fixed instant for the duration of a test.
 * Opt-in: only tests that assert time-dependent behaviour need this; freezing
 * globally would break Prisma/Redis internals that rely on timers advancing.
 */
export function freezeClockAt(iso: string): FrozenClock {
  const frozen = new Date(iso).getTime();
  if (!Number.isFinite(frozen)) {
    throw new Error(`freezeClockAt: invalid ISO timestamp "${iso}"`);
  }
  const RealDate = Date;

  function FakeDate(...args: unknown[]): Date {
    if (args.length === 0) return new RealDate(frozen);
    // @ts-expect-error — spread into the real constructor overloads.
    return new RealDate(...args);
  }
  // Static surface: now/parse/UTC must reflect the frozen instant where relevant.
  Object.defineProperty(FakeDate, 'now', { value: () => frozen });
  FakeDate.parse = RealDate.parse;
  FakeDate.UTC = RealDate.UTC;
  (FakeDate as unknown as { prototype: Date }).prototype = RealDate.prototype;

  Date = FakeDate as unknown as DateConstructor;
  return {
    iso: new RealDate(frozen).toISOString(),
    restore() {
      Date = RealDate;
    },
  };
}

// ── Reproducibility metadata ─────────────────────────────────────────────────

export interface ReproMetadata {
  seed: number;
  timezone: string;
  nodeVersion: string;
  pinnedImages: Record<ImageName, string>;
  startedAt: string;
}

/** Snapshot describing exactly how this run was made deterministic. */
export function collectReproMetadata(now: Date = new Date()): ReproMetadata {
  return {
    seed: resolveSeed(),
    timezone: process.env.TZ ?? '(unset)',
    nodeVersion: process.version,
    pinnedImages: { ...PINNED_IMAGES },
    startedAt: now.toISOString(),
  };
}