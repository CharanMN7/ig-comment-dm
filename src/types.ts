export type Env = {
  DB: D1Database;
  META_APP_ID: string;
  META_APP_SECRET: string;
  /** Facebook App Secret from App settings → Basic. Meta often HMAC-signs webhooks with this, not the Instagram secret. */
  FACEBOOK_APP_SECRET?: string;
  WEBHOOK_VERIFY_TOKEN: string;
  TOKEN_ENCRYPTION_KEY: string;
  ADMIN_URL_SECRET: string;
  SESSION_SIGNING_KEY: string;
  PUBLIC_BASE_URL: string;
};

export type WebhookEvent = {
  id: number;
  received_at: number;
  status: string;
  object: string | null;
  preview: string | null;
  error: string | null;
};

export type Account = {
  ig_user_id: string;
  username: string;
  access_token_enc: string;
  token_iv: string;
  token_expires_at: number;
  active: number;
  connected_at: number;
  last_refreshed_at: number | null;
  needs_reconnect: number;
};

/** `word` needs the keyword to stand alone; `contains` finds it anywhere, inside hashtags and longer words too. */
export type MatchMode = 'word' | 'contains';

export type Rule = {
  id: number;
  ig_user_id: string;
  label: string;
  keywords: string;
  match_mode: MatchMode;
  /** JSON array, like `keywords`. Matched with the same normalisation and the same `match_mode`. */
  exclude_keywords: string;
  /** 1: every comment on `media_id` matches and `keywords` are ignored. Never set without a `media_id`. */
  match_all: number;
  /** 1: the public reply also goes out when another rule sends the DM. 0 for every rule saved earlier. */
  reply_without_dm: number;
  media_id: string | null;
  dm_text: string;
  public_reply_text: string | null;
  active: number;
  created_at: number;
};

export type Sent = {
  comment_id: string;
  ig_user_id: string;
  rule_id: number | null;
  commenter_id: string | null;
  /**
   * `queued` or `retry`, waiting; `pending`, being sent; then `ok`, `failed`,
   * `skipped`, or `unsure` when Instagram never confirmed the DM, which may
   * have been delivered.
   */
  dm_status: string;
  reply_status: string | null;
  error: string | null;
  /** When the row was written, then when it reached ok, failed or skipped. */
  sent_at: number;
  /** DM calls made, counting one Instagram never answered. */
  attempts: number;
  /** Queued or retrying: when it may be sent. Pending: when its lease runs out. */
  next_attempt_at: number | null;
  comment_at: number | null;
  username: string | null;
};

/** A rule that matched a comment besides the one that sent its DM, and what became of its public reply. */
export type ExtraReply = {
  comment_id: string;
  rule_id: number;
  status: string;
  error: string | null;
  sent_at: number;
};

export type SessionData = {
  exp: number;
  csrf: string;
  authed: boolean;
};
