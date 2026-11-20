/**
 * Unit tests for useTxToast.ts
 *
 * Covers:
 * - Success lifecycle: pushes info toasts for each phase, then a success toast
 * - Success toast includes the stellar.expert explorer URL when a hash is available
 * - Failure lifecycle: pushes an error toast with the mapped error message
 * - User rejection: shows a cancellation message, not a generic error
 * - getTxExplorerUrl: returns correct URLs for testnet / mainnet / missing hash
 * - isUserRejectionError integration: recognised phrases suppress generic errors
 * - Toast dismissal (Issue 016): manual dismiss, auto-timeout, accessible name,
 *   and dismissal isolation from transaction state
 */

import React from 'react';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// ── Mocks ─────────────────────────────────────────────────────────────────────

// Stub config so we control the network value
jest.mock('@/lib/config', () => ({
  config: {
    contractId: 'CTEST',
    network: 'testnet',
    rpcUrl: 'https://soroban-testnet.stellar.org',
    networkPassphrase: 'Test SDF Network ; September 2015',
    indexerUrl: '',
  },
}));

// Stub errors module — we test the real isUserRejectionError separately below
jest.mock('@/lib/errors', () => {
  const actual = jest.requireActual('@/lib/errors');
  return {
    ...actual,
    getReadableErrorMessage: (_e: unknown, fallback: string) => fallback,
  };
});

// ── Imports ───────────────────────────────────────────────────────────────────

import { useTxToast, getTxExplorerUrl } from '@/hooks/useTxToast';
import { config } from '@/lib/config';
import { isUserRejectionError } from '@/lib/errors';
import { ToastProvider, useToast } from '@/components/ToastProvider';

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Renders a minimal component that exposes the useTxToast API via data-testid
 * attributes so we can inspect it from tests.
 */
function TxToastHarness({
  fn,
  action,
  onResult,
}: {
  fn: () => Promise<unknown>;
  action?: string;
  onResult?: (result: unknown) => void;
}) {
  const { run, isRunning, phase } = useTxToast();

  const handleClick = async () => {
    const result = await run(fn, { action });
    onResult?.(result);
  };

  return (
    <div>
      <button onClick={handleClick} data-testid="trigger">
        run
      </button>
      <span data-testid="running">{String(isRunning)}</span>
      <span data-testid="phase">{phase}</span>
    </div>
  );
}

function renderHarness(
  fn: () => Promise<unknown>,
  opts: { action?: string; onResult?: (r: unknown) => void } = {}
) {
  return render(
    <ToastProvider>
      <TxToastHarness fn={fn} action={opts.action} onResult={opts.onResult} />
    </ToastProvider>
  );
}

// ── getTxExplorerUrl ──────────────────────────────────────────────────────────

describe('getTxExplorerUrl', () => {
  const validHash = 'a'.repeat(64);

  beforeEach(() => {
    Object.defineProperty(config, 'network', { configurable: true, value: 'testnet' });
  });

  it('returns a testnet URL for the given hash', () => {
    const url = getTxExplorerUrl(validHash);
    expect(url).toBe(`https://stellar.expert/explorer/testnet/tx/${validHash}`);
  });

  it('returns a mainnet URL when the configured network is mainnet', () => {
    Object.defineProperty(config, 'network', { configurable: true, value: 'mainnet' });
    expect(getTxExplorerUrl(validHash)).toBe(`https://stellar.expert/explorer/mainnet/tx/${validHash}`);
  });

  it('returns null when hash is null', () => {
    expect(getTxExplorerUrl(null)).toBeNull();
  });

  it('returns null when hash is undefined', () => {
    expect(getTxExplorerUrl(undefined)).toBeNull();
  });

  it('returns null when hash is an empty string', () => {
    expect(getTxExplorerUrl('')).toBeNull();
  });

  it('returns null when the hash is not a valid Stellar transaction hash', () => {
    expect(getTxExplorerUrl('https://attacker.example')).toBeNull();
  });
});

// ── isUserRejectionError ──────────────────────────────────────────────────────

describe('isUserRejectionError (from errors.ts)', () => {
  it('detects "User rejected" (Freighter)', () => {
    expect(isUserRejectionError(new Error('User rejected the request'))).toBe(true);
  });

  it('detects "user denied" (Metamask-style)', () => {
    expect(isUserRejectionError(new Error('user denied transaction'))).toBe(true);
  });

  it('detects "user cancelled"', () => {
    expect(isUserRejectionError(new Error('user cancelled the operation'))).toBe(true);
  });

  it('detects "Transaction was rejected"', () => {
    expect(isUserRejectionError(new Error('Transaction was rejected by the user'))).toBe(true);
  });

  it('returns false for a generic error', () => {
    expect(isUserRejectionError(new Error('Insufficient balance'))).toBe(false);
  });

  it('returns false for a non-Error value', () => {
    expect(isUserRejectionError(null)).toBe(false);
    expect(isUserRejectionError(42)).toBe(false);
  });

  it('works with plain strings', () => {
    expect(isUserRejectionError('Request rejected by user')).toBe(true);
    expect(isUserRejectionError('some other failure')).toBe(false);
  });
});

// ── useTxToast — success lifecycle ───────────────────────────────────────────

describe('useTxToast — success lifecycle', () => {
  beforeEach(() => jest.clearAllMocks());

  it('shows info toasts during execution and a success toast on completion', async () => {
    const user = userEvent.setup();
    const successFn = jest.fn().mockResolvedValue(undefined);

    renderHarness(successFn, { action: 'Purchase' });

    await user.click(screen.getByTestId('trigger'));

    // Success toast should appear
    await waitFor(() => {
      expect(screen.getByRole('status', { hidden: true })).toBeInTheDocument();
    });

    // The success toast message should name the action and its outcome
    await waitFor(() => {
      const statuses = screen.getAllByRole('status', { hidden: true });
      const messages = statuses.map((el) => el.textContent ?? '');
      expect(messages.some((m) => m.includes('purchase') && m.includes('confirmed'))).toBe(true);
    });
  });

  it('returns the result of the wrapped function', async () => {
    const user = userEvent.setup();
    const results: unknown[] = [];
    const successFn = jest.fn().mockResolvedValue(42);

    renderHarness(successFn, { action: 'Test', onResult: (r) => results.push(r) });

    await user.click(screen.getByTestId('trigger'));
    await waitFor(() => expect(results).toHaveLength(1));
    expect(results[0]).toBe(42);
  });

  it('includes explorer URL in the success toast when the result has a hash', async () => {
    const user = userEvent.setup();
    const txHash = 'a'.repeat(64);
    const successFn = jest.fn().mockResolvedValue({ hash: txHash });

    renderHarness(successFn, { action: 'Bid' });

    await user.click(screen.getByTestId('trigger'));

    await waitFor(() => {
      const statuses = screen.getAllByRole('status', { hidden: true });
      const messages = statuses.map((el) => el.textContent ?? '');
      expect(
        messages.some((m) =>
          m.includes('stellar.expert') && m.includes(txHash)
        )
      ).toBe(true);
    });
  });

  it('shows a generic success toast when the result has no hash', async () => {
    const user = userEvent.setup();
    const successFn = jest.fn().mockResolvedValue({ someField: 'value' });

    renderHarness(successFn, { action: 'Listing' });

    await user.click(screen.getByTestId('trigger'));

    await waitFor(() => {
      const statuses = screen.getAllByRole('status', { hidden: true });
      const messages = statuses.map((el) => el.textContent ?? '');
      expect(
        messages.some((m) => m.includes('listing') && m.includes('confirmed'))
      ).toBe(true);
    });
  });

  it('isRunning is true during execution and false after', async () => {
    const user = userEvent.setup();
    let resolvePromise!: () => void;
    const controlledFn = () =>
      new Promise<void>((resolve) => {
        resolvePromise = resolve;
      });

    renderHarness(controlledFn, { action: 'Offer' });

    // Not running yet
    expect(screen.getByTestId('running').textContent).toBe('false');

    // Start the action (don't await — let it hang)
    act(() => {
      screen.getByTestId('trigger').click();
    });

    // Should be running now
    await waitFor(() =>
      expect(screen.getByTestId('running').textContent).toBe('true')
    );

    // Resolve the promise
    await act(async () => {
      resolvePromise();
    });

    // Should be done
    await waitFor(() =>
      expect(screen.getByTestId('running').textContent).toBe('false')
    );
  });

  // ── Outcome-specific next-action guidance ────────────────────────────────
  //
  // Every success toast must end with concise guidance for what to do next,
  // tailored to the action family (purchase / listing / bid / offer).

  it.each([
    { action: 'Purchase', guidance: 'Profile' },
    { action: 'Create listing', guidance: 'listing link' },
    { action: 'Bid', guidance: 'highest bid' },
    { action: 'Offer', guidance: 'Offers' },
  ])('appends next-action guidance for "$action"', async ({ action, guidance }) => {
    const user = userEvent.setup();
    const successFn = jest.fn().mockResolvedValue(undefined);

    renderHarness(successFn, { action });
    await user.click(screen.getByTestId('trigger'));

    await waitFor(() => {
      const statuses = screen.getAllByRole('status', { hidden: true });
      const messages = statuses.map((el) => el.textContent ?? '');
      expect(messages.some((m) => m.includes('Next:') && m.includes(guidance))).toBe(true);
    });
  });

  it('keeps the transaction hash available via the explorer link', async () => {
    const user = userEvent.setup();
    const txHash = 'b'.repeat(64);
    const successFn = jest.fn().mockResolvedValue({ hash: txHash });

    renderHarness(successFn, { action: 'Purchase' });
    await user.click(screen.getByTestId('trigger'));

    await waitFor(() => {
      const statuses = screen.getAllByRole('status', { hidden: true });
      const messages = statuses.map((el) => el.textContent ?? '');
      const msg = messages.find((m) => m.includes('stellar.expert'));
      expect(msg).toBeDefined();
      expect(msg).toContain(txHash);
      expect(msg).toContain('Next:');
    });
  });

  it('uses generic guidance for unmapped actions', async () => {
    const user = userEvent.setup();
    const successFn = jest.fn().mockResolvedValue(undefined);

    renderHarness(successFn, { action: 'My Custom Action' });
    await user.click(screen.getByTestId('trigger'));

    await waitFor(() => {
      const statuses = screen.getAllByRole('status', { hidden: true });
      const messages = statuses.map((el) => el.textContent ?? '');
      expect(messages.some((m) => m.includes('on-chain state'))).toBe(true);
    });
  });

  it('uses a custom action label in toasts', async () => {
    const user = userEvent.setup();
    const successFn = jest.fn().mockResolvedValue(undefined);

    renderHarness(successFn, { action: 'My Custom Action' });
    await user.click(screen.getByTestId('trigger'));

    await waitFor(() => {
      const statuses = screen.getAllByRole('status', { hidden: true });
      const messages = statuses.map((el) => el.textContent ?? '');
      expect(messages.some((m) => m.includes('My Custom Action'))).toBe(true);
    });
  });
});

// ── useTxToast — failure lifecycle ───────────────────────────────────────────

describe('useTxToast — failure lifecycle', () => {
  beforeEach(() => jest.clearAllMocks());

  it('shows an error toast and returns null on failure', async () => {
    const user = userEvent.setup();
    const results: unknown[] = [];
    const failFn = jest.fn().mockRejectedValue(new Error('Transaction failed'));

    renderHarness(failFn, { action: 'Purchase', onResult: (r) => results.push(r) });

    await user.click(screen.getByTestId('trigger'));

    // Error toast should appear
    await waitFor(() => {
      const alerts = screen.getAllByRole('alert', { hidden: true });
      expect(alerts.length).toBeGreaterThan(0);
    });

    // run() should have returned null
    await waitFor(() => expect(results).toHaveLength(1));
    expect(results[0]).toBeNull();
  });

  it('isRunning goes back to false after failure', async () => {
    const user = userEvent.setup();
    const failFn = jest.fn().mockRejectedValue(new Error('oops'));

    renderHarness(failFn, { action: 'Bid' });

    await user.click(screen.getByTestId('trigger'));

    await waitFor(() =>
      expect(screen.getByTestId('running').textContent).toBe('false')
    );
  });

  it('phase returns to error after a failure', async () => {
    const user = userEvent.setup();
    const failFn = jest.fn().mockRejectedValue(new Error('oops'));

    renderHarness(failFn, { action: 'Bid' });

    await user.click(screen.getByTestId('trigger'));

    await waitFor(() =>
      expect(screen.getByTestId('phase').textContent).toBe('error')
    );
  });

  it('shows a user-rejection message when the wallet rejects', async () => {
    const user = userEvent.setup();
    const rejectedFn = jest
      .fn()
      .mockRejectedValue(new Error('User rejected the request'));

    renderHarness(rejectedFn, { action: 'Listing' });

    await user.click(screen.getByTestId('trigger'));

    await waitFor(() => {
      const alerts = screen.getAllByRole('alert', { hidden: true });
      const messages = alerts.map((el) => el.textContent ?? '');
      expect(
        messages.some((m) => m.includes('cancelled') || m.includes('rejected'))
      ).toBe(true);
    });
  });

  it('does NOT include explorer URL in the error toast', async () => {
    const user = userEvent.setup();
    const failFn = jest.fn().mockRejectedValue(new Error('bad tx'));

    renderHarness(failFn, { action: 'Offer' });

    await user.click(screen.getByTestId('trigger'));

    await waitFor(() => {
      const alerts = screen.getAllByRole('alert', { hidden: true });
      const messages = alerts.map((el) => el.textContent ?? '');
      expect(messages.some((m) => m.includes('stellar.expert'))).toBe(false);
    });
  });
});

// ── Toast dismissal (Issue 016) ───────────────────────────────────────────────
//
// These tests target ToastProvider behaviour directly, keeping them decoupled
// from the transaction state machine.  A minimal harness pushes a toast via
// useToast() and the suite asserts dismissal semantics independently.

/**
 * A minimal component that exposes toast operations via data-testid attributes.
 * It intentionally holds no transaction state so we can verify that dismissing
 * a notification never mutates anything beyond the toast list.
 */
function ToastHarness() {
  const { pushToast, dismissToast } = useToast();
  const [lastDismissedId, setLastDismissedId] = React.useState<string | null>(null);

  return (
    <div>
      <button
        data-testid="push-info"
        onClick={() => pushToast('Hello world', 'info', 60_000)}
      >
        push info
      </button>
      <button
        data-testid="push-success"
        onClick={() => pushToast('All done', 'success', 60_000)}
      >
        push success
      </button>
      <button
        data-testid="push-short"
        onClick={() => pushToast('Gone soon', 'info', 100)}
      >
        push short-lived
      </button>
      {/* Expose the last dismissed id so tests can assert isolation */}
      <span data-testid="last-dismissed">{lastDismissedId ?? ''}</span>
    </div>
  );
}

function renderToastHarness() {
  return render(
    <ToastProvider>
      <ToastHarness />
    </ToastProvider>
  );
}

describe('Toast dismissal (Issue 016)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
  });

  // ── Manual dismissal ────────────────────────────────────────────────────────

  it('dismiss button removes the toast from the live region', async () => {
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
    renderToastHarness();

    await user.click(screen.getByTestId('push-info'));

    // Toast should be present
    expect(screen.getByText('Hello world')).toBeInTheDocument();

    // Click the dismiss button on that toast
    await user.click(screen.getByRole('button', { name: /dismiss notification/i }));

    // Toast must be gone
    expect(screen.queryByText('Hello world')).not.toBeInTheDocument();
  });

  it('dismissing one toast does not remove other toasts', async () => {
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
    renderToastHarness();

    // Push two toasts
    await user.click(screen.getByTestId('push-info'));
    await user.click(screen.getByTestId('push-success'));

    expect(screen.getByText('Hello world')).toBeInTheDocument();
    expect(screen.getByText('All done')).toBeInTheDocument();

    // Dismiss only the first one
    const dismissButtons = screen.getAllByRole('button', { name: /dismiss notification/i });
    await user.click(dismissButtons[0]);

    expect(screen.queryByText('Hello world')).not.toBeInTheDocument();
    expect(screen.getByText('All done')).toBeInTheDocument();
  });

  // ── Accessible dismiss button ───────────────────────────────────────────────

  it('every dismiss button has an accessible name', async () => {
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
    renderToastHarness();

    await user.click(screen.getByTestId('push-info'));
    await user.click(screen.getByTestId('push-success'));

    const dismissButtons = screen.getAllByRole('button', { name: /dismiss notification/i });
    expect(dismissButtons.length).toBeGreaterThanOrEqual(2);
    for (const btn of dismissButtons) {
      // getByRole with name already validates the accessible name is non-empty,
      // but we also assert aria-label is explicitly set (not relying on inner text).
      expect(btn).toHaveAttribute('aria-label', 'Dismiss notification');
    }
  });

  // ── Auto-timeout ────────────────────────────────────────────────────────────

  it('toast disappears automatically after its configured duration', async () => {
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
    renderToastHarness();

    // Push a toast with a 100 ms lifetime
    await user.click(screen.getByTestId('push-short'));
    expect(screen.getByText('Gone soon')).toBeInTheDocument();

    // Advance time past the timeout
    act(() => {
      jest.advanceTimersByTime(150);
    });

    await waitFor(() => {
      expect(screen.queryByText('Gone soon')).not.toBeInTheDocument();
    });
  });

  it('manually dismissed toast does not reappear after its original timeout fires', async () => {
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
    renderToastHarness();

    // Push a short-lived toast
    await user.click(screen.getByTestId('push-short'));
    expect(screen.getByText('Gone soon')).toBeInTheDocument();

    // Manually dismiss before the timer fires
    await user.click(screen.getByRole('button', { name: /dismiss notification/i }));
    expect(screen.queryByText('Gone soon')).not.toBeInTheDocument();

    // Now let the original timeout fire — the toast should still be absent
    act(() => {
      jest.advanceTimersByTime(200);
    });

    await waitFor(() => {
      expect(screen.queryByText('Gone soon')).not.toBeInTheDocument();
    });
  });

  // ── Dismissal does not mutate transaction state ─────────────────────────────
  //
  // Render the full useTxToast harness, run a successful transaction so we
  // have a real toast present, then dismiss it and confirm the phase/isRunning
  // values are unchanged — dismissing UI feedback never cancels or alters the
  // underlying transaction.

  it('dismissing a toast does not alter transaction phase or isRunning', async () => {
    // Use real timers for the tx harness (fake timers conflict with promises)
    jest.useRealTimers();

    const user = userEvent.setup();

    // A transaction that resolves immediately
    const successFn = jest.fn().mockResolvedValue(undefined);

    render(
      <ToastProvider>
        <TxToastHarness fn={successFn} action="Offer" />
      </ToastProvider>
    );

    // Run the transaction to completion so a success toast is visible
    await user.click(screen.getByTestId('trigger'));

    // Wait for the success toast to appear
    await waitFor(() => {
      const statuses = screen.getAllByRole('status', { hidden: true });
      expect(statuses.some((el) => (el.textContent ?? '').includes('confirmed'))).toBe(true);
    });

    // Record phase before dismissal
    const phaseBefore = screen.getByTestId('phase').textContent;
    const runningBefore = screen.getByTestId('running').textContent;

    // Dismiss ALL visible toasts
    const dismissButtons = screen.queryAllByRole('button', { name: /dismiss notification/i });
    for (const btn of dismissButtons) {
      await user.click(btn);
    }

    // Toasts should be gone from the live region
    await waitFor(() => {
      expect(screen.queryAllByRole('status', { hidden: true }).length).toBe(0);
      expect(screen.queryAllByRole('alert', { hidden: true }).length).toBe(0);
    });

    // Transaction phase and running state must be unchanged
    expect(screen.getByTestId('phase').textContent).toBe(phaseBefore);
    expect(screen.getByTestId('running').textContent).toBe(runningBefore);
  });
});
