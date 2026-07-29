/**
 * Unit tests for lib/ipfs.ts — IPFS gateway fallback utilities.
 * Includes new tests for Issue #7: upload validation, computeFileHash, and
 * extended gateway-fallback behaviour.
 */
import axios from 'axios';

jest.mock('@/lib/config', () => ({
  config: {
    pinataGateway: 'https://gateway.pinata.cloud',
  },
}));

jest.mock('axios');
const mockAxios = jest.mocked(axios);

import {
  normalizeIpfsUri,
  getGatewayUrls,
  cidToGatewayUrl,
  fetchMetadata,
  DEFAULT_FALLBACK_GATEWAYS,
  validateImageFile,
  validateArtworkMetadata,
  computeFileHash,
  ALLOWED_IMAGE_TYPES,
  MAX_IMAGE_SIZE_BYTES,
  MIN_IMAGE_DIMENSION_PX,
  MAX_IMAGE_DIMENSION_PX,
} from '@/lib/ipfs';

// ── normalizeIpfsUri ──────────────────────────────────────────────────────────

describe('normalizeIpfsUri', () => {
  it('strips ipfs:// prefix from a CID', () => {
    expect(normalizeIpfsUri('ipfs://QmTest123')).toBe('QmTest123');
  });

  it('passes a raw CID through unchanged', () => {
    expect(normalizeIpfsUri('QmTest123')).toBe('QmTest123');
  });

  it('passes an HTTP URL through unchanged', () => {
    expect(normalizeIpfsUri('https://example.com/img.png')).toBe('https://example.com/img.png');
  });

  it('trims whitespace', () => {
    expect(normalizeIpfsUri('  ipfs://QmTest  ')).toBe('QmTest');
  });
});

// ── getGatewayUrls ────────────────────────────────────────────────────────────

describe('getGatewayUrls', () => {
  it('returns primary gateway first, then fallbacks', () => {
    const urls = getGatewayUrls('QmTest', 'https://my-gateway.example.com');
    expect(urls[0]).toBe('https://my-gateway.example.com/ipfs/QmTest');
    expect(urls[1]).toBe('https://ipfs.io/ipfs/QmTest');
    expect(urls.slice(2)).toEqual(
      DEFAULT_FALLBACK_GATEWAYS.slice(1).map((g) => `${g}/ipfs/QmTest`)
    );
  });

  it('deduplicates when primary matches a fallback', () => {
    const urls = getGatewayUrls('QmTest', 'https://ipfs.io');
    const ipfsIoCount = urls.filter((u) => u.startsWith('https://ipfs.io')).length;
    expect(ipfsIoCount).toBe(1);
  });

  it('strips ipfs:// prefix from input', () => {
    const urls = getGatewayUrls('ipfs://QmTest');
    expect(urls[0]).toContain('/ipfs/QmTest');
  });

  it('returns a single-element array for HTTP URLs', () => {
    const urls = getGatewayUrls('https://cdn.example.com/img.png');
    expect(urls).toEqual(['https://cdn.example.com/img.png']);
  });

  it('uses config.pinataGateway when no primary is provided', () => {
    const urls = getGatewayUrls('QmTest');
    expect(urls[0]).toBe('https://gateway.pinata.cloud/ipfs/QmTest');
  });

  it('strips trailing slashes from gateway URLs', () => {
    const urls = getGatewayUrls('QmTest', 'https://gateway.example.com/');
    expect(urls[0]).toBe('https://gateway.example.com/ipfs/QmTest');
  });
});

// ── cidToGatewayUrl ───────────────────────────────────────────────────────────

describe('cidToGatewayUrl', () => {
  it('returns the first gateway URL (primary)', () => {
    const url = cidToGatewayUrl('QmTest');
    expect(url).toBe('https://gateway.pinata.cloud/ipfs/QmTest');
  });

  it('handles HTTP URLs', () => {
    const url = cidToGatewayUrl('https://cdn.example.com/img.png');
    expect(url).toBe('https://cdn.example.com/img.png');
  });
});

// ── fetchMetadata ─────────────────────────────────────────────────────────────

describe('fetchMetadata', () => {
  const mockMetadata = { title: 'Test', description: 'Desc', image: 'QmImg', year: '2024', category: 'art' };

  beforeEach(() => {
    mockAxios.get.mockReset();
  });

  it('fetches from the primary gateway on first attempt', async () => {
    mockAxios.get.mockResolvedValueOnce({ data: mockMetadata });

    const result = await fetchMetadata('QmMetaCid');
    expect(result).toEqual(mockMetadata);
    expect(mockAxios.get).toHaveBeenCalledTimes(1);
    expect(mockAxios.get).toHaveBeenCalledWith(
      'https://gateway.pinata.cloud/ipfs/QmMetaCid'
    );
  });

  it('falls back to the next gateway when the primary fails', async () => {
    mockAxios.get
      .mockRejectedValueOnce(new Error('Primary down'))
      .mockResolvedValueOnce({ data: mockMetadata });

    const result = await fetchMetadata('QmMetaCid');
    expect(result).toEqual(mockMetadata);
    expect(mockAxios.get).toHaveBeenCalledTimes(2);
    expect(mockAxios.get).toHaveBeenNthCalledWith(
      2,
      'https://ipfs.io/ipfs/QmMetaCid'
    );
  });

  it('throws when all gateways fail', async () => {
    mockAxios.get.mockRejectedValue(new Error('All gateways down'));

    await expect(fetchMetadata('QmMetaCid')).rejects.toThrow('All gateways down');
    expect(mockAxios.get).toHaveBeenCalledTimes(
      1 + DEFAULT_FALLBACK_GATEWAYS.length
    );
  });

  it('returns a default object for undefined CIDs', async () => {
    const result = await fetchMetadata(undefined);
    expect(result).toEqual({
      title: 'Unknown Artwork',
      description: '',
      artist: 'Unknown',
      image: '',
      year: '',
      category: '',
    });
    expect(mockAxios.get).not.toHaveBeenCalled();
  });
});

// ── validateImageFile (Issue #7) ──────────────────────────────────────────────

function makeFile(
  name: string,
  type: string,
  size: number,
  content = 'x'
): File {
  // Build a File whose .size property equals `size` even if content is short
  const blob = new Blob([content.padEnd(size, '0')], { type });
  return new File([blob], name, { type });
}

describe('validateImageFile', () => {
  it('accepts a valid JPEG under the size limit', async () => {
    const file = makeFile('art.jpg', 'image/jpeg', 1024);
    const result = await validateImageFile(file);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('accepts all allowed MIME types', async () => {
    for (const type of ALLOWED_IMAGE_TYPES) {
      const file = makeFile(`art.${type.split('/')[1]}`, type, 512);
      const result = await validateImageFile(file);
      expect(result.errors).not.toContain('UNSUPPORTED_TYPE');
    }
  });

  it('rejects an unsupported MIME type', async () => {
    const file = makeFile('doc.pdf', 'application/pdf', 512);
    const result = await validateImageFile(file);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('UNSUPPORTED_TYPE');
    expect(result.messages[0]).toMatch(/unsupported image type/i);
  });

  it('rejects an empty file', async () => {
    const file = makeFile('empty.png', 'image/png', 0, '');
    const result = await validateImageFile(file);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('FILE_EMPTY');
  });

  it('rejects a file exceeding MAX_IMAGE_SIZE_BYTES', async () => {
    // Build a file descriptor whose reported size exceeds the limit without
    // actually allocating 20 MB of memory.
    const oversized = { name: 'big.png', type: 'image/png', size: MAX_IMAGE_SIZE_BYTES + 1 } as File;
    const result = await validateImageFile(oversized);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('FILE_TOO_LARGE');
    expect(result.messages[0]).toMatch(/exceeds the 20 MB limit/i);
  });

  it('returns multiple errors for multiple problems', async () => {
    const file = { name: 'bad.bmp', type: 'image/bmp', size: 0 } as File;
    const result = await validateImageFile(file);
    expect(result.errors).toContain('UNSUPPORTED_TYPE');
    expect(result.errors).toContain('FILE_EMPTY');
  });

  it('skips dimension check when createImageBitmap is not available', async () => {
    // In jsdom, createImageBitmap is typically undefined — the function should
    // succeed without dimension errors for valid type/size files.
    const file = makeFile('art.png', 'image/png', 1024);
    const result = await validateImageFile(file);
    // Should not contain dimension errors
    expect(result.errors).not.toContain('DIMENSIONS_TOO_SMALL');
    expect(result.errors).not.toContain('DIMENSIONS_TOO_LARGE');
  });
});

// ── validateArtworkMetadata (Issue #7 + #68) ──────────────────────────────────

describe('validateArtworkMetadata', () => {
  const valid = {
    title: 'My Artwork',
    artist: 'GARTIST',
    image: 'ipfs://QmABC',
    altText: 'A colourful digital painting of a sunset over the ocean.',
  };

  it('passes for a complete metadata object', () => {
    expect(validateArtworkMetadata(valid).valid).toBe(true);
  });

  it('rejects when title is missing', () => {
    const r = validateArtworkMetadata({ ...valid, title: '' });
    expect(r.errors).toContain('MISSING_TITLE');
  });

  it('rejects when artist is missing', () => {
    const r = validateArtworkMetadata({ ...valid, artist: '' });
    expect(r.errors).toContain('MISSING_ARTIST');
  });

  it('rejects when image CID is missing', () => {
    const r = validateArtworkMetadata({ ...valid, image: '' });
    expect(r.errors).toContain('MISSING_IMAGE');
  });

  it('rejects when altText is absent for a non-decorative image', () => {
    const r = validateArtworkMetadata({ ...valid, altText: undefined });
    expect(r.errors).toContain('MISSING_ALT_TEXT');
  });

  it('rejects when altText exceeds 300 chars', () => {
    const r = validateArtworkMetadata({ ...valid, altText: 'a'.repeat(301) });
    expect(r.errors).toContain('ALT_TEXT_TOO_LONG');
    expect(r.messages[0]).toMatch(/300 characters/i);
  });

  it('accepts when isDecorativeImage is true and altText is absent', () => {
    const r = validateArtworkMetadata({
      ...valid,
      altText: undefined,
      isDecorativeImage: true,
    });
    expect(r.valid).toBe(true);
  });

  it('collects multiple errors', () => {
    const r = validateArtworkMetadata({});
    expect(r.errors.length).toBeGreaterThanOrEqual(3);
    expect(r.errors).toContain('MISSING_TITLE');
    expect(r.errors).toContain('MISSING_IMAGE');
  });
});

// ── computeFileHash (Issue #7) ────────────────────────────────────────────────

describe('computeFileHash', () => {
  it('returns an empty string when crypto.subtle is unavailable', async () => {
    const origCrypto = (globalThis as any).crypto;
    (globalThis as any).crypto = undefined;
    const file = makeFile('art.png', 'image/png', 4);
    const hash = await computeFileHash(file);
    expect(hash).toBe('');
    (globalThis as any).crypto = origCrypto;
  });

  it('returns a hex string when crypto.subtle is available', async () => {
    if (typeof crypto === 'undefined' || !crypto.subtle) return; // skip in envs without subtle
    const file = makeFile('art.png', 'image/png', 8, 'ABCDEFGH');
    const hash = await computeFileHash(file);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('returns different hashes for different content', async () => {
    if (typeof crypto === 'undefined' || !crypto.subtle) return;
    const fileA = makeFile('a.png', 'image/png', 8, 'AAAAAAAA');
    const fileB = makeFile('b.png', 'image/png', 8, 'BBBBBBBB');
    const [hashA, hashB] = await Promise.all([computeFileHash(fileA), computeFileHash(fileB)]);
    expect(hashA).not.toBe(hashB);
  });

  it('is deterministic for the same content', async () => {
    if (typeof crypto === 'undefined' || !crypto.subtle) return;
    const file = makeFile('art.png', 'image/png', 8, 'CONTENT1');
    const [h1, h2] = await Promise.all([computeFileHash(file), computeFileHash(file)]);
    expect(h1).toBe(h2);
  });
});

jest.mock('@/lib/config', () => ({
  config: {
    pinataGateway: 'https://gateway.pinata.cloud',
  },
}));

jest.mock('axios');
const mockAxios = jest.mocked(axios);

import {
  normalizeIpfsUri,
  getGatewayUrls,
  cidToGatewayUrl,
  fetchMetadata,
  DEFAULT_FALLBACK_GATEWAYS,
} from '@/lib/ipfs';

describe('normalizeIpfsUri', () => {
  it('strips ipfs:// prefix from a CID', () => {
    expect(normalizeIpfsUri('ipfs://QmTest123')).toBe('QmTest123');
  });

  it('passes a raw CID through unchanged', () => {
    expect(normalizeIpfsUri('QmTest123')).toBe('QmTest123');
  });

  it('passes an HTTP URL through unchanged', () => {
    expect(normalizeIpfsUri('https://example.com/img.png')).toBe('https://example.com/img.png');
  });

  it('trims whitespace', () => {
    expect(normalizeIpfsUri('  ipfs://QmTest  ')).toBe('QmTest');
  });
});

describe('getGatewayUrls', () => {
  it('returns primary gateway first, then fallbacks', () => {
    const urls = getGatewayUrls('QmTest', 'https://my-gateway.example.com');
    expect(urls[0]).toBe('https://my-gateway.example.com/ipfs/QmTest');
    expect(urls[1]).toBe('https://ipfs.io/ipfs/QmTest');
    expect(urls.slice(2)).toEqual(
      DEFAULT_FALLBACK_GATEWAYS.slice(1).map((g) => `${g}/ipfs/QmTest`)
    );
  });

  it('deduplicates when primary matches a fallback', () => {
    const urls = getGatewayUrls('QmTest', 'https://ipfs.io');
    const ipfsIoCount = urls.filter((u) => u.startsWith('https://ipfs.io')).length;
    expect(ipfsIoCount).toBe(1);
  });

  it('strips ipfs:// prefix from input', () => {
    const urls = getGatewayUrls('ipfs://QmTest');
    expect(urls[0]).toContain('/ipfs/QmTest');
  });

  it('returns a single-element array for HTTP URLs', () => {
    const urls = getGatewayUrls('https://cdn.example.com/img.png');
    expect(urls).toEqual(['https://cdn.example.com/img.png']);
  });

  it('uses config.pinataGateway when no primary is provided', () => {
    const urls = getGatewayUrls('QmTest');
    expect(urls[0]).toBe('https://gateway.pinata.cloud/ipfs/QmTest');
  });

  it('strips trailing slashes from gateway URLs', () => {
    const urls = getGatewayUrls('QmTest', 'https://gateway.example.com/');
    expect(urls[0]).toBe('https://gateway.example.com/ipfs/QmTest');
  });
});

describe('cidToGatewayUrl', () => {
  it('returns the first gateway URL (primary)', () => {
    const url = cidToGatewayUrl('QmTest');
    expect(url).toBe('https://gateway.pinata.cloud/ipfs/QmTest');
  });

  it('handles HTTP URLs', () => {
    const url = cidToGatewayUrl('https://cdn.example.com/img.png');
    expect(url).toBe('https://cdn.example.com/img.png');
  });
});

describe('fetchMetadata', () => {
  const mockMetadata = { title: 'Test', description: 'Desc', image: 'QmImg', year: '2024', category: 'art' };

  beforeEach(() => {
    mockAxios.get.mockReset();
  });

  it('fetches from the primary gateway on first attempt', async () => {
    mockAxios.get.mockResolvedValueOnce({ data: mockMetadata });

    const result = await fetchMetadata('QmMetaCid');
    expect(result).toEqual(mockMetadata);
    expect(mockAxios.get).toHaveBeenCalledTimes(1);
    expect(mockAxios.get).toHaveBeenCalledWith(
      'https://gateway.pinata.cloud/ipfs/QmMetaCid'
    );
  });

  it('falls back to the next gateway when the primary fails', async () => {
    mockAxios.get
      .mockRejectedValueOnce(new Error('Primary down'))
      .mockResolvedValueOnce({ data: mockMetadata });

    const result = await fetchMetadata('QmMetaCid');
    expect(result).toEqual(mockMetadata);
    expect(mockAxios.get).toHaveBeenCalledTimes(2);
    expect(mockAxios.get).toHaveBeenNthCalledWith(
      2,
      'https://ipfs.io/ipfs/QmMetaCid'
    );
  });

  it('throws when all gateways fail', async () => {
    mockAxios.get.mockRejectedValue(new Error('All gateways down'));

    await expect(fetchMetadata('QmMetaCid')).rejects.toThrow('All gateways down');
    // Should have tried every gateway
    expect(mockAxios.get).toHaveBeenCalledTimes(
      1 + DEFAULT_FALLBACK_GATEWAYS.length
    );
  });

  it('returns a default object for undefined CIDs', async () => {
    const result = await fetchMetadata(undefined);
    expect(result).toEqual({
      title: 'Unknown Artwork',
      description: '',
      artist: 'Unknown',
      image: '',
      year: '',
      category: '',
    });
    expect(mockAxios.get).not.toHaveBeenCalled();
  });
});
