import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';

afterEach(() => vi.restoreAllMocks());

describe('App', () => {
  it('shows the product shell and a healthy API state', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ status: 'ok' })
    }));

    render(<App />);
    expect(screen.getByRole('heading', { name: 'Universal Workbench' })).toBeInTheDocument();
    expect(await screen.findByText('API online')).toBeInTheDocument();
  });
});
