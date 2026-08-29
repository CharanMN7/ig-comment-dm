/**
 * Placeholder substitution for DM and public reply text.
 *
 * "Hey sarah" reads like a person; "Hey" reads like a bot. The rule author
 * writes `Hey {username}, here's the guide: {link}` once and each send fills it
 * in.
 */

/**
 * Tokens this program knows how to fill.
 *
 * Anything not listed here is left exactly as written, so a rule containing a
 * literal `{foo}` — or JSON, or a code snippet — survives untouched. Blanking
 * unknown tokens would silently delete a creator's copy.
 */
export const KNOWN_PLACEHOLDERS = ['username', 'link'] as const;

export type PlaceholderName = (typeof KNOWN_PLACEHOLDERS)[number];

export type PlaceholderValues = Partial<Record<PlaceholderName, string | null | undefined>>;

const TOKEN = /\{([a-z_]+)\}/g;

function isKnown(name: string): name is PlaceholderName {
  return (KNOWN_PLACEHOLDERS as readonly string[]).includes(name);
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
 */
export function substitutePlaceholders(text: string, values: PlaceholderValues): string {
  const filled = text.replace(TOKEN, (whole, name: string) => {
    if (!isKnown(name)) return whole;
    const value = values[name];
    return value == null ? '' : value;
  });

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
 *
 * `{link}` is deliberately not budgeted here — see `MAX_USERNAME_LENGTH`.
 */
export const MAX_USERNAME_LENGTH = 30;

export function worstCaseLength(text: string): number {
  let length = text.length;
  for (const match of text.matchAll(TOKEN)) {
    const name = match[1];
    if (name === 'username') {
      // The token itself disappears and is replaced by the value.
      length += MAX_USERNAME_LENGTH - match[0].length;
    }
  }
  return length;
}
