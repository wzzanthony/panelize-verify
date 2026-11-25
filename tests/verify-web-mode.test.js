import {
  buildWebJudgeMessage,
  parseWebJudgeReply,
  extractJsonObject,
  comparableUrl,
  createWebVerificationService
} from '../modules/verify/web-judge.js';
import { createWebJudgeRunner, GEMINI_WEB_ORIGIN } from '../multi-panel/verify-web-runner.js';
import { createSession, submitVote } from '../modules/verify/session-state.js';
import { createVerifyDock, EXTRACT_REQUEST, ANSWER_STATE } from '../multi-panel/verify-dock.js';
import { relabelAnonymousText } from '../modules/verify/verification-service.js';
import { DEFAULT_ACCEPTANCE_TEMPLATE } from '../modules/verify/acceptance-template.js';
import { createMemoryStore, SETTINGS_STORAGE_KEY, normalizeSettings } from '../modules/verify/storage.js';

function makeSession(randomBit = () => 0) {
  return createSession({
    prompt: 'When was the Eiffel Tower completed?',
    answerA: { model: 'chatgpt', modelName: 'ChatGPT', content: 'As ChatGPT, I can say it opened in 1887.', completedAt: 'x' },
    answerB: { model: 'claude', modelName: 'Claude', content: 'It was completed in 1889.', completedAt: 'x' },
    randomBit
  });
}

function reply(data) {
  return `Here is the check.\n\n\`\`\`json\n${JSON.stringify(data)}\n\`\`\``;
}

const REPLY_DATA = {
  claims: [
    {
      id: 'C1', statement: 'The Eiffel Tower opened in 1887.', answers: ['X'], verifiable: true,
      status: 'CONTRADICTED', explanation: 'Sources say 1889. https://made-up.example/x',
      sources: [{ url: 'https://www.toureiffel.paris/en/history', title: 'Tour Eiffel' }]
    },
    {
      id: 'C2', statement: 'The Eiffel Tower was completed in 1889.', answers: ['Y'], verifiable: true,
      status: 'SUPPORTED', explanation: 'Confirmed.',
      sources: [{ url: 'https://invented.example/page', title: 'Invented' }, { url: 'javascript:alert(1)' }]
    },
    { id: 'C3', statement: 'You should visit in spring.', answers: ['Y'], verifiable: false }
  ],
  logic: {
    X: { verdict: 'SOUND', issues: [{ type: 'CALCULATION_ERROR', severity: 'high', quote: 'opened in 1887', explanation: 'Answer X subtracts the wrong years. https://made-up.example/' }] },
    Y: { verdict: 'SOUND', issues: [] }
  },
  verdict: 'Y',
  reasoning: 'Answer Y is accurate while Answer X gives the wrong year.',
  criteria: { factualAccuracy: { X: 2, Y: 5 } }
};

describe('Verify web mode — message to Gemini', () => {
  it('sends only the prompt and anonymous X/Y answers: no model names, no vote', () => {
    const session = submitVote(makeSession(), 'A', { explanation: 'VOTE-SENTINEL-REASON' });
    const message = buildWebJudgeMessage(session, { maxClaimsPerAnswer: 5 });
    expect(message.text).toContain('<<<BEGIN ANSWER X>>>');
    expect(message.text).toContain('It was completed in 1889.');
    expect(message.text).not.toMatch(/ChatGPT|Claude/);
    expect(message.text).not.toContain('VOTE-SENTINEL-REASON');
    expect(message.text).toContain('每个回答最多 5 条可核查事实');
    // Default acceptance template: role, fact check, logic review, verdict.
    expect(message.text).toContain('专业验收团队');
    expect(message.text).toContain('逻辑审查');
    // The output format is always appended, before the data.
    expect(message.text.indexOf('# 输出格式')).toBeLessThan(message.text.indexOf('<<<BEGIN USER QUESTION>>>'));
    expect(message.redactions).toBeGreaterThan(0);
  });
});

describe('Verify web mode — parsing and evidence rules', () => {
  const pageLinks = [
    'https://www.google.com/url?q=https%3A%2F%2Ftoureiffel.paris%2Fen%2Fhistory%2F%3Futm_source%3Dgemini&sa=D'
  ];

  it('counts only sources that also appear among the Gemini page citations', () => {
    const session = makeSession(() => 0); // X = A, Y = B
    const evaluation = parseWebJudgeReply(reply(REPLY_DATA), pageLinks, { session, temporaryChat: true });
    expect(evaluation.backend).toBe('web');
    expect(evaluation.verdict).toBe('B');
    expect(evaluation.anonymousVerdict).toBe('Y');
    expect(evaluation.reasoning).toBe('Answer B is accurate while Answer A gives the wrong year.');
    expect(evaluation.criteria.factualAccuracy).toEqual({ A: 2, B: 5 });

    const c1 = evaluation.claims.find(claim => claim.sharedId === 'C1');
    expect(c1.answerId).toBe('A');
    expect(c1.status).toBe('CONTRADICTED');
    expect(c1.evidence).toEqual([expect.objectContaining({ url: 'https://www.toureiffel.paris/en/history', confirmed: true })]);
    expect(c1.explanation).not.toContain('made-up.example');

    // C2's only usable source is not on the page: not counted as verified.
    const c2 = evaluation.claims.find(claim => claim.sharedId === 'C2');
    expect(c2.status).toBe('INSUFFICIENT_EVIDENCE');
    expect(c2.modelStatus).toBe('SUPPORTED');
    expect(c2.evidence).toHaveLength(1);
    expect(c2.evidence[0].confirmed).toBe(false);

    const c3 = evaluation.claims.find(claim => claim.sharedId === 'C3');
    expect(c3.status).toBe('NOT_VERIFIABLE');
    expect(evaluation.usage).toMatchObject({ temporaryChat: true, sources: 2, confirmedSources: 1 });
    expect(evaluation.warnings.join(' ')).toMatch(/downgraded/);
  });

  it('maps the verdict through a swapped anonymization', () => {
    const session = makeSession(() => 1); // X = B, Y = A
    const evaluation = parseWebJudgeReply(reply(REPLY_DATA), pageLinks, { session, temporaryChat: true });
    expect(evaluation.verdict).toBe('A');
    expect(evaluation.claims.find(claim => claim.sharedId === 'C1').answerId).toBe('B');
  });

  it('verifies nothing when no citation links could be read from the page', () => {
    const evaluation = parseWebJudgeReply(reply(REPLY_DATA), [], { session: makeSession(), temporaryChat: false });
    expect(evaluation.claims.filter(claim => claim.status === 'SUPPORTED' || claim.status === 'CONTRADICTED')).toHaveLength(0);
    expect(evaluation.warnings.join(' ')).toMatch(/No citation links/);
    expect(evaluation.warnings.join(' ')).toMatch(/Gemini history/);
  });

  it('rejects replies without valid JSON or with an unknown verdict', () => {
    expect(() => parseWebJudgeReply('Sorry, I cannot help.', [], { session: makeSession() })).toThrow(/validation/);
    expect(() => parseWebJudgeReply(reply({ ...REPLY_DATA, verdict: 'A' }), [], { session: makeSession() })).toThrow(/unknown verdict/);
  });

  it('finds the JSON object with or without a fence', () => {
    expect(extractJsonObject('JSON\n```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJsonObject('prefix {"a":2} suffix')).toEqual({ a: 2 });
  });

  it('normalises URLs for comparison and unwraps Google redirects', () => {
    expect(comparableUrl('https://www.example.org/a/?utm_source=x')).toBe('example.org/a');
    expect(comparableUrl('https://www.google.com/url?q=https://example.org/a')).toBe('example.org/a');
    expect(comparableUrl('javascript:alert(1)')).toBe('');
  });

  it('runs end to end through the service with a fake runner', async () => {
    const runner = { run: vi.fn(async () => ({ text: reply(REPLY_DATA), links: pageLinks, temporaryChat: true })) };
    const service = createWebVerificationService({ runner });
    const steps = [];
    const evaluation = await service.evaluate(makeSession(), { onProgress: step => steps.push(step) });
    expect(runner.run).toHaveBeenCalledTimes(1);
    expect(runner.run.mock.calls[0][0]).not.toMatch(/ChatGPT|Claude/);
    expect(evaluation.verdict).toBe('B');
    expect(steps).toContain('parsing');
  });
});

function createClock() {
  let time = 0;
  return {
    now: () => time,
    sleep: async ms => { time += ms; await Promise.resolve(); }
  };
}

function fakeRunnerEnv({ states, ackTempChat = true }) {
  const clock = createClock();
  let navigations = 0;
  const frameWindow = {};
  const frame = { contentWindow: frameWindow, src: '', getAttribute(name) { return name === 'src' ? this.src : null; } };
  const listeners = new Set();
  const win = {
    addEventListener: (_type, fn) => listeners.add(fn),
    removeEventListener: (_type, fn) => listeners.delete(fn)
  };
  const posted = [];
  let stateIndex = 0;
  const runner = createWebJudgeRunner({
    getFrame: () => frame,
    navigate: async (target, url) => { navigations += 1; target.src = url; },
    win: /** @type {any} */ (win),
    now: clock.now,
    sleep: clock.sleep,
    postToFrame: (_panel, message) => {
      posted.push(message);
      if (message.type === 'ENABLE_TEMP_CHAT' && ackTempChat) {
        listeners.forEach(fn => fn({ source: frameWindow, origin: GEMINI_WEB_ORIGIN, data: { type: 'PANELIZE_TEMP_CHAT_ENABLED', provider: 'gemini' } }));
      }
      if (message.type === 'INJECT_TEXT') stateIndex = Math.max(stateIndex, 1);
    },
    requestState: async () => {
      const list = typeof states === 'function' ? states(posted) : states;
      return list[Math.min(stateIndex, list.length - 1)];
    },
    timeoutMs: 60000
  });
  return { runner, frame, posted, navigations: () => navigations, advance: () => { stateIndex += 1; } };
}

describe('Verify web mode — hidden Gemini runner', () => {
  const idle = { supported: true, generating: false, userTurnCount: 0, lastUserText: '', lastUserHash: 'h0', hasAnswer: false, text: '', textHash: 't0', links: [] };
  const done = {
    supported: true, generating: false, userTurnCount: 1, lastUserText: 'MESSAGE-FOR-GEMINI', lastUserHash: 'h1',
    hasAnswer: true, text: 'REPLY', textHash: 't1', links: ['https://example.org/a']
  };

  it('opens Gemini, turns on temporary chat, sends once and returns the settled reply', async () => {
    const env = fakeRunnerEnv({ states: [idle, done] });
    const result = await env.runner.run('MESSAGE-FOR-GEMINI');
    expect(result).toEqual({ text: 'REPLY', links: ['https://example.org/a'], temporaryChat: true });
    expect(env.posted.filter(message => message.type === 'INJECT_TEXT')).toEqual([
      expect.objectContaining({ text: 'MESSAGE-FOR-GEMINI', autoSubmit: true, context: 'multi-panel' })
    ]);
    // Each run starts from a freshly loaded page; the frame stays for reading after the vote.
    expect(env.navigations()).toBe(1);
    // A second run reloads (the page now holds the first check), the first did not need to.
    await env.runner.run('MESSAGE-FOR-GEMINI').catch(() => {});
    expect(env.navigations()).toBe(2);
    expect(env.runner.getPanel()).toEqual(expect.objectContaining({ providerId: 'gemini', iframe: env.frame }));
    expect(env.runner.isRunning()).toBe(false);
  });

  it('reports when temporary chat could not be turned on', async () => {
    const env = fakeRunnerEnv({ states: [idle, done], ackTempChat: false });
    const result = await env.runner.run('MESSAGE-FOR-GEMINI');
    expect(result.temporaryChat).toBe(false);
    expect(env.posted.filter(message => message.type === 'ENABLE_TEMP_CHAT')).toHaveLength(3);
  });

  it('re-sends once when nothing was submitted, then fails clearly', async () => {
    const env = fakeRunnerEnv({ states: () => [idle] });
    await expect(env.runner.run('MESSAGE-FOR-GEMINI')).rejects.toMatchObject({ code: 'WEB_SEND_FAILED' });
    expect(env.posted.filter(message => message.type === 'INJECT_TEXT')).toHaveLength(2);
  });

  it('fails when the Gemini page never answers', async () => {
    const env = fakeRunnerEnv({ states: [null] });
    await expect(env.runner.run('MESSAGE-FOR-GEMINI')).rejects.toMatchObject({ code: 'WEB_NOT_READY' });
  });

  it('stops on cancel', async () => {
    const env = fakeRunnerEnv({ states: [idle] });
    const controller = new AbortController();
    controller.abort();
    await expect(env.runner.run('MESSAGE-FOR-GEMINI', { signal: controller.signal })).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(env.posted.filter(message => message.type === 'INJECT_TEXT')).toHaveLength(0);
  });
});

function memorySettings(initial) {
  const data = { [SETTINGS_STORAGE_KEY]: initial };
  return { get: async key => ({ [key]: data[key] }), set: async values => Object.assign(data, values) };
}

const flush = async () => {
  for (let i = 0; i < 10; i += 1) await new Promise(resolve => setTimeout(resolve, 0));
};

function setupDock(settings, { withGeminiPanel = false } = {}) {
  document.body.innerHTML = '<div id="verify-region"><section id="verify-dock"></section><aside id="pane" hidden></aside></div>';
  const root = document.getElementById('verify-dock');
  const judgePane = document.getElementById('pane');
  const panels = [
    ...(withGeminiPanel ? [{ id: 'p0', providerId: 'gemini', iframe: { contentWindow: {} } }] : []),
    { id: 'p1', providerId: 'chatgpt', iframe: { contentWindow: {} } },
    { id: 'p2', providerId: 'claude', iframe: { contentWindow: {} } }
  ];
  const removePanels = vi.fn();
  const states = {
    chatgpt: { supported: true, generating: false, hasAnswer: true, text: 'The tower opened in 1887.', lastUserText: 'Q', userTurnCount: 1, lastUserHash: 'u', textHash: 'a' },
    claude: { supported: true, generating: false, hasAnswer: true, text: 'It was completed in 1889.', lastUserText: 'Q', userTurnCount: 1, lastUserHash: 'u', textHash: 'b' }
  };
  const apiEvaluate = vi.fn();
  const webEvaluate = vi.fn(async session => parseWebJudgeReply(reply(REPLY_DATA), [
    'https://www.toureiffel.paris/en/history'
  ], { session, temporaryChat: true }));
  const dock = createVerifyDock({
    root,
    getPanels: () => panels,
    postToPanelFrame: (panel, message) => {
      if (message.type !== EXTRACT_REQUEST) return;
      queueMicrotask(() => window.dispatchEvent(new MessageEvent('message', {
        data: { type: ANSWER_STATE, context: 'panelize-verify', requestId: message.requestId, provider: panel.providerId, ...states[panel.providerId] }
      })));
    },
    findMessageSourcePanel: (list, event) => list.find(panel => panel.providerId === event.data.provider),
    getProviderName: id => id,
    store: createMemoryStore(),
    settingsStorage: memorySettings(settings),
    createService: () => ({ evaluate: apiEvaluate }),
    createWebService: () => ({ evaluate: webEvaluate }),
    createWebRunner: () => ({ run: vi.fn(), getPanel: () => null }),
    createJudgeFrame: doc => doc.createElement('div'),
    judgePane,
    removePanels,
    confirm: () => true
  });
  return { dock, root, apiEvaluate, webEvaluate, judgePane, panels, removePanels };
}

describe('Verify web mode — dock', () => {
  it('defaults to web mode', () => {
    expect(normalizeSettings({}).backend).toBe('web');
    expect(normalizeSettings({ backend: 'other' }).backend).toBe('web');
    expect(normalizeSettings({ backend: 'api' }).backend).toBe('api');
  });

  it('sends nothing to Gemini web before the user confirms web mode', async () => {
    const env = setupDock({ autoVerify: true });
    await env.dock.init();
    await env.dock.captureNow();
    await flush();
    expect(env.webEvaluate).not.toHaveBeenCalled();
    expect(env.root.textContent).toContain('Confirm this once in Verify settings');
    document.querySelector('.pv-modal')?.remove();
  });

  it('verifies without an API key and still hides results until the vote', async () => {
    const env = setupDock({ autoVerify: true, webConsentAcknowledged: true });
    await env.dock.init();
    await env.dock.captureNow();
    await flush();
    expect(env.webEvaluate).toHaveBeenCalledTimes(1);
    expect(env.apiEvaluate).not.toHaveBeenCalled();
    expect(env.dock._getCurrentSession().verification.status).toBe('done');
    expect(env.root.textContent).not.toContain('The Eiffel Tower was completed in 1889.');
    expect(env.root.textContent).not.toContain('Gemini Preference');

    await env.dock.submitHumanVote('A');
    await flush();
    expect(env.root.textContent).toContain('Gemini Preference');
    expect(env.root.textContent).toContain('Gemini web mode');
    expect(env.root.textContent).toContain('unconfirmed');
  });
});

describe('Verify web mode — acceptance template and logic review', () => {
  it('uses a custom template but always keeps the output format', () => {
    const message = buildWebJudgeMessage(makeSession(), { template: 'CUSTOM-ACCEPTANCE-RULES' });
    expect(message.text.startsWith('CUSTOM-ACCEPTANCE-RULES')).toBe(true);
    expect(message.text).not.toContain('专业验收团队');
    expect(message.text).toContain('# 输出格式');
    expect(buildWebJudgeMessage(makeSession(), { template: '   ' }).text.startsWith(DEFAULT_ACCEPTANCE_TEMPLATE)).toBe(true);
  });

  it('parses the logic review per answer and never leaves "sound" next to a high-severity issue', () => {
    const evaluation = parseWebJudgeReply(reply(REPLY_DATA), [], { session: makeSession(() => 0) });
    expect(evaluation.logic.A.verdict).toBe('FLAWED');
    expect(evaluation.logic.A.issues[0]).toMatchObject({ type: 'CALCULATION_ERROR', severity: 'high', quote: 'opened in 1887' });
    expect(evaluation.logic.A.issues[0].explanation).toBe('Answer A subtracts the wrong years. [link removed]');
    expect(evaluation.logic.B).toEqual({ verdict: 'SOUND', issues: [] });
  });

  it('warns when no logic review came back', () => {
    const { logic, ...withoutLogic } = REPLY_DATA;
    const evaluation = parseWebJudgeReply(reply(withoutLogic), [], { session: makeSession() });
    expect(evaluation.logic).toBeUndefined();
    expect(evaluation.warnings.join(' ')).toMatch(/no logic review/);
  });

  it('relabels Chinese X/Y references to A/B', () => {
    expect(relabelAnonymousText('回答 X 更准确；Y 更好。答案Y有误', { X: 'B', Y: 'A' })).toBe('回答 B 更准确；A 更好。答案 A有误');
  });
});

describe('Verify web mode — Gemini as verifier panel', () => {
  it('treats a Gemini grid panel as the verifier: no Send All, not A or B', async () => {
    const env = setupDock({ autoVerify: false, webConsentAcknowledged: true }, { withGeminiPanel: true });
    await env.dock.init();
    expect(env.dock.isVerifierPanel(env.panels[0])).toBe(true);
    expect(env.dock.isVerifierPanel(env.panels[1])).toBe(false);
    await env.dock.captureNow();
    await flush();
    const session = env.dock._getCurrentSession();
    expect([session.answerA.model, session.answerB.model]).toEqual(['chatgpt', 'claude']);
    const removeButton = [...env.root.querySelectorAll('button')].find(button => button.textContent === 'Remove it from the top');
    removeButton.click();
    expect(env.removePanels).toHaveBeenCalledWith(['p0']);
  });

  it('keeps Gemini as a normal answer panel in API mode', async () => {
    const env = setupDock({ backend: 'api', consentAcknowledged: true }, { withGeminiPanel: true });
    await env.dock.init();
    expect(env.dock.isVerifierPanel(env.panels[0])).toBe(false);
  });

  it('shows the verifier panel below, covered until the vote', async () => {
    const env = setupDock({ autoVerify: true, webConsentAcknowledged: true });
    await env.dock.init();
    await env.dock.captureNow();
    await flush();
    expect(env.judgePane.hidden).toBe(false);
    expect(env.judgePane.querySelector('.pv-judge-frame')).not.toBeNull();
    expect(env.judgePane.querySelector('.pv-judge-cover').hidden).toBe(false);
    expect(document.getElementById('verify-region').classList.contains('pv-with-judge')).toBe(true);

    await env.dock.submitHumanVote('B');
    await flush();
    expect(env.judgePane.querySelector('.pv-judge-cover').hidden).toBe(true);
    expect(env.root.textContent).toContain('B. Logic Review');
    expect(env.root.textContent).toContain('Calculation error');
  });
});
