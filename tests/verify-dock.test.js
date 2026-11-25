import { createVerifyDock, EXTRACT_REQUEST, ANSWER_STATE } from '../multi-panel/verify-dock.js';
import { createMemoryStore, SETTINGS_STORAGE_KEY } from '../modules/verify/storage.js';

const EVALUATION = {
  model: 'gemini-test',
  verdict: 'B',
  anonymousVerdict: 'X',
  reasoning: 'SECRET-REASONING: Answer B is accurate.',
  criteria: { factualAccuracy: { A: 2, B: 5 } },
  claims: [
    { id: 'C1-A', sharedId: 'C1', answerId: 'A', statement: 'SECRET-CLAIM opened in 1887', status: 'CONTRADICTED', explanation: 'Sources say 1889.', evidence: [{ url: 'https://example.org/eiffel', title: 'example.org' }] },
    { id: 'C2-B', sharedId: 'C2', answerId: 'B', statement: 'Completed in 1889', status: 'SUPPORTED', explanation: 'Confirmed.', evidence: [{ url: 'javascript:alert(1)', title: 'bad' }] }
  ],
  evaluatedAt: '2026-11-21T00:00:00.000Z',
  warnings: [],
  usage: { calls: 3, searchQueries: 1, totalTokens: 100 },
  searchEntryPointHtml: '<div>chips</div>'
};

function memorySettings(initial) {
  const data = { [SETTINGS_STORAGE_KEY]: initial };
  return {
    get: async key => ({ [key]: data[key] }),
    set: async values => Object.assign(data, values)
  };
}

function setup({ store = createMemoryStore(), evaluate, settings, states } = {}) {
  document.body.innerHTML = '<button id="toggle"></button><section id="verify-dock"></section>';
  const root = document.getElementById('verify-dock');
  const panels = [
    { id: 'p1', providerId: 'chatgpt', iframe: { contentWindow: {} } },
    { id: 'p2', providerId: 'claude', iframe: { contentWindow: {} } }
  ];
  const answerStates = states || {
    chatgpt: { supported: true, generating: false, hasAnswer: true, text: 'The tower opened in 1887.', lastUserText: 'When was the Eiffel Tower completed?', userTurnCount: 1, lastUserHash: 'u', textHash: 'a' },
    claude: { supported: true, generating: false, hasAnswer: true, text: 'It was completed in 1889.', lastUserText: 'When was the Eiffel Tower completed?', userTurnCount: 1, lastUserHash: 'u', textHash: 'b' }
  };
  const posted = [];
  const postToPanelFrame = (panel, message) => {
    posted.push({ panel, message });
    if (message.type !== EXTRACT_REQUEST) return;
    const state = typeof answerStates[panel.providerId] === 'function'
      ? answerStates[panel.providerId]()
      : answerStates[panel.providerId];
    queueMicrotask(() => window.dispatchEvent(new MessageEvent('message', {
      data: { type: ANSWER_STATE, context: 'panelize-verify', requestId: message.requestId, provider: panel.providerId, ...state }
    })));
  };
  const evaluateFn = evaluate || vi.fn(async () => EVALUATION);
  const dock = createVerifyDock({
    root,
    toggleButton: document.getElementById('toggle'),
    getPanels: () => panels,
    postToPanelFrame,
    // The real helper checks event.source and origin; here the provider id stands in.
    findMessageSourcePanel: (list, event) => list.find(panel => panel.providerId === event.data.provider),
    getProviderName: id => ({ chatgpt: 'ChatGPT', claude: 'Claude' })[id] || id,
    store,
    settingsStorage: memorySettings(settings ?? { backend: 'api', autoVerify: true, consentAcknowledged: true }),
    createService: () => ({ evaluate: evaluateFn }),
    confirm: () => true
  });
  return { dock, root, store, evaluateFn, posted, panels };
}

const flush = async () => {
  for (let i = 0; i < 10; i += 1) await new Promise(resolve => setTimeout(resolve, 0));
};

function clickButton(root, label) {
  const button = [...root.querySelectorAll('button')].find(candidate => candidate.textContent.trim() === label);
  if (!button) throw new Error(`No button "${label}"`);
  button.click();
}

describe('Verify dock — Test 3: human-first voting', () => {
  it('keeps every Gemini result hidden until the vote is saved', async () => {
    const store = createMemoryStore();
    await store.setApiKey('AIzaKEY');
    const { dock, root, evaluateFn } = setup({ store });
    await dock.init();
    await dock.captureNow();
    await flush();

    // Gemini already finished in the background...
    expect(evaluateFn).toHaveBeenCalledTimes(1);
    expect(dock._getCurrentSession().verification.status).toBe('done');
    // ...but nothing about its decision is on the page.
    const before = root.textContent;
    expect(before).not.toContain('SECRET-REASONING');
    expect(before).not.toContain('SECRET-CLAIM');
    expect(before).not.toContain('Gemini Preference');
    expect(before).not.toMatch(/Contradicted|Supported:/);
    expect(root.querySelector('.pv-status-CONTRADICTED, .pv-status-SUPPORTED, .pv-verdict, iframe')).toBeNull();
    expect(before).toContain('Results are hidden until you submit or skip your vote');

    clickButton(root, 'Answer A is better');
    clickButton(root, 'Submit Vote');
    await flush();

    const after = root.textContent;
    expect(dock._getCurrentSession().humanVote.preference).toBe('A');
    expect(after).toContain('SECRET-REASONING');
    expect(after).toContain('SECRET-CLAIM');
    expect(after).toContain('Human Preference');
    expect(root.querySelector('.pv-agree-DISAGREE').textContent).toBe('Disagree');
    // Unsafe evidence URL is not rendered as a link.
    expect([...root.querySelectorAll('a')].some(link => link.getAttribute('href')?.startsWith('javascript'))).toBe(false);
    // Search suggestions render sandboxed, without script permission.
    const frame = root.querySelector('iframe.pv-search-suggestions');
    expect(frame.getAttribute('sandbox')).not.toContain('allow-scripts');
  });

  it('records a skipped vote explicitly', async () => {
    const store = createMemoryStore();
    await store.setApiKey('AIzaKEY');
    const { dock, root } = setup({ store });
    await dock.init();
    await dock.captureNow();
    await flush();
    clickButton(root, 'Skip voting');
    await flush();
    expect(dock._getCurrentSession().humanVote.preference).toBe('SKIPPED');
    expect(root.textContent).toContain('No human vote (skipped)');
  });

  it('does not send anything to Gemini without consent', async () => {
    const store = createMemoryStore();
    await store.setApiKey('AIzaKEY');
    const { dock, evaluateFn } = setup({ store, settings: { backend: 'api', autoVerify: true, consentAcknowledged: false } });
    await dock.init();
    await dock.captureNow();
    await flush();
    expect(evaluateFn).not.toHaveBeenCalled();
    document.querySelector('.pv-modal')?.remove();
  });

  it('starts only one verification per session (no double billing)', async () => {
    const store = createMemoryStore();
    await store.setApiKey('AIzaKEY');
    let release;
    const evaluate = vi.fn(() => new Promise(resolve => { release = () => resolve(EVALUATION); }));
    const { dock } = setup({ store, evaluate, settings: { backend: 'api', autoVerify: false, consentAcknowledged: true } });
    await dock.init();
    await dock.captureNow();
    const id = dock._getCurrentSession().id;
    void dock.startVerification(id);
    void dock.startVerification(id);
    await flush();
    expect(evaluate).toHaveBeenCalledTimes(1);
    release();
    await flush();
    await dock.startVerification(id);
    expect(evaluate).toHaveBeenCalledTimes(1);
  });
});

describe('Verify dock — Test 7: API failure', () => {
  it('shows the error, invents no result and still saves the vote', async () => {
    const store = createMemoryStore();
    await store.setApiKey('AIzaKEY');
    const evaluate = vi.fn(async () => { throw Object.assign(new Error('The Gemini API key was rejected.'), { code: 'INVALID_API_KEY' }); });
    const { dock, root } = setup({ store, evaluate });
    await dock.init();
    await dock.captureNow();
    await flush();
    expect(root.querySelector('.pv-error').textContent).toContain('INVALID_API_KEY');
    expect(root.textContent).toContain('The tower opened in 1887.'); // answers still visible
    clickButton(root, 'Tie / both equally good');
    clickButton(root, 'Submit Vote');
    await flush();
    const saved = await store.getSession(dock._getCurrentSession().id);
    expect(saved.humanVote.preference).toBe('TIE');
    expect(saved.geminiEvaluation).toBeUndefined();
    expect(root.querySelector('.pv-verdict')).toBeNull();
  });
});

describe('Verify dock — Test 8: persistence', () => {
  it('restores the saved session and keeps results hidden until the vote', async () => {
    const store = createMemoryStore();
    await store.setApiKey('AIzaKEY');
    const first = setup({ store });
    await first.dock.init();
    await first.dock.captureNow();
    await flush();
    first.dock.destroy();

    const second = setup({ store });
    await second.dock.init();
    expect(second.dock._getCurrentSession().verification.status).toBe('done');
    expect(second.root.textContent).toContain('The tower opened in 1887.');
    expect(second.root.textContent).not.toContain('SECRET-REASONING');
    clickButton(second.root, 'Answer B is better');
    clickButton(second.root, 'Submit Vote');
    await flush();
    expect(second.root.textContent).toContain('SECRET-REASONING');
    expect(second.root.querySelector('.pv-agree-AGREE')).not.toBeNull();
  });
});

describe('Verify dock — automatic capture', () => {
  it('ignores the previous answer and captures the new reply once it is stable', async () => {
    let clock = 0;
    let turn = 1;
    let generating = false;
    const state = provider => () => ({
      supported: true,
      generating,
      hasAnswer: true,
      text: turn === 1 ? `old ${provider}` : `new ${provider}`,
      textHash: `${turn}-${provider}`,
      userTurnCount: turn,
      lastUserHash: `u${turn}`,
      lastUserText: turn === 1 ? 'old question' : 'Is the Earth round?'
    });
    const store = createMemoryStore();
    const env = setup({ store, states: { chatgpt: state('chatgpt'), claude: state('claude') }, settings: { backend: 'api', autoVerify: false } });
    // Drive time and polling by hand.
    const timers = [];
    const dock = createVerifyDock({
      root: env.root,
      getPanels: () => env.panels,
      postToPanelFrame: (panel, message) => {
        const states = { chatgpt: state('chatgpt'), claude: state('claude') };
        queueMicrotask(() => window.dispatchEvent(new MessageEvent('message', {
          data: { type: ANSWER_STATE, context: 'panelize-verify', requestId: message.requestId, provider: panel.providerId, ...states[panel.providerId]() }
        })));
      },
      findMessageSourcePanel: (list, event) => list.find(panel => panel.providerId === event.data.provider),
      getProviderName: id => id,
      store,
      settingsStorage: memorySettings({ autoVerify: false }),
      createService: () => ({ evaluate: vi.fn() }),
      now: () => clock,
      schedule: (fn, ms) => { const handle = { fn, ms }; timers.push(handle); return handle; },
      cancelSchedule: handle => { const index = timers.indexOf(handle); if (index >= 0) timers.splice(index, 1); }
    });
    env.dock.destroy();
    await dock.init();
    const runPolls = async () => {
      const due = timers.filter(timer => timer.ms <= 1500);
      due.forEach(timer => timers.splice(timers.indexOf(timer), 1));
      due.forEach(timer => timer.fn());
      await flush();
    };

    dock.beforeBroadcast('Is the Earth round?');
    await flush();
    turn = 2;
    generating = true;
    await dock.afterBroadcast('Is the Earth round?', { sent: true });
    await runPolls();
    expect(dock._getCurrentSession()).toBeNull();
    expect(env.root.textContent).toContain('generating');

    generating = false;
    clock = 1000;
    await runPolls();
    expect(dock._getCurrentSession()).toBeNull(); // still stabilizing
    clock = 5000;
    await runPolls();
    const session = dock._getCurrentSession();
    expect(session.prompt).toBe('Is the Earth round?');
    expect(session.answerA.content).toBe('new chatgpt');
    expect(session.answerB.content).toBe('new claude');
    expect((await store.listSessions())).toHaveLength(1);
  });
});
