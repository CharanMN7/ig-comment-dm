import { jitteredDelayMs, sleep } from './crypto.ts';

export const GRAPH_VERSION = 'v23.0';
export const GRAPH = `https://graph.instagram.com/${GRAPH_VERSION}`;
export const OAUTH_AUTHORIZE = 'https://www.instagram.com/oauth/authorize';
export const OAUTH_TOKEN = 'https://api.instagram.com/oauth/access_token';
export const OAUTH_SCOPES = [
  'instagram_business_basic',
  'instagram_business_manage_comments',
  'instagram_business_manage_messages',
].join(',');

export type MetaCallResult = {
  ok: boolean;
  status: number;
  body: string;
};

async function fetchWithRetry(url: string, init: RequestInit): Promise<Response> {
  let lastRes: Response | undefined;
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, init);
      if (res.status === 429 || res.status >= 500) {
        lastRes = res;
        if (attempt < 2) await sleep(jitteredDelayMs(500 * 2 ** attempt));
        continue;
      }
      return res;
    } catch (err) {
      lastErr = err;
      if (attempt < 2) await sleep(jitteredDelayMs(500 * 2 ** attempt));
    }
  }
  if (lastRes) return lastRes;
  throw lastErr instanceof Error ? lastErr : new Error('network error talking to Instagram');
}

async function readResult(res: Response): Promise<MetaCallResult> {
  const body = await res.text();
  return { ok: res.ok, status: res.status, body };
}

export async function sendPrivateReply(
  igUserId: string,
  token: string,
  commentId: string,
  text: string,
): Promise<MetaCallResult> {
  const url = `${GRAPH}/${encodeURIComponent(igUserId)}/messages`;
  const res = await fetchWithRetry(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      recipient: { comment_id: commentId },
      message: { text },
    }),
  });
  return readResult(res);
}

/**
 * Required after Connect. Dashboard field subscription is not enough for Instagram Login.
 * POST JSON to /{ig-user-id}/subscribed_apps — `/me` + query-string is unreliable.
 */
export async function subscribeCommentWebhooks(igUserId: string, token: string): Promise<MetaCallResult> {
  const url = `${GRAPH}/${encodeURIComponent(igUserId)}/subscribed_apps`;
  const res = await fetchWithRetry(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ subscribed_fields: ['comments'] }),
  });
  return readResult(res);
}

export type IgComment = {
  id: string;
  text: string;
  timestamp?: string;
  from?: { id?: string; username?: string };
};

/** One page of newest comments. Used by the 5-minute poll when webhooks miss. */
export async function listMediaComments(token: string, mediaId: string): Promise<IgComment[]> {
  const url = new URL(`${GRAPH}/${encodeURIComponent(mediaId)}/comments`);
  url.searchParams.set('fields', 'id,text,timestamp,from');
  url.searchParams.set('order', 'reverse_chronological');
  url.searchParams.set('limit', '25');
  const res = await fetchWithRetry(url.toString(), {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` },
  });
  const text = await res.text();
  let json: {
    data?: Array<{
      id?: string | number;
      text?: string;
      timestamp?: string;
      from?: { id?: string | number; username?: string };
    }>;
    error?: { message?: string };
  };
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(text || `could not list comments (${res.status})`);
  }
  if (!res.ok) throw new Error(json.error?.message || text || 'could not list comments');
  const items: IgComment[] = [];
  for (const row of json.data ?? []) {
    if (row.id == null) continue;
    items.push({
      id: String(row.id),
      text: row.text ?? '',
      timestamp: row.timestamp,
      from: row.from
        ? { id: row.from.id != null ? String(row.from.id) : undefined, username: row.from.username }
        : undefined,
    });
  }
  return items;
}

export async function sendPublicReply(commentId: string, token: string, message: string): Promise<MetaCallResult> {
  const url = `${GRAPH}/${encodeURIComponent(commentId)}/replies`;
  const res = await fetchWithRetry(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ message }),
  });
  return readResult(res);
}

export async function exchangeCodeForShortLived(opts: {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  code: string;
}): Promise<{ access_token: string; user_id?: string }> {
  const form = new FormData();
  form.set('client_id', opts.clientId);
  form.set('client_secret', opts.clientSecret);
  form.set('grant_type', 'authorization_code');
  form.set('redirect_uri', opts.redirectUri);
  form.set('code', opts.code);
  const res = await fetchWithRetry(OAUTH_TOKEN, { method: 'POST', body: form });
  const text = await res.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(text || `token exchange failed (${res.status})`);
  }
  const obj = json as {
    access_token?: string;
    user_id?: string | number;
    data?: Array<{ access_token?: string; user_id?: string | number }>;
    error_message?: string;
    error?: { message?: string };
  };
  const inner = obj.data?.[0];
  const token = obj.access_token ?? inner?.access_token;
  const userId = obj.user_id ?? inner?.user_id;
  if (!token) {
    throw new Error(obj.error_message || obj.error?.message || text || 'token exchange failed');
  }
  return { access_token: token, user_id: userId != null ? String(userId) : undefined };
}

export async function exchangeLongLived(
  clientSecret: string,
  shortLived: string,
): Promise<{ access_token: string; expires_in: number }> {
  const url = new URL('https://graph.instagram.com/access_token');
  url.searchParams.set('grant_type', 'ig_exchange_token');
  url.searchParams.set('client_secret', clientSecret);
  url.searchParams.set('access_token', shortLived);
  const res = await fetchWithRetry(url.toString(), { method: 'GET' });
  const text = await res.text();
  let json: { access_token?: string; expires_in?: number; error?: { message?: string } };
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(text || `long-lived exchange failed (${res.status})`);
  }
  if (!json.access_token || typeof json.expires_in !== 'number') {
    throw new Error(json.error?.message || text || 'long-lived exchange failed');
  }
  return { access_token: json.access_token, expires_in: json.expires_in };
}

export async function refreshLongLived(
  token: string,
): Promise<{ ok: true; access_token: string; expires_in: number } | { ok: false; body: string; status: number }> {
  const url = new URL('https://graph.instagram.com/refresh_access_token');
  url.searchParams.set('grant_type', 'ig_refresh_token');
  url.searchParams.set('access_token', token);
  const res = await fetchWithRetry(url.toString(), { method: 'GET' });
  const body = await res.text();
  if (!res.ok) return { ok: false, body, status: res.status };
  let json: { access_token?: string; expires_in?: number };
  try {
    json = JSON.parse(body);
  } catch {
    return { ok: false, body, status: res.status };
  }
  if (!json.access_token || typeof json.expires_in !== 'number') {
    return { ok: false, body, status: res.status };
  }
  return { ok: true, access_token: json.access_token, expires_in: json.expires_in };
}

export async function fetchMe(
  token: string,
): Promise<{ id: string; user_id?: string; username: string }> {
  const url = new URL(`${GRAPH}/me`);
  url.searchParams.set('fields', 'user_id,username,id');
  const res = await fetchWithRetry(url.toString(), {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` },
  });
  const text = await res.text();
  let json: { id?: string | number; user_id?: string | number; username?: string; error?: { message?: string } };
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(text || `could not load Instagram profile (${res.status})`);
  }
  if (!res.ok || json.username == null) {
    throw new Error(json.error?.message || text || 'could not load Instagram profile');
  }
  return {
    id: String(json.id ?? ''),
    user_id: json.user_id != null ? String(json.user_id) : undefined,
    username: json.username,
  };
}

export type IgMediaItem = {
  id: string;
  caption: string;
  permalink: string;
  kind: 'reel' | 'post';
};

export async function listRecentMedia(token: string): Promise<IgMediaItem[]> {
  const url = new URL(`${GRAPH}/me/media`);
  url.searchParams.set('fields', 'id,caption,permalink,media_type,media_product_type');
  url.searchParams.set('limit', '25');
  const res = await fetchWithRetry(url.toString(), {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` },
  });
  const text = await res.text();
  let json: {
    data?: Array<{
      id?: string | number;
      caption?: string;
      permalink?: string;
      media_product_type?: string;
    }>;
    error?: { message?: string };
  };
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(text || `could not list posts (${res.status})`);
  }
  if (!res.ok) throw new Error(json.error?.message || text || 'could not list posts');
  const items: IgMediaItem[] = [];
  for (const row of json.data ?? []) {
    if (row.id == null) continue;
    const permalink = row.permalink ?? '';
    const kind: 'reel' | 'post' =
      row.media_product_type === 'REELS' || /\/reel\//i.test(permalink) ? 'reel' : 'post';
    const cap = (row.caption ?? '').replace(/\s+/g, ' ').trim();
    items.push({
      id: String(row.id),
      caption: cap.slice(0, 48) || permalink || String(row.id),
      permalink,
      kind,
    });
  }
  return items;
}

export function oauthRedirectUri(requestUrl: string, publicBaseUrl?: string): string {
  let origin = '';
  try {
    const u = new URL(requestUrl);
    if (u.protocol && u.host) {
      const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
      origin = `${local ? u.protocol : 'https:'}//${u.host}`;
    }
  } catch {
    origin = '';
  }
  if (!origin) origin = (publicBaseUrl ?? '').replace(/\/+$/, '');
  return `${origin.replace(/\/+$/, '')}/connect/callback`;
}

/** @deprecated prefer oauthRedirectUri(requestUrl) so Connect matches the live host */
export function redirectUri(publicBaseUrl: string): string {
  return oauthRedirectUri('', publicBaseUrl);
}

export function authorizeUrl(opts: {
  clientId: string;
  redirectUri: string;
  state: string;
  forceReauth: boolean;
}): string {
  const url = new URL(OAUTH_AUTHORIZE);
  url.searchParams.set('client_id', opts.clientId);
  url.searchParams.set('redirect_uri', opts.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', OAUTH_SCOPES);
  url.searchParams.set('state', opts.state);
  // Meta docs: boolean. Instagram's authorize page treats false as hide Facebook Login.
  url.searchParams.set('enable_fb_login', 'false');
  if (opts.forceReauth) url.searchParams.set('force_reauth', 'true');
  return url.toString();
}
