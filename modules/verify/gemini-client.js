// Panelize Verify — minimal Gemini API client (REST, generateContent).
//
// Follows the official REST reference:
//   POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent
//   header x-goog-api-key
// The key travels in a header, never in the URL, and never appears in
// errors or logs.

export const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const MODEL_ID_PATTERN = /^[a-z0-9][a-z0-9.-]{0,79}$/i;
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

export class GeminiApiError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {{ status?: number, retryable?: boolean }} [extra]
   */
  constructor(code, message, { status, retryable = false } = {}) {
    super(message);
    this.name = 'GeminiApiError';
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

export const ERROR_MESSAGES = {
  MISSING_API_KEY: 'No Gemini API key is configured. Add one in Verify settings.',
  INVALID_API_KEY: 'The Gemini API key was rejected. Check the key in Verify settings.',
  PERMISSION_DENIED: 'The API key may not use this model or Google Search grounding.',
  MODEL_NOT_FOUND: 'The configured Gemini model ID was not found. Pick another model in Verify settings.',
  QUOTA_EXCEEDED: 'Gemini quota or rate limit reached. Try again later.',
  TIMEOUT: 'The Gemini request timed out.',
  CANCELLED: 'The Gemini request was cancelled.',
  NETWORK_ERROR: 'Could not reach the Gemini API. Check the network connection.',
  SERVER_ERROR: 'The Gemini API returned a server error.',
  BAD_REQUEST: 'Gemini rejected the request.',
  BLOCKED: 'Gemini declined to answer (safety or policy block).',
  EMPTY_RESPONSE: 'Gemini returned an empty response.',
  INVALID_OUTPUT: 'Gemini returned output that failed validation.',
  SEARCH_UNAVAILABLE: 'Google Search grounding returned no evidence, so no claim could be verified.'
};

export function isValidModelId(model) {
  return typeof model === 'string' && MODEL_ID_PATTERN.test(model);
}

function scrub(text, apiKey) {
  let out = String(text || '');
  if (apiKey) {
    out = out.split(apiKey).join('[redacted]');
  }
  // Any other key-shaped token.
  return out.replace(/AIza[0-9A-Za-z_-]{20,}/g, '[redacted]').slice(0, 400);
}

function classifyHttpError(status, body, apiKey) {
  const apiMessage = scrub(body?.error?.message || '', apiKey);
  const reason = JSON.stringify(body?.error?.details || '');
  let code;
  if (status === 400 && /API_KEY_INVALID|API key not valid/i.test(`${apiMessage} ${reason}`)) {
    code = 'INVALID_API_KEY';
  } else if (status === 401) {
    code = 'INVALID_API_KEY';
  } else if (status === 403) {
    code = 'PERMISSION_DENIED';
  } else if (status === 404) {
    code = 'MODEL_NOT_FOUND';
  } else if (status === 429) {
    code = 'QUOTA_EXCEEDED';
  } else if (status >= 500) {
    code = 'SERVER_ERROR';
  } else {
    code = 'BAD_REQUEST';
  }
  const message = apiMessage ? `${ERROR_MESSAGES[code]} (${apiMessage})` : ERROR_MESSAGES[code];
  return new GeminiApiError(code, message, { status, retryable: RETRYABLE_STATUSES.has(status) });
}

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new GeminiApiError('CANCELLED', ERROR_MESSAGES.CANCELLED));
    }, { once: true });
  });
}

/** Removes ```json fences some models add around JSON output. */
export function stripJsonFence(text) {
  const trimmed = String(text || '').trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced ? fenced[1] : trimmed;
}

/**
 * @param {{ apiKey: string, model: string, timeoutMs?: number, maxRetries?: number,
 *   fetchImpl?: typeof fetch, retryBaseMs?: number }} options
 */
export function createGeminiClient({
  apiKey,
  model,
  timeoutMs = 90000,
  maxRetries = 2,
  fetchImpl = globalThis.fetch?.bind(globalThis),
  retryBaseMs = 1000
}) {
  if (!apiKey) {
    throw new GeminiApiError('MISSING_API_KEY', ERROR_MESSAGES.MISSING_API_KEY);
  }
  if (!isValidModelId(model)) {
    throw new GeminiApiError('MODEL_NOT_FOUND', ERROR_MESSAGES.MODEL_NOT_FOUND);
  }

  async function requestOnce(url, init, signal) {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const response = await fetchImpl(url, { ...init, signal: controller.signal });
      let body = null;
      try {
        body = await response.json();
      } catch {
        body = null;
      }
      if (!response.ok) {
        throw classifyHttpError(response.status, body, apiKey);
      }
      return body;
    } catch (error) {
      if (error instanceof GeminiApiError) throw error;
      if (error?.name === 'AbortError' || controller.signal.aborted) {
        throw timedOut
          ? new GeminiApiError('TIMEOUT', ERROR_MESSAGES.TIMEOUT, { retryable: true })
          : new GeminiApiError('CANCELLED', ERROR_MESSAGES.CANCELLED);
      }
      throw new GeminiApiError('NETWORK_ERROR', ERROR_MESSAGES.NETWORK_ERROR, { retryable: true });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  async function request(path, init, signal) {
    const url = `${GEMINI_API_BASE}/${path}`;
    let attempt = 0;
    for (;;) {
      try {
        return await requestOnce(url, init, signal);
      } catch (error) {
        const canRetry = error.retryable && error.code !== 'TIMEOUT' && attempt < maxRetries
          && !signal?.aborted;
        if (!canRetry) throw error;
        attempt += 1;
        await delay(retryBaseMs * 2 ** (attempt - 1), signal);
      }
    }
  }

  const headers = {
    'Content-Type': 'application/json',
    'x-goog-api-key': apiKey
  };

  /**
   * @param {{ systemInstruction: string, userText: string, useSearch?: boolean,
   *   json?: boolean, signal?: AbortSignal }} input
   */
  async function generate({ systemInstruction, userText, useSearch = false, json = false, signal }) {
    const body = {
      systemInstruction: { parts: [{ text: systemInstruction }] },
      contents: [{ role: 'user', parts: [{ text: userText }] }]
    };
    if (useSearch) {
      body.tools = [{ googleSearch: {} }];
    }
    if (json) {
      body.generationConfig = { responseMimeType: 'application/json' };
    }
    const result = await request(
      `models/${encodeURIComponent(model)}:generateContent`,
      { method: 'POST', headers, body: JSON.stringify(body) },
      signal
    );
    if (result?.promptFeedback?.blockReason) {
      throw new GeminiApiError('BLOCKED', ERROR_MESSAGES.BLOCKED);
    }
    const candidate = result?.candidates?.[0];
    if (!candidate) {
      throw new GeminiApiError('EMPTY_RESPONSE', ERROR_MESSAGES.EMPTY_RESPONSE);
    }
    if (['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII'].includes(candidate.finishReason)) {
      throw new GeminiApiError('BLOCKED', ERROR_MESSAGES.BLOCKED);
    }
    const parts = (candidate.content?.parts || [])
      .map(part => (typeof part?.text === 'string' && !part.thought ? part.text : ''));
    const text = parts.join('');
    if (!text.trim()) {
      throw new GeminiApiError('EMPTY_RESPONSE', ERROR_MESSAGES.EMPTY_RESPONSE);
    }
    return { text, parts, candidate, usage: result.usageMetadata || null, modelVersion: result.modelVersion };
  }

  /**
   * Checks the key and model with a metadata call (no generation cost).
   * @param {{ signal?: AbortSignal }} [options]
   */
  async function checkModel({ signal } = {}) {
    return request(`models/${encodeURIComponent(model)}`, { method: 'GET', headers }, signal);
  }

  return { generate, checkModel, model };
}
