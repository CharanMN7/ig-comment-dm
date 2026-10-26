/**
 * `{username}` in a DM or public reply becomes the commenter's Instagram
 * username, without the `@`. It is the only placeholder: `{link}` waits for
 * tracked links (#23), and any other `{word}` is the creator's own text and is
 * sent as typed.
 *
 * The token is matched without regard to case. A creator who types
 * `{Username}` means the same thing, and sending them the literal braces would
 * be the worst way to find out the spelling mattered.
 */
const TOKEN = /\{username\}/gi;
const TOKEN_LENGTH = '{username}'.length;

/** Instagram's own limit, and what length checks assume a name can expand to. */
export const USERNAME_MAX = 30;

/** Each `{username}` can grow the text by this much once a name is put in. */
export const USERNAME_GROWTH = USERNAME_MAX - TOKEN_LENGTH;

/** What the admin Test page puts in, so a dry run shows where the name lands. */
export const SAMPLE_USERNAME = 'sample_user';

/**
 * Anything outside Instagram's username alphabet is treated as no username, so
 * an odd payload can't push a message past the length the form promised.
 */
const USERNAME = new RegExp(`^[A-Za-z0-9._]{1,${USERNAME_MAX}}$`);

export function cleanUsername(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const name = raw.trim().replace(/^@/, '');
  return USERNAME.test(name) ? name : null;
}

export function countUsernameTokens(text: string): number {
  return text.match(TOKEN)?.length ?? 0;
}

/** The longest `text` can become once every `{username}` holds a 30-character name. */
export function worstCaseLength(text: string): number {
  return text.length + countUsernameTokens(text) * USERNAME_GROWTH;
}

export function fillPlaceholders(text: string, username: string | null | undefined): string {
  const name = cleanUsername(username);
  if (name) return text.replace(TOKEN, () => name);
  return removeUsernameTokens(text);
}

const isSpace = (c: string | undefined): boolean => c === ' ' || c === '\t';
const isLineBreak = (c: string | undefined): boolean => c === '\n' || c === '\r';
// Rules saved before line breaks were normalised can still hold CRLF.
const breakAt = (s: string, i: number): number => (s[i] === '\r' ? (s[i + 1] === '\n' ? 2 : 1) : s[i] === '\n' ? 1 : 0);
const breakBefore = (s: string, i: number): number =>
  s[i - 1] === '\n' ? (s[i - 2] === '\r' ? 2 : 1) : s[i - 1] === '\r' ? 1 : 0;
// Punctuation that closes the clause the name sat in: "Hey {username}, here".
const CLOSING = /^[,.!?;:…)\]»”’，。！？、；：]$/u;
// Punctuation that follows a name opening a line: "{username}, here".
const AFTER_OPENING = /^[,.!?;:…，。！？、；：]$/u;

/**
 * With no username, each token goes and the cut reaches only as far as the
 * spaces and punctuation touching it, so nothing else the creator typed moves.
 *
 *   "Hey {username}, here"     → "Hey, here"
 *   "Thanks, {username}!"      → "Thanks!"
 *   "Hi @{username} welcome"   → "Hi welcome"
 *   "{username}, here's"       → "here's"
 *   a line holding only the token is removed with its line break
 */
function removeUsernameTokens(text: string): string {
  let out = text;
  let from = 0;
  for (;;) {
    TOKEN.lastIndex = from;
    const m = TOKEN.exec(out);
    if (!m) return out;
    const [cutStart, cutEnd] = cutAround(out, m.index, m.index + m[0].length);
    out = out.slice(0, cutStart) + out.slice(cutEnd);
    from = cutStart;
  }
}

function cutAround(s: string, tokenStart: number, tokenEnd: number): [number, number] {
  // "@{username}" is a mention; a bare "@" left behind is noise.
  const start = s[tokenStart - 1] === '@' ? tokenStart - 1 : tokenStart;
  let spaceStart = start;
  while (isSpace(s[spaceStart - 1])) spaceStart--;
  let spaceEnd = tokenEnd;
  while (isSpace(s[spaceEnd])) spaceEnd++;

  const before = s[spaceStart - 1];
  const after = s[spaceEnd];
  const lineStart = before === undefined || isLineBreak(before);
  const lineEnd = after === undefined || isLineBreak(after);

  if (lineStart && lineEnd) return cutLine(s, spaceStart, spaceEnd);

  if (lineStart) {
    // Keep the line's indentation; drop the token, then what hung off it.
    let end = spaceEnd;
    if (end === tokenEnd) {
      while (AFTER_OPENING.test(s[end] ?? '')) end++;
      if (end > tokenEnd) while (isSpace(s[end])) end++;
    }
    return [start, end];
  }

  if (lineEnd || CLOSING.test(after)) {
    // The comma that set the name off goes with it: "Thanks, {username}!".
    const cutFrom = before === ',' || before === '，' ? spaceStart - 1 : spaceStart;
    // Spaces before closing punctuation are the creator's ("Merci {username} !").
    return [cutFrom, lineEnd ? spaceEnd : tokenEnd];
  }

  // Between two words, one side's spaces must stay or the words would join.
  if (spaceStart < start && spaceEnd > tokenEnd) return [start, spaceEnd];
  return [start, tokenEnd];
}

/**
 * The token was the whole line, so the line goes with one of its breaks. When
 * it was a paragraph of its own, one bordering break goes too, or the two
 * paragraphs around it would end up with a double gap, or the message with a
 * blank first or last line.
 */
function cutLine(s: string, lineFrom: number, lineTo: number): [number, number] {
  const prevBreak = breakBefore(s, lineFrom);
  const nextBreak = breakAt(s, lineTo);
  if (!prevBreak && !nextBreak) return [lineFrom, lineTo];
  const prevBlank = !prevBreak || lineFrom === prevBreak || breakBefore(s, lineFrom - prevBreak) > 0;
  const nextBlank = !nextBreak || lineTo + nextBreak === s.length || breakAt(s, lineTo + nextBreak) > 0;

  let cutStart = lineFrom;
  let cutEnd = lineTo;
  if (nextBreak) cutEnd += nextBreak;
  else cutStart -= prevBreak;
  if (prevBlank && nextBlank) {
    if (nextBreak && breakAt(s, cutEnd)) cutEnd += breakAt(s, cutEnd);
    else cutStart -= breakBefore(s, cutStart);
  }
  return [cutStart, cutEnd];
}
