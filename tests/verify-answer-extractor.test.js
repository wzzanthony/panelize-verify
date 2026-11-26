import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const source = readFileSync(resolve(process.cwd(), 'content-scripts/answer-extractor.js'), 'utf8');

function load() {
  delete window.__panelizeVerifyExtractorInstalled;
  window.eval(source);
  return window.PanelizeVerifyExtractor;
}

describe('answer extractor (Test 2: answer extraction)', () => {
  let extractor;
  beforeEach(() => {
    document.body.innerHTML = '';
    extractor = load();
  });

  it('reads only the ChatGPT reply after the latest user turn', () => {
    document.body.innerHTML = `
      <main>
        <div data-message-author-role="user">old question</div>
        <div data-message-author-role="assistant"><div class="markdown"><p>OLD ANSWER</p></div></div>
        <div data-message-author-role="user">What is the boiling point of water?</div>
        <div data-message-author-role="assistant"><div class="markdown">
          <p>Water boils at <strong>100 °C</strong> at sea level.</p>
          <button>Copy</button>
        </div></div>
      </main>`;
    const state = extractor.readAnswerState('chatgpt');
    expect(state.supported).toBe(true);
    expect(state.userTurnCount).toBe(2);
    expect(state.lastUserText).toBe('What is the boiling point of water?');
    expect(state.text).toBe('Water boils at **100 °C** at sea level.');
    expect(state.text).not.toContain('OLD ANSWER');
    expect(state.text).not.toContain('Copy');
    expect(state.generating).toBe(false);
  });

  describe('ChatGPT 2026 markup without data-message-author-role', () => {
    it('reads search-unit-key turns and skips the "ChatGPT said:" heading', () => {
      document.body.innerHTML = `
        <main>
          <div data-turn-key="t1">
            <div data-chatgpt-search-unit-key="c:0:user"><h5 class="sr-only">You said:</h5>
              <div data-user-message-bubble="true">old question</div></div>
            <div data-chatgpt-search-unit-key="c:1:assistant"><div data-markdown-text-style="assistant-message"><p>OLD ANSWER</p></div></div>
          </div>
          <div data-turn-key="t2">
            <div data-chatgpt-search-unit-key="c:2:user"><h5 class="sr-only">You said:</h5>
              <div data-user-message-bubble="true">Why is my calf tight?</div></div>
            <div data-chatgpt-search-unit-key="c:3:assistant">
              <h6 class="sr-only">ChatGPT said:</h6>
              <div data-markdown-text-style="assistant-message"><p>Usually <strong>fatigue</strong>.</p></div>
            </div>
          </div>
        </main>`;
      const state = extractor.readAnswerState('chatgpt');
      expect(state.userTurnCount).toBe(2);
      expect(state.lastUserText).toBe('Why is my calf tight?');
      expect(state.text).toBe('Usually **fatigue**.');
      expect(state.generating).toBe(false);
      expect(state.probe).toBeUndefined();
    });

    it('reads content-search-unit-key turns', () => {
      document.body.innerHTML = `
        <div data-content-search-unit-key="x:0:user"><div data-user-message-bubble="true">Q1</div></div>
        <div data-content-search-unit-key="x:1:assistant"><div class="prose"><p>A1</p></div></div>`;
      const state = extractor.readAnswerState('chatgpt');
      expect(state.userTurnCount).toBe(1);
      expect(state.lastUserText).toBe('Q1');
      expect(state.text).toBe('A1');
    });

    it('reads li[data-message-role] replies and treats an incomplete one as generating', () => {
      document.body.innerHTML = `
        <ol>
          <li data-message-role="user">Q</li>
          <li data-message-role="assistant"><div data-assistant-markdown-root><p>Partial</p></div></li>
        </ol>`;
      let state = extractor.readAnswerState('chatgpt');
      expect(state.text).toBe('Partial');
      expect(state.generating).toBe(true);
      document.querySelector('li[data-message-role="assistant"]').setAttribute('data-message-complete', '');
      state = extractor.readAnswerState('chatgpt');
      expect(state.generating).toBe(false);
    });

    it('uses the parent of a role heading as the turn', () => {
      document.body.innerHTML = `
        <section><h4 data-conversation-role="user">You said:</h4><p>Q</p></section>
        <section><h4 data-conversation-role="assistant">ChatGPT said:</h4><div><p>The answer.</p></div></section>`;
      const state = extractor.readAnswerState('chatgpt');
      expect(state.userTurnCount).toBe(1);
      expect(state.text).toBe('The answer.');
    });

    it('treats a non-complete turn state as generating', () => {
      document.body.innerHTML = `
        <div data-talvt-turn-state="streaming">
          <div data-content-search-unit-key="x:1:assistant"><p>so far</p></div>
        </div>`;
      expect(extractor.readAnswerState('chatgpt').generating).toBe(true);
      document.querySelector('[data-talvt-turn-state]').setAttribute('data-talvt-turn-state', 'complete');
      expect(extractor.readAnswerState('chatgpt').generating).toBe(false);
    });

    it('reports marker counts, not text, when nothing is found', () => {
      document.body.innerHTML = '<main><div data-turn-key="t"><p>secret page text</p></div></main>';
      const state = extractor.readAnswerState('chatgpt');
      expect(state.hasAnswer).toBe(false);
      expect(state.probe).toMatchObject({ role: 0, unit: 0, turnKey: 1 });
      expect(JSON.stringify(state.probe)).not.toContain('secret');
    });
  });

  it('reports no answer while the new turn has no reply yet', () => {
    document.body.innerHTML = `
      <div data-message-author-role="user">q1</div>
      <div data-message-author-role="assistant"><div class="markdown">a1</div></div>
      <div data-message-author-role="user">q2</div>
      <button data-testid="stop-button"></button>`;
    const state = extractor.readAnswerState('chatgpt');
    expect(state.hasAnswer).toBe(false);
    expect(state.text).toBe('');
    expect(state.generating).toBe(true);
  });

  it('detects Claude streaming and skips thinking blocks', () => {
    document.body.innerHTML = `
      <div data-testid="user-message">Explain TCP</div>
      <div data-is-streaming="true"><div class="font-claude-response">
        <div data-testid="thinking-block">private reasoning</div>
        <p>TCP is a reliable transport protocol.</p>
      </div></div>`;
    const state = extractor.readAnswerState('claude');
    expect(state.generating).toBe(true);
    expect(state.text).toBe('TCP is a reliable transport protocol.');
    document.querySelector('[data-is-streaming]').setAttribute('data-is-streaming', 'false');
    expect(extractor.readAnswerState('claude').generating).toBe(false);
  });

  it('reads Gemini model-response elements without thoughts', () => {
    document.body.innerHTML = `
      <user-query>Capital of Australia?</user-query>
      <model-response><model-thoughts>hmm</model-thoughts>
        <message-content><div class="markdown"><p>Canberra.</p></div></message-content>
      </model-response>`;
    const state = extractor.readAnswerState('gemini');
    expect(state.text).toBe('Canberra.');
  });

  it('lists the links the page rendered in the latest reply, not in code or older turns', () => {
    document.body.innerHTML = `
      <user-query>old</user-query>
      <model-response><a href="https://old.example/">old source</a></model-response>
      <user-query>Capital of Australia?</user-query>
      <model-response>
        <message-content><div class="markdown"><p>Canberra.</p>
          <pre><code>{"url":"https://in-code.example/"}</code></pre>
          <code><a href="https://inline-code.example/">x</a></code>
        </div></message-content>
        <a href="https://www.google.com/url?q=https://example.gov.au/">example.gov.au</a>
        <a href="https://www.google.com/url?q=https://example.gov.au/">duplicate</a>
        <a href="javascript:alert(1)">bad</a>
      </model-response>`;
    const state = extractor.readAnswerState('gemini');
    expect(state.links).toEqual(['https://www.google.com/url?q=https://example.gov.au/']);
  });

  it('keeps Markdown structure: headings, lists, code blocks and tables', () => {
    document.body.innerHTML = `<div id="m">
      <h2>Steps</h2>
      <ol><li>Install</li><li>Run <code>npm test</code><ul><li>nested</li></ul></li></ol>
      <pre><code class="language-js">const a = 1;
console.log(a);</code></pre>
      <table><tr><th>k</th><th>v</th></tr><tr><td>x</td><td>1</td></tr></table>
    </div>`;
    const text = extractor.normalizeMessage(document.getElementById('m'));
    expect(text).toContain('## Steps');
    expect(text).toContain('1. Install');
    expect(text).toContain('2. Run `npm test`');
    expect(text).toContain('  - nested');
    expect(text).toContain('```js\nconst a = 1;\nconsole.log(a);\n```');
    expect(text).toContain('| k | v |');
    expect(text).toContain('| x | 1 |');
  });

  it('returns unsupported for providers without an adapter', () => {
    expect(extractor.readAnswerState('deepseek')).toEqual({ supported: false });
  });

  it('changes the text hash when the reply grows', () => {
    expect(extractor.hashText('abc')).not.toBe(extractor.hashText('abcd'));
    expect(extractor.hashText('abc')).toBe(extractor.hashText('abc'));
  });

  it('ignores extraction requests that do not come from the extension page', () => {
    const post = vi.spyOn(window.parent, 'postMessage');
    window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'PANELIZE_VERIFY_EXTRACT', context: 'multi-panel', requestId: 'r1' },
      origin: 'https://evil.example'
    }));
    expect(post).not.toHaveBeenCalled();
    post.mockRestore();
  });
});
