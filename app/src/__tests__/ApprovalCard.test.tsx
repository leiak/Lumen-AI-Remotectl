import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ApiProvider } from '../api/context';
import { ApiClient } from '../api/client';
import { ApprovalCard } from '../components/ApprovalCard';
import type { Comment } from '../api/types';

function makeApi(responses: {
  postComment?: (id: string, body: { body: string }) => Promise<Comment>;
  failPost?: boolean;
}) {
  const addComment = vi.fn(async (id: string, input: { body: string }) => {
    if (responses.failPost) throw new Error('network down');
    if (responses.postComment) return responses.postComment(id, input);
    return {
      id: 'c-new',
      issueId: id,
      authorType: 'user' as const,
      body: input.body,
      kind: 'approval_response' as const,
      createdAt: new Date().toISOString(),
    };
  });
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const cmtsMatch = url.match(/\/api\/issues\/([^/]+)\/comments$/);
    if (cmtsMatch && init && init.method === 'POST') {
      const body = JSON.parse(init.body as string);
      const result = await addComment(cmtsMatch[1]!, body);
      return new Response(JSON.stringify(result), { status: 201, headers: { 'content-type': 'application/json' } });
    }
    return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
  });
  const api = new ApiClient({ baseUrl: 'http://x', apiKey: 'sk-test', fetch: fetchMock as any });
  // expose spy
  (api as any).__addCommentSpy = addComment;
  return api;
}

function renderCard(api: ApiClient, props: Partial<React.ComponentProps<typeof ApprovalCard>> = {}, onResolved = vi.fn()) {
  const defaults = {
    issueId: 'i-1',
    commentId: 'c-1',
    body: 'Should I deploy to production?',
    onResolved,
  };
  return render(
    <MemoryRouter>
      <ApiProvider client={api}>
        <ApprovalCard {...defaults} {...props} />
      </ApiProvider>
    </MemoryRouter>
  );
}

describe('ApprovalCard', () => {
  it('renders the body and both action buttons', () => {
    const api = makeApi({});
    renderCard(api);
    expect(screen.getByText(/Should I deploy to production\?/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Approve/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Deny/i })).toBeInTheDocument();
  });

  it('clicking Approve posts a yes comment and fires onResolved', async () => {
    const api = makeApi({});
    const onResolved = vi.fn();
    renderCard(api, {}, onResolved);
    fireEvent.click(screen.getByRole('button', { name: /Approve/i }));
    await waitFor(() => {
      expect((api as any).__addCommentSpy).toHaveBeenCalledWith('i-1', { body: 'yes' });
    });
    await waitFor(() => {
      expect(onResolved).toHaveBeenCalledTimes(1);
    });
  });

  it('clicking Deny posts a no comment and fires onResolved', async () => {
    const api = makeApi({});
    const onResolved = vi.fn();
    renderCard(api, {}, onResolved);
    fireEvent.click(screen.getByRole('button', { name: /Deny/i }));
    await waitFor(() => {
      expect((api as any).__addCommentSpy).toHaveBeenCalledWith('i-1', { body: 'no' });
    });
    await waitFor(() => {
      expect(onResolved).toHaveBeenCalledTimes(1);
    });
  });

  it('disables both buttons while request is in flight', async () => {
    let resolvePost!: (v: Comment) => void;
    const postComment = vi.fn((_id: string, _body: { body: string }) =>
      new Promise<Comment>((resolve) => { resolvePost = resolve; })
    );
    const api = makeApi({ postComment });
    renderCard(api);
    const approve = screen.getByRole('button', { name: /Approve/i });
    const deny = screen.getByRole('button', { name: /Deny/i });
    fireEvent.click(approve);
    await waitFor(() => {
      expect(approve).toBeDisabled();
      expect(deny).toBeDisabled();
    });
    resolvePost({
      id: 'c-new', issueId: 'i-1', authorType: 'user', body: 'yes',
      kind: 'approval_response', createdAt: new Date().toISOString(),
    });
    await waitFor(() => {
      expect(approve).not.toBeDisabled();
    });
  });

  it('shows an inline error and re-enables buttons when the API call fails', async () => {
    const api = makeApi({ failPost: true });
    renderCard(api);
    fireEvent.click(screen.getByRole('button', { name: /Approve/i }));
    await waitFor(() => {
      expect(screen.getByText(/Failed to send response/i)).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: /Approve/i })).not.toBeDisabled();
    expect(screen.getByRole('button', { name: /Deny/i })).not.toBeDisabled();
  });
});