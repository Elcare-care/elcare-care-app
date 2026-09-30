/**
 * compatibility.ts — Contract version compatibility checks.
 *
 * Clients (frontend, indexer) should call isCompatible() at startup to detect
 * when a deployed contract version is newer than the types this package was
 * built against, which may indicate breaking ABI changes.
 *
 * Version scheme: MAJOR.MINOR.PATCH
 *   MAJOR bump — breaking: new mandatory method args, removed methods/events,
 *                changed error codes.
 *   MINOR bump — additive: new optional methods, new events, new optional fields.
 *   PATCH bump — non-breaking: bug fixes, documentation only.
 *
 * Compatibility rule:
 *   The client is compatible with a deployed contract when:
 *     clientMajor === deployedMajor  (same major version)
 *
 * A deployed minor version HIGHER than the client minor is "additive-only"
 * and generally safe — the client may not know about new events but will not
 * misinterpret existing ones.
 */

import { MARKETPLACE_CONTRACT_VERSION } from './marketplace.js';
import { LAUNCHPAD_CONTRACT_VERSION } from './launchpad.js';

export type ContractName = 'marketplace' | 'launchpad';

export interface CompatibilityResult {
  compatible: boolean;
  clientVersion: string;
  deployedVersion: string;
  reason?: string;
}

function parseSemver(version: string): [number, number, number] {
  const parts = version.split('.').map(Number);
  if (parts.length !== 3 || parts.some(isNaN)) {
    throw new Error(`Invalid semver: "${version}"`);
  }
  return parts as [number, number, number];
}

/**
 * Check whether the client package is compatible with a deployed contract version.
 *
 * @param contract       "marketplace" | "launchpad"
 * @param deployedVersion Semver string returned by get_version() on the deployed contract.
 */
export function checkCompatibility(
  contract: ContractName,
  deployedVersion: string,
): CompatibilityResult {
  const clientVersion =
    contract === 'marketplace' ? MARKETPLACE_CONTRACT_VERSION : LAUNCHPAD_CONTRACT_VERSION;

  let clientParts: [number, number, number];
  let deployedParts: [number, number, number];

  try {
    clientParts = parseSemver(clientVersion);
    deployedParts = parseSemver(deployedVersion);
  } catch (err) {
    return {
      compatible: false,
      clientVersion,
      deployedVersion,
      reason: `Version parse error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const [clientMajor, clientMinor] = clientParts;
  const [deployedMajor, deployedMinor] = deployedParts;

  if (deployedMajor !== clientMajor) {
    return {
      compatible: false,
      clientVersion,
      deployedVersion,
      reason:
        `Major version mismatch: client=${clientMajor}, deployed=${deployedMajor}. ` +
        `Update @elcarehub/contract-abi to a v${deployedMajor}.x.x release.`,
    };
  }

  if (deployedMinor > clientMinor) {
    // Deployed contract is NEWER — additive-only, safe but worth noting
    return {
      compatible: true,
      clientVersion,
      deployedVersion,
      reason:
        `Deployed contract has a higher minor version (${deployedMinor} > ${clientMinor}). ` +
        `New events or methods may not be recognised by this client. ` +
        `Consider upgrading @elcarehub/contract-abi.`,
    };
  }

  if (deployedMinor < clientMinor) {
    // Deployed contract is OLDER — client may reference methods/events not yet deployed
    return {
      compatible: true,
      clientVersion,
      deployedVersion,
      reason:
        `Client is ahead of the deployed contract (client minor=${clientMinor}, deployed minor=${deployedMinor}). ` +
        `Some client features may not be available on this deployment.`,
    };
  }

  return { compatible: true, clientVersion, deployedVersion };
}

/**
 * Assert compatibility and throw if incompatible.
 * Intended for use at application startup.
 *
 * @example
 *   assertCompatibility('marketplace', await contract.getVersion());
 */
export function assertCompatibility(
  contract: ContractName,
  deployedVersion: string,
): void {
  const result = checkCompatibility(contract, deployedVersion);
  if (!result.compatible) {
    throw new Error(
      `[contract-abi] Incompatible contract version for "${contract}": ${result.reason}`
    );
  }
}
