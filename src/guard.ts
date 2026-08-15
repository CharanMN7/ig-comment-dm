/**
 * The single most important guard in this codebase.
 *
 * Meta delivers webhooks for the operator's own comments on their own posts.
 * Acting on those would try to DM the operator, waste the one-reply slot, and
 * look broken. Call this before anything else in the comment pipeline.
 */
export function isSelfComment(
  commenterId: string | null | undefined,
  accountIgUserId: string,
): boolean {
  if (commenterId == null || commenterId === '') return false;
  return commenterId === accountIgUserId;
}
