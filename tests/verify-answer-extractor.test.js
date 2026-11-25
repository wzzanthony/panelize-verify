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
