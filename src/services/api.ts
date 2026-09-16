import type { MediaAsset } from '../state/models.ts';
export class ApiError extends Error {
  status: number;
  data: any;
  constructor(status: number, data: any) {
    super(data?.error || `Server request failed (${status})`);
    this.status = status;
    this.data = data;
  }
}

export async function api<T = any>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api${path}`, { credentials: 'same-origin', ...options, headers: { ...(typeof options.body === 'string' ? { 'Content-Type': 'application/json' } : {}), ...options.headers } });
  const data = response.status === 204 ? null : await response.json();
  if (!response.ok) throw new ApiError(response.status, data);
  return data as T;
}

// The store stays usable by state tests; the browser connects these callbacks at startup.
export const connection = {
  enabled: false,
  flush: async () => {},
  refresh: async () => {},
  receiveMedia: (_asset: MediaAsset, _revision: number) => {},
};
