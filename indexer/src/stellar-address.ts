/**
 * stellar-address.ts — Stellar address validation utility.
 *
 * A valid Stellar public key (G-address) is a 56-character base32 string that
 * starts with the letter "G".  Base32 uses the alphabet A–Z and 2–7.
 *
 * This check is a fast syntactic guard — it does not validate the checksum
 * embedded in the Stellar key encoding (that would require full XDR decoding).
 * Syntactic validation is sufficient to reject obviously malformed inputs and
 * SQL metacharacters before they reach the query layer.
 */

/** Stellar base32 alphabet: A-Z plus digits 2-7. */
const STELLAR_ADDRESS_RE = /^G[A-Z2-7]{55}$/;

/**
 * Returns true when `addr` matches the 56-character Stellar G-address format.
 *
 * @example
 *   isValidStellarAddress('GBFUNHEQOVN35LFEKP7SZXFYJPMJ3WLXLX4PQZGBK737NTLRHOKVES3F') // true
 *   isValidStellarAddress('not-an-address')                                                // false
 *   isValidStellarAddress('')                                                               // false
 */
export function isValidStellarAddress(addr: string): boolean {
  if (typeof addr !== 'string') return false;
  return STELLAR_ADDRESS_RE.test(addr);
}

/**
 * Zod refinement message for Stellar address fields.
 * Use with `.refine(isValidStellarAddress, STELLAR_ADDRESS_ERROR)`.
 */
export const STELLAR_ADDRESS_ERROR =
  'Must be a valid 56-character Stellar G-address (base32, starts with G)';
