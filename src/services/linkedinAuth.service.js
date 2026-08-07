const axios = require('axios');
const { env } = require('../config/env');
const { AUTH_BASE, USERINFO_URL, SCOPES } = require('../config/linkedin');
const storage = require('./storage.service');
const linkedinOrg = require('./linkedinOrg.service');
const logger = require('../utils/logger');

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

  const saved = await storage.saveToken({
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

  // Best-effort: refresh the list of Company Pages this member administers. Wrapped so a
  // failure here (e.g. Community Management API was never approved for this app) doesn't
  // block completing login — personal posting still works either way.
  try {
    const orgs = await linkedinOrg.listAdministeredOrganizations(tokenResponse.access_token);
    await storage.replaceOrganizations(orgs);
    logger.info(`Fetched ${orgs.length} administered organization(s) on reconnect.`);
  } catch (err) {
    logger.warn('Could not fetch administered organizations on reconnect:', err.message);
  }

  return saved;
}

// For the Settings page's "Refresh company pages" button — re-fetches admin org list using
// the already-stored token, no full re-auth needed (only useful if the token already has
// the org scopes; if it doesn't, reconnecting is what's actually required).
async function refreshOrganizations() {
  const token = await storage.getToken();
  if (!token?.accessToken) throw new Error('Not connected to LinkedIn.');
  const orgs = await linkedinOrg.listAdministeredOrganizations(token.accessToken);
  await storage.replaceOrganizations(orgs);
  return orgs;
}

module.exports = { buildAuthUrl, exchangeCodeForToken, fetchUserInfo, completeLogin, refreshOrganizations };
