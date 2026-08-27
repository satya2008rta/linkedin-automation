const storage = require('../services/storage.service');
const linkedinPost = require('../services/linkedinPost.service');
const logger = require('../utils/logger');

const MAX_ATTEMPTS = 3;
const RETRY_BACKOFF_MINUTES = 5;
// Every LinkedIn API call now has a 30s timeout (see linkedinPost.service.js), so a request
// that's genuinely still running resolves well within a few minutes on its own. Anything
// still 'posting' past this window means the process died mid-request, not that it's slow —
// see reapStaleLocks in storage.service.js for why that lands on 'failed', not 'pending'.
const STALE_LOCK_MINUTES = 5;
const CLAIM_BATCH_SIZE = 5;

// Runs the actual publish for a post that has already been claimed (status='posting').
// Shared by the cron loop and the manual "Post Now" route so the two paths behave
// identically and can't drift apart.
async function executeClaimedPost(post) {
  // The claimed row (a plain SELECT * from storage.claimDuePosts/claimSpecificPost) already
  // carries its owner's userId — publish under THAT user's token, never a global one, so two
  // users each having a due post publish under their own identities.
  const tokenState = await storage.tokenStatus(post.userId);
  if (!tokenState.connected || tokenState.expired) {
    return storage.updatePost(post.id, post.userId, {
      status: 'blocked_token_expired',
      lastError: 'LinkedIn token is missing or expired. Reconnect in Settings, then retry this post.',
    });
  }

  try {
    const result = await linkedinPost.publishPostRecord(post, tokenState.token);
    return storage.updatePost(post.id, post.userId, {
      status: 'posted',
      linkedinPostUrn: result.urn,
      linkedinPostUrl: result.url,
      postedAt: new Date().toISOString(),
      lastError: null,
    });
  } catch (err) {
    const message = err.response?.data?.message || err.message || 'Unknown error publishing post.';
    logger.error(`Post ${post.id} failed (attempt ${post.attempts}):`, message);

    if (post.attempts < MAX_ATTEMPTS) {
      // Requeue with a short backoff so a transient LinkedIn/network error doesn't just
      // retry every cron tick and hammer the API.
      const nextTry = new Date(Date.now() + RETRY_BACKOFF_MINUTES * 60000).toISOString();
      return storage.updatePost(post.id, post.userId, {
        status: 'pending',
        scheduledFor: nextTry,
        lastError: message,
      });
    }
    return storage.updatePost(post.id, post.userId, { status: 'failed', lastError: message });
  }
}

// Called by the scheduler on every cron tick.
async function runDueJobs() {
  const reaped = await storage.reapStaleLocks(STALE_LOCK_MINUTES);
  if (reaped > 0) logger.warn(`Reset ${reaped} stale-locked post(s) back to pending.`);

  const claimed = await storage.claimDuePosts(CLAIM_BATCH_SIZE);
  for (const post of claimed) {
    await executeClaimedPost(post);
  }
  return claimed.length;
}

// Called by the "Post Now" route for an on-demand, unscheduled publish. userId scopes the
// claim to the requesting user's own post — see storage.claimSpecificPost, which returns
// null both when the post is mid-claim by the scheduler AND when it belongs to someone else,
// so this error message covers both without leaking which case it was.
async function postNow(postId, userId) {
  const claimed = await storage.claimSpecificPost(postId, userId);
  if (!claimed) {
    throw new Error('This post is already being processed (likely by the scheduler) — refresh and check its status.');
  }
  return executeClaimedPost(claimed);
}

module.exports = { runDueJobs, postNow, executeClaimedPost, MAX_ATTEMPTS };
