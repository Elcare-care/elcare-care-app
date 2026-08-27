/**
 * Tests for EditProfileModal component (issue #533)
 */
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// ── Mocks ──────────────────────────────────────────────────────────────────

jest.mock('lucide-react', () =>
    Object.fromEntries(
        ['X', 'Globe', 'Edit3', 'Save', 'Twitter'].map((name) => [
            name,
            ({ 'aria-hidden': _ah, ...rest }: any) => <span data-testid={`icon-${name}`} {...rest} />,
        ])
    )
);

jest.mock('@/context/WalletContext', () => ({
    useWalletContext: jest.fn(),
}));

jest.mock('@/lib/artistProfile', () => ({
    getProfile: jest.fn(),
    saveProfile: jest.fn(),
}));

import { useWalletContext } from '@/context/WalletContext';
import { getProfile, saveProfile } from '@/lib/artistProfile';
import { EditProfileModal } from '@/components/EditProfileModal';

const mockUseWalletContext = useWalletContext as jest.MockedFunction<typeof useWalletContext>;
const mockGetProfile = getProfile as jest.MockedFunction<typeof getProfile>;
const mockSaveProfile = saveProfile as jest.MockedFunction<typeof saveProfile>;

const TEST_ADDRESS = 'GABC123456789';

// Default wallet context
const defaultWalletCtx = {
    publicKey: TEST_ADDRESS,
    isConnected: true,
} as any;

// Helper: render the modal in its open state
function renderModal(overrides: Partial<React.ComponentProps<typeof EditProfileModal>> = {}) {
    const defaultProps: React.ComponentProps<typeof EditProfileModal> = {
        address: TEST_ADDRESS,
        isOpen: true,
        onClose: jest.fn(),
        onSave: jest.fn(),
        ...overrides,
    };
    return {
        ...render(<EditProfileModal {...defaultProps} />),
        props: defaultProps,
    };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('EditProfileModal', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockUseWalletContext.mockReturnValue(defaultWalletCtx);
        mockGetProfile.mockReturnValue(null);
        mockSaveProfile.mockImplementation(() => undefined);
    });

    // ── 1. Renders empty form when no existing profile ────────────────────

    it('renders with empty form fields when no existing profile exists', () => {
        mockGetProfile.mockReturnValue(null);
        renderModal();

        expect(screen.getByRole('dialog')).toBeInTheDocument();
        expect(screen.getByLabelText(/display name/i)).toHaveValue('');
        expect(screen.getByLabelText(/bio/i)).toHaveValue('');
        expect(screen.getByLabelText(/twitter/i)).toHaveValue('');
        expect(screen.getByLabelText(/website/i)).toHaveValue('');
    });

    // ── 2. Pre-fills form when profile already exists ────────────────────

    it('renders with pre-filled values when a profile already exists', () => {
        mockGetProfile.mockReturnValue({
            displayName: 'Kofi Mensah',
            bio: 'Ghanaian kente weaver turned digital artist.',
            twitterHandle: 'kofimensah_art',
            websiteUrl: 'https://kofimensah.art',
        });

        renderModal();

        expect(screen.getByLabelText(/display name/i)).toHaveValue('Kofi Mensah');
        expect(screen.getByLabelText(/bio/i)).toHaveValue('Ghanaian kente weaver turned digital artist.');
        expect(screen.getByLabelText(/twitter/i)).toHaveValue('kofimensah_art');
        expect(screen.getByLabelText(/website/i)).toHaveValue('https://kofimensah.art');
    });

    // ── 3. Display name change triggers onSave with new value ────────────

    it('saves updated display name and calls onSave callback', async () => {
        mockGetProfile.mockReturnValue(null);
        const user = userEvent.setup();
        const { props } = renderModal();

        const nameInput = screen.getByLabelText(/display name/i);
        await user.clear(nameInput);
        await user.type(nameInput, 'Amara Diallo');

        await user.click(screen.getByRole('button', { name: /save profile/i }));

        expect(mockSaveProfile).toHaveBeenCalledWith(
            TEST_ADDRESS,
            expect.objectContaining({ displayName: 'Amara Diallo' })
        );
        expect(props.onSave).toHaveBeenCalledWith(
            expect.objectContaining({ displayName: 'Amara Diallo' })
        );
    });

    // ── 4. Bio change triggers onSave with new value ─────────────────────

    it('saves updated bio and calls onSave callback', async () => {
        mockGetProfile.mockReturnValue(null);
        const user = userEvent.setup();
        const { props } = renderModal();

        const bioTextarea = screen.getByLabelText(/bio/i);
        await user.clear(bioTextarea);
        await user.type(bioTextarea, 'Celebrating African heritage through NFTs.');

        await user.click(screen.getByRole('button', { name: /save profile/i }));

        expect(mockSaveProfile).toHaveBeenCalledWith(
            TEST_ADDRESS,
            expect.objectContaining({ bio: 'Celebrating African heritage through NFTs.' })
        );
        expect(props.onSave).toHaveBeenCalledWith(
            expect.objectContaining({ bio: 'Celebrating African heritage through NFTs.' })
        );
    });

    // ── 5. Cancel closes modal without saving ────────────────────────────

    it('calls onClose without saving when Cancel is clicked', async () => {
        mockGetProfile.mockReturnValue(null);
        const user = userEvent.setup();
        const { props } = renderModal();

        const nameInput = screen.getByLabelText(/display name/i);
        await user.type(nameInput, 'Some Name');

        await user.click(screen.getByRole('button', { name: /cancel/i }));

        expect(props.onClose).toHaveBeenCalledTimes(1);
        expect(mockSaveProfile).not.toHaveBeenCalled();
        expect(props.onSave).not.toHaveBeenCalled();
    });

    // ── 6. Character limit: display name > 50 chars shows error ─────────

    it('shows a validation error when display name exceeds 50 characters', async () => {
        mockGetProfile.mockReturnValue(null);
        const user = userEvent.setup();
        const { props } = renderModal();

        const nameInput = screen.getByLabelText(/display name/i);
        // 51-character string
        const longName = 'A'.repeat(51);
        await user.clear(nameInput);
        await user.type(nameInput, longName);

        await user.click(screen.getByRole('button', { name: /save profile/i }));

        expect(await screen.findByRole('alert')).toHaveTextContent(/50 characters/i);
        expect(mockSaveProfile).not.toHaveBeenCalled();
        expect(props.onSave).not.toHaveBeenCalled();
    });

    // ── 7. Twitter handle strips leading @ on save ───────────────────────

    it('strips the leading @ from a twitter handle before saving', async () => {
        mockGetProfile.mockReturnValue(null);
        const user = userEvent.setup();
        const { props } = renderModal();

        const twitterInput = screen.getByLabelText(/twitter/i);
        // Simulate the user typing with an @ prefix
        fireEvent.change(twitterInput, { target: { value: '@artisthandle' } });

        await user.click(screen.getByRole('button', { name: /save profile/i }));

        expect(mockSaveProfile).toHaveBeenCalledWith(
            TEST_ADDRESS,
            expect.objectContaining({ twitterHandle: 'artisthandle' })
        );
    });

    // ── 8. Does not render when isOpen is false ──────────────────────────

    it('renders nothing when isOpen is false', () => {
        renderModal({ isOpen: false });
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    // ── 9. Close button (X) calls onClose ────────────────────────────────

    it('calls onClose when the X close button is clicked', async () => {
        mockGetProfile.mockReturnValue(null);
        const user = userEvent.setup();
        const { props } = renderModal();

        await user.click(screen.getByRole('button', { name: /close edit profile/i }));

        expect(props.onClose).toHaveBeenCalledTimes(1);
    });
});
