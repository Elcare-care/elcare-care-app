/**
 * operator-actor-label.test.ts — Issue #1066.
 *
 * Operator-initiated mutations (dead-letter remediate/replay, snapshot verify)
 * record an `actor` in audit tables. That label must never be the raw
 * X-Operator-Token value.
 */

import { describe, it, expect } from 'vitest';
import { operatorActorLabel } from '../api/auth-middleware';

const FAKE_TOKEN = 'fixture-operator-token-not-real-0000000000';

function req(headers: Record<string, unknown>, ip?: string): any {
  return { headers, ip };
}

describe('operatorActorLabel', () => {
  it('never contains the raw operator token', () => {
    const label = operatorActorLabel(req({ 'x-operator-token': FAKE_TOKEN }, '10.0.0.5'));
    expect(label).not.toContain(FAKE_TOKEN);
    expect(label).toMatch(/^operator:tok-[0-9a-f]{12}$/);
  });

  it('is stable for the same token and differs for another token', () => {
    const a = operatorActorLabel(req({ 'x-operator-token': FAKE_TOKEN }));
    const b = operatorActorLabel(req({ 'x-operator-token': FAKE_TOKEN }));
    const c = operatorActorLabel(req({ 'x-operator-token': FAKE_TOKEN + 'x' }));
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it('falls back to the client ip, then "unknown", when no token header is sent', () => {
    expect(operatorActorLabel(req({}, '10.0.0.5'))).toBe('operator:ip-10.0.0.5');
    expect(operatorActorLabel(req({}))).toBe('operator:unknown');
  });
});
