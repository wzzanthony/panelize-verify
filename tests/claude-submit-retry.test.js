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

  it('tries Enter in the editor when a click leaves the prompt in place, then clicks again', async () => {
    const { editor, sendButton } = createClaudeDom();
    let count = 0;
    const enters = vi.fn();
    editor.addEventListener('keydown', event => { if (event.key === 'Enter') enters(); });
    sendButton.addEventListener('click', () => {
      count += 1;
      if (count === 2) editor.textContent = ''; // the second click is the one that sends
    });
    send('What is the capital of Australia?');
    await vi.advanceTimersByTimeAsync(10000);
    expect(count).toBe(2);
    expect(enters).toHaveBeenCalledTimes(1);
  });

  it('sends with Enter when clicking does not', async () => {
    const { editor, sendButton } = createClaudeDom();
    const clicks = vi.fn();
    sendButton.addEventListener('click', clicks);
    editor.addEventListener('keydown', event => { if (event.key === 'Enter') editor.textContent = ''; });
    send('What is the capital of Australia?');
    await vi.advanceTimersByTimeAsync(10000);
    expect(clicks).toHaveBeenCalledTimes(1);
    expect(editor.textContent).toBe('');
  });

  it('stops after a fixed number of tries when nothing sends', async () => {
    const { editor, sendButton } = createClaudeDom();
    const clicks = vi.fn();
    const enters = vi.fn();
    sendButton.addEventListener('click', clicks);
    editor.addEventListener('keydown', event => { if (event.key === 'Enter') enters(); });
    send('What is the capital of Australia?');
    await vi.advanceTimersByTimeAsync(20000);
    expect(clicks).toHaveBeenCalledTimes(3);
    expect(enters).toHaveBeenCalledTimes(2);
  });

  it('never clicks the composer\'s "+" button in place of Send', async () => {
    document.body.innerHTML = `
      <fieldset>
        <button id="add" type="button" aria-label="Add files, connectors, and more"><svg></svg></button>
        <div class="ProseMirror" contenteditable="true" role="textbox"></div>
      </fieldset>`;
    const editor = document.querySelector('.ProseMirror');
    const add = document.getElementById('add');
    [editor, add].forEach(markVisible);
    const addClicks = vi.fn();
    add.addEventListener('click', addClicks);
    editor.addEventListener('keydown', event => { if (event.key === 'Enter') editor.textContent = ''; });
    send('What is the capital of Australia?');
    await vi.advanceTimersByTimeAsync(10000);
    expect(addClicks).not.toHaveBeenCalled();
    expect(editor.textContent).toBe('');
  });

  it('clicks the last icon button of the composer when Send has no label', async () => {
    document.body.innerHTML = `
      <fieldset>
        <button id="add" type="button" aria-label="Add files"><svg></svg></button>
        <div class="ProseMirror" contenteditable="true" role="textbox"></div>
        <button id="send" type="button"><svg></svg></button>
      </fieldset>`;
    const editor = document.querySelector('.ProseMirror');
    const add = document.getElementById('add');
    const sendButton = document.getElementById('send');
    [editor, add, sendButton].forEach(markVisible);
    const addClicks = vi.fn();
    add.addEventListener('click', addClicks);
    sendButton.addEventListener('click', () => { editor.textContent = ''; });
    send('What is the capital of Australia?');
    await vi.advanceTimersByTimeAsync(10000);
    expect(addClicks).not.toHaveBeenCalled();
    expect(editor.textContent).toBe('');
  });
});
