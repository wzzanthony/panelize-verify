// Panelize Verify — CompletionDetector.
//
// Decides from repeated extractor polls whether a panel's reply to the
// prompt just sent is complete. A reply counts as complete when:
//   1. it belongs to a user turn newer than the one seen before sending,
//   2. that user turn matches the prompt (when the prompt is known),
//   3. the provider shows no "stop generating" control, and
//   4. the text has not changed for `stableMs`.
// Streaming partials and the previous turn's answer therefore never pass.

export const DEFAULT_STABLE_MS = 2500;
export const PROMPT_KEY_LENGTH = 40;

export function normalizeForMatch(text) {
  return String(text || '')
    .normalize('NFKC')
    .replace(/\s+/g, '')
    .toLowerCase();
}

/**
 * Providers may render the prompt with extra markup or truncate it, so the
 * check compares a normalized prefix in either direction.
 */
export function promptMatchesUserTurn(prompt, userText) {
  const promptKey = normalizeForMatch(prompt).slice(0, PROMPT_KEY_LENGTH);
  const user = normalizeForMatch(userText);
  if (!promptKey) return true;
  if (!user) return false;
  return user.includes(promptKey) || promptKey.startsWith(user.slice(0, PROMPT_KEY_LENGTH));
}

/**
 * @param {{ prompt?: string, baseline?: object | null, stableMs?: number }} options
 */
export function createCompletionDetector({ prompt = '', baseline = null, stableMs = DEFAULT_STABLE_MS } = {}) {
  let lastHash = null;
  let lastChangeAt = 0;
  /** @type {any} */
  let completed = null;

  function isNewTurn(state) {
    if (!baseline || baseline.supported === false) {
      // No baseline: rely on the prompt match alone.
      return Boolean(prompt) && promptMatchesUserTurn(prompt, state.lastUserText);
    }
    return state.userTurnCount > (baseline.userTurnCount || 0)
      || state.lastUserHash !== baseline.lastUserHash;
  }

  /**
   * @param {object} state Answer state from the extractor.
   * @param {number} now Milliseconds.
   * @returns {{ phase: 'unsupported' | 'error' | 'waiting' | 'generating' | 'stabilizing' | 'complete' | 'mismatch', text?: string }}
   */
  function update(state, now) {
    if (completed) {
      return completed;
    }
    if (!state || state.supported === false) {
      return { phase: 'unsupported' };
    }
    if (state.error) {
      return { phase: 'error' };
    }
    if (!isNewTurn(state)) {
      return { phase: 'waiting' };
    }
    if (prompt && !promptMatchesUserTurn(prompt, state.lastUserText)) {
      return { phase: 'mismatch' };
    }
    if (!state.hasAnswer) {
      return { phase: state.generating ? 'generating' : 'waiting' };
    }
    if (state.textHash !== lastHash) {
      lastHash = state.textHash;
      lastChangeAt = now;
    }
    if (state.generating) {
      return { phase: 'generating', text: state.text };
    }
    if (now - lastChangeAt < stableMs) {
      return { phase: 'stabilizing', text: state.text };
    }
    completed = { phase: 'complete', text: state.text };
    return completed;
  }

  return { update };
}
