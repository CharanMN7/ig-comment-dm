/**
 * Placeholder substitution for DM and public reply text.
 *
 * "Hey sarah" reads like a person; "Hey" reads like a bot. The rule author
 * writes `Hey {username}, here's the guide` once and each send fills it in.
 */

/**
 * Tokens this program knows how to fill.
 *
 * Anything not listed here is left exactly as written, so a rule containing a
 * literal `{foo}` — or JSON, or a code snippet — survives untouched. Blanking
 * unknown tokens would silently delete a creator's copy.
 *
 * `{link}` is deliberately **not** here. It is the name the tracked-link
 * feature (#23) will use, and until that exists there is nothing to fill it
 * with. Treating it as known would mean deleting it from every message that
 * used it, so instead the rule form rejects it at save time with an
 * explanation — see `RESERVED_PLACEHOLDERS`.
 */
export const KNOWN_PLACEHOLDERS = ['username'] as const;

/**
 * Tokens that will mean something later but mean nothing now.
 *
 * The form refuses to save a rule containing one. That is the alternative to
 * the two bad options: filling it with nothing (the creator's link silently
 * vanishes from every DM) or letting it through (subscribers receive a literal
 * `{link}`).
 */
export const RESERVED_PLACEHOLDERS: Record<string, string> = {
  link: 'Tracked links do not exist yet, so {link} would send as empty. Paste the URL directly for now.',
};

export type PlaceholderName = (typeof KNOWN_PLACEHOLDERS)[number];

export type PlaceholderValues = Partial<Record<PlaceholderName, string | null | undefined>>;

// Case-insensitive: someone who writes {Username} at the start of a sentence
// means the same thing as {username}, and silently ignoring it is the kind of
// bug that gets found in a subscriber's inbox.
const TOKEN = /\{([a-zA-Z_]+)\}/g;

function isKnown(name: string): name is PlaceholderName {
  return (KNOWN_PLACEHOLDERS as readonly string[]).includes(name);
}

/**
 * The reserved token this text uses, or null.
 *
 * Used by the rule form so the message names the token the author actually
 * typed, whatever case they typed it in.
 */
export function findReservedPlaceholder(text: string): { name: string; message: string } | null {
  for (const match of text.matchAll(TOKEN)) {
    const name = match[1].toLowerCase();
    const message = RESERVED_PLACEHOLDERS[name];
    if (message) return { name, message };
  }
  return null;
}

/**
 * Replace every known token, leaving unknown ones alone.
 *
 * A token with no value is removed rather than rendered — `Hey {username},`
 * with no username must read `Hey,` and not `Hey undefined` or `Hey {username}`.
 * Removal leaves a gap, so the whitespace either side is tidied afterwards:
 * runs of spaces and tabs collapse to one, and a space stranded before a comma
 * or full stop is dropped. Newlines are preserved — a creator's paragraph
 * breaks are not whitespace noise.
 *
 * That tidy only runs when a token was actually removed. It is a repair for
 * damage this function did, not a house style, and applying it to text it did
 * not touch would quietly reformat a creator's own copy — collapsing the double
 * spaces or the alignment they typed on purpose.
 */
export function substitutePlaceholders(text: string, values: PlaceholderValues): string {
  let removedSomething = false;

  const filled = text.replace(TOKEN, (whole, rawName: string) => {
    const name = rawName.toLowerCase();
    if (!isKnown(name)) return whole;
    const value = values[name];
    if (value == null || value === '') {
      removedSomething = true;
      return '';
    }
    return value;
  });

  if (!removedSomething) return filled;

  return filled
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+([,.!?;:])/g, '$1')
    .replace(/[ \t]+$/gm, '')
    .trim();
}

/**
 * The longest `substitutePlaceholders` could make this text.
 *
 * Length has to be validated when the rule is saved, but the values do not
 * exist until a send. So the rule form validates against the worst case: every
 * `{username}` expanded to the longest username Instagram permits.
 */
export const MAX_USERNAME_LENGTH = 30;

export function worstCaseLength(text: string): number {
  let length = text.length;
  for (const match of text.matchAll(TOKEN)) {
    if (match[1].toLowerCase() === 'username') {
      // The token itself disappears and is replaced by the value.
      length += MAX_USERNAME_LENGTH - match[0].length;
    }
  }
  return length;
}
