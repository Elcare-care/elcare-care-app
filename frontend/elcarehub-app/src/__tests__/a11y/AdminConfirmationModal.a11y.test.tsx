import React from 'react';
import { render, screen } from '@testing-library/react';
import { axe } from 'jest-axe';
import { AdminConfirmationModal } from '@/components/AdminConfirmationModal';

jest.mock('lucide-react', () =>
  Object.fromEntries(
    ['AlertTriangle', 'ShieldAlert', 'X', 'Loader2'].map((name) => [
      name,
      () => <span />,
    ])
  )
);

const defaultProps = {
  isOpen: true,
  onClose: jest.fn(),
  onConfirm: jest.fn(),
  title: 'Freeze Collection Metadata',
  actionDescription: 'This will permanently freeze metadata updates for this collection.',
  consequences: ['This action cannot be undone', 'Existing listings will be unaffected'],
};

describe('AdminConfirmationModal accessibility', () => {
  it('has no axe violations when open', async () => {
    const { container } = render(<AdminConfirmationModal {...defaultProps} />);
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  it('exposes dialog semantics with an accessible name and description', () => {
    render(<AdminConfirmationModal {...defaultProps} />);
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAccessibleName('Freeze Collection Metadata');
    expect(dialog).toHaveAccessibleDescription(/permanently freeze metadata/i);
  });

  it('has no axe violations while processing (disabled actions)', async () => {
    const { container } = render(<AdminConfirmationModal {...defaultProps} isProcessing />);
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  it('disables cancel and close controls while processing so focus cannot land on them', () => {
    render(<AdminConfirmationModal {...defaultProps} isProcessing />);
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancel and close dialog' })).toBeDisabled();
  });
});
