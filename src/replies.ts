import { randomIndex } from './crypto.ts';

/**
 * A rule's public replies share the `public_reply_text` column. One reply is
 * stored as plain text, exactly as before variations existed, and two or more
 * as a JSON array of strings.
 *
 * Reading has to be safe for every value saved before that, so only a JSON
 * array of non-empty strings counts as variations. Anything else, a multi-line
 * reply, `[]`, or text that merely starts with `[`, is one reply and is sent
 * whole. A reply the creator set up never goes quiet because it parsed oddly.
 */
export function parsePublicReplies(stored: string | null | undefined): string[] {
  const text = stored?.trim() ?? '';
  if (!text) return [];
  if (text.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (
        Array.isArray(parsed) &&
        parsed.length > 0 &&
        parsed.every((r): r is string => typeof r === 'string' && r.trim() !== '')
      ) {
        return parsed.map((r) => r.trim());
      }
    } catch {
      // Plain text that starts with a bracket.
    }
  }
  return [text];
}

export function serializePublicReplies(replies: string[]): string | null {
  const kept = replies.map((r) => r.trim()).filter(Boolean);
  if (kept.length === 0) return null;
  // A lone reply stays plain text unless it would read back as variations,
  // say a creator whose reply is literally ["a","b"].
  const [only] = kept;
  if (kept.length === 1 && only !== undefined) {
    const back = parsePublicReplies(only);
    if (back.length === 1 && back[0] === only) return only;
  }
  return JSON.stringify(kept);
}

/** One reply per send, so ten comments don't get ten identical replies. */
export function pickReply(replies: string[], random: (n: number) => number = randomIndex): string | null {
  if (replies.length <= 1) return replies[0] ?? null;
  return replies[random(replies.length)] ?? replies[0] ?? null;
}
