// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../api/aiProjectOps', () => ({
  useProjectOps: () => ({ data: { hangAfterMin: 15, diagnoseWithModel: true }, isLoading: false, error: null }),
  usePatchProjectOps: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

import { OperationsCard } from './OperationsCard';

afterEach(cleanup);

describe('OperationsCard', () => {
  it('uses the design wording and shows the saved number', () => {
    render(<OperationsCard projectId="p1" />);
    expect(screen.getByText('Say nothing is moving after')).toBeTruthy();
    expect(screen.getByText(/A build that is still printing never trips it/)).toBeTruthy();
    expect((screen.getByTestId('ops-hang-after') as HTMLInputElement).value).toBe('15');
    expect(screen.getByText('Changes take effect on the next run.')).toBeTruthy();
  });
});
