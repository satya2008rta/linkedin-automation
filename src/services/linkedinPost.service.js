const fs = require('fs');
const axios = require('axios');
const { API_BASE, restHeaders } = require('../config/linkedin');
const { validateLocalImage } = require('./media.service');

// Every outbound call here has an explicit timeout. Without one, a stalled connection
// (flaky network, LinkedIn hiccup) hangs indefinitely — the post sits in 'posting' forever
// with nothing actually happening, and if the process gets killed while that hang is in
// progress (e.g. a server restart), the DB is left in an unrecoverable ambiguous state:
// unclear whether LinkedIn actually received the request or not. A bounded timeout turns
// that into a normal, visible failure instead.
const REQUEST_TIMEOUT_MS = 30000;

async function initializeImageUpload(personUrn, accessToken) {
  const { data } = await axios.post(
    `${API_BASE}/images?action=initializeUpload`,
    { initializeUploadRequest: { owner: personUrn } },
    { headers: restHeaders(accessToken, { 'Content-Type': 'application/json' }), timeout: REQUEST_TIMEOUT_MS }
  );
  // data.value: { uploadUrl, image (URN) }
  return data.value;
}

async function uploadImageBinary(uploadUrl, filePath) {
  const buffer = fs.readFileSync(filePath);
  await axios.put(uploadUrl, buffer, {
    headers: { 'Content-Type': 'application/octet-stream' },
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
    timeout: REQUEST_TIMEOUT_MS,
  });
}

// Uploads a local image and returns its LinkedIn image URN, ready to attach to a post.
async function uploadImage(personUrn, accessToken, filePath) {
  validateLocalImage(filePath);
  const { uploadUrl, image } = await initializeImageUpload(personUrn, accessToken);
  await uploadImageBinary(uploadUrl, filePath);
  return image; // e.g. urn:li:image:C4E10AQ...
}

// Creates a post (text, optionally with one attached image). Returns { urn, url }.
async function createPost({ personUrn, accessToken, commentary, visibility = 'PUBLIC', imageUrn = null }) {
  const body = {
    author: personUrn,
    commentary,
    visibility,
    distribution: {
      feedDistribution: 'MAIN_FEED',
      targetEntities: [],
      thirdPartyDistributionChannels: [],
    },
    lifecycleState: 'PUBLISHED',
    isReshareDisabledByAuthor: false,
  };

  if (imageUrn) {
    body.content = { media: { id: imageUrn } };
  }

  const response = await axios.post(`${API_BASE}/posts`, body, {
    headers: restHeaders(accessToken, { 'Content-Type': 'application/json' }),
    timeout: REQUEST_TIMEOUT_MS,
  });

  // LinkedIn returns 201 with an empty body; the created post's URN comes back in a header.
  const urn = response.headers['x-restli-id'] || response.headers['X-RestLi-Id'] || null;
  const url = urn ? `https://www.linkedin.com/feed/update/${urn}/` : null;
  return { urn, url };
}

// End-to-end: given a `posts` row (content/mediaPath/mediaType/visibility) plus the
// current token, uploads media if present and creates the LinkedIn post. Used by both the
// manual "Post Now" route and the scheduler's postRunner so the two paths can't drift.
async function publishPostRecord(post, token) {
  let imageUrn = null;
  if (post.mediaType === 'image' && post.mediaPath) {
    imageUrn = await uploadImage(token.personUrn, token.accessToken, post.mediaPath);
  }
  return createPost({
    personUrn: token.personUrn,
    accessToken: token.accessToken,
    commentary: post.content,
    visibility: post.visibility || 'PUBLIC',
    imageUrn,
  });
}

module.exports = { initializeImageUpload, uploadImageBinary, uploadImage, createPost, publishPostRecord };
