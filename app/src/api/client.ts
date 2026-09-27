import type { Issue, Comment } from './types';
import { storage } from '../storage';

export interface ApiClientOpts {
  baseUrl?: string;
  apiKey?: string;
  fetch?: typeof fetch;
}

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

export function fmtError(e: unknown): string {
  if (e && typeof e === 'object' && 'status' in e && typeof (e as { status: unknown }).status === 'number') {
    const err = e as { status: number; message?: string };
    return `${err.status}: ${err.message ?? 'request failed'}`;
  }
  return String(e);
}

/**
 * Resolve the base URL on every request so Settings edits to storage take
 * effect immediately — the live ApiClient always sees the user's current
 * server host. Throws a clear ApiError if no host is configured.
 * The host is the server origin (e.g. http://100.x.x.x:3100); method paths
 * already include the /api prefix (e.g. /api/issues).
 */
function resolveBaseUrl(fallback?: string): string {
  const host = storage.getHost() ?? fallback;
  if (!host) throw new ApiError(0, 'no_host_configured');
  return host.replace(/\/$/, '');
}

/**
 * Resolve the API key on every request for the same reason as resolveBaseUrl.
 * Throws a clear ApiError if no api key is configured.
 */
function resolveApiKey(fallback?: string): string {
  const key = storage.getApiKey() ?? fallback;
  if (!key) throw new ApiError(0, 'no_api_key_configured');
  return key;
}

export class ApiClient {
  // Constructor-time defaults. Used only when storage does not have a value
  // (e.g. unit tests that don't exercise the storage layer).
  private defaultBaseUrl?: string;
  private defaultApiKey?: string;
  private fetch: typeof fetch;

  constructor(opts: ApiClientOpts = {}) {
    if (opts.baseUrl !== undefined) this.defaultBaseUrl = opts.baseUrl;
    if (opts.apiKey !== undefined) this.defaultApiKey = opts.apiKey;
    this.fetch = opts.fetch ?? globalThis.fetch.bind(globalThis);
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = resolveBaseUrl(this.defaultBaseUrl) + path;
    const apiKey = resolveApiKey(this.defaultApiKey);
    const init: RequestInit = {
      method,
      headers: {
        'authorization': `Bearer ${apiKey}`,
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