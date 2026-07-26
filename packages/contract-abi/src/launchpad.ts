/**
 * launchpad.ts — Generated TypeScript types for the ElcareHub launchpad contract.
 *
 * Mirrors contracts/launchpad/src/types.rs and events.rs.
 */

export const LAUNCHPAD_CONTRACT_VERSION = '1.0.0' as const;

export type CollectionKind = 'normal_721' | 'normal_1155' | 'lazy_721' | 'lazy_1155';

/** Emitted when a new collection contract is deployed via the launchpad factory. */
export interface DeployEvent {
  /** Creator address (deployer). */
  creator: string;
  /** Address of the newly deployed collection contract. */
  contractAddress: string;
  kind: CollectionKind;
}

/** Union of all launchpad event payload types keyed by their indexer event type string. */
export type LaunchpadEventPayload =
  | { type: 'DEPLOY_NORMAL_721';  data: DeployEvent }
  | { type: 'DEPLOY_NORMAL_1155'; data: DeployEvent }
  | { type: 'DEPLOY_LAZY_721';    data: DeployEvent }
  | { type: 'DEPLOY_LAZY_1155';   data: DeployEvent };
