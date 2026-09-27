import type { Issue, Comment } from './types';

export interface ApiClientOpts {
  baseUrl: string;
  apiKey: string;
  fetch?: typeof fetch;
}

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

export class ApiClient {
  private baseUrl: string;
  private apiKey: string;
  private fetch: typeof fetch;

  constructor(opts: ApiClientOpts) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, '');
    this.apiKey = opts.apiKey;
    this.fetch = opts.fetch ?? globalThis.fetch.bind(globalThis);
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const init: RequestInit = {
      method,
      headers: {
        'authorization': `Bearer ${this.apiKey}`,
        'content-type': 'application/json',
      },
    };
    if (body !== undefined) init.body = JSON.stringify(body);
    const res = await this.fetch(url, init);
    const text = await res.text();
    if (!res.ok) {
      throw new ApiError(res.status, text || `${method} ${path} failed with ${res.status}`);
    }
    let parsed: T;
    try {
      parsed = text ? (JSON.parse(text) as T) : (undefined as unknown as T);
    } catch (e) {
      throw new ApiError(res.status, `Invalid JSON in response: ${text.slice(0, 200)}`);
    }
    return parsed;
  }

  listIssues(): Promise<Issue[]> {
    return this.request('GET', '/api/issues');
  }

  getIssue(id: string): Promise<Issue> {
    return this.request('GET', `/api/issues/${id}`);
  }

  createIssue(input: { title: string; workspacePath: string; priority?: 'low' | 'medium' | 'high' }): Promise<Issue> {
    return this.request('POST', '/api/issues', input);
  }

  listComments(issueId: string): Promise<Comment[]> {
    return this.request('GET', `/api/issues/${issueId}/comments`);
  }

  addComment(issueId: string, input: { body: string }): Promise<Comment> {
    return this.request('POST', `/api/issues/${issueId}/comments`, input);
  }
}
