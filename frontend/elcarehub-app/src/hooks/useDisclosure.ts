/**
 * hooks/useDisclosure.ts
 *
 * Work item C — React hook for action disclosure acknowledgement.
 *
 * Returns:
 *   acknowledged  — true if the current version has been accepted
 *   acknowledge   — call this when the user checks the box / clicks Accept
 *   disclosure    — the full DisclosureRecord for the action
 *
 * The hook initialises from localStorage so reloads do not prompt again
 * for the same disclosure version.
 */

import { useState, useCallback, useEffect } from 'react';
import {
  DisclosureActionType,
  DisclosureRecord,
  DISCLOSURES,
  isAcknowledged,
  recordAcknowledgement,
} from '@/lib/disclosures';

export interface UseDisclosureResult {
  disclosure: DisclosureRecord;
  acknowledged: boolean;
  acknowledge: () => void;
  /** True if the disclosure requires acknowledgement AND has not been given */
  blocksAction: boolean;
}

export function useDisclosure(action: DisclosureActionType): UseDisclosureResult {
  const disclosure = DISCLOSURES[action];

  const [acknowledged, setAcknowledged] = useState<boolean>(() => {
    // Safe to call isAcknowledged here since useState initialiser runs once
    return disclosure.requiresAcknowledgement ? isAcknowledged(action) : true;
  });

  // Sync with localStorage on mount (handles SSR hydration mismatch)
  useEffect(() => {
    if (disclosure.requiresAcknowledgement) {
      setAcknowledged(isAcknowledged(action));
    }
  }, [action, disclosure.requiresAcknowledgement]);

  const acknowledge = useCallback(() => {
    recordAcknowledgement(action);
    setAcknowledged(true);
  }, [action]);

  return {
    disclosure,
    acknowledged,
    acknowledge,
    blocksAction: disclosure.requiresAcknowledgement && !acknowledged,
  };
}
