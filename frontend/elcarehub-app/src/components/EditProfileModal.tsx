'use client';

import React, { useEffect, useState } from 'react';
import { X, Globe, Edit3, Save } from 'lucide-react';
import { useWalletContext } from '@/context/WalletContext';
import { getProfile, saveProfile, ArtistProfile } from '@/lib/artistProfile';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface EditProfileModalProps {
    /** Stellar address whose profile is being edited */
    address: string;
    isOpen: boolean;
    onClose: () => void;
    /** Called after a successful save with the updated profile data */
    onSave: (profile: ArtistProfile) => void;
}

interface FormState {
    displayName: string;
    bio: string;
    twitterHandle: string;
    websiteUrl: string;
}

interface FormErrors {
    displayName?: string;
    bio?: string;
    twitterHandle?: string;
    websiteUrl?: string;
}

const DISPLAY_NAME_MAX = 50;
const BIO_MAX = 300;

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

export function EditProfileModal({ address, isOpen, onClose, onSave }: EditProfileModalProps) {
    const { publicKey } = useWalletContext();

    const [form, setForm] = useState<FormState>({
        displayName: '',
        bio: '',
        twitterHandle: '',
        websiteUrl: '',
    });

    const [errors, setErrors] = useState<FormErrors>({});

    // Load existing profile data when modal opens
    useEffect(() => {
        if (!isOpen) return;

        const existing = getProfile(address);
        if (existing) {
            setForm({
                displayName: existing.displayName,
                bio: existing.bio,
                twitterHandle: existing.twitterHandle,
                websiteUrl: existing.websiteUrl,
            });
        } else {
            setForm({ displayName: '', bio: '', twitterHandle: '', websiteUrl: '' });
        }
        setErrors({});
    }, [isOpen, address]);

    // Trap focus and handle Escape key
    useEffect(() => {
        if (!isOpen) return;

        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                onClose();
            }
        };

        document.addEventListener('keydown', handleKeyDown);
        return () => document.removeEventListener('keydown', handleKeyDown);
    }, [isOpen, onClose]);

    if (!isOpen) return null;

    // ── Validation ─────────────────────────────────────────────────────────

    function validate(data: FormState): FormErrors {
        const errs: FormErrors = {};

        if (data.displayName.length > DISPLAY_NAME_MAX) {
            errs.displayName = `Display name must be ${DISPLAY_NAME_MAX} characters or fewer.`;
        }

        if (data.bio.length > BIO_MAX) {
            errs.bio = `Bio must be ${BIO_MAX} characters or fewer.`;
        }

        if (data.websiteUrl && !/^https?:\/\/.+/.test(data.websiteUrl)) {
            errs.websiteUrl = 'Please enter a valid URL starting with http:// or https://.';
        }

        return errs;
    }

    // ── Handlers ───────────────────────────────────────────────────────────

    function handleChange(field: keyof FormState, value: string) {
        setForm((prev) => ({ ...prev, [field]: value }));
        // Clear field error on change
        if (errors[field]) {
            setErrors((prev) => ({ ...prev, [field]: undefined }));
        }
    }

    function handleTwitterChange(value: string) {
        // Strip any leading '@' characters
        const stripped = value.replace(/^@+/, '');
        handleChange('twitterHandle', stripped);
    }

    function handleSubmit(e: React.FormEvent) {
        e.preventDefault();

        const validationErrors = validate(form);
        if (Object.keys(validationErrors).length > 0) {
            setErrors(validationErrors);
            return;
        }

        const profile: ArtistProfile = {
            displayName: form.displayName.trim(),
            bio: form.bio.trim(),
            twitterHandle: form.twitterHandle.trim(),
            websiteUrl: form.websiteUrl.trim(),
        };

        saveProfile(address, profile);
        onSave(profile);
    }

    // ── Render ─────────────────────────────────────────────────────────────

    return (
        <div
            className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-midnight-950/70 backdrop-blur-sm animate-in fade-in duration-200"
            aria-hidden="false"
        >
            {/* Backdrop click to close */}
            <div
                className="absolute inset-0"
                aria-hidden="true"
                onClick={onClose}
            />

            <div
                role="dialog"
                aria-modal="true"
                aria-labelledby="edit-profile-title"
                aria-describedby="edit-profile-description"
                data-testid="edit-profile-modal"
                className="relative w-full max-w-lg overflow-hidden rounded-3xl bg-midnight-900 border border-white/10 shadow-2xl animate-in zoom-in-95 duration-200 outline-none"
            >
                {/* Header */}
                <div className="flex items-center justify-between border-b border-white/10 px-6 py-5">
                    <div className="flex items-center gap-3">
                        <div
                            className="flex h-9 w-9 items-center justify-center rounded-xl bg-brand-500/20 text-brand-400"
                            aria-hidden="true"
                        >
                            <Edit3 size={18} />
                        </div>
                        <h2
                            id="edit-profile-title"
                            className="font-display text-lg font-bold text-white"
                        >
                            Edit Profile
                        </h2>
                    </div>
                    <button
                        type="button"
                        onClick={onClose}
                        aria-label="Close edit profile dialog"
                        className="rounded-full p-1.5 text-white/40 transition-colors hover:bg-white/10 hover:text-white"
                    >
                        <X size={18} aria-hidden="true" />
                    </button>
                </div>

                {/* Form */}
                <form onSubmit={handleSubmit} noValidate>
                    <p
                        id="edit-profile-description"
                        className="sr-only"
                    >
                        Edit your artist profile information including display name, bio, and social links.
                    </p>

                    <div className="space-y-5 px-6 py-6">
                        {/* Display Name */}
                        <div>
                            <label
                                htmlFor="edit-display-name"
                                className="mb-1.5 block text-sm font-semibold text-white/70"
                            >
                                Display Name
                            </label>
                            <input
                                id="edit-display-name"
                                type="text"
                                value={form.displayName}
                                onChange={(e) => handleChange('displayName', e.target.value)}
                                maxLength={DISPLAY_NAME_MAX + 10} // allow slightly over so we can show error
                                placeholder="Your artist name"
                                aria-describedby={errors.displayName ? 'display-name-error' : 'display-name-hint'}
                                aria-invalid={!!errors.displayName}
                                className={`w-full rounded-2xl bg-white/5 border px-4 py-3 text-white placeholder-white/25 text-sm outline-none transition-colors focus:bg-white/8 focus:border-brand-500/60 ${
                                    errors.displayName
                                        ? 'border-red-500/60'
                                        : 'border-white/10 hover:border-white/20'
                                }`}
                            />
                            {errors.displayName ? (
                                <p
                                    id="display-name-error"
                                    role="alert"
                                    className="mt-1.5 text-xs text-red-400"
                                >
                                    {errors.displayName}
                                </p>
                            ) : (
                                <p
                                    id="display-name-hint"
                                    className="mt-1.5 text-xs text-white/30"
                                >
                                    {form.displayName.length}/{DISPLAY_NAME_MAX} characters
                                </p>
                            )}
                        </div>

                        {/* Bio */}
                        <div>
                            <label
                                htmlFor="edit-bio"
                                className="mb-1.5 block text-sm font-semibold text-white/70"
                            >
                                Bio
                            </label>
                            <textarea
                                id="edit-bio"
                                value={form.bio}
                                onChange={(e) => handleChange('bio', e.target.value)}
                                maxLength={BIO_MAX + 50}
                                placeholder="Tell collectors about yourself and your art..."
                                rows={4}
                                aria-describedby={errors.bio ? 'bio-error' : 'bio-hint'}
                                aria-invalid={!!errors.bio}
                                className={`w-full resize-none rounded-2xl bg-white/5 border px-4 py-3 text-white placeholder-white/25 text-sm outline-none transition-colors focus:bg-white/8 focus:border-brand-500/60 ${
                                    errors.bio
                                        ? 'border-red-500/60'
                                        : 'border-white/10 hover:border-white/20'
                                }`}
                            />
                            {errors.bio ? (
                                <p
                                    id="bio-error"
                                    role="alert"
                                    className="mt-1.5 text-xs text-red-400"
                                >
                                    {errors.bio}
                                </p>
                            ) : (
                                <p
                                    id="bio-hint"
                                    className="mt-1.5 text-xs text-white/30"
                                >
                                    {form.bio.length}/{BIO_MAX} characters
                                </p>
                            )}
                        </div>

                        {/* Twitter Handle */}
                        <div>
                            <label
                                htmlFor="edit-twitter"
                                className="mb-1.5 block text-sm font-semibold text-white/70"
                            >
                                Twitter / X Handle
                            </label>
                            <div className="relative">
                                <span
                                    className="absolute left-4 top-1/2 -translate-y-1/2 text-white/30 text-sm font-bold select-none"
                                    aria-hidden="true"
                                >
                                    @
                                </span>
                                <input
                                    id="edit-twitter"
                                    type="text"
                                    value={form.twitterHandle}
                                    onChange={(e) => handleTwitterChange(e.target.value)}
                                    placeholder="yourhandle"
                                    aria-describedby="twitter-hint"
                                    className="w-full rounded-2xl bg-white/5 border border-white/10 pl-8 pr-4 py-3 text-white placeholder-white/25 text-sm outline-none transition-colors hover:border-white/20 focus:bg-white/8 focus:border-brand-500/60"
                                />
                            </div>
                            <p id="twitter-hint" className="mt-1.5 text-xs text-white/30">
                                Without the @ symbol
                            </p>
                        </div>

                        {/* Website URL */}
                        <div>
                            <label
                                htmlFor="edit-website"
                                className="mb-1.5 block text-sm font-semibold text-white/70"
                            >
                                Website
                            </label>
                            <div className="relative">
                                <span
                                    className="absolute left-4 top-1/2 -translate-y-1/2 text-white/30"
                                    aria-hidden="true"
                                >
                                    <Globe size={15} />
                                </span>
                                <input
                                    id="edit-website"
                                    type="url"
                                    value={form.websiteUrl}
                                    onChange={(e) => handleChange('websiteUrl', e.target.value)}
                                    placeholder="https://yoursite.com"
                                    aria-describedby={errors.websiteUrl ? 'website-error' : undefined}
                                    aria-invalid={!!errors.websiteUrl}
                                    className={`w-full rounded-2xl bg-white/5 border pl-10 pr-4 py-3 text-white placeholder-white/25 text-sm outline-none transition-colors focus:bg-white/8 focus:border-brand-500/60 ${
                                        errors.websiteUrl
                                            ? 'border-red-500/60'
                                            : 'border-white/10 hover:border-white/20'
                                    }`}
                                />
                            </div>
                            {errors.websiteUrl && (
                                <p
                                    id="website-error"
                                    role="alert"
                                    className="mt-1.5 text-xs text-red-400"
                                >
                                    {errors.websiteUrl}
                                </p>
                            )}
                        </div>
                    </div>

                    {/* Footer actions */}
                    <div className="flex gap-3 border-t border-white/10 px-6 py-5">
                        <button
                            type="button"
                            onClick={onClose}
                            className="flex-1 rounded-2xl border border-white/10 py-3 text-sm font-semibold text-white/60 transition-colors hover:border-white/20 hover:text-white"
                        >
                            Cancel
                        </button>
                        <button
                            type="submit"
                            className="flex flex-1 items-center justify-center gap-2 rounded-2xl bg-brand-500 py-3 text-sm font-bold text-white shadow-lg shadow-brand-500/20 transition-all hover:bg-brand-600 active:scale-95"
                        >
                            <Save size={16} aria-hidden="true" />
                            Save Profile
                        </button>
                    </div>
                </form>
            </div>
        </div>
    );
}
