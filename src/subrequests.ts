/**
 * Cloudflare's free plan allows a Worker invocation 50 subrequests, where a
 * subrequest is any fetch or any call to D1, and separately caps D1 at 50
 * queries per invocation. A call past either fails outright. Every fetch and
 * every D1 query is counted here against 50, the stricter reading; a D1 batch
 * is one query.
 */
export const SUBREQUESTS_PER_INVOCATION = 50;

/**
 * What one invocation has left. Each step takes what it needs before it
 * starts, so a busy minute stops between sends, with its outcomes written,
 * rather than having a query refused partway through one.
 */
export class Subrequests {
  #left: number;

  constructor(limit: number = SUBREQUESTS_PER_INVOCATION) {
    this.#left = limit;
  }

  get left(): number {
    return this.#left;
  }

  /** Spends `n` if that many are left, and says whether it did. */
  take(n = 1): boolean {
    if (n > this.#left) return false;
    this.#left -= n;
    return true;
  }
}
