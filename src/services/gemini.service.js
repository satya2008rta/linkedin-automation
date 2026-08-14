const { GoogleGenerativeAI } = require('@google/generative-ai');
const { env } = require('../config/env');

// Uses Google's rolling "-latest" alias rather than a dated model id (e.g. "gemini-2.0-flash")
// so this doesn't silently break again the next time Google retires a specific version.
// Deliberately "flash", not "flash-lite" or "pro": Google's tiers run
// Flash-Lite (cheapest/fastest, weaker) < Flash (balanced) < Pro (priciest, strongest) —
// Flash is the moderate middle ground for a once-a-month content-planning call, so token
// spend doesn't run needlessly high (Pro) or produce noticeably thinner drafts (Flash-Lite).
// Overridable via env if you want a different tier — check
// https://ai.google.dev/gemini-api/docs/models for current names.
const MODEL_NAME = process.env.GEMINI_MODEL || 'gemini-flash-latest';

const MAX_POST_CHARS = 3000; // LinkedIn's own commentary length ceiling

class GeminiPlanError extends Error {}

function buildPrompt(settings, { displayName, fromDate, toDate, daysAhead }) {
  const postsPerWeek = Number(settings.aiPostsPerWeek) || 3;
  const daysCount = daysAhead || 30;
  const approxCount = Math.max(2, Math.round((postsPerWeek * daysCount) / 7));

  const rangeInstruction = fromDate && toDate
    ? `for the exact date range from ${fromDate} to ${toDate} (inclusive)`
    : `for a ${daysCount}-day period starting from ${fromDate || 'tomorrow'}`;

  const dateConstraint = fromDate && toDate
    ? `strictly between ${fromDate} and ${toDate} (inclusive)`
    : `between ${fromDate || 'tomorrow'} onwards`;

  return `You are a LinkedIn content strategist writing on behalf of ${displayName || 'a professional'}.
Generate a LinkedIn content calendar ${rangeInstruction}.

Content pillars / topics: ${settings.aiTopics || '(not specified — use general professional development / industry commentary)'}
Tone / voice: ${settings.aiTone || 'professional, approachable'}
Target audience: ${settings.aiAudience || 'professional network / industry peers'}
Desired cadence: about ${postsPerWeek} posts per week (~${approxCount} posts total across the date range)
Preferred posting times: ${settings.aiPreferredTimes || 'late morning on weekdays'}
Extra instructions: ${settings.aiExtraInstructions || '(none)'}

Rules:
- Each post's "content" must be original, ready-to-publish LinkedIn post text (no markdown, no hashtag spam — at most 3 relevant hashtags at the end if natural).
- Keep each post under ${MAX_POST_CHARS} characters.
- Spread "suggestedDate" values across the date range ${dateConstraint}, as ISO date strings (YYYY-MM-DD).
- "suggestedTime" should be a 24h "HH:mm" string matching the preferred posting times.
- Vary the angle/format across posts (story, tip list, question, opinion, lesson learned) — don't repeat the same structure every time.
- Return ONLY a JSON array, no surrounding prose, matching this shape:
[{ "content": string, "suggestedDate": "YYYY-MM-DD", "suggestedTime": "HH:mm" }]`;
}

function validateAndNormalize(rawItems) {
  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    throw new GeminiPlanError('Gemini did not return any draft posts. Try again or adjust your AI inputs.');
  }
  const normalized = [];
  for (const item of rawItems) {
    if (!item || typeof item.content !== 'string' || !item.content.trim()) continue;
    if (typeof item.suggestedDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(item.suggestedDate)) continue;
    const time = typeof item.suggestedTime === 'string' && /^\d{2}:\d{2}$/.test(item.suggestedTime) ? item.suggestedTime : '10:00';
    const iso = new Date(`${item.suggestedDate}T${time}:00`);
    if (Number.isNaN(iso.getTime())) continue;
    normalized.push({ content: item.content.trim().slice(0, MAX_POST_CHARS), scheduledFor: iso.toISOString() });
  }
  if (normalized.length === 0) {
    throw new GeminiPlanError('Gemini returned drafts but none had a valid shape — try generating again.');
  }
  return normalized;
}

// Returns an array of { content, scheduledFor } ready to insert as draft posts.
async function generateMonthlyContentPlan(settings, { apiKey, displayName, fromDate, toDate, daysAhead = 30 }) {
  if (!apiKey) {
    throw new GeminiPlanError('No Gemini API key configured. Add one in Settings first.');
  }

  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({
    model: MODEL_NAME,
    generationConfig: { responseMimeType: 'application/json' },
  });

  let calculatedDays = daysAhead;
  if (fromDate && toDate) {
    const diffMs = new Date(toDate).getTime() - new Date(fromDate).getTime();
    if (diffMs >= 0) {
      calculatedDays = Math.max(1, Math.round(diffMs / 86400000) + 1);
    }
  }

  const prompt = buildPrompt(settings, { displayName, fromDate, toDate, daysAhead: calculatedDays });

  let text;
  try {
    const result = await model.generateContent(prompt);
    text = result.response.text();
  } catch (err) {
    throw new GeminiPlanError(`Gemini request failed: ${err.message}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new GeminiPlanError('Gemini returned a response that was not valid JSON. Try generating again.');
  }

  return validateAndNormalize(parsed);
}

// Rewrites a single post's text per a free-text instruction (the ✨ "rewrite with AI"
// feature on Queue/Calendar). Stateless — takes/returns plain text, no post ID, no DB
// access — so it works identically for a saved post, an unsaved edit-in-progress, or a
// not-yet-approved draft.
function validateRewriteResponse(parsed) {
  if (!parsed || typeof parsed.content !== 'string' || !parsed.content.trim()) {
    throw new GeminiPlanError('Gemini did not return usable text. Try again or reword your instruction.');
  }
  return parsed.content.trim().slice(0, MAX_POST_CHARS);
}

async function rewriteText(apiKey, { content, instruction }) {
  if (!apiKey) {
    throw new GeminiPlanError('No Gemini API key configured. Add one in Settings first.');
  }
  if (!content || !content.trim()) {
    throw new GeminiPlanError('Nothing to rewrite yet — write something first.');
  }
  if (!instruction || !instruction.trim()) {
    throw new GeminiPlanError('Describe what you want changed.');
  }

  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({
    model: MODEL_NAME,
    generationConfig: { responseMimeType: 'application/json' },
  });

  const prompt = `You are editing an existing LinkedIn post based on the author's instruction.

Original post:
"""
${content}
"""

Instruction: ${instruction}

Rewrite the post accordingly. Keep it ready-to-publish LinkedIn post text (no markdown, no surrounding quotes), under ${MAX_POST_CHARS} characters. Preserve the original intent/topic unless the instruction explicitly says otherwise.
Return ONLY JSON matching this shape: { "content": string }`;

  let text;
  try {
    const result = await model.generateContent(prompt);
    text = result.response.text();
  } catch (err) {
    throw new GeminiPlanError(`Gemini request failed: ${err.message}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new GeminiPlanError('Gemini returned a response that was not valid JSON. Try again.');
  }

  return validateRewriteResponse(parsed);
}

module.exports = {
  generateMonthlyContentPlan,
  rewriteText,
  GeminiPlanError,
  resolveApiKey: (settings) => settings.geminiApiKey || env.geminiApiKeyFallback || null,
};
