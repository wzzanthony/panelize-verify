// Panelize Verify — drives the Gemini verifier panel in web mode.
//
// The frame is the gemini.google.com panel shown in the Verify area below
// the answer panels. It is an ordinary Panelize provider frame (same content
// scripts, same header rules, same postMessage contract), so it uses the
// user's own Gemini login and nothing is billed. Each run reloads it into a
// fresh chat. The Verify dock keeps it covered until the user has voted, so
// Gemini's reply is never seen first.

import { createCompletionDetector } from '../modules/verify/completion-detector.js';
import { GeminiApiError } from '../modules/verify/gemini-client.js';

export const GEMINI_WEB_URL = 'https://gemini.google.com/app';
export const GEMINI_WEB_ORIGIN = 'https://gemini.google.com';
export const JUDGE_PANEL_ID = 'panelize-verify-judge';
const TEMP_CHAT_ENABLED = 'PANELIZE_TEMP_CHAT_ENABLED';

export const WEB_ERROR_MESSAGES = {
  WEB_NOT_READY: 'The Gemini page did not load in the verifier panel. Check that gemini.google.com opens in this browser.',
  WEB_SEND_FAILED: 'Could not send the check to Gemini. Make sure you are signed in at gemini.google.com, then retry.',
  WEB_UNSUPPORTED: 'The Gemini page could not be read. Its layout may have changed.',
  TIMEOUT: 'Gemini did not finish answering in time.',
  CANCELLED: 'The verification was cancelled.'
};

function loadOnce(iframe, url, timeoutMs) {
  return new Promise(resolve => {
    const done = () => {
      clearTimeout(timer);
      iframe.removeEventListener('load', done);
      resolve();
    };
    const timer = setTimeout(done, timeoutMs);
    iframe.addEventListener('load', done);
    iframe.src = url;
  });
}

/**
 * Navigates the frame and resolves once the new document has loaded. A frame
 * that already has a page (possibly still loading) goes through about:blank
 * first, so a late load event from that page is never taken for the new one.
 */
async function defaultNavigate(iframe, url, timeoutMs) {
  if (iframe.getAttribute('src')) {
    await loadOnce(iframe, 'about:blank', 5000);
  }
  await loadOnce(iframe, url, timeoutMs);
}

function webError(code) {
  return new GeminiApiError(code, WEB_ERROR_MESSAGES[code]);
}

/**
 * @param {{
 *   getFrame: () => any,
 *   navigate?: (iframe: any, url: string, timeoutMs: number) => Promise<void>,
 *   postToFrame: (panel: any, message: object) => void,
 *   requestState: (panel: any) => Promise<any>,
 *   win?: Window,
 *   url?: string,
 *   now?: () => number,
 *   sleep?: (ms: number) => Promise<void>,
 *   pollMs?: number,
 *   stableMs?: number,
 *   readyTimeoutMs?: number,
 *   resendAfterMs?: number,
 *   tempChatWaitMs?: number,
 *   timeoutMs?: number
 * }} options
 */
export function createWebJudgeRunner({
  getFrame,
  navigate = defaultNavigate,
  postToFrame,
  requestState,
  win = window,
  url = GEMINI_WEB_URL,
  now = () => Date.now(),
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  pollMs = 1500,
  stableMs = 4000,
  readyTimeoutMs = 45000,
  resendAfterMs = 20000,
  tempChatWaitMs = 6000,
  timeoutMs = 300000
}) {
  let running = false;
  /** Frames that already received a check (their page is no longer a fresh chat). */
  const usedFrames = new WeakSet();

  /** The verifier frame as a panel-like object, or null when it is not on the page. */
  function currentPanel() {
    const iframe = getFrame();
    return iframe ? { id: JUDGE_PANEL_ID, providerId: 'gemini', iframe } : null;
  }

  /** @type {any} */
  let panel = null;

  function frameDocument() {
    return panel?.iframe?.ownerDocument || document;
  }

  /**
   * Gets the frame onto a fresh Gemini chat. A page that was loaded on the
   * Gemini URL and never used for a check is used as it is; reloading a page
   * that is still loading can end on Chrome's error page.
   */
  async function openFrame(signal) {
    panel = currentPanel();
    if (!panel) throw webError('WEB_NOT_READY');
    const fresh = !usedFrames.has(panel.iframe) && panel.iframe.getAttribute('src') === url;
    if (!fresh) await navigate(panel.iframe, url, readyTimeoutMs);
    try {
      return await waitForReady(signal);
    } catch (error) {
      if (error?.code !== 'WEB_NOT_READY') throw error;
      // One more try from a clean load (e.g. the page ended on an error page).
      await navigate(panel.iframe, url, readyTimeoutMs);
      return waitForReady(signal);
    }
  }

  function checkAbort(signal) {
    if (signal?.aborted) throw webError('CANCELLED');
  }

  async function waitForReady(signal) {
    const deadline = now() + readyTimeoutMs;
    while (now() < deadline) {
      checkAbort(signal);
      const state = await requestState(panel);
      if (state && state.supported !== false) return state;
      if (state && state.supported === false) throw webError('WEB_UNSUPPORTED');
      await sleep(1000);
    }
    throw webError('WEB_NOT_READY');
  }

  /** Asks Panelize's content script to switch on Gemini's temporary chat. */
  async function enableTemporaryChat(signal) {
    let confirmed = false;
    const listener = event => {
      if (event.source === panel?.iframe?.contentWindow && event.origin === GEMINI_WEB_ORIGIN
        && event.data?.type === TEMP_CHAT_ENABLED && event.data?.provider === 'gemini') {
        confirmed = true;
      }
    };
    win.addEventListener('message', listener);
    try {
      const deadline = now() + tempChatWaitMs;
      let attempts = 0;
      while (!confirmed && now() < deadline) {
        checkAbort(signal);
        if (attempts < 3) {
          postToFrame(panel, { type: 'ENABLE_TEMP_CHAT', providerMode: null, context: 'multi-panel' });
          attempts += 1;
        }
        await sleep(1500);
      }
    } finally {
      win.removeEventListener('message', listener);
    }
    return confirmed;
  }

  /** Injection may focus Gemini's composer; give focus back to the user. */
  function guardFocus() {
    const doc = frameDocument();
    const previous = doc.activeElement;
    const restore = () => {
      if (panel && doc.activeElement === panel.iframe && previous && previous !== doc.body && previous.isConnected) {
        /** @type {HTMLElement} */ (previous).focus({ preventScroll: true });
      }
    };
    [200, 800, 2000].forEach(ms => setTimeout(restore, ms));
  }

  function send(text) {
    guardFocus();
    postToFrame(panel, { type: 'INJECT_TEXT', text, images: [], autoSubmit: true, providerMode: null, context: 'multi-panel' });
  }

  /**
   * @param {string} text Message for Gemini.
   * @param {{ signal?: AbortSignal, onProgress?: (step: string) => void }} [options]
   * @returns {Promise<{ text: string, links: string[], temporaryChat: boolean }>}
   */
  async function run(text, { signal, onProgress = () => {} } = {}) {
    if (running) throw new GeminiApiError('BUSY', 'A web verification is already running.');
    running = true;
    try {
      onProgress('opening');
      await openFrame(signal);
      const temporaryChat = await enableTemporaryChat(signal);
      if (temporaryChat) {
        await sleep(1500); // let Gemini switch to the temporary chat view
      }
      const baseline = await waitForReady(signal);

      onProgress('sending');
      usedFrames.add(panel.iframe);
      send(text);
      let lastSentAt = now();
      const deadline = lastSentAt + timeoutMs;
      const detector = createCompletionDetector({ prompt: text, baseline, stableMs });
      let resent = false;
      while (now() < deadline) {
        await sleep(pollMs);
        checkAbort(signal);
        const state = await requestState(panel);
        if (!state) continue;
        const result = detector.update(state, now());
        if (result.phase === 'complete') {
          return { text: result.text || state.text, links: Array.isArray(state.links) ? state.links : [], temporaryChat };
        }
        if (result.phase === 'unsupported') throw webError('WEB_UNSUPPORTED');
        if (result.phase === 'generating' || result.phase === 'stabilizing') {
          onProgress('waiting');
        } else if (result.phase === 'waiting' && state.userTurnCount <= (baseline.userTurnCount || 0)
          && now() - lastSentAt >= resendAfterMs) {
          // Nothing was submitted (composer not ready, or signed out).
          if (resent) throw webError('WEB_SEND_FAILED');
          resent = true;
          lastSentAt = now();
          send(text);
        }
      }
      throw webError('TIMEOUT');
    } finally {
      running = false;
    }
  }

  return {
    run,
    isRunning: () => running,
    /** The verifier frame as a panel-like object (for message source checks). */
    getPanel: currentPanel
  };
}
