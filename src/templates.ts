export interface RuleTemplate {
  id: string;
  name: string;
  description: string;
  label: string;
  keywords: string[];
  dm_text: string;
  public_reply_text?: string;
}

export const RULE_TEMPLATES: RuleTemplate[] = [
  {
    id: 'lead-magnet',
    name: 'Free guide / lead magnet',
    description: 'Creators building a list',
    label: 'Free guide',
    keywords: ['guide', 'freebie', 'send', 'link', 'guía'],
    dm_text:
      "Hey! Here is the link to download the free guide:\nhttps://example.com/free-guide\n\nHope it helps! Let me know if you have any questions.",
    public_reply_text: 'Sent you a DM with the link! Check your inbox 📥',
  },
  {
    id: 'product-link',
    name: 'Product link',
    description: 'DTC and e-commerce',
    label: 'Product details',
    keywords: ['link', 'buy', 'shop', 'order', 'lien'],
    dm_text:
      "Thanks for asking! You can find the product details and shop here:\nhttps://example.com/product\n\nFeel free to ask if you have sizing or shipping questions!",
    public_reply_text: 'Just sent the link to your DMs! 🛍️',
  },
  {
    id: 'price-list',
    name: 'Price list',
    description: 'Services, beauty, trades',
    label: 'Pricing & Services',
    keywords: ['price', 'pricing', 'cost', 'how much', 'rates', 'tarif'],
    dm_text:
      "Hi! Here is our current pricing and service menu:\nhttps://example.com/pricing\n\nDM us if you'd like to talk through any custom options!",
    public_reply_text: 'Sent our price list to your DMs! ✨',
  },
  {
    id: 'booking-link',
    name: 'Booking link',
    description: 'Coaches, consultants',
    label: 'Book a call',
    keywords: ['book', 'call', 'consult', 'appointment', 'calendar'],
    dm_text:
      "Hey there! You can grab a spot on my calendar directly here:\nhttps://calendly.com/example/intro\n\nLooking forward to speaking with you!",
    public_reply_text: 'Check your DMs for the booking link! 🗓️',
  },
  {
    id: 'waitlist',
    name: 'Waitlist',
    description: 'Launches',
    label: 'VIP Waitlist',
    keywords: ['waitlist', 'early', 'vip', 'join', 'beta'],
    dm_text:
      "You're on the right track! Join the early-access waitlist here to get notified first plus special launch perks:\nhttps://example.com/waitlist\n\nCan't wait to share what we've been building!",
    public_reply_text: 'Sent you the early access invite in your DMs! 🚀',
  },
  {
    id: 'event-rsvp',
    name: 'Event RSVP',
    description: 'Community organisers',
    label: 'Event registration',
    keywords: ['rsvp', 'attend', 'tickets', 'event', 'meetup'],
    dm_text:
      "Hey! Here is the registration page and event details:\nhttps://example.com/event\n\nSpots are limited, so reserve yours when you can. See you there!",
    public_reply_text: 'Sent the event details and registration link to your DMs! 🎟️',
  },
  {
    id: 'menu',
    name: 'Menu',
    description: 'Restaurants and cafés',
    label: 'Food & drink menu',
    keywords: ['menu', 'food', 'drinks', 'specials'],
    dm_text:
      "Hello! Here is our full current menu along with this week's specials:\nhttps://example.com/menu\n\nWe look forward to serving you!",
    public_reply_text: 'Sent the menu straight to your DMs! 🍽️',
  },
];
