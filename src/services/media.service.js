const fs = require('fs');
const mime = require('mime-types');

const ALLOWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif']);
const MAX_IMAGE_BYTES = 20 * 1024 * 1024; // LinkedIn's own image size ceiling is similar

class MediaValidationError extends Error {}

// Deliberately checked at post-time (not at schedule-creation time) since a post can be
// scheduled days/weeks out and the referenced desktop file can move, get renamed, or (if
// it lives under a OneDrive-synced Desktop) be a cloud-only placeholder that isn't fully
// on disk yet.
function validateLocalImage(filePath) {
  if (!filePath) throw new MediaValidationError('No file path provided.');
  if (!fs.existsSync(filePath)) {
    throw new MediaValidationError(`File not found at post time: ${filePath}`);
  }
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) {
    throw new MediaValidationError(`Path is not a file: ${filePath}`);
  }
  if (stat.size === 0) {
    throw new MediaValidationError(
      `File is 0 bytes — if this is on a OneDrive-synced Desktop it may be a cloud-only placeholder that hasn't downloaded locally: ${filePath}`
    );
  }
  if (stat.size > MAX_IMAGE_BYTES) {
    throw new MediaValidationError(`File is too large (${Math.round(stat.size / 1024 / 1024)}MB, max 20MB): ${filePath}`);
  }
  const mimeType = mime.lookup(filePath);
  if (!mimeType || !ALLOWED_IMAGE_TYPES.has(mimeType)) {
    throw new MediaValidationError(`Unsupported image type for ${filePath} (allowed: jpg, png, gif).`);
  }
  return { mimeType, sizeBytes: stat.size };
}

module.exports = { validateLocalImage, MediaValidationError, ALLOWED_IMAGE_TYPES };
