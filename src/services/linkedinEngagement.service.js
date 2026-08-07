const axios = require('axios');
const { API_BASE, restHeaders } = require('../config/linkedin');
const { encodeUrnForPath } = require('../utils/urn');

const REQUEST_TIMEOUT_MS = 30000; // see linkedinPost.service.js for why this matters

async function likePost(activityUrn, personUrn, accessToken) {
  const path = `${API_BASE}/socialActions/${encodeUrnForPath(activityUrn)}/likes`;
  await axios.post(
    path,
    { actor: personUrn, root: activityUrn },
    { headers: restHeaders(accessToken, { 'Content-Type': 'application/json' }), timeout: REQUEST_TIMEOUT_MS }
  );
}

async function commentOnPost(activityUrn, personUrn, text, accessToken) {
  const path = `${API_BASE}/socialActions/${encodeUrnForPath(activityUrn)}/comments`;
  await axios.post(
    path,
    { actor: personUrn, object: activityUrn, message: { text } },
    { headers: restHeaders(accessToken, { 'Content-Type': 'application/json' }), timeout: REQUEST_TIMEOUT_MS }
  );
}

module.exports = { likePost, commentOnPost };
