/**
 * Starting points for a first rule. Picking one fills in the new-rule form and
 * saves nothing. They are content, so a change to one is a pull request, not
 * an admin setting.
 *
 * Every message here is shipped as-is by someone, so it has to read like the
 * creator typed it. Keywords are words a follower types to ask for this exact
 * thing, never everyday words that would message people who didn't ask, and
 * no two templates share one, so two rules started from templates never fight
 * over a comment.
 */

/**
 * Where the creator's link goes. Deliberately not a URL, so a template saved
 * unedited could never send a follower to someone else's page, and the rule
 * form refuses to save while it is still there.
 */
export const LINK_MARKER = 'PASTE-YOUR-LINK-HERE';

export type RuleTemplate = {
  /** The `template` value in `/rules/new?template=…`. */
  id: string;
  /** The gallery title, and the rule's name once filled in. */
  name: string;
  /** Who it suits, one line in the gallery. */
  forWhom: string;
  /** Setup the form can't do by itself, shown above the filled-in form. */
  note?: string;
  /** Empty when the rule replies to every comment on its post. */
  keywords: string[];
  exclusions: string[];
  matchAll: boolean;
  dm: string;
  /** The main public reply, then its variations. */
  publicReplies: string[];
};

export const TEMPLATES: readonly RuleTemplate[] = [
  {
    id: 'guide',
    name: 'Free guide',
    forWhom: 'A PDF or checklist people get in return for their email. Answers “guía” and “गाइड” too.',
    // Followers type the keyword in their own language and script, whatever
    // language the post is in. No "how much" exclusion: the guide is free, so
    // whoever asks the price is exactly who should get it.
    keywords: ['guide', 'guía', 'गाइड'],
    exclusions: [],
    matchAll: false,
    dm: `Hey {username}, here’s the guide: ${LINK_MARKER}

Put your email in on that page and it’ll arrive within a few minutes. If it doesn’t, look in Promotions or spam.`,
    publicReplies: [
      '@{username} sent, check your DMs',
      'Sent you the guide!',
      'Just sent it. If you don’t follow me, look in your message requests.',
    ],
  },
  {
    id: 'shop',
    name: 'Product link',
    forWhom: 'Sends the buy link for what’s in your post.',
    note: 'Selling more than one thing? Pick this product’s post under “Which posts”, so each post sends its own link.',
    keywords: ['shop', 'where to buy'],
    exclusions: [],
    matchAll: false,
    dm: `Here’s where to get it: ${LINK_MARKER}

Got a question before you order, {username}? Reply here. It comes straight to me.`,
    publicReplies: [
      '@{username} the link’s in your DMs',
      'Sent you the link',
      'Sent! It may be waiting in your message requests.',
    ],
  },
  {
    id: 'prices',
    name: 'Price list',
    forWhom: 'For hair, nails, tattoos and trades, where every post gets asked “price?”',
    keywords: ['price', 'prices', 'pricing', 'rates'],
    exclusions: [],
    matchAll: false,
    dm: `Hi {username}, here are my current prices: ${LINK_MARKER}

To book, reply with what you’d like done and a day that suits you, and I’ll send the times I have free.`,
    publicReplies: [
      '@{username} sent you my prices',
      'Prices are in your DMs',
      'Sent! Not in your inbox? Check message requests.',
    ],
  },
  {
    id: 'booking',
    name: 'Book a session',
    forWhom: 'Coaches and consultants: sends your booking page.',
    keywords: ['coaching', 'consult', 'consultation'],
    exclusions: [],
    matchAll: false,
    dm: `You can pick a time here, {username}: ${LINK_MARKER}

If none of the times work where you are, reply with your time zone and I’ll find one.`,
    publicReplies: [
      '@{username} sent you the booking link',
      'Check your DMs',
      'Sent. If you don’t follow me, it’ll be under message requests.',
    ],
  },
  {
    id: 'waitlist',
    name: 'Waitlist',
    forWhom: 'Collects emails before a launch, a course or a product drop.',
    keywords: ['waitlist', 'wait list', 'waiting list'],
    // Launch posts fill up with people saying they've joined, and sending them
    // the sign-up link again reads like nobody is paying attention.
    exclusions: ['already on the waitlist', 'already signed up'],
    matchAll: false,
    dm: `Hey {username}, add your email here to get on the list: ${LINK_MARKER}

You’ll hear the day it opens, before I announce it here.`,
    publicReplies: [
      '@{username} sent you the sign-up link',
      'In your DMs!',
      'Sent. No sign of it? Try your message requests.',
    ],
  },
  {
    id: 'rsvp',
    name: 'Event RSVP',
    forWhom: 'Meetups, workshops, run clubs and webinars.',
    keywords: ['rsvp', 'save me a seat', 'save me a spot'],
    exclusions: [],
    matchAll: false,
    dm: `Hope you can make it, {username}! RSVP here: ${LINK_MARKER}

The date, time and where to be are all on that page. If your plans change, reply here so I can give your place to someone else.`,
    publicReplies: [
      '@{username} sent you the RSVP link',
      'Sent, see you there!',
      'Check your DMs, or message requests if you don’t follow me.',
    ],
  },
  {
    id: 'menu',
    name: 'Menu',
    forWhom: 'Restaurants, cafés and food trucks.',
    // "menu" alone, as whole words: every way of asking contains it, and
    // anywhere-matching would also fire on Spanish "menuda".
    keywords: ['menu'],
    exclusions: [],
    matchAll: false,
    dm: `Hi {username}, here’s our menu: ${LINK_MARKER}

Questions about allergens or bookings? Reply here and we’ll get back to you.`,
    publicReplies: [
      '@{username} the menu’s in your DMs',
      'Sent you the menu',
      'Sent! If you don’t follow us, it’s in your message requests.',
    ],
  },
  {
    id: 'giveaway',
    name: 'Giveaway entry',
    forWhom: 'Confirms every entry on one giveaway post, no keyword needed.',
    note: 'Pick the giveaway post under “Which posts”. This rule answers every comment, so it only runs on one post.',
    keywords: [],
    exclusions: [],
    matchAll: true,
    // Fake "you won" messages from lookalike accounts follow most giveaways,
    // so the entry message says up front what the real one will never ask.
    dm: `You’re in, {username}. Good luck!

I’ll pick the winner when the giveaway closes and message them from this account. I’ll never ask for a payment or card details to claim a prize, so ignore anyone who does.

Full rules: ${LINK_MARKER}`,
    publicReplies: [
      '@{username} you’re in!',
      'Got your entry, good luck',
      'You’re in. Details are in your DMs.',
    ],
  },
];

export function findTemplate(id: string | undefined): RuleTemplate | undefined {
  return TEMPLATES.find((t) => t.id === id);
}

// Names that only ever stand in for the creator's own, in a host or as the
// first part of a path: calendly.com/example, linktr.ee/your-name, yourshop.com.
const SAMPLE_NAMES = new Set([
  'example',
  'yourname',
  'yourusername',
  'yourhandle',
  'yourlink',
  'yourpage',
  'yoursite',
  'yourwebsite',
  'yourdomain',
  'yourshop',
  'yourstore',
]);

// Top-level domains reserved so they never resolve to anyone's site.
const RESERVED_TLDS = new Set(['example', 'test', 'invalid', 'localhost']);

// A host, with or without the scheme, and any path after it. Bare hosts
// count because creators type "mysite.com/guide" as often as the full URL.
const LINK = /(?:https?:\/\/)?((?:[a-z0-9-]+\.)+[a-z]{2,})(\/\S*)?/gi;

const isSampleName = (s: string): boolean => SAMPLE_NAMES.has(s.toLowerCase().replace(/[-_.]/g, ''));

/**
 * The marker, or the first sample link such as example.com, still in `text`,
 * written the way it appears there. Null when there is none.
 */
export function placeholderLinkIn(text: string): string | null {
  if (text.toUpperCase().includes(LINK_MARKER)) return LINK_MARKER;
  for (const m of text.matchAll(LINK)) {
    const labels = (m[1] ?? '').toLowerCase().split('.');
    const tld = labels.pop() ?? '';
    const firstSegment = (m[2] ?? '').split(/[/?#]/)[1] ?? '';
    if (RESERVED_TLDS.has(tld) || labels.some(isSampleName) || isSampleName(firstSegment)) {
      return m[0].replace(/[.,!?;:)\]]+$/, '');
    }
  }
  return null;
}
