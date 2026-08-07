// Turns a LinkedIn post URL the user pastes in (from their browser address bar) into the
// activity/ugcPost URN needed by the Social Actions API. LinkedIn's Default Tier gives no
// feed/search access, so this is the only way the app ever learns about a post to engage
// with — the user always supplies it directly.

const ACTIVITY_PATTERN = /activity[:-](\d{10,20})/;
const UGC_POST_PATTERN = /ugcPost[:-](\d{10,20})/;

class UrnParseError extends Error {}

function parseActivityUrnFromUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') {
    throw new UrnParseError('Paste a LinkedIn post URL.');
  }
  const url = rawUrl.trim();

  if (/lnkd\.in\//i.test(url)) {
    throw new UrnParseError(
      "Shortened lnkd.in links don't contain the post ID. Open the post on LinkedIn, use " +
        '"Copy link to post", and paste the full linkedin.com URL instead.'
    );
  }

  let decoded = url;
  try {
    decoded = decodeURIComponent(url);
  } catch {
    // leave as-is if it isn't validly encoded
  }

  const activityMatch = decoded.match(ACTIVITY_PATTERN);
  if (activityMatch) {
    return { type: 'activity', id: activityMatch[1], urn: `urn:li:activity:${activityMatch[1]}` };
  }

  const ugcMatch = decoded.match(UGC_POST_PATTERN);
  if (ugcMatch) {
    return { type: 'ugcPost', id: ugcMatch[1], urn: `urn:li:ugcPost:${ugcMatch[1]}` };
  }

  throw new UrnParseError(
    "Couldn't find a post ID in that URL. Paste the full post URL, e.g. " +
      'https://www.linkedin.com/posts/someone_a-post-title-activity-1234567890123456789-AbCd/'
  );
}

// URNs contain colons, which must be percent-encoded when used as a REST.li path segment.
function encodeUrnForPath(urn) {
  return encodeURIComponent(urn);
}

module.exports = { parseActivityUrnFromUrl, encodeUrnForPath, UrnParseError };
