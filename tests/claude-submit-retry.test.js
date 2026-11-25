import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { dispatchMultiPanelMessage } from './helpers/multi-panel-messages.js';

const contentScriptSource = readFileSync(
  resolve(process.cwd(), 'content-scripts/text-injection-all-providers.js'),
  'utf8'
);

function markVisible(element) {
  Object.defineProperty(element, 'offsetParent', { configurable: true, get: () => document.body });
}

function createClaudeDom({ sendDisabled = false } = {}) {
  document.body.innerHTML = `
    <fieldset>
      <div class="ProseMirror" contenteditable="true" role="textbox"></div>
      <button id="claude-send" type="button" aria-label="Send message"><svg></svg></button>
    </fieldset>`;
  const editor = document.querySelector('.ProseMirror');
  const sendButton = document.getElementById('claude-send');
  [editor, sendButton].forEach(markVisible);
  sendButton.disabled = sendDisabled;
  return { editor, sendButton };
}

function send(text) {
  dispatchMultiPanelMessage({ type: 'INJECT_TEXT', text, autoSubmit: true, context: 'multi-panel' });
}

describe('Claude Send All submit', () => {
  beforeAll(() => {
    window.happyDOM.setURL('https://claude.ai/new');
    window.eval(contentScriptSource);
  });

  beforeEach(() => {
    vi.useFakeTimers();
    window.happyDOM.setURL('https://claude.ai/new');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('sends once when the first click works', async () => {
    const { editor, sendButton } = createClaudeDom();
    const clicks = vi.fn(() => { editor.textContent = ''; });
    sendButton.addEventListener('click', clicks);
    send('What is the capital of Australia?');
    await vi.advanceTimersByTimeAsync(10000);
    expect(clicks).toHaveBeenCalledTimes(1);
  });

  it('waits for a send button that is still disabled, then sends', async () => {
    const { editor, sendButton } = createClaudeDom({ sendDisabled: true });
    const clicks = vi.fn(() => { editor.textContent = ''; });
    sendButton.addEventListener('click', clicks);
    send('What is the capital of Australia?');
    await vi.advanceTimersByTimeAsync(1000);
    expect(clicks).not.toHaveBeenCalled();
    sendButton.disabled = false;
    await vi.advanceTimersByTimeAsync(10000);
    expect(clicks).toHaveBeenCalledTimes(1);
  });

  it('clicks again when the prompt is still in the composer after a click', async () => {
    const { editor, sendButton } = createClaudeDom();
    let count = 0;
    sendButton.addEventListener('click', () => {
      count += 1;
      if (count === 2) editor.textContent = ''; // the second click is the one that sends
    });
    send('What is the capital of Australia?');
    await vi.advanceTimersByTimeAsync(10000);
    expect(count).toBe(2);
  });

  it('presses Enter as a last resort when clicks never send', async () => {
    const { editor, sendButton } = createClaudeDom();
    const clicks = vi.fn();
    const enters = vi.fn();
    sendButton.addEventListener('click', clicks);
    editor.addEventListener('keydown', event => { if (event.key === 'Enter') enters(); });
    send('What is the capital of Australia?');
    await vi.advanceTimersByTimeAsync(15000);
    expect(clicks).toHaveBeenCalledTimes(4);
    expect(enters).toHaveBeenCalledTimes(1);
  });
});
