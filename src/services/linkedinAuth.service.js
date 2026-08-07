const axios = require('axios');
const { env } = require('../config/env');
const { AUTH_BASE, USERINFO_URL, SCOPES } = require('../config/linkedin');
const storage = require('./storage.service');

function buildAuthUrl(state) {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: env.linkedin.clientId,
    redirect_uri: env.linkedin.redirectUri,
    state,
    scope: SCOPES.join(' '),
  });
  return `${AUTH_BASE}/authorization?${params.toString()}`;
}

async function exchangeCodeForToken(code) {
  const params = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: env.linkedin.redirectUri,
    client_id: env.linkedin.clientId,
    client_secret: env.linkedin.clientSecret,
  });
  const { data } = await axios.post(`${AUTH_BASE}/accessToken`, params.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });
  // data: { access_token, expires_in (seconds), scope, token_type }
  return data;
}

async function fetchUserInfo(accessToken) {
  const { data } = await axios.get(USERINFO_URL, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  // OIDC userinfo: sub, name, given_name, family_name, email, picture, ...
  return data;
}

// Runs the full callback-time flow: exchange code -> fetch profile -> persist to storage.
async function completeLogin(code) {
  const tokenResponse = await exchangeCodeForToken(code);
  const obtainedAt = new Date();
  const expiresAt = new Date(obtainedAt.getTime() + tokenResponse.expires_in * 1000);

  const userInfo = await fetchUserInfo(tokenResponse.access_token);

  return storage.saveToken({
    accessToken: tokenResponse.access_token,
    tokenType: tokenResponse.token_type || 'Bearer',
    scope: tokenResponse.scope || SCOPES.join(' '),
    personUrn: `urn:li:person:${userInfo.sub}`,
    displayName: userInfo.name || [userInfo.given_name, userInfo.family_name].filter(Boolean).join(' '),
    email: userInfo.email || null,
    pictureUrl: userInfo.picture || null,
    headline: userInfo.headline || null, // OIDC userinfo doesn't always include this; kept for future use
    obtainedAt: obtainedAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
    lastAuthAt: obtainedAt.toISOString(),
  });
}

module.exports = { buildAuthUrl, exchangeCodeForToken, fetchUserInfo, completeLogin };
