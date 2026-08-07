const { env } = require('./env');

// LinkedIn's newer REST API surface (as opposed to the legacy /v2 endpoints).
// Docs: https://learn.microsoft.com/linkedin/
const AUTH_BASE = 'https://www.linkedin.com/oauth/v2';
const API_BASE = 'https://api.linkedin.com/rest';
const USERINFO_URL = 'https://api.linkedin.com/v2/userinfo';

// Scopes granted by the "Sign In with LinkedIn using OpenID Connect" +
// "Share on LinkedIn" products (both Default Tier, no partner approval needed).
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
