// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DocsPage } from '../../../types/docs';

const api = vi.hoisted(() => ({ post: vi.fn() }));
vi.mock('../../../api/client', async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return { ...real, client: { ...(real.client as object), post: api.post } };
});

import { SaveTemplateDialog } from './SaveTemplateDialog';

const PAGE = {
  id: 'pg1',
  projectId: 'p1',
  title: 'What a shared board taught us',
  markdown: 'A ticket is a promise written for a stranger.',
  draft: null,
} as unknown as DocsPage;

function setup() {
  const onSaved = vi.fn();
  render(
    <QueryClientProvider client={new QueryClient()}>
      <SaveTemplateDialog projectId="p1" page={PAGE} onClose={vi.fn()} onSaved={onSaved} />
    </QueryClientProvider>,
  );
  return {
    onSaved,
    name: screen.getByLabelText('Name') as HTMLInputElement,
    save: screen.getByTestId('save-template'),
  };
}

beforeEach(() => api.post.mockReset());
afterEach(cleanup);

describe('Save as a template', () => {
  it('sends the name, what it keeps, who can use it and where it is listed', async () => {
    api.post.mockResolvedValue({ data: { id: 't1', name: 'Blog post' } });
    const { onSaved, name, save } = setup();
    expect(name.value).toBe(PAGE.title);
    fireEvent.change(name, { target: { value: 'Blog post' } });
    fireEvent.change(screen.getByLabelText('Short description'), { target: { value: 'Cover and pull quote' } });
    fireEvent.click(screen.getByRole('radio', { name: /Style and structure/ }));
    fireEvent.click(screen.getByRole('button', { name: 'This project' }));
    fireEvent.click(screen.getByRole('button', { name: 'Writing' }));
    fireEvent.click(save);
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith({ id: 't1', name: 'Blog post' }));
    expect(api.post).toHaveBeenCalledWith('/projects/p1/docs/gallery', {
      pageId: 'pg1',
      name: 'Blog post',
      description: 'Cover and pull quote',
      category: 'writing',
      keeps: 'structure',
      scope: 'project',
      replace: false,
    });
  });

  it('keeps Save off while the name is too long, with a counter', () => {
    const { name, save } = setup();
    fireEvent.change(name, { target: { value: 'x'.repeat(75) } });
    expect(screen.getByTestId('name-too-long').textContent).toMatch(/up to 60 characters.*75 \/ 60/);
    expect((save as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(name, { target: { value: '   ' } });
    expect((save as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(name, { target: { value: 'Blog post' } });
    expect((save as HTMLButtonElement).disabled).toBe(false);
  });

  it('turns the name red when it is already used, then replaces it or takes another name', async () => {
    const conflict = {
      response: { status: 409, data: { detail: { code: 'name_taken', message: 'taken', template_id: 't9' } } },
    };
    api.post.mockRejectedValueOnce(conflict).mockRejectedValueOnce(conflict);
    const { onSaved, name, save } = setup();
    fireEvent.change(name, { target: { value: 'Blog post' } });
    fireEvent.click(save);
    await screen.findByTestId('name-taken');
    expect(name.getAttribute('aria-invalid')).toBe('true');
    expect((save as HTMLButtonElement).disabled).toBe(true);
    // another name clears it
    fireEvent.click(screen.getByRole('button', { name: 'Use another name' }));
    expect(screen.queryByTestId('name-taken')).toBeNull();
    fireEvent.click(save);
    await screen.findByTestId('name-taken');
    api.post.mockResolvedValueOnce({ data: { id: 't9', name: 'Blog post' } });
    fireEvent.click(screen.getByRole('button', { name: 'Replace' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(api.post.mock.lastCall?.[1]).toMatchObject({ name: 'Blog post', replace: true });
  });

  it('shows what the server says about a name it refuses', async () => {
    api.post.mockRejectedValueOnce({
      response: {
        status: 422,
        data: { detail: { code: 'name_too_long', message: 'A template name is limited to 60 characters' } },
      },
    });
    const { save } = setup();
    fireEvent.click(save);
    expect(await screen.findByText('A template name is limited to 60 characters')).toBeTruthy();
  });
});
