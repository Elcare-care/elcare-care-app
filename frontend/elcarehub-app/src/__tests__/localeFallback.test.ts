import en from '../../messages/en.json';
import sw from '../../messages/sw.json';

type Messages = Record<string, unknown>;

/**
 * Flattens a nested message object into a list of dot-separated keys.
 * Arrays are treated as leaf values (their indices are not expanded).
 */
function flattenKeys(messages: Messages, prefix = ''): string[] {
  const keys: string[] = [];

  for (const [key, value] of Object.entries(messages)) {
    const path = prefix ? `${prefix}.${key}` : key;

    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      keys.push(...flattenKeys(value as Messages, path));
    } else {
      keys.push(path);
    }
  }

  return keys;
}

/**
 * Explicit allowlist of keys that are intentionally missing from sw.json.
 * Add entries here only when a missing Swahili translation is deliberate.
 */
const ALLOWED_MISSING_SW_KEYS: string[] = [];

describe('locale parity: en.json vs sw.json', () => {
  const enKeys = flattenKeys(en as Messages);
  const swKeys = new Set(flattenKeys(sw as Messages));

  const missingInSw = enKeys.filter((key) => !swKeys.has(key)).sort();

  it('reports keys present in en.json but missing from sw.json', () => {
    // Report missing entries for visibility in test output.
    if (missingInSw.length > 0) {
      // eslint-disable-next-line no-console
      console.warn(
        `Missing Swahili translations (${missingInSw.length}):\n` +
          missingInSw.map((key) => `  - ${key}`).join('\n'),
      );
    }

    expect(missingInSw).toEqual(
      [...ALLOWED_MISSING_SW_KEYS].sort(),
    );
  });

  it('has no duplicate flattened keys in en.json', () => {
    expect(enKeys.length).toBe(new Set(enKeys).size);
  });
});