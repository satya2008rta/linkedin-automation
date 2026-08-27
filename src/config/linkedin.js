const { env } = require('./env');

// LinkedIn's newer REST API surface (as opposed to the legacy /v2 endpoints).
// Docs: https://learn.microsoft.com/linkedin/
const AUTH_BASE = 'https://www.linkedin.com/oauth/v2';
const API_BASE = 'https://api.linkedin.com/rest';
const USERINFO_URL = 'https://api.linkedin.com/v2/userinfo';

// Scopes granted by the "Sign In with LinkedIn using OpenID Connect" + "Share on LinkedIn"
// products (both Default Tier, no partner approval needed) — this is all that's requested
// for now. Company Page posting used to also request rw_organization_admin +
// w_organization_social (from the Community Management API product, which needs LinkedIn's
// manual approval per app), deliberately removed for the moment to keep the sign-in flow
// simple and consistent while multi-user support is being rolled out. Org-related features
// (linkedinOrg.service.js, the organizations table, "Post as a Page") already degrade
// gracefully with just these scopes — they'll just always show "no company pages" rather
// than erroring. Re-add 'rw_organization_admin', 'w_organization_social' here to bring
// Company Page posting back.
const SCOPES = ['openid', 'profile', 'email', 'w_member_social'];

function restHeaders(accessToken, extra = {}) {
  return {
    Authorization: `Bearer ${accessToken}`,
    'LinkedIn-Version': env.linkedin.apiVersion,
    'X-Restli-Protocol-Version': '2.0.0',
    ...extra,
  };
}

module.exports = { AUTH_BASE, API_BASE, USERINFO_URL, SCOPES, restHeaders };
