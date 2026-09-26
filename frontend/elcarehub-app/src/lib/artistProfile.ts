// ─────────────────────────────────────────────────────────────────────────────
// lib/artistProfile.ts — Local-storage backed artist profile metadata store
//
// Stores per-address profile metadata (display name, bio, social links) in
// localStorage under the key `artist_profile_<address>`.
// All functions are SSR-safe (guarded by `typeof window` checks).
// ─────────────────────────────────────────────────────────────────────────────

export interface ArtistProfile {
    /** Human-readable display name (max 50 chars) */
    displayName: string;
    /** Short artist bio (max 300 chars) */
    bio: string;
    /** Twitter / X handle — stored WITHOUT the leading '@' */
    twitterHandle: string;
    /** Artist website URL */
    websiteUrl: string;
}

/** Partial version used when saving — all fields are optional */
export type ArtistProfileUpdate = Partial<ArtistProfile>;

const STORAGE_PREFIX = 'artist_profile_';

function storageKey(address: string): string {
    return `${STORAGE_PREFIX}${address}`;
}

/**
 * Read the stored profile for `address`.
 * Returns `null` if nothing is stored or storage is unavailable.
 */
export function getProfile(address: string): ArtistProfile | null {
    if (typeof window === 'undefined') return null;

    try {
        const raw = localStorage.getItem(storageKey(address));
        if (!raw) return null;

        const parsed = JSON.parse(raw) as Partial<ArtistProfile>;
        return {
            displayName: parsed.displayName ?? '',
            bio: parsed.bio ?? '',
            twitterHandle: parsed.twitterHandle ?? '',
            websiteUrl: parsed.websiteUrl ?? '',
        };
    } catch (err) {
        console.warn('[artistProfile] Failed to read profile', err);
        return null;
    }
}

/**
 * Persist (or update) the profile for `address`.
 * Merges `data` over any existing stored values so callers can do partial
 * updates.
 */
export function saveProfile(address: string, data: ArtistProfileUpdate): void {
    if (typeof window === 'undefined') return;

    try {
        const existing = getProfile(address) ?? {
            displayName: '',
            bio: '',
            twitterHandle: '',
            websiteUrl: '',
        };

        const updated: ArtistProfile = {
            ...existing,
            ...data,
        };

        localStorage.setItem(storageKey(address), JSON.stringify(updated));
    } catch (err) {
        console.warn('[artistProfile] Failed to save profile', err);
    }
}

/**
 * Remove the stored profile for `address`.
 */
export function clearProfile(address: string): void {
    if (typeof window === 'undefined') return;

    try {
        localStorage.removeItem(storageKey(address));
    } catch {
        // Ignore
    }
}
