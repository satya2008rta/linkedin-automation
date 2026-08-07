const axios = require('axios');
const { API_BASE, restHeaders } = require('../config/linkedin');

const REQUEST_TIMEOUT_MS = 30000;

// Finds LinkedIn Company Pages the authenticated member administers, so the app can offer
// them as "post as" choices. Two calls: first the access-control list (which orgs, with
// what role), then a name lookup for just those org IDs (organizationAcls doesn't return
// names). Returns [] rather than throwing if the token lacks the org scopes (e.g. the app
// never had Community Management API added/approved) — org features degrade gracefully
// rather than breaking personal posting.
async function listAdministeredOrganizations(accessToken) {
  let aclElements;
  try {
    const { data } = await axios.get(`${API_BASE}/organizationAcls`, {
      params: { q: 'roleAssignee', role: 'ADMINISTRATOR', state: 'APPROVED' },
      headers: restHeaders(accessToken),
      timeout: REQUEST_TIMEOUT_MS,
    });
    aclElements = data.elements || [];
  } catch (err) {
    if (err.response?.status === 403) return []; // scope not granted — treat as "no pages"
    throw err;
  }

  // Different LinkedIn API versions have used either field name for this in their docs.
  const urns = [...new Set(aclElements.map((e) => e.organizationTarget || e.organization).filter(Boolean))];
  if (urns.length === 0) return [];

  const ids = urns.map((urn) => urn.split(':').pop());
  const { data } = await axios.get(`${API_BASE}/organizationsLookup`, {
    params: { ids: `List(${ids.join(',')})` },
    headers: restHeaders(accessToken),
    timeout: REQUEST_TIMEOUT_MS,
  });

  return urns.map((urn) => {
    const id = urn.split(':').pop();
    const org = data.results?.[id];
    return { urn, id, name: org?.localizedName || `Organization ${id}` };
  });
}

module.exports = { listAdministeredOrganizations };
