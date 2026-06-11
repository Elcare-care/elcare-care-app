/**
 * Component tests for SearchFilter.
 */
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// lucide-react icons can cause issues in jsdom — mock them
jest.mock('lucide-react', () => ({
  Search: () => <span data-testid="icon-search" />,
  SlidersHorizontal: () => <span />,
  ArrowUpDown: () => <span />,
  X: () => <span data-testid="icon-x" />,
  Filter: () => <span />,
}));

import { SearchFilter } from '@/components/SearchFilter';
import type { Filters } from '@/components/SearchFilter';

const DEFAULT_FILTERS: Filters = {
  search: '',
  status: 'All',
  category: 'All',
  minPrice: '',
  maxPrice: '',
  sort: 'newest',
};

describe('SearchFilter', () => {
  it('renders the search input', () => {
    const onChange = jest.fn();
    render(
      <SearchFilter
        filters={DEFAULT_FILTERS}
        onFilterChange={onChange}
        showFilters={false}
        setShowFilters={jest.fn()}
        totalResults={5}
      />
    );
    expect(screen.getByPlaceholderText(/search/i)).toBeInTheDocument();
  });

  it('calls onFilterChange with updated search text', async () => {
    const onChange = jest.fn();
    const user = userEvent.setup();
    render(
      <SearchFilter
        filters={DEFAULT_FILTERS}
        onFilterChange={onChange}
        showFilters={false}
        setShowFilters={jest.fn()}
        totalResults={5}
      />
    );
    await user.type(screen.getByPlaceholderText(/search/i), 'landscape');
    expect(onChange).toHaveBeenCalledWith({ search: 'l' });
  });

  it('calls setShowFilters when filter toggle button is clicked', async () => {
    const setShowFilters = jest.fn();
    const user = userEvent.setup();
    render(
      <SearchFilter
        filters={DEFAULT_FILTERS}
        onFilterChange={jest.fn()}
        showFilters={false}
        setShowFilters={setShowFilters}
        totalResults={0}
      />
    );
    // Click the "Filters" toggle button
    const filterBtn = screen.getByRole('button', { name: /filter/i });
    await user.click(filterBtn);
    expect(setShowFilters).toHaveBeenCalledWith(true);
  });

  it('shows status filter buttons when showFilters is true', () => {
    render(
      <SearchFilter
        filters={DEFAULT_FILTERS}
        onFilterChange={jest.fn()}
        showFilters={true}
        setShowFilters={jest.fn()}
        totalResults={0}
      />
    );
    expect(screen.getByRole('button', { name: /active/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /sold/i })).toBeInTheDocument();
  });

  it('calls onFilterChange with status when status button is clicked', async () => {
    const onChange = jest.fn();
    const user = userEvent.setup();
    render(
      <SearchFilter
        filters={DEFAULT_FILTERS}
        onFilterChange={onChange}
        showFilters={true}
        setShowFilters={jest.fn()}
        totalResults={0}
      />
    );
    await user.click(screen.getByRole('button', { name: /^active$/i }));
    expect(onChange).toHaveBeenCalledWith({ status: 'Active' });
  });

  it('shows the total results count', () => {
    render(
      <SearchFilter
        filters={DEFAULT_FILTERS}
        onFilterChange={jest.fn()}
        showFilters={false}
        setShowFilters={jest.fn()}
        totalResults={42}
      />
    );
    expect(screen.getByText(/42/)).toBeInTheDocument();
  });

  it('shows Reset All Filters button when filters are active', async () => {
    const onChange = jest.fn();
    const user = userEvent.setup();
    render(
      <SearchFilter
        filters={{ ...DEFAULT_FILTERS, search: 'test' }}
        onFilterChange={onChange}
        showFilters={false}
        setShowFilters={jest.fn()}
        totalResults={0}
      />
    );
    const clearBtn = screen.getByRole('button', { name: /reset all filters/i });
    expect(clearBtn).toBeInTheDocument();
    await user.click(clearBtn);
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ search: '' }));
  });

  it('does not show Reset All Filters button when no filters are active', () => {
    render(
      <SearchFilter
        filters={DEFAULT_FILTERS}
        onFilterChange={jest.fn()}
        showFilters={false}
        setShowFilters={jest.fn()}
        totalResults={0}
      />
    );
    expect(screen.queryByRole('button', { name: /reset all filters/i })).not.toBeInTheDocument();
  });
});
