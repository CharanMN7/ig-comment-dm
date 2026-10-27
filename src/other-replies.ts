import type { RuleMatch } from './match.ts';
import { parsePublicReplies } from './replies.ts';

/**
 * How many rules besides the DM's may post a public reply to one comment.
 * With the DM rule's own, that is up to three replies from the account under
 * one comment, which still reads as answers; five matching rules stacking
 * five replies reads as a bot. Each is also one more Meta call inside the
 * webhook's 25 seconds, which every comment in a delivery shares.
 */
export const EXTRA_PUBLIC_REPLY_CAP = 2;

export const EXTRA_REPLY_NONE = 'this rule has no public reply';
export const EXTRA_REPLY_OWN_DM_ONLY = 'public reply only when this rule sends the DM';
export const EXTRA_REPLY_OVER_CAP = `only ${EXTRA_PUBLIC_REPLY_CAP} other rules can publicly reply to one comment`;
export const EXTRA_REPLY_NO_DM = 'public reply not posted, because Instagram didn’t confirm the DM';
export const EXTRA_REPLY_RULE_GONE = 'public reply not posted, because the rule was turned off or deleted before the DM went out';

export type OtherRule = RuleMatch & { replies: string[]; posts: boolean };

/**
 * Which of the other matching rules post a public reply: those that have one
 * and were set to post it without their own DM, in matching order, up to the
 * cap. Only opted-in rules, because a reply usually says "Sent you a DM", and
 * here this rule's DM isn't sent. The Test page shows this same plan, so it
 * can't promise a reply a real comment wouldn't get.
 */
export function planOtherRules(also: RuleMatch[]): OtherRule[] {
  let posting = 0;
  return also.map((m) => {
    const replies = parsePublicReplies(m.rule.public_reply_text);
    const posts = replies.length > 0 && m.rule.reply_without_dm === 1 && posting < EXTRA_PUBLIC_REPLY_CAP;
    if (posts) posting += 1;
    return { ...m, replies, posts };
  });
}

/** Why the plan leaves out this rule's public reply, or null when it posts one. */
export function otherRuleSkipReason(other: OtherRule): string | null {
  if (other.replies.length === 0) return EXTRA_REPLY_NONE;
  if (other.rule.reply_without_dm !== 1) return EXTRA_REPLY_OWN_DM_ONLY;
  return other.posts ? null : EXTRA_REPLY_OVER_CAP;
}
