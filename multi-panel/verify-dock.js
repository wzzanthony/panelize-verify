// Panelize Verify — the Verify dock in the Multi-Panel page.
//
// Layout: a slim status bar under the panels (build number, A / B capture
// state, Gemini's state, the covered Gemini page as a thumbnail) and the
// Verify window (answers, vote, results). The window opens on request as a
// separate browser window the user can drag anywhere, e.g. onto a second
// screen, or, if the browser blocks that, as a draggable box in the page.
// Verification runs in the background and the bar says when it is done.
//
// Flow per prompt: capture both answers -> human vote (A / B / Tie / Skip)
// -> reveal Gemini's fact check and blind verdict. Gemini may run in the
// background, but nothing that hints at its A/B preference is rendered until
// the vote is saved. All model and web text is rendered with textContent.

import {
  createSession,
  submitVote,
  addPostRevealFeedback,
  canRevealGemini,
  isVoteLocked,
  markVerificationRunning,
  markVerificationDone,
  markVerificationError,
  normalizeRestoredSession
} from '../modules/verify/session-state.js';
import { createCompletionDetector, promptMatchesUserTurn } from '../modules/verify/completion-detector.js';
import { compareJudgements, AGREEMENT_LABELS, computeAgreementStats } from '../modules/verify/agreement.js';
import { createGeminiClient } from '../modules/verify/gemini-client.js';
import { createGeminiVerificationService } from '../modules/verify/verification-service.js';
import { createWebVerificationService } from '../modules/verify/web-judge.js';
import { createWebJudgeRunner, GEMINI_WEB_URL } from './verify-web-runner.js';
import { DEFAULT_ACCEPTANCE_TEMPLATE } from '../modules/verify/acceptance-template.js';
import {
  loadVerifySettings,
  saveVerifySettings,
  exportSessionsJson,
  SUGGESTED_MODELS
} from '../modules/verify/storage.js';
import { sanitizeEvidenceUrl } from '../modules/verify/grounding.js';

export const EXTRACT_REQUEST = 'PANELIZE_VERIFY_EXTRACT';
export const ANSWER_STATE = 'PANELIZE_VERIFY_ANSWER_STATE';
const POLL_INTERVAL_MS = 1500;
const CAPTURE_TIMEOUT_MS = 10 * 60 * 1000;
const STATE_REQUEST_TIMEOUT_MS = 2500;

const STATUS_LABELS = {
  SUPPORTED: 'Supported',
  CONTRADICTED: 'Contradicted',
  INSUFFICIENT_EVIDENCE: 'Insufficient evidence',
  NOT_VERIFIABLE: 'Not verifiable'
};
const STATUS_ORDER = ['CONTRADICTED', 'SUPPORTED', 'INSUFFICIENT_EVIDENCE', 'NOT_VERIFIABLE'];
const PREFERENCE_LABELS = { A: 'Answer A', B: 'Answer B', TIE: 'Tie', SKIPPED: 'Skipped', UNCERTAIN: 'Uncertain' };
const PHASE_LABELS = {
  idle: 'idle',
  waiting: 'waiting for reply',
  generating: 'generating…',
  stabilizing: 'finishing…',
  complete: 'captured',
  mismatch: 'latest turn does not match the prompt',
  unsupported: 'capture not supported — paste manually',
  error: 'capture error',
  timeout: 'timed out',
  'no-frame': 'panel not loaded'
};
// Short labels for the status bar.
const BAR_PHASE_LABELS = {
  idle: '空闲',
  waiting: '等待回答',
  generating: '生成中…',
  stabilizing: '即将完成…',
  complete: '已抓取',
  mismatch: '最新提问与发送的问题不一致',
  unsupported: '不支持自动抓取',
  error: '抓取出错',
  timeout: '抓取超时',
  'no-frame': '面板未响应'
};
const PROGRESS_LABELS = {
  opening: 'Opening a fresh Gemini chat…',
  sending: 'Sending the check to Gemini…',
  waiting: 'Gemini is searching and checking claims…',
  parsing: 'Reading Gemini\'s reply…',
  extracting: 'Extracting factual claims…',
  verifying: 'Searching Google and checking claims…',
  judging: 'Comparing the anonymous answers…'
};

// ===== DOM helpers =====
// Icons must be in the bundled Material Symbols subset
// (libs/material-symbols/font-source.json).

/**
 * @param {string} tag
 * @param {Record<string, any>} [attrs]
 * @param {any} [children]
 * @returns {any} The element; typed loosely so form fields need no casts.
 */
function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
    else if (value === true) node.setAttribute(key, '');
    else node.setAttribute(key, String(value));
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

function icon(name) {
  return el('span', { class: 'material-symbols-outlined', 'aria-hidden': 'true', text: name });
}

function formatTime(iso) {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function safeLink(url, text) {
  const href = sanitizeEvidenceUrl(url);
  if (!href) return el('span', { text: text || 'invalid link' });
  return el('a', { href, target: '_blank', rel: 'noopener noreferrer', text: text || href });
}

/**
 * @param {{
 *   root: HTMLElement,
 *   toggleButton?: HTMLElement | null,
 *   getPanels: () => any[],
 *   postToPanelFrame: (panel: any, message: object) => void,
 *   findMessageSourcePanel: (panels: any[], event: MessageEvent) => any,
 *   getProviderName: (providerId: string) => string,
 *   store: ReturnType<typeof import('../modules/verify/storage.js').createMemoryStore>,
 *   settingsStorage?: any,
 *   createService?: (settings: object, apiKey: string) => { evaluate: Function },
 *   createWebService?: (settings: object, runner: any) => { evaluate: Function },
 *   createWebRunner?: (getFrame: () => any, settings: object) => any,
 *   judgePane?: HTMLElement | null,
 *   bar?: HTMLElement | null,
 *   openWindow?: (url: string, name: string, features: string) => any,
 *   windowUrl?: string,
 *   createJudgeFrame?: (doc: Document, load: boolean) => any,
 *   removePanels?: (panelIds: string[]) => void,
 *   showToast?: (message: string) => void,
 *   confirm?: (message: string) => boolean,
 *   now?: () => number,
 *   schedule?: (fn: () => void, ms: number) => any,
 *   cancelSchedule?: (handle: any) => void
 * }} options
 */
export function createVerifyDock(options) {
  const {
    root,
    toggleButton = null,
    getPanels,
    postToPanelFrame,
    findMessageSourcePanel,
    getProviderName,
    store,
    settingsStorage,
    showToast = () => {},
    confirm = message => (root.ownerDocument?.defaultView || window).confirm(message),
    now = () => Date.now(),
    schedule = (fn, ms) => setTimeout(fn, ms),
    cancelSchedule = handle => clearTimeout(handle),
    judgePane = null,
    bar = null,
    openWindow = (url, name, features) => window.open(url, name, features),
    windowUrl = globalThis.chrome?.runtime?.getURL?.('multi-panel/verify-window.html') || 'verify-window.html',
    removePanels = null,
    createJudgeFrame = (doc, load) => {
      const iframe = doc.createElement('iframe');
      iframe.title = 'Gemini verifier';
      iframe.setAttribute('allow', 'clipboard-write');
      if (load) iframe.src = GEMINI_WEB_URL;
      return iframe;
    }
  } = options;
  const createService = options.createService || ((settings, apiKey) => createGeminiVerificationService({
    client: createGeminiClient({ apiKey, model: settings.model, timeoutMs: settings.timeoutMs })
  }));
  const createWebService = options.createWebService
    || ((current, runner) => createWebVerificationService({ runner, template: current.webTemplate }));
  const createWebRunner = options.createWebRunner || ((getFrame, current) => createWebJudgeRunner({
    getFrame,
    postToFrame: postToPanelFrame,
    requestState,
    timeoutMs: current.webTimeoutMs
  }));

  /** @type {Map<string, any>} */
  const sessions = new Map();
  const saveChains = new Map();
  const runners = new Map();
  const progress = new Map();
  const pendingStateRequests = new Map();
  let requestCounter = 0;
  let currentSessionId = null;
  let capture = null;
  let pollHandle = null;
  let settings = null;
  let hasApiKey = false;
  /** Where the Verify window is: 'closed', 'float' (in the page) or 'popup'. */
  let windowMode = 'closed';
  let popupWin = null;
  let popupWatch = null;
  /** The home of `root` in this page while it is not in the popup. */
  let rootHome = null;
  /** Something new for the user: 'answers' (vote now) or 'verified'. */
  let attention = null;
  let judgeOpen = false;
  let lastPrompt = '';
  let draftChoice = null;
  let draftReason = '';
  let errorMessage = '';
  let destroyed = false;
  let webRunner = null;
  let webRunSessionId = null;
  /** Session whose check is in (or was last run in) the Gemini verifier panel. */
  let judgedSessionId = null;
  /** @type {any} */
  let judgeFrame = null;
  /** @type {Record<string, HTMLElement>} */
  let paneParts = {};

  // ===== Persistence =====

  function getCurrent() {
    return currentSessionId ? sessions.get(currentSessionId) || null : null;
  }

  /** Applies `change` to the latest copy of a session and saves it in order. */
  function updateSession(id, change) {
    const previous = saveChains.get(id) || Promise.resolve();
    const next = previous.catch(() => {}).then(async () => {
      const latest = sessions.get(id);
      if (!latest) throw new Error('Session not found');
      const updated = change(latest);
      await store.saveSession(updated);
      sessions.set(id, updated);
      return updated;
    });
    saveChains.set(id, next);
    return next.finally(() => render());
  }

  // ===== Frame messaging =====

  function handleMessage(event) {
    const data = event?.data;
    if (!data || typeof data !== 'object' || data.type !== ANSWER_STATE || data.context !== 'panelize-verify') {
      return;
    }
    const panel = findMessageSourcePanel(allFrames(), event);
    if (!panel || data.provider !== panel.providerId) return;
    const pending = pendingStateRequests.get(data.requestId);
    if (!pending || pending.panelId !== panel.id) return;
    pendingStateRequests.delete(data.requestId);
    pending.resolve(data);
  }

  function requestState(panel) {
    if (!panel?.iframe?.contentWindow) return Promise.resolve(null);
    requestCounter += 1;
    const requestId = `pv-${now().toString(36)}-${requestCounter}`;
    return new Promise(resolve => {
      const timer = schedule(() => {
        pendingStateRequests.delete(requestId);
        resolve(null);
      }, STATE_REQUEST_TIMEOUT_MS);
      pendingStateRequests.set(requestId, {
        panelId: panel.id,
        resolve: value => {
          cancelSchedule(timer);
          resolve(value);
        }
      });
      postToPanelFrame(panel, { type: EXTRACT_REQUEST, context: 'multi-panel', requestId });
    });
  }

  /** The answer panels plus the Gemini verifier frame. */
  function allFrames() {
    const judge = judgeFrame ? { id: 'panelize-verify-judge', providerId: 'gemini', iframe: judgeFrame } : null;
    return judge ? [...getPanels(), judge] : getPanels();
  }

  /**
   * In web mode Gemini is the verifier: when two other panels are open to be
   * compared, a Gemini panel in the grid neither receives Send All nor counts
   * as answer A or B. With fewer, Gemini stays an ordinary answer panel.
   */
  function isVerifierPanel(panel) {
    if (!isWebBackend() || panel?.providerId !== 'gemini') return false;
    return getPanels().filter(other => other?.providerId !== 'gemini').length >= 2;
  }

  function answerPanels() {
    return getPanels().filter(panel => !isVerifierPanel(panel));
  }

  function comparedPanels() {
    const panels = answerPanels();
    return panels.length >= 2 ? { A: panels[0], B: panels[1] } : null;
  }

  // ===== Capture =====

  function stopPolling() {
    if (pollHandle !== null) {
      cancelSchedule(pollHandle);
      pollHandle = null;
    }
  }

  /**
   * Called by broadcastMessage before the prompt is posted, so the baseline
   * reading reaches each frame ahead of the injected prompt.
   */
  function beforeBroadcast(text) {
    const pair = comparedPanels();
    if (!pair || !text?.trim()) return;
    stopPolling();
    attention = null;
    capture = {
      prompt: text,
      startedAt: now(),
      sent: false,
      sides: {
        A: { panelId: pair.A.id, providerId: pair.A.providerId, baseline: requestState(pair.A), phase: 'waiting', text: '' },
        B: { panelId: pair.B.id, providerId: pair.B.providerId, baseline: requestState(pair.B), phase: 'waiting', text: '' }
      }
    };
    render();
  }

  async function afterBroadcast(text, { sent }) {
    if (!capture || capture.prompt !== text) return;
    if (!sent) {
      capture = null;
      render();
      return;
    }
    lastPrompt = text;
    capture.sent = true;
    const active = capture;
    for (const side of Object.values(active.sides)) {
      const baseline = await side.baseline;
      side.detector = createCompletionDetector({ prompt: text, baseline });
    }
    if (capture === active) schedulePoll(0);
  }

  function schedulePoll(delayMs = POLL_INTERVAL_MS) {
    stopPolling();
    pollHandle = schedule(() => {
      pollHandle = null;
      void pollOnce();
    }, delayMs);
  }

  function findPanel(panelId) {
    return getPanels().find(panel => panel.id === panelId) || null;
  }

  async function pollOnce() {
    const active = capture;
    if (!active || destroyed) return;
    if (now() - active.startedAt > CAPTURE_TIMEOUT_MS) {
      Object.values(active.sides).forEach(side => {
        if (side.phase !== 'complete') side.phase = 'timeout';
      });
      render();
      return;
    }
    await Promise.all(Object.values(active.sides).map(async side => {
      if (side.phase === 'complete') return;
      const panel = findPanel(side.panelId);
      if (!panel || panel.providerId !== side.providerId) {
        side.phase = 'no-frame';
        return;
      }
      const state = await requestState(panel);
      if (!state) {
        side.phase = 'no-frame';
        return;
      }
      const result = side.detector.update(state, now());
      side.phase = result.phase;
      if (result.text) side.text = result.text;
      side.diag = describeState(state, await side.baseline);
    }));
    if (capture !== active) return;
    const { A, B } = active.sides;
    if (A.phase === 'complete' && B.phase === 'complete') {
      await completeCapture(active.prompt, A, B, 'auto');
      return;
    }
    render();
    // Stop once neither side can still change on its own; the user can then
    // capture or paste manually.
    const settled = ['unsupported', 'timeout', 'complete'];
    if (!(settled.includes(A.phase) && settled.includes(B.phase))) {
      schedulePoll();
    }
  }

  /** One line on what the extractor sees, to tell why a capture is stuck. */
  function describeState(state, baseline) {
    if (!state) return '面板没有回应抓取请求';
    if (state.supported === false) return '该网站不支持自动抓取';
    const turns = `提问轮数 ${baseline?.userTurnCount ?? '?'}→${state.userTurnCount ?? 0}`;
    const reply = state.hasAnswer ? `回答 ${String(state.text || '').length} 字` : '未找到回答';
    const busy = state.generating ? '页面显示仍在生成' : '页面显示已停止';
    const user = state.lastUserText ? '' : ' · 未找到提问';
    return `${turns} · ${reply} · ${busy}${user}`;
  }

  async function completeCapture(prompt, sideA, sideB, source) {
    stopPolling();
    capture = null;
    const timestamp = new Date(now()).toISOString();
    const record = side => ({
      model: side.providerId,
      modelName: getProviderName(side.providerId),
      content: side.text,
      completedAt: timestamp,
      source
    });
    let session;
    try {
      session = createSession({ prompt, answerA: record(sideA), answerB: record(sideB), now: () => new Date(now()) });
    } catch (error) {
      errorMessage = error.message;
      render();
      return;
    }
    sessions.set(session.id, session);
    currentSessionId = session.id;
    draftChoice = null;
    draftReason = '';
    errorMessage = '';
    try {
      await store.saveSession(session);
    } catch (error) {
      errorMessage = `Could not save the session locally: ${error.message}`;
    }
    attention = 'answers';
    render();
    if (shouldAutoVerify() && backendReady()) {
      showToast('两个回答已抓取，Gemini 正在后台验证。你可以先打开 Verify 投票。');
      void startVerification(session.id);
    } else {
      showToast('两个回答已抓取。打开 Verify 投票。');
    }
  }

  /** Reads both panels once, for replies the automatic capture missed. */
  async function captureNow() {
    const pair = comparedPanels();
    if (!pair) {
      showToast('Verify needs at least two panels.');
      return;
    }
    stopPolling();
    const [stateA, stateB] = await Promise.all([requestState(pair.A), requestState(pair.B)]);
    const problems = [];
    [['A', pair.A, stateA], ['B', pair.B, stateB]].forEach(([label, panel, state]) => {
      const name = getProviderName(panel.providerId);
      if (!state) problems.push(`${label} (${name}) did not respond`);
      else if (state.supported === false) problems.push(`${label} (${name}) is not supported for automatic capture`);
      else if (state.generating) problems.push(`${label} (${name}) is still generating`);
      else if (!state.hasAnswer) problems.push(`${label} (${name}) has no answer yet`);
    });
    if (problems.length > 0) {
      showToast(`Cannot capture: ${problems.join('; ')}. You can paste answers manually.`);
      return;
    }
    const prompt = lastPrompt && promptMatchesUserTurn(lastPrompt, stateA.lastUserText)
      ? lastPrompt
      : stateA.lastUserText;
    await completeCapture(
      prompt,
      { providerId: pair.A.providerId, text: stateA.text },
      { providerId: pair.B.providerId, text: stateB.text },
      'manual'
    );
  }

  // ===== Verification =====

  function isWebBackend() {
    return settings?.backend !== 'api';
  }

  function hasConsent() {
    return isWebBackend() ? Boolean(settings?.webConsentAcknowledged) : Boolean(settings?.consentAcknowledged);
  }

  /** Web mode always verifies (it is free); API mode only if the user chose so. */
  function shouldAutoVerify() {
    return isWebBackend() || Boolean(settings?.autoVerify);
  }

  /** Whether a verification can start without asking the user anything. */
  function backendReady() {
    return hasConsent() && (isWebBackend() || hasApiKey);
  }

  function ensureConsent() {
    if (hasConsent()) return true;
    // Web mode asks inline, in the Gemini section (see renderGeminiSection).
    if (isWebBackend()) {
      render();
      return false;
    }
    openSettings({ highlightConsent: true });
    return false;
  }

  /** The one-time web-mode consent, given from the inline prompt; then verify. */
  async function grantWebConsent(sessionId) {
    try {
      settings = await saveVerifySettings({ ...settings, backend: 'web', webConsentAcknowledged: true }, settingsStorage);
    } catch (error) {
      errorMessage = `Could not save the setting: ${error.message}`;
      render();
      return;
    }
    render();
    if (sessionId) void startVerification(sessionId);
  }

  // ===== Gemini verifier panel (web mode) =====

  function ensureJudgeFrame() {
    if (judgeFrame || !paneParts.body) return judgeFrame;
    // While a check is starting, the runner loads the page itself (once).
    judgeFrame = createJudgeFrame(paneParts.body.ownerDocument || document, !webRunSessionId);
    judgeFrame.classList.add('pv-judge-frame');
    paneParts.body.prepend(judgeFrame);
    return judgeFrame;
  }

  function buildJudgePane() {
    if (!judgePane || paneParts.body) return;
    paneParts.status = el('span', { class: 'pv-muted pv-judge-status' });
    paneParts.coverText = el('span', { class: 'pv-judge-cover-text' });
    paneParts.cover = el('div', { class: 'pv-judge-cover', role: 'status' }, [paneParts.coverText]);
    paneParts.peek = el('button', {
      type: 'button', class: 'pv-judge-peek', title: 'Show the Gemini page',
      onclick: () => { judgeOpen = true; updateJudgePane(); }
    }, [el('span', { text: '查看 Gemini 页面' })]);
    paneParts.close = el('button', {
      type: 'button', class: 'pv-btn pv-icon-only', 'aria-label': 'Close the Gemini page',
      onclick: () => { judgeOpen = false; updateJudgePane(); }
    }, [icon('close')]);
    paneParts.body = el('div', { class: 'pv-judge-body' }, [paneParts.cover, paneParts.peek]);
    judgePane.replaceChildren(
      el('div', { class: 'pv-judge-head' }, [el('strong', { text: 'Gemini 验证页面' }), paneParts.status, paneParts.close]),
      paneParts.body
    );
  }

  /** Whether Gemini's page must stay covered: a check is running or awaits the vote. */
  function judgeCovered() {
    if (webRunSessionId) return true;
    const judged = judgedSessionId ? sessions.get(judgedSessionId) : null;
    return Boolean(judged && !isVoteLocked(judged));
  }

  /**
   * The Gemini page sits at the end of the status bar as a small thumbnail
   * (kept rendered: Chrome throttles hidden cross-origin frames), covered
   * while a check runs or awaits the vote. Once uncovered it can be opened
   * as a large overlay; only CSS changes, so the page never reloads.
   */
  function updateJudgePane() {
    if (!judgePane) return;
    const visible = isWebBackend();
    judgePane.hidden = !visible;
    if (!visible) return;
    buildJudgePane();
    // Gemini's page is created only for a check (the runner asks for it),
    // never just because the multi-panel page opened.
    if (judgedSessionId) ensureJudgeFrame();
    const running = Boolean(webRunSessionId);
    const covered = judgeCovered() || !judgeFrame;
    if (covered) judgeOpen = false;
    judgePane.classList.toggle('pv-judge-open', judgeOpen);
    paneParts.cover.hidden = !covered;
    paneParts.peek.hidden = covered || judgeOpen;
    paneParts.close.hidden = !judgeOpen;
    const failed = sessions.get(judgedSessionId)?.verification?.status === 'error';
    paneParts.coverText.textContent = !judgeFrame
      ? 'Gemini 待命 · 验证时在这里打开'
      : running ? 'Gemini 验证中…'
        : failed ? 'Gemini 验证失败' : judgeCovered() ? 'Gemini 已完成 · 投票后可看' : 'Gemini';
    paneParts.status.textContent = running ? ' · checking' : covered ? ' · waiting for your vote' : ' · gemini.google.com';
    judgePane.title = covered ? 'Gemini 的页面在你投票前保持遮挡' : '';
  }

  function getWebRunner() {
    if (!webRunner) webRunner = createWebRunner(ensureJudgeFrame, settings);
    return webRunner;
  }

  async function startVerification(sessionId, { force = false } = {}) {
    const session = sessions.get(sessionId);
    if (!session) return;
    if (runners.has(sessionId)) return; // already running: never double-bill
    if (session.verification?.status === 'done' && !force) return;
    if (!ensureConsent()) return;
    const web = isWebBackend();
    if (web && webRunSessionId) {
      showToast('Gemini web is still checking another comparison. Try again when it finishes.');
      return;
    }
    // Claim the slot before the first await so a second click cannot start
    // a parallel (double-billed) run.
    const controller = new AbortController();
    runners.set(sessionId, controller);
    let apiKey = '';
    if (web) {
      webRunSessionId = sessionId;
      judgedSessionId = sessionId;
      judgeOpen = false;
      render();
    } else {
      apiKey = await store.getApiKey().catch(() => '');
      if (!apiKey) {
        runners.delete(sessionId);
        hasApiKey = false;
        openSettings({ highlightKey: true });
        return;
      }
    }
    progress.set(sessionId, web ? 'opening' : 'extracting');
    try {
      await updateSession(sessionId, latest => markVerificationRunning(latest, { now: () => new Date(now()) }));
      const service = web ? createWebService(settings, getWebRunner()) : createService(settings, apiKey);
      const evaluation = await service.evaluate(sessions.get(sessionId), {
        maxClaimsPerAnswer: settings.maxClaimsPerAnswer,
        maxAnswerChars: settings.maxAnswerChars,
        redactModelNames: settings.redactModelNames,
        signal: controller.signal,
        onProgress: step => {
          progress.set(sessionId, step);
          render();
        }
      });
      const done = await updateSession(sessionId, latest => markVerificationDone(latest, evaluation, { now: () => new Date(now()) }));
      if (done && !isVoteLocked(done)) {
        attention = 'verified';
        showToast('Gemini 验证完成。打开 Verify，投票后查看结果。');
      }
    } catch (error) {
      const failed = await updateSession(sessionId, latest => markVerificationError(latest, error, { now: () => new Date(now()) }))
        .catch(() => null);
      if (failed && error?.code !== 'CANCELLED') showToast('Gemini 验证失败，详情见 Verify 窗口。');
    } finally {
      runners.delete(sessionId);
      progress.delete(sessionId);
      if (webRunSessionId === sessionId) webRunSessionId = null;
      render();
    }
  }

  function cancelVerification(sessionId) {
    runners.get(sessionId)?.abort();
  }

  // ===== Voting =====

  async function submitHumanVote(preference) {
    const session = getCurrent();
    if (!session || isVoteLocked(session)) return;
    try {
      // The reveal happens in render() only after the save has succeeded.
      await updateSession(session.id, latest => submitVote(latest, preference, {
        explanation: draftReason,
        now: () => new Date(now())
      }));
      errorMessage = '';
      attention = null;
      render();
    } catch (error) {
      errorMessage = `Vote not saved: ${error.message}`;
      render();
    }
  }

  async function submitFeedback(preference, explanation) {
    const session = getCurrent();
    if (!session) return;
    try {
      await updateSession(session.id, latest => addPostRevealFeedback(latest, preference, {
        explanation,
        now: () => new Date(now())
      }));
    } catch (error) {
      errorMessage = error.message;
      render();
    }
  }

  // ===== Rendering =====

  // ----- Verify window: a separate browser window, or a box in the page -----

  function isWindowOpen() {
    return windowMode !== 'closed';
  }

  function syncToolbar() {
    toggleButton?.classList.toggle('active', isWindowOpen());
    toggleButton?.setAttribute('aria-pressed', String(isWindowOpen()));
    toggleButton?.classList.toggle('pv-attention', Boolean(attention));
  }

  /** In-page fallback: a draggable, resizable box. */
  function showFloat() {
    if (rootHome && root.parentElement !== rootHome) rootHome.append(root);
    windowMode = 'float';
    root.classList.remove('pv-popup');
    root.classList.add('pv-float');
    root.hidden = false;
    attention = null;
    render();
  }

  /**
   * Opens the Verify window as its own browser window (drag it to another
   * screen). It shows this page's own Verify view: same-origin extension
   * pages can share DOM, so nothing is copied or sent anywhere.
   */
  function openVerify() {
    if (windowMode === 'popup' && popupWin && !popupWin.closed) {
      popupWin.focus?.();
      return;
    }
    let win = null;
    try {
      win = openWindow(windowUrl, 'panelize-verify', 'popup=yes,width=560,height=860');
    } catch {
      win = null;
    }
    if (!win) {
      showFloat();
      return;
    }
    popupWin = win;
    windowMode = 'popup';
    attention = null;
    root.classList.remove('pv-float');
    waitForPopup(win, 0);
    render();
  }

  function waitForPopup(win, tries) {
    if (popupWin !== win || destroyed) return;
    let host = null;
    try {
      const doc = win.closed ? null : win.document;
      // The window starts on about:blank; wait for our page's host element.
      host = doc && doc.readyState !== 'loading' ? doc.getElementById('pv-window-host') : null;
    } catch {
      host = null;
    }
    if (host) {
      mountInPopup(win, host);
      return;
    }
    if (win.closed || tries >= 100) {
      popupClosed();
      if (!win.closed) {
        try { win.close(); } catch { /* ignore */ }
        showFloat();
      }
      return;
    }
    schedule(() => waitForPopup(win, tries + 1), 100);
  }

  function mountInPopup(win, host) {
    const theme = document.documentElement.getAttribute('data-theme');
    if (theme) host.ownerDocument.documentElement.setAttribute('data-theme', theme);
    host.append(root);
    root.classList.add('pv-popup');
    root.hidden = false;
    const check = () => {
      if (popupWin !== win) return;
      if (win.closed) {
        popupClosed();
        return;
      }
      popupWatch = schedule(check, 1000);
    };
    popupWatch = schedule(check, 1000);
    render();
    win.focus?.();
  }

  function popupClosed() {
    if (popupWatch !== null) {
      cancelSchedule(popupWatch);
      popupWatch = null;
    }
    popupWin = null;
    root.classList.remove('pv-popup');
    if (rootHome) rootHome.append(root);
    root.hidden = true;
    windowMode = 'closed';
    render();
  }

  function closeVerify() {
    if (windowMode === 'popup') {
      const win = popupWin;
      popupClosed();
      try { win?.close(); } catch { /* ignore */ }
      return;
    }
    windowMode = 'closed';
    root.classList.remove('pv-float');
    root.hidden = true;
    render();
  }

  /** Kept for callers and tests: true shows the in-page window, false closes it. */
  function setExpanded(value) {
    if (value) {
      if (!isWindowOpen()) showFloat();
    } else {
      closeVerify();
    }
  }

  function startDrag(event) {
    if (windowMode !== 'float' || event.button !== 0) return;
    if (event.target?.closest?.('button, a, input, select, textarea')) return;
    const rect = root.getBoundingClientRect();
    const dx = event.clientX - rect.left;
    const dy = event.clientY - rect.top;
    const doc = root.ownerDocument || document;
    const view = doc.defaultView || window;
    const move = moveEvent => {
      const left = Math.min(Math.max(0, moveEvent.clientX - dx), Math.max(0, view.innerWidth - 120));
      const top = Math.min(Math.max(0, moveEvent.clientY - dy), Math.max(0, view.innerHeight - 40));
      root.style.left = `${left}px`;
      root.style.top = `${top}px`;
      root.style.right = 'auto';
      root.style.bottom = 'auto';
    };
    const up = () => {
      doc.removeEventListener('pointermove', move);
      doc.removeEventListener('pointerup', up);
    };
    doc.addEventListener('pointermove', move);
    doc.addEventListener('pointerup', up);
    event.preventDefault();
  }

  function sideStatus(label) {
    const pair = comparedPanels();
    const session = getCurrent();
    const side = capture?.sides?.[label];
    let name = '—';
    let phase = 'idle';
    if (side) {
      name = getProviderName(side.providerId);
      phase = side.phase;
    } else if (session) {
      const record = label === 'A' ? session.answerA : session.answerB;
      name = record.modelName || record.model;
      phase = 'complete';
    } else if (pair) {
      name = getProviderName(pair[label].providerId);
    }
    return { name, phase };
  }

  /** The installed build, e.g. "v2.2.4-verify.3", so a tester sees which code runs. */
  function buildLabel() {
    try {
      const manifest = globalThis.chrome?.runtime?.getManifest?.();
      const version = manifest?.version_name || manifest?.version;
      return version ? `v${version}` : '';
    } catch {
      return '';
    }
  }

  /** "Build 4" from version_name "2.2.4-verify.4": bumped on every update. */
  function buildBadge() {
    const label = buildLabel();
    if (!label) return null;
    const match = /verify\.(\d+)/.exec(label);
    return el('span', { class: 'pv-build', title: `Installed Panelize Verify ${label}`, text: match ? `Build ${match[1]}` : label });
  }

  function renderHeader() {
    const chips = ['A', 'B'].map(label => {
      const { name, phase } = sideStatus(label);
      return el('span', { class: `pv-chip pv-phase-${phase}`, title: capture?.sides?.[label]?.diag || '' }, [
        el('strong', { text: `${label} · ${name}` }), ` ${PHASE_LABELS[phase] || phase}`
      ]);
    });
    return el('div', { class: 'pv-header', onpointerdown: startDrag }, [
      el('strong', { class: 'pv-title', text: 'Verify' }),
      buildBadge(),
      el('div', { class: 'pv-chips' }, chips),
      el('div', { class: 'pv-header-actions' }, [
        el('button', { class: 'pv-btn', type: 'button', title: 'Read both panels now', onclick: () => void captureNow() },
          [icon('download'), 'Capture now']),
        el('button', { class: 'pv-btn', type: 'button', title: 'Enter answers by hand', onclick: openManualEntry },
          [icon('input'), 'Paste']),
        el('button', { class: 'pv-btn', type: 'button', title: 'Saved evaluations', onclick: () => void openHistory() },
          [icon('schedule'), 'History']),
        el('button', { class: 'pv-btn pv-icon-only', type: 'button', title: 'Verify settings', 'aria-label': 'Verify settings', onclick: () => openSettings() },
          [icon('settings')]),
        windowMode === 'float'
          ? el('button', { class: 'pv-btn pv-icon-only', type: 'button', title: 'Open as a separate window (you can drag it to another screen)', 'aria-label': 'Open as a separate window', onclick: () => openVerify() },
            [icon('open_in_new')])
          : null,
        el('button', { class: 'pv-btn pv-icon-only', type: 'button', title: 'Close', 'aria-label': 'Close Verify', onclick: () => closeVerify() },
          [icon('close')])
      ])
    ]);
  }

  function renderGeminiChip() {
    const session = getCurrent();
    let text = '待命';
    let state = 'idle';
    let action = null;
    const status = session?.verification?.status;
    if (!isWebBackend() && !hasApiKey) {
      text = 'API 模式未设置 Key';
      action = el('button', { type: 'button', class: 'pv-btn pv-mini', onclick: () => openSettings({ highlightKey: true }) }, '设置');
    } else if (isWebBackend() && !hasConsent()) {
      text = '首次使用需确认';
      state = 'attention';
      action = el('button', {
        type: 'button', class: 'pv-btn pv-primary pv-mini',
        title: '把问题和两个匿名回答发到你登录的 gemini.google.com 做验证（只需确认一次）',
        onclick: () => void grantWebConsent(session && status !== 'done' ? session.id : null)
      }, '允许 Gemini 验证');
    } else if (session && (runners.has(session.id) || status === 'running')) {
      text = '验证中…';
      state = 'busy';
    } else if (status === 'done') {
      text = isVoteLocked(session) ? '✓ 结果已揭晓' : '✓ 验证完成 · 投票后查看';
      state = 'done';
    } else if (status === 'error') {
      text = '验证失败';
      state = 'failed';
      action = el('button', { type: 'button', class: 'pv-btn pv-mini', onclick: () => void startVerification(session.id) }, '重试');
    } else if (capture?.sent) {
      text = '等待两个回答';
    } else if (session) {
      text = '未验证';
      action = el('button', { type: 'button', class: 'pv-btn pv-mini', onclick: () => void startVerification(session.id) }, '开始验证');
    }
    return el('span', { class: `pv-chip pv-gem pv-gem-${state}` }, [
      state === 'busy' ? el('span', { class: 'pv-spinner', 'aria-hidden': 'true' }) : null,
      el('strong', { text: 'Gemini' }), ` ${text}`, action ? ' ' : null, action
    ]);
  }

  /** The slim status bar under the panels. */
  function renderBar() {
    if (!bar) return;
    const sides = ['A', 'B'].map(label => {
      const { name, phase } = sideStatus(label);
      const diag = capture?.sides?.[label]?.diag;
      return el('span', { class: `pv-chip pv-phase-${phase}`, title: diag ? `${name}: ${diag}` : name }, [
        el('strong', { text: `${label} · ${name}` }), ` ${BAR_PHASE_LABELS[phase] || phase}`
      ]);
    });
    const capturing = Boolean(capture?.sent) && Object.values(capture.sides).some(side => side.phase !== 'complete');
    const verifierPanels = getPanels().filter(isVerifierPanel);
    const openLabel = attention === 'verified' ? '验证完成 · 打开' : attention === 'answers' ? '去投票' : '打开 Verify';
    bar.replaceChildren(...[
      el('strong', { class: 'pv-bar-title', text: 'Verify' }),
      buildBadge(),
      el('div', { class: 'pv-bar-chips' }, [...sides, renderGeminiChip()]),
      capturing ? el('span', { class: 'pv-bar-diag', text: ['A', 'B'].map(label => capture.sides[label].diag ? `${label}: ${capture.sides[label].diag}` : '').filter(Boolean).join('  |  ') }) : null,
      el('div', { class: 'pv-bar-actions' }, [
        capturing ? el('button', {
          type: 'button', class: 'pv-btn pv-mini',
          title: '两个回答都已生成完，但这里没有变化？点此直接读取两个面板',
          onclick: () => void captureNow()
        }, [icon('download'), '立即抓取']) : null,
        verifierPanels.length > 0 && removePanels ? el('button', {
          type: 'button', class: 'pv-btn pv-mini',
          title: '网格里的 Gemini 不参与回答，验证在后台进行',
          onclick: () => removePanels(verifierPanels.map(panel => panel.id))
        }, '移除网格中的 Gemini') : null,
        el('button', {
          type: 'button', class: `pv-btn pv-primary${attention ? ' pv-attention' : ''}`,
          title: '在单独的窗口中打开 Verify（可拖到分屏）',
          onclick: () => openVerify()
        }, [icon('open_in_new'), openLabel]),
        el('button', { class: 'pv-btn pv-icon-only', type: 'button', title: 'Verify settings', 'aria-label': 'Verify settings', onclick: () => openSettings() },
          [icon('settings')])
      ])
    ].filter(Boolean));
  }

  function renderAnswersSection(session) {
    const pair = comparedPanels();
    const notes = [];
    const verifierPanels = getPanels().filter(isVerifierPanel);
    if (!pair) notes.push('Verify compares two answer panels. Add a second panel to start.');
    else if (answerPanels().length > 2) notes.push('More than two answer panels are open: the first two are compared as A and B.');
    const extra = [];
    if (verifierPanels.length > 0) {
      extra.push(el('p', { class: 'pv-muted', text: 'The Gemini panel in the grid only verifies (in the background); it does not receive Send All. Remove it with the button in the Verify bar.' }));
    }
    if (!session) {
      return el('section', { class: 'pv-section pv-answers' }, [
        el('h3', { text: 'Answers' }),
        el('p', { class: 'pv-muted', text: capture?.sent
          ? 'Waiting for both replies to finish…'
          : 'Send a prompt with "Send All". Both replies are captured when they finish.' }),
        ...(capture?.sent ? ['A', 'B'].map(label => {
          const side = capture.sides[label];
          return el('p', { class: 'pv-muted pv-diag', text: `${label} · ${getProviderName(side.providerId)}: ${PHASE_LABELS[side.phase] || side.phase}${side.diag ? ` — ${side.diag}` : ''}` });
        }) : []),
        capture?.sent ? el('p', { class: 'pv-muted', text: 'If both replies are finished but this does not change, use "Capture now".' }) : null,
        ...notes.map(note => el('p', { class: 'pv-note', text: note })),
        ...extra
      ]);
    }
    const answer = (label, record) => el('details', { class: 'pv-answer' }, [
      el('summary', {}, [
        el('strong', { text: `Answer ${label} · ${record.modelName || record.model}` }),
        el('span', { class: 'pv-muted', text: ` ${record.content.length} chars · ${record.source === 'manual' ? 'entered manually' : 'captured'} ${formatTime(record.completedAt)}` })
      ]),
      el('pre', { class: 'pv-answer-text', text: record.content })
    ]);
    return el('section', { class: 'pv-section pv-answers' }, [
      el('h3', { text: 'Answers' }),
      el('p', { class: 'pv-prompt' }, [el('span', { class: 'pv-muted', text: 'Prompt: ' }), session.prompt || '(none)']),
      answer('A', session.answerA),
      answer('B', session.answerB),
      ...notes.map(note => el('p', { class: 'pv-note', text: note })),
      ...extra
    ]);
  }

  function renderVotingSection(session) {
    const section = el('section', { class: 'pv-section pv-voting' }, [el('h3', { text: 'Human Preference Voting' })]);
    if (!session) {
      section.append(el('p', { class: 'pv-muted', text: 'Voting opens when both answers are captured.' }));
      return section;
    }
    if (isVoteLocked(session)) {
      const vote = session.humanVote;
      section.append(el('p', { class: 'pv-locked' }, [
        el('strong', { text: `Your vote: ${PREFERENCE_LABELS[vote.preference]}` }),
        el('span', { class: 'pv-muted', text: ` · locked ${formatTime(vote.submittedAt)}` })
      ]));
      if (vote.explanation) section.append(el('p', { class: 'pv-muted', text: `Reason: ${vote.explanation}` }));
      return section;
    }
    section.append(el('p', { class: 'pv-muted', text: 'Read both answers and choose first. Gemini\'s results stay hidden until you submit or skip.' }));
    const options = [['A', 'Answer A is better'], ['B', 'Answer B is better'], ['TIE', 'Tie / both equally good']];
    const group = el('div', { class: 'pv-vote-options', role: 'radiogroup', 'aria-label': 'Your preference' },
      options.map(([value, label]) => el('button', {
        type: 'button',
        class: `pv-vote-btn${draftChoice === value ? ' selected' : ''}`,
        role: 'radio',
        'aria-checked': String(draftChoice === value),
        onclick: () => { draftChoice = value; render(); }
      }, label)));
    const reason = el('textarea', {
      class: 'pv-reason', rows: '2', maxlength: '2000', placeholder: 'Optional: why? (short)'
    });
    reason.value = draftReason;
    reason.addEventListener('input', () => { draftReason = reason.value; });
    section.append(group, reason, el('div', { class: 'pv-row' }, [
      el('button', {
        type: 'button', class: 'pv-btn pv-primary', disabled: !draftChoice,
        onclick: () => void submitHumanVote(draftChoice)
      }, 'Submit Vote'),
      el('button', {
        type: 'button', class: 'pv-btn',
        onclick: () => void submitHumanVote('SKIPPED')
      }, 'Skip voting')
    ]));
    return section;
  }

  function renderGeminiSection(session) {
    const section = el('section', { class: 'pv-section pv-gemini' }, [el('h3', { text: 'Gemini Fact Checker' })]);
    if (!session) {
      section.append(el('p', { class: 'pv-muted', text: 'Available once both answers are captured.' }));
      return section;
    }
    const status = session.verification?.status || 'idle';
    const running = runners.has(session.id) || status === 'running';
    if (isWebBackend() && !hasConsent()) {
      section.append(
        el('p', { class: 'pv-note pv-consent', text: 'Gemini 网页验证会把问题和两个匿名回答（X / Y）发送到你登录的 gemini.google.com，由 Gemini 按验收模板核查。你的投票不会发送。只需确认一次。' }),
        el('button', {
          type: 'button', class: 'pv-btn pv-primary',
          onclick: () => void grantWebConsent(running ? null : session.id)
        }, '同意并开始验证 / Allow and verify'));
      return section;
    }
    if (!backendReady()) {
      const text = isWebBackend()
        ? 'Web mode sends the prompt and both answers to Gemini (gemini.google.com) with your Google login. Confirm this once in Verify settings.'
        : !hasApiKey
          ? 'Add your Gemini API key in Verify settings, or switch to web mode (no key needed).'
          : 'Verification sends the prompt and both answers to the Google Gemini API. Confirm this once in Verify settings.';
      section.append(el('p', { class: 'pv-note', text }));
    }
    if (running) {
      section.append(el('p', { class: 'pv-status' }, [
        el('span', { class: 'pv-spinner', 'aria-hidden': 'true' }),
        ` ${PROGRESS_LABELS[progress.get(session.id)] || 'Verifying…'} Results stay hidden until you vote.`
      ]), el('button', { type: 'button', class: 'pv-btn', onclick: () => cancelVerification(session.id) }, 'Cancel'));
      return section;
    }
    if (status === 'error') {
      // Errors carry no preference, so they are shown right away.
      section.append(el('p', { class: 'pv-error', role: 'alert', text: `Verification failed (${session.verification.error?.code}): ${session.verification.error?.message}` }),
        el('p', { class: 'pv-muted', text: 'No verification result was produced. Your vote can still be saved.' }),
        el('button', { type: 'button', class: 'pv-btn', onclick: () => void startVerification(session.id) }, 'Retry verification'));
      return section;
    }
    if (status === 'idle') {
      section.append(el('button', {
        type: 'button', class: 'pv-btn pv-primary', onclick: () => void startVerification(session.id)
      }, 'Verify Both Answers'));
      return section;
    }
    // status === 'done'
    if (!canRevealGemini(session)) {
      section.append(el('p', { class: 'pv-status', text: 'Verification finished. Results are hidden until you submit or skip your vote.' }));
      return section;
    }
    section.append(...renderReveal(session));
    return section;
  }

  function renderClaim(claim) {
    const evidence = claim.evidence.length > 0
      ? el('ul', { class: 'pv-evidence' }, claim.evidence.map(item => el('li', {}, [
        safeLink(item.url, item.title || 'source'),
        item.confirmed === false
          ? el('span', { class: 'pv-unconfirmed', text: ' · unconfirmed: not among the Gemini page\'s citations' })
          : null,
        item.publishedAt ? el('span', { class: 'pv-muted', text: ` · published ${item.publishedAt}` }) : null,
        item.citedText ? el('div', { class: 'pv-muted pv-cited', text: `Cited for: “${item.citedText}”` }) : null
      ])))
      : el('p', { class: 'pv-muted', text: 'No search source attached.' });
    return el('details', { class: `pv-claim pv-status-${claim.status}` }, [
      el('summary', {}, [el('span', { class: 'pv-badge', text: STATUS_LABELS[claim.status] }), ' ', claim.statement]),
      el('p', {}, [el('strong', { text: 'Gemini: ' }), claim.explanation]),
      claim.modelStatus && claim.modelStatus !== claim.status
        ? el('p', { class: 'pv-muted', text: `Gemini's raw label was ${claim.modelStatus}.` })
        : null,
      evidence
    ]);
  }

  function renderAnswerFacts(session, label) {
    const evaluation = session.geminiEvaluation;
    const record = label === 'A' ? session.answerA : session.answerB;
    const claims = evaluation.claims.filter(claim => claim.answerId === label)
      .sort((a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status));
    const counts = STATUS_ORDER.map(status => {
      const count = claims.filter(claim => claim.status === status).length;
      return el('span', { class: `pv-count pv-status-${status}`, text: `${STATUS_LABELS[status]}: ${count}` });
    });
    return el('div', { class: 'pv-facts-col' }, [
      el('h4', { text: `Answer ${label} · ${record.modelName || record.model}` }),
      el('div', { class: 'pv-counts' }, counts),
      claims.length > 0 ? el('div', {}, claims.map(renderClaim)) : el('p', { class: 'pv-muted', text: 'No factual claims extracted.' })
    ]);
  }

  function renderSearchSuggestions(html) {
    if (!html) return null;
    // Google's Search Suggestions must be displayed with grounded results.
    // They render in a sandbox with scripts disabled; links open new tabs.
    const frame = el('iframe', {
      class: 'pv-search-suggestions',
      title: 'Google Search Suggestions',
      sandbox: 'allow-popups allow-popups-to-escape-sandbox',
      referrerpolicy: 'no-referrer'
    });
    frame.srcdoc = `<!doctype html><html><head><meta charset="utf-8"><base target="_blank"></head><body style="margin:0">${html}</body></html>`;
    return el('div', { class: 'pv-suggestions-wrap' }, [el('h4', { text: 'Google Search Suggestions' }), frame]);
  }

  function renderCriteria(criteria) {
    const names = {
      factualAccuracy: 'Factual accuracy', evidenceSupport: 'Evidence support', logicalRigor: 'Logical rigor', completeness: 'Completeness',
      relevance: 'Relevance', internalConsistency: 'Internal consistency'
    };
    const rows = Object.entries(criteria || {}).filter(([key]) => names[key]);
    if (rows.length === 0) return null;
    return el('table', { class: 'pv-criteria' }, [
      el('thead', {}, el('tr', {}, [el('th', { text: 'Criterion (1–5)' }), el('th', { text: 'A' }), el('th', { text: 'B' })])),
      el('tbody', {}, rows.map(([key, scores]) => el('tr', {}, [
        el('td', { text: names[key] }), el('td', { text: scores.A ?? '—' }), el('td', { text: scores.B ?? '—' })
      ])))
    ]);
  }

  const LOGIC_VERDICT_LABELS = { SOUND: 'Sound', MINOR_ISSUES: 'Minor issues', FLAWED: 'Flawed' };
  const LOGIC_TYPE_LABELS = {
    MISREAD_QUESTION: 'Misreads the question',
    INVALID_INFERENCE: 'Invalid inference',
    CALCULATION_ERROR: 'Calculation error',
    CONTRADICTION: 'Self-contradiction',
    UNSUPPORTED_ASSUMPTION: 'Unsupported assumption',
    OTHER: 'Other'
  };

  function renderLogicColumn(session, label) {
    const record = label === 'A' ? session.answerA : session.answerB;
    const review = session.geminiEvaluation.logic?.[label];
    const head = el('h4', { text: `Answer ${label} · ${record.modelName || record.model}` });
    if (!review) return el('div', { class: 'pv-facts-col' }, [head, el('p', { class: 'pv-muted', text: 'No logic review returned.' })]);
    return el('div', { class: 'pv-facts-col' }, [
      head,
      el('span', { class: `pv-logic-verdict pv-logic-${review.verdict}`, text: LOGIC_VERDICT_LABELS[review.verdict] }),
      review.issues.length > 0
        ? el('ul', { class: 'pv-logic-issues' }, review.issues.map(issue => el('li', {}, [
          el('span', { class: `pv-sev pv-sev-${issue.severity}`, text: issue.severity }),
          ' ', el('strong', { text: LOGIC_TYPE_LABELS[issue.type] || issue.type }), ': ', issue.explanation,
          issue.quote ? el('div', { class: 'pv-muted pv-cited', text: `“${issue.quote}”` }) : null
        ])))
        : el('p', { class: 'pv-muted', text: 'No logic problems found.' })
    ]);
  }

  function renderReveal(session) {
    const evaluation = session.geminiEvaluation;
    const human = session.humanVote.preference;
    const agreement = compareJudgements(human, evaluation.verdict);
    const blocks = [];

    blocks.push(el('div', { class: 'pv-block' }, [
      el('h4', { text: 'A. Fact Verification' }),
      el('div', { class: 'pv-facts' }, [renderAnswerFacts(session, 'A'), renderAnswerFacts(session, 'B')])
    ]));

    if (evaluation.logic) {
      blocks.push(el('div', { class: 'pv-block' }, [
        el('h4', { text: 'B. Logic Review' }),
        el('div', { class: 'pv-facts' }, [renderLogicColumn(session, 'A'), renderLogicColumn(session, 'B')])
      ]));
    }

    blocks.push(el('div', { class: 'pv-block' }, [
      el('h4', { text: `${evaluation.logic ? 'C' : 'B'}. Gemini's Final Decision (blind)` }),
      el('p', { class: 'pv-verdict', text: evaluation.verdict === 'UNCERTAIN' ? 'Uncertain'
        : evaluation.verdict === 'TIE' ? 'Tie' : `${PREFERENCE_LABELS[evaluation.verdict]} is better` }),
      el('p', { text: evaluation.reasoning }),
      renderCriteria(evaluation.criteria),
      el('p', { class: 'pv-muted', text: `Gemini saw the answers as anonymous "X"/"Y" (A was ${session.anonymization.X === 'A' ? 'X' : 'Y'}), without model names or your vote.` })
    ]));

    if (evaluation.report) {
      blocks.push(el('details', { class: 'pv-block pv-report' }, [
        el('summary', { text: 'Gemini 验收报告（全文）' }),
        el('pre', { class: 'pv-report-text', text: evaluation.report })
      ]));
    }

    const disagreement = [];
    if (agreement === 'DISAGREE' || agreement === 'PARTIAL') {
      if (human === 'A' || human === 'B') {
        const wrong = evaluation.claims.filter(claim => claim.answerId === human && claim.status === 'CONTRADICTED');
        disagreement.push(el('p', { text: wrong.length > 0
          ? `Gemini found ${wrong.length} contradicted claim(s) in your preferred Answer ${human}:`
          : `Gemini found no contradicted claims in your preferred Answer ${human}; the difference comes from the other criteria.` }));
        if (wrong.length > 0) disagreement.push(el('ul', {}, wrong.map(claim => el('li', { text: claim.statement }))));
        const logicIssues = evaluation.logic?.[human]?.issues || [];
        if (logicIssues.length > 0) {
          disagreement.push(el('p', { text: `Gemini's logic review found ${logicIssues.length} issue(s) in Answer ${human}:` }),
            el('ul', {}, logicIssues.map(issue => el('li', { text: `${LOGIC_TYPE_LABELS[issue.type] || issue.type} (${issue.severity}): ${issue.explanation}` }))));
        }
      }
      disagreement.push(el('p', { class: 'pv-muted', text: 'See Gemini\'s reasoning and criterion scores above.' }));
    }
    blocks.push(el('div', { class: 'pv-block' }, [
      el('h4', { text: `${evaluation.logic ? 'D' : 'C'}. Human vs AI` }),
      el('table', { class: 'pv-hva' }, el('tbody', {}, [
        el('tr', {}, [el('th', { text: 'Human Preference' }), el('td', { text: PREFERENCE_LABELS[human] })]),
        el('tr', {}, [el('th', { text: 'Gemini Preference' }), el('td', { text: PREFERENCE_LABELS[evaluation.verdict] })]),
        el('tr', {}, [el('th', { text: 'Agreement' }), el('td', { class: `pv-agree-${agreement}`, text: AGREEMENT_LABELS[agreement] })])
      ])),
      disagreement.length > 0 ? el('details', { class: 'pv-why' }, [el('summary', { text: 'Why do we differ?' }), ...disagreement]) : null,
      renderFeedback(session)
    ]));

    const meta = [];
    (evaluation.warnings || []).forEach(warning => meta.push(el('p', { class: 'pv-note', text: warning })));
    const webEvaluation = evaluation.backend === 'web';
    if (webEvaluation) {
      const usage = evaluation.usage || {};
      meta.push(el('p', { class: 'pv-muted', text: `Gemini web mode (your Google account, no API billing) · temporary chat ${usage.temporaryChat ? 'on' : 'off'} · ${usage.confirmedSources || 0} of ${usage.sources || 0} cited sources confirmed on the page · ${formatTime(evaluation.evaluatedAt)}` }));
      if (judgePane && judgedSessionId === session.id) {
        meta.push(el('button', {
          type: 'button', class: 'pv-btn',
          onclick: () => { judgeOpen = true; updateJudgePane(); }
        }, '在 Gemini 页面中查看（主窗口）'));
      }
    } else if (evaluation.usage) {
      const usage = evaluation.usage;
      meta.push(el('p', { class: 'pv-muted', text: `Model ${evaluation.model} · ${usage.calls} API calls · ${usage.searchQueries} search queries · ${usage.totalTokens} tokens · ${formatTime(evaluation.evaluatedAt)}` }));
    }
    if (evaluation.redactions > 0) {
      meta.push(el('p', { class: 'pv-muted', text: `${evaluation.redactions} model self-reference(s) were redacted before sending.` }));
    }
    meta.push(el('button', {
      type: 'button', class: 'pv-btn',
      onclick: () => {
        const question = isWebBackend()
          ? 'Run the verification again in Gemini web mode? It sends the answers to gemini.google.com once more.'
          : 'Run the verification again? This makes new Gemini API and Google Search calls and may cost money.';
        if (confirm(question)) {
          void startVerification(session.id, { force: true });
        }
      }
    }, 'Re-run verification'));
    blocks.push(renderSearchSuggestions(evaluation.searchEntryPointHtml));
    blocks.push(el('div', { class: 'pv-block pv-meta' }, meta));
    return blocks.filter(Boolean);
  }

  function renderFeedback(session) {
    const wrap = el('details', { class: 'pv-feedback' }, [el('summary', { text: 'Changed your mind? (recorded as post-reveal feedback)' })]);
    (session.postRevealFeedback || []).forEach(entry => {
      wrap.append(el('p', { class: 'pv-muted', text: `${formatTime(entry.submittedAt)}: ${PREFERENCE_LABELS[entry.preference]}${entry.explanation ? ` — ${entry.explanation}` : ''}` }));
    });
    const select = el('select', { 'aria-label': 'Post-reveal preference' },
      ['A', 'B', 'TIE'].map(value => el('option', { value, text: PREFERENCE_LABELS[value] })));
    const note = el('input', { type: 'text', maxlength: '2000', placeholder: 'Optional note' });
    wrap.append(el('div', { class: 'pv-row' }, [select, note, el('button', {
      type: 'button', class: 'pv-btn',
      onclick: () => void submitFeedback(select.value, note.value)
    }, 'Record')]), el('p', { class: 'pv-muted', text: 'Your original vote stays unchanged.' }));
    return wrap;
  }

  function render() {
    if (destroyed) return;
    const session = getCurrent();
    const body = el('div', { class: 'pv-body' }, [
      errorMessage ? el('p', { class: 'pv-error', role: 'alert', text: errorMessage }) : null,
      renderAnswersSection(session),
      renderVotingSection(session),
      renderGeminiSection(session)
    ]);
    root.replaceChildren(renderHeader(), body);
    renderBar();
    updateJudgePane();
    syncToolbar();
  }

  // ===== Modals =====

  /**
   * @param {string} title
   * @param {HTMLElement} content
   * @param {{ onClose?: () => void }} [modalOptions]
   */
  function openModal(title, content, { onClose } = {}) {
    const overlay = el('div', { class: 'pv-modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': title });
    const close = () => {
      overlay.remove();
      onClose?.();
    };
    overlay.addEventListener('click', event => { if (event.target === overlay) close(); });
    overlay.addEventListener('keydown', event => { if (event.key === 'Escape') close(); });
    overlay.append(el('div', { class: 'pv-modal-card' }, [
      el('div', { class: 'pv-modal-head' }, [
        el('h3', { text: title }),
        el('button', { type: 'button', class: 'pv-btn pv-icon-only', 'aria-label': 'Close', onclick: close }, [icon('close')])
      ]),
      content
    ]));
    // In the Verify window when it is open (it may be a separate window).
    const host = isWindowOpen() ? root.ownerDocument || document : document;
    host.body.append(overlay);
    /** @type {HTMLElement | null} */ (overlay.querySelector('input, textarea, select, button'))?.focus();
    return close;
  }

  function openSettings({ highlightKey = false, highlightConsent = false } = {}) {
    const keyInput = el('input', { type: 'password', autocomplete: 'off', spellcheck: 'false', placeholder: hasApiKey ? '•••••••• (saved; leave empty to keep)' : 'Paste your Gemini API key' });
    const model = el('input', { type: 'text', list: 'pv-models', spellcheck: 'false' });
    model.value = settings.model;
    const auto = el('input', { type: 'checkbox' });
    auto.checked = settings.autoVerify;
    const redact = el('input', { type: 'checkbox' });
    redact.checked = settings.redactModelNames;
    const consent = el('input', { type: 'checkbox' });
    consent.checked = settings.consentAcknowledged;
    const maxClaims = el('input', { type: 'number', min: '1', max: '25' });
    maxClaims.value = String(settings.maxClaimsPerAnswer);
    const maxChars = el('input', { type: 'number', min: '1000', max: '100000', step: '1000' });
    maxChars.value = String(settings.maxAnswerChars);
    const timeout = el('input', { type: 'number', min: '10', max: '300' });
    timeout.value = String(Math.round(settings.timeoutMs / 1000));
    const webBackend = el('input', { type: 'radio', name: 'pv-backend', value: 'web' });
    const apiBackend = el('input', { type: 'radio', name: 'pv-backend', value: 'api' });
    webBackend.checked = settings.backend !== 'api';
    apiBackend.checked = settings.backend === 'api';
    const webConsent = el('input', { type: 'checkbox' });
    webConsent.checked = settings.webConsentAcknowledged;
    const webTimeout = el('input', { type: 'number', min: '60', max: '900' });
    webTimeout.value = String(Math.round(settings.webTimeoutMs / 1000));
    const template = el('textarea', { rows: '12', spellcheck: 'false', class: 'pv-template' });
    template.value = settings.webTemplate || DEFAULT_ACCEPTANCE_TEMPLATE;
    const status = el('p', { class: 'pv-muted', role: 'status' });

    const field = (label, input, hint, highlight) => el('label', { class: `pv-field${highlight ? ' pv-highlight' : ''}` }, [
      el('span', { text: label }), input, hint ? el('small', { class: 'pv-muted', text: hint }) : null
    ]);

    const save = async () => {
      try {
        if (keyInput.value.trim()) {
          await store.setApiKey(keyInput.value.trim());
          hasApiKey = true;
        }
        settings = await saveVerifySettings({
          backend: apiBackend.checked ? 'api' : 'web',
          webConsentAcknowledged: webConsent.checked,
          webTimeoutMs: Number(webTimeout.value) * 1000,
          // Saving the default text unchanged keeps following future defaults.
          webTemplate: template.value.trim() === DEFAULT_ACCEPTANCE_TEMPLATE.trim() ? '' : template.value,
          model: model.value,
          autoVerify: auto.checked,
          redactModelNames: redact.checked,
          consentAcknowledged: consent.checked,
          maxClaimsPerAnswer: Number(maxClaims.value),
          maxAnswerChars: Number(maxChars.value),
          timeoutMs: Number(timeout.value) * 1000
        }, settingsStorage);
        keyInput.value = '';
        // A new runner picks up the new timeout; never swap one mid-run.
        if (!webRunSessionId) webRunner = null;
        status.textContent = 'Saved.';
        render();
      } catch (error) {
        status.textContent = `Not saved: ${error.message}`;
      }
    };
    const test = async () => {
      status.textContent = 'Checking key and model…';
      try {
        const key = keyInput.value.trim() || await store.getApiKey();
        const client = createGeminiClient({ apiKey: key, model: model.value.trim(), timeoutMs: 20000, maxRetries: 0 });
        const info = await client.checkModel();
        status.textContent = `OK: ${info?.displayName || model.value} is reachable with this key.`;
      } catch (error) {
        status.textContent = `Check failed: ${error.message}`;
      }
    };
    const removeKey = async () => {
      await store.setApiKey('');
      hasApiKey = false;
      status.textContent = 'API key removed.';
      render();
    };

    const webGroup = el('div', { class: 'pv-group' }, [
      el('p', { class: 'pv-muted', text: 'Like the other panels: Gemini runs on gemini.google.com with your Google login, in the background (its page is the thumbnail at the right of the Verify bar). No API key and no billing. Every comparison is verified automatically, and the bar tells you when it is done. In this mode Gemini only verifies; a Gemini panel in the grid does not receive Send All. Sources are what Gemini cites on the page; there is no API grounding metadata, so evidence checks are weaker than in API mode.' }),
      el('label', { class: `pv-check${highlightConsent && webBackend.checked ? ' pv-highlight' : ''}` }, [webConsent,
        ' I understand that web mode sends the prompt and both answer texts to Gemini under my Google account. Verify turns on Gemini\'s temporary chat when it can; if it cannot, the check appears in my Gemini history.']),
      field('Web mode timeout (seconds)', webTimeout, 'Gemini web can take a few minutes when it searches.'),
      field('Acceptance template (what Gemini is asked to check)', template,
        'Role, fact check, logic review and verdict rules. The reply format, the question and the two anonymous answers are added after it automatically.'),
      el('div', { class: 'pv-row' }, [el('button', {
        type: 'button', class: 'pv-btn',
        onclick: () => { template.value = DEFAULT_ACCEPTANCE_TEMPLATE; }
      }, 'Restore default template')])
    ]);
    const apiGroup = el('div', { class: 'pv-group' }, [
      el('p', { class: 'pv-muted', text: 'Uses the Gemini API with Google Search grounding: sources come from structured grounding metadata. Search grounding is not on the free tier for Gemini 3.x Flash models, so the key\'s project needs billing.' }),
      field('Gemini API key', keyInput, 'Stored only in this browser (extension-private IndexedDB). Never logged or exported.', highlightKey),
      field('Gemini model ID', model, 'Any model that supports Google Search grounding. Prefer stable over preview models.'),
      el('datalist', { id: 'pv-models' }, SUGGESTED_MODELS.map(id => el('option', { value: id }))),
      el('label', { class: `pv-check${highlightConsent && apiBackend.checked ? ' pv-highlight' : ''}` }, [consent,
        ' I understand that verification sends the prompt and both answer texts (nothing else) to the Google Gemini API, where Google may keep them for up to 30 days for grounding.']),
      field('Request timeout (seconds)', timeout),
      el('label', { class: 'pv-check' }, [auto, ' Verify automatically when both answers are captured (each check makes paid API calls)']),
      el('div', { class: 'pv-row' }, [
        el('button', { type: 'button', class: 'pv-btn', onclick: () => void test() }, 'Test key & model'),
        hasApiKey ? el('button', { type: 'button', class: 'pv-btn', onclick: () => void removeKey() }, 'Remove key') : null
      ])
    ]);
    const syncGroups = () => {
      webGroup.hidden = !webBackend.checked;
      apiGroup.hidden = !apiBackend.checked;
    };
    webBackend.addEventListener('change', syncGroups);
    apiBackend.addEventListener('change', syncGroups);
    syncGroups();

    openModal('Verify settings', el('div', { class: 'pv-settings' }, [
      el('fieldset', { class: 'pv-backend' }, [
        el('legend', { text: 'How Gemini checks the answers' }),
        el('label', { class: 'pv-check' }, [webBackend, ' Web mode — gemini.google.com, free (default)']),
        el('label', { class: 'pv-check' }, [apiBackend, ' API mode — Gemini API key, stricter evidence, needs billing'])
      ]),
      webGroup,
      apiGroup,
      el('label', { class: 'pv-check' }, [redact, ' Redact the compared models\' names from answers before sending (keeps the judge blind)']),
      field('Max claims per answer', maxClaims, 'In API mode this also limits search cost: Google bills each search query the model runs.'),
      field('Max characters per answer', maxChars),
      el('div', { class: 'pv-row' }, [
        el('button', { type: 'button', class: 'pv-btn pv-primary', onclick: () => void save() }, 'Save')
      ]),
      status,
      el('details', { class: 'pv-dev' }, [
        el('summary', { text: `Testing an update (${buildLabel() || 'unknown build'})` }),
        el('p', { class: 'pv-muted', text: 'After replacing the extension\'s files (git pull, or a new zip unpacked over the same folder), reload it here. This page closes; open it again from the toolbar. Saved comparisons and settings are kept.' }),
        el('button', {
          type: 'button', class: 'pv-btn',
          onclick: () => globalThis.chrome?.runtime?.reload?.()
        }, 'Reload extension from disk')
      ])
    ]));
  }

  function openManualEntry() {
    const session = getCurrent();
    const pair = comparedPanels();
    const prompt = el('textarea', { rows: '2', placeholder: 'Prompt' });
    prompt.value = capture?.prompt || lastPrompt || session?.prompt || '';
    const answerA = el('textarea', { rows: '6', placeholder: 'Answer A' });
    answerA.value = capture?.sides?.A?.text || '';
    const answerB = el('textarea', { rows: '6', placeholder: 'Answer B' });
    answerB.value = capture?.sides?.B?.text || '';
    const nameA = pair ? getProviderName(pair.A.providerId) : 'Model A';
    const nameB = pair ? getProviderName(pair.B.providerId) : 'Model B';
    const status = el('p', { class: 'pv-error', role: 'status' });
    let close = null;
    const create = async () => {
      if (!answerA.value.trim() || !answerB.value.trim()) {
        status.textContent = 'Both answers are required.';
        return;
      }
      close?.();
      lastPrompt = prompt.value;
      await completeCapture(
        prompt.value,
        { providerId: pair?.A.providerId || 'unknown-a', text: answerA.value.trim() },
        { providerId: pair?.B.providerId || 'unknown-b', text: answerB.value.trim() },
        'manual'
      );
    };
    close = openModal('Enter answers manually', el('div', { class: 'pv-settings' }, [
      el('p', { class: 'pv-muted', text: 'Use this when automatic capture is not supported or picked up the wrong text. Copy each reply from its panel.' }),
      el('label', { class: 'pv-field' }, [el('span', { text: 'Prompt' }), prompt]),
      el('label', { class: 'pv-field' }, [el('span', { text: `Answer A (${nameA})` }), answerA]),
      el('label', { class: 'pv-field' }, [el('span', { text: `Answer B (${nameB})` }), answerB]),
      el('div', { class: 'pv-row' }, [el('button', { type: 'button', class: 'pv-btn pv-primary', onclick: () => void create() }, 'Start comparison')]),
      status
    ]));
  }

  async function openHistory() {
    let list = [];
    try {
      list = await store.listSessions();
    } catch (error) {
      showToast(`Could not read history: ${error.message}`);
      return;
    }
    const stats = computeAgreementStats(list);
    const rate = stats.agreementRate === null ? '—' : `${Math.round(stats.agreementRate * 100)}%`;
    let close = null;
    const rows = list.map(session => {
      const human = session.humanVote?.preference;
      const revealed = Boolean(human) && session.geminiEvaluation;
      const gemini = revealed ? session.geminiEvaluation.verdict : undefined;
      return el('tr', {}, [
        el('td', { text: formatTime(session.createdAt) }),
        el('td', { class: 'pv-ellipsis', title: session.prompt, text: session.prompt }),
        el('td', { text: `${session.answerA.modelName || session.answerA.model} / ${session.answerB.modelName || session.answerB.model}` }),
        el('td', { text: human ? PREFERENCE_LABELS[human] : 'no vote' }),
        // Never reveal Gemini's verdict for a session that has no vote yet.
        el('td', { text: revealed ? PREFERENCE_LABELS[gemini] : (session.geminiEvaluation ? 'hidden' : '—') }),
        el('td', { text: revealed ? AGREEMENT_LABELS[compareJudgements(human, gemini)] : '—' }),
        el('td', {}, el('button', {
          type: 'button', class: 'pv-btn',
          onclick: () => {
            currentSessionId = session.id;
            sessions.set(session.id, normalizeRestoredSession(sessions.get(session.id) || session));
            draftChoice = null;
            draftReason = '';
            close?.();
            render();
          }
        }, 'Open'))
      ]);
    });
    const exportJson = () => {
      const blob = new Blob([exportSessionsJson(list)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = el('a', { href: url, download: `panelize-verify-${new Date().toISOString().slice(0, 10)}.json` });
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    };
    const clearAll = async () => {
      if (!confirm('Delete all saved evaluations from this browser? This cannot be undone.')) return;
      await store.clearSessions();
      sessions.clear();
      currentSessionId = null;
      close?.();
      render();
    };
    close = openModal('Evaluation history', el('div', { class: 'pv-history' }, [
      el('p', { text: `${stats.total} sessions · human–Gemini agreement ${rate} over ${stats.comparable} comparable votes · skipped ${stats.counts.NO_HUMAN_VOTE} · Gemini uncertain ${stats.counts.AI_UNCERTAIN} · partial (tie) ${stats.counts.PARTIAL}` }),
      el('div', { class: 'pv-row' }, [
        el('button', { type: 'button', class: 'pv-btn pv-primary', onclick: exportJson, disabled: list.length === 0 }, [icon('download'), 'Export JSON']),
        el('button', { type: 'button', class: 'pv-btn', onclick: () => void clearAll(), disabled: list.length === 0 }, 'Delete all')
      ]),
      list.length > 0
        ? el('div', { class: 'pv-table-wrap' }, el('table', { class: 'pv-history-table' }, [
          el('thead', {}, el('tr', {}, ['Date', 'Prompt', 'Models (A / B)', 'Human', 'Gemini', 'Agreement', ''].map(text => el('th', { text })))),
          el('tbody', {}, rows)
        ]))
        : el('p', { class: 'pv-muted', text: 'No saved evaluations yet.' })
    ]));
  }

  // ===== Lifecycle =====

  async function init() {
    window.addEventListener('message', handleMessage);
    window.addEventListener('pagehide', closePopupOnLeave);
    rootHome = root.parentElement;
    root.hidden = true;
    toggleButton?.addEventListener('click', () => (isWindowOpen() ? closeVerify() : openVerify()));
    settings = await loadVerifySettings(settingsStorage).catch(() => null)
      || await loadVerifySettings(null);
    hasApiKey = Boolean(await store.getApiKey().catch(() => ''));
    try {
      const saved = await store.listSessions();
      saved.slice(0, 50).forEach(session => sessions.set(session.id, normalizeRestoredSession(session)));
      currentSessionId = saved[0]?.id || null;
    } catch (error) {
      errorMessage = `Saved evaluations could not be loaded: ${error.message}`;
    }
    render();
  }

  function closePopupOnLeave() {
    try { popupWin?.close(); } catch { /* ignore */ }
  }

  function destroy() {
    destroyed = true;
    stopPolling();
    if (popupWatch !== null) cancelSchedule(popupWatch);
    closePopupOnLeave();
    window.removeEventListener('message', handleMessage);
    window.removeEventListener('pagehide', closePopupOnLeave);
    runners.forEach(controller => controller.abort());
    judgeFrame?.remove();
    judgeFrame = null;
  }

  return {
    init,
    destroy,
    isVerifierPanel,
    openVerify,
    closeVerify,
    beforeBroadcast,
    afterBroadcast,
    captureNow,
    startVerification,
    submitHumanVote,
    render,
    // Test hooks.
    _getCurrentSession: getCurrent,
    _whenSaved: id => saveChains.get(id) || Promise.resolve()
  };
}
