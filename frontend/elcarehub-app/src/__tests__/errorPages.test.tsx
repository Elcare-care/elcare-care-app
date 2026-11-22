import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';

// Existing app error components
import { NotFoundState, UnavailableState } from '@/components/PageStates';
import RootErrorBoundary from '@/components/RootErrorBoundary';

// Fixtures for error states
const notFoundFixture = {
  status: 404,
  title: 'Page not found',
  message: 'The page you are looking for does not exist.',
};

const serverErrorFixture = {
  status: 500,
  title: 'Something went wrong',
  message: 'An unexpected error occurred. Please try again later.',
};

// Technical text that must never be exposed to users
const TECHNICAL_PATTERNS = [
  /stack trace/i,
  /at\s+\w+\s+\(.*:\d+:\d+\)/,
  /TypeError/,
  /ReferenceError/,
  /SyntaxError/,
  /node_modules/,
  /\.tsx?:\d+/,
  /\.js:\d+/,
  /Error:\s/,
];

function assertNoTechnicalText(container: HTMLElement) {
  const text = container.textContent || '';
  for (const pattern of TECHNICAL_PATTERNS) {
    expect(text).not.toMatch(pattern);
  }
}

function assertNavigationPresent() {
  // Navigation links should remain available on error pages
  const nav = screen.queryByRole('navigation');
  if (nav) {
    expect(nav).toBeInTheDocument();
  }
  // At minimum, a home link should be present
  const homeLinks = screen.queryAllByRole('link', { name: /home|back|return/i });
  expect(homeLinks.length).toBeGreaterThan(0);
}

describe('Error pages', () => {
  describe('404 Not Found route', () => {
    it('renders the NotFoundState with navigation and no technical details', async () => {
      const { container } = render(
        <NotFoundState
          title={notFoundFixture.title}
          message={notFoundFixture.message}
        />,
      );

      // Heading is rendered
      const heading = screen.getByRole('heading', {
        name: new RegExp(notFoundFixture.title, 'i'),
      });
      expect(heading).toBeInTheDocument();

      // Message is rendered
      expect(
        screen.getByText(new RegExp(notFoundFixture.message, 'i')),
      ).toBeInTheDocument();

      // Navigation remains
      assertNavigationPresent();

      // No technical text exposed
      assertNoTechnicalText(container);

      // Focus moves to the error heading (or announcement is made)
      await waitFor(() => {
        const focused = document.activeElement;
        const isHeadingFocused = focused === heading;
        const hasLiveRegion =
          screen.queryByRole('alert') !== null ||
          screen.queryByRole('status') !== null;
        expect(isHeadingFocused || hasLiveRegion).toBe(true);
      });
    });
  });

  describe('500 Server Error route', () => {
    it('renders the UnavailableState with navigation and no technical details', async () => {
      const { container } = render(
        <UnavailableState
          title={serverErrorFixture.title}
          message={serverErrorFixture.message}
        />,
      );

      const heading = screen.getByRole('heading', {
        name: new RegExp(serverErrorFixture.title, 'i'),
      });
      expect(heading).toBeInTheDocument();

      expect(
        screen.getByText(new RegExp(serverErrorFixture.message, 'i')),
      ).toBeInTheDocument();

      assertNavigationPresent();
      assertNoTechnicalText(container);

      await waitFor(() => {
        const focused = document.activeElement;
        const isHeadingFocused = focused === heading;
        const hasLiveRegion =
          screen.queryByRole('alert') !== null ||
          screen.queryByRole('status') !== null;
        expect(isHeadingFocused || hasLiveRegion).toBe(true);
      });
    });

    it('RootErrorBoundary catches errors without exposing stack traces', async () => {
      const thrownError = new Error(
        'TypeError: Cannot read properties of undefined at Component (node_modules/foo.tsx:12:34)',
      );

      const Thrower: React.FC = () => {
        throw thrownError;
      };

      // Silence expected console.error from React error boundary
      const originalError = console.error;
      console.error = jest.fn();

      try {
        const { container } = render(
          <RootErrorBoundary>
            <Thrower />
          </RootErrorBoundary>,
        );

        // A fallback heading should be rendered
        await waitFor(() => {
          const heading = screen.getByRole('heading');
          expect(heading).toBeInTheDocument();
        });

        // Navigation remains available in the fallback
        assertNavigationPresent();

        // No stack trace or technical error text exposed
        assertNoTechnicalText(container);
        expect(container.textContent || '').not.toContain(thrownError.message);

        // Focus or announcement behavior
        await waitFor(() => {
          const heading = screen.getByRole('heading');
          const focused = document.activeElement;
          const isHeadingFocused = focused === heading;
          const hasLiveRegion =
            screen.queryByRole('alert') !== null ||
            screen.queryByRole('status') !== null;
          expect(isHeadingFocused || hasLiveRegion).toBe(true);
        });
      } finally {
        console.error = originalError;
      }
    });
  });
});