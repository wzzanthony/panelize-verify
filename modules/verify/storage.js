// Panelize Verify — local persistence.
//
// Sessions and the Gemini API key live in IndexedDB of the extension origin
// (chrome-extension://<id>). Content scripts run in the provider page's
// origin and web pages cannot reach it, unlike chrome.storage, which content
// scripts can read. Non-secret settings use chrome.storage.local.
// Nothing here is uploaded anywhere.

export const VERIFY_DB_NAME = 'PanelizeVerifyDB';
export const VERIFY_DB_VERSION = 1;
const SESSIONS = 'sessions';
const SECRETS = 'secrets';
const GEMINI_KEY_NAME = 'geminiApiKey';
export const SETTINGS_STORAGE_KEY = 'panelizeVerifySettings';
export const MAX_API_KEY_LENGTH = 512;

// The model ID is configuration, not code: pick any model that supports
// Google Search grounding. This default is a stable (non-preview) model.
// backend 'web' drives gemini.google.com with the user's login (free, no
// key); 'api' uses the Gemini API with Search grounding (needs billing).
export const VERIFY_BACKENDS = Object.freeze(['web', 'api']);
export const DEFAULT_VERIFY_SETTINGS = Object.freeze({
  backend: 'web',
  webConsentAcknowledged: false,
  webTimeoutMs: 300000,
  model: 'gemini-3.5-flash-lite',
  autoVerify: true,
  consentAcknowledged: false,
  maxClaimsPerAnswer: 8,
  maxAnswerChars: 12000,
  timeoutMs: 90000,
  redactModelNames: true
});

export const SUGGESTED_MODELS = Object.freeze([
  'gemini-3.5-flash-lite',
  'gemini-3.8-flash',
  'gemini-3.6-flash',
  'gemini-2.5-flash-lite'
]);

function clampInt(value, min, max, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number >= min && number <= max ? number : fallback;
}

export function normalizeSettings(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const defaults = DEFAULT_VERIFY_SETTINGS;
  return {
    backend: VERIFY_BACKENDS.includes(source.backend) ? source.backend : defaults.backend,
    webConsentAcknowledged: source.webConsentAcknowledged === true,
    webTimeoutMs: clampInt(source.webTimeoutMs, 60000, 900000, defaults.webTimeoutMs),
    model: typeof source.model === 'string' && /^[a-z0-9][a-z0-9.-]{0,79}$/i.test(source.model.trim())
      ? source.model.trim()
      : defaults.model,
    autoVerify: typeof source.autoVerify === 'boolean' ? source.autoVerify : defaults.autoVerify,
    consentAcknowledged: source.consentAcknowledged === true,
    maxClaimsPerAnswer: clampInt(source.maxClaimsPerAnswer, 1, 25, defaults.maxClaimsPerAnswer),
    maxAnswerChars: clampInt(source.maxAnswerChars, 1000, 100000, defaults.maxAnswerChars),
    timeoutMs: clampInt(source.timeoutMs, 10000, 300000, defaults.timeoutMs),
    redactModelNames: typeof source.redactModelNames === 'boolean'
      ? source.redactModelNames
      : defaults.redactModelNames
  };
}

export async function loadVerifySettings(storage = globalThis.chrome?.storage?.local) {
  if (!storage) return normalizeSettings(null);
  const result = await storage.get(SETTINGS_STORAGE_KEY);
  return normalizeSettings(result?.[SETTINGS_STORAGE_KEY]);
}

export async function saveVerifySettings(settings, storage = globalThis.chrome?.storage?.local) {
  const normalized = normalizeSettings(settings);
  await storage?.set({ [SETTINGS_STORAGE_KEY]: normalized });
  return normalized;
}

// ===== IndexedDB =====

function promisify(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function openDb(factory) {
  return new Promise((resolve, reject) => {
    const request = factory.open(VERIFY_DB_NAME, VERIFY_DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(SESSIONS)) {
        const store = db.createObjectStore(SESSIONS, { keyPath: 'id' });
        store.createIndex('createdAt', 'createdAt');
      }
      if (!db.objectStoreNames.contains(SECRETS)) {
        db.createObjectStore(SECRETS, { keyPath: 'name' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/**
 * @param {IDBFactory} [factory]
 */
export function createIndexedDbStore(factory = globalThis.indexedDB) {
  let dbPromise = null;
  const db = () => {
    if (!factory) return Promise.reject(new Error('IndexedDB is not available'));
    dbPromise = dbPromise || openDb(factory);
    return dbPromise;
  };
  async function run(storeName, mode, operation) {
    const database = await db();
    const transaction = database.transaction(storeName, mode);
    const result = await promisify(operation(transaction.objectStore(storeName)));
    await new Promise((resolve, reject) => {
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
    return result;
  }
  return {
    saveSession: session => run(SESSIONS, 'readwrite', store => store.put(structuredClone(session))),
    getSession: id => run(SESSIONS, 'readonly', store => store.get(id)),
    listSessions: async () => {
      const all = await run(SESSIONS, 'readonly', store => store.getAll());
      return all.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    },
    deleteSession: id => run(SESSIONS, 'readwrite', store => store.delete(id)),
    clearSessions: () => run(SESSIONS, 'readwrite', store => store.clear()),
    getApiKey: async () => (await run(SECRETS, 'readonly', store => store.get(GEMINI_KEY_NAME)))?.value || '',
    setApiKey: (value) => {
      const key = typeof value === 'string' ? value.trim() : '';
      if (key.length > MAX_API_KEY_LENGTH) {
        return Promise.reject(new Error('API key is too long'));
      }
      return key
        ? run(SECRETS, 'readwrite', store => store.put({ name: GEMINI_KEY_NAME, value: key }))
        : run(SECRETS, 'readwrite', store => store.delete(GEMINI_KEY_NAME));
    }
  };
}

/** Same interface, in memory; used by tests and as a fallback. */
export function createMemoryStore() {
  const sessions = new Map();
  let apiKey = '';
  return {
    saveSession: async session => { sessions.set(session.id, structuredClone(session)); },
    getSession: async id => (sessions.has(id) ? structuredClone(sessions.get(id)) : undefined),
    listSessions: async () => [...sessions.values()]
      .map(session => structuredClone(session))
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))),
    deleteSession: async id => { sessions.delete(id); },
    clearSessions: async () => { sessions.clear(); },
    getApiKey: async () => apiKey,
    setApiKey: async value => { apiKey = typeof value === 'string' ? value.trim() : ''; }
  };
}

/**
 * JSON export. The API key is never part of it; raw grounding metadata is
 * optional because it can be large.
 */
export function exportSessionsJson(sessions, { includeGroundingMetadata = false } = {}) {
  const cleaned = sessions.map(session => {
    if (includeGroundingMetadata || !session.geminiEvaluation) return session;
    const { groundingMetadata, ...rest } = session.geminiEvaluation;
    return { ...session, geminiEvaluation: rest };
  });
  return JSON.stringify({
    format: 'panelize-verify-sessions',
    version: 1,
    exportedAt: new Date().toISOString(),
    sessions: cleaned
  }, null, 2);
}
