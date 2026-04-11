// kango-wa/src/flows.js
// Conversation flow engine — manage multi-step chat interactions cleanly.
// Copyright (c) 2026 Hector Manuel. All rights reserved.
// Works with any in-memory or external store (Redis, PostgreSQL, etc.)

'use strict';

const DEFAULT_TTL = 30 * 60 * 1000; // 30 minutes

// ─── In-memory store (default, no dependencies) ──────────────────────────────

function createMemoryStore() {
  const store = new Map();

  return {
    async get(key) {
      const entry = store.get(key);
      if (!entry) return null;
      if (Date.now() > entry.expiresAt) {
        store.delete(key);
        return null;
      }
      return entry.value;
    },
    async set(key, value, ttlMs = DEFAULT_TTL) {
      store.set(key, { value, expiresAt: Date.now() + ttlMs });
    },
    async del(key) {
      store.delete(key);
    },
  };
}

// ─── Flow engine ─────────────────────────────────────────────────────────────

/**
 * Create a conversation flow engine.
 *
 * A "flow" is a named sequence of steps. Each step has a handler that
 * receives the user's message and returns the next step name (or null to end).
 *
 * @param {object} [options]
 * @param {object} [options.store]        - Custom store ({ get, set, del }). Defaults to in-memory.
 * @param {number} [options.ttl]          - Session TTL in ms. Default 30 minutes.
 * @param {string} [options.storePrefix]  - Key prefix for store entries.
 * @returns {object} Flow engine instance
 *
 * @example
 * const flows = createFlowEngine();
 *
 * flows.define('register', {
 *   start: async ({ reply }) => {
 *     await reply('What is your name?');
 *     return 'get_name';
 *   },
 *   get_name: async ({ text, data, reply, next, end }) => {
 *     data.name = text;
 *     await reply(`Nice to meet you, ${text}! What is your email?`);
 *     return 'get_email';
 *   },
 *   get_email: async ({ text, data, reply, end }) => {
 *     data.email = text;
 *     await reply(`Registered! Name: ${data.name}, Email: ${data.email}`);
 *     return null; // ends the flow
 *   },
 * });
 *
 * // In your message handler:
 * sock.ev.on('messages.upsert', async ({ messages }) => {
 *   const msg = messages[0];
 *   const jid = msg.key.remoteJid;
 *   const text = msg.message?.conversation || '';
 *
 *   const reply = (t) => sock.sendMessage(jid, { text: t });
 *
 *   if (text === 'register') {
 *     await flows.start(jid, 'register', { sock, reply });
 *   } else {
 *     await flows.handle(jid, text, { sock, reply });
 *   }
 * });
 */
function createFlowEngine(options = {}) {
  const {
    store = createMemoryStore(),
    ttl = DEFAULT_TTL,
    storePrefix = 'kango:flow:',
  } = options;

  const flowDefinitions = {};

  /**
   * Get the store key for a JID.
   * @param {string} jid
   * @returns {string}
   */
  function storeKey(jid) {
    return `${storePrefix}${jid}`;
  }

  /**
   * Get the current session for a JID.
   * @param {string} jid
   * @returns {Promise<object|null>}
   */
  async function getSession(jid) {
    return store.get(storeKey(jid));
  }

  /**
   * Save the session for a JID.
   * @param {string} jid
   * @param {object} session
   */
  async function saveSession(jid, session) {
    await store.set(storeKey(jid), session, ttl);
  }

  /**
   * Clear the session for a JID.
   * @param {string} jid
   */
  async function clearSession(jid) {
    await store.del(storeKey(jid));
  }

  /**
   * Define a named flow with its steps.
   *
   * Each step is an async function that receives a context object:
   *   { text, data, jid, sock, reply, end }
   * and returns the name of the next step, or null/undefined to end the flow.
   *
   * @param {string} name  - Flow name
   * @param {object} steps - Map of step name → async handler function
   */
  function define(name, steps) {
    if (!name || typeof name !== 'string') {
      throw new Error('[kango-wa] Flow name must be a non-empty string');
    }
    if (!steps || typeof steps !== 'object') {
      throw new Error('[kango-wa] Flow steps must be an object');
    }
    flowDefinitions[name] = steps;
  }

  /**
   * Start a flow for a user. Runs the first step immediately.
   *
   * @param {string} jid       - User JID
   * @param {string} flowName  - Flow name (must be defined with define())
   * @param {object} ctx       - Context to pass to steps ({ sock, reply, ... })
   * @param {object} [initialData] - Initial data to populate the session
   */
  async function start(jid, flowName, ctx = {}, initialData = {}) {
    const flow = flowDefinitions[flowName];
    if (!flow) {
      throw new Error(`[kango-wa] Flow "${flowName}" is not defined`);
    }

    const firstStep = Object.keys(flow)[0];
    if (!firstStep) {
      throw new Error(`[kango-wa] Flow "${flowName}" has no steps`);
    }

    const session = {
      flow: flowName,
      step: firstStep,
      data: { ...initialData },
      startedAt: Date.now(),
    };

    await saveSession(jid, session);
    await runStep(jid, session, '', ctx);
  }

  /**
   * Handle an incoming message for a user who is inside a flow.
   *
   * @param {string} jid   - User JID
   * @param {string} text  - Incoming message text
   * @param {object} ctx   - Context to pass to steps ({ sock, reply, ... })
   * @returns {Promise<boolean>} true if a flow was active, false if no active flow
   */
  async function handle(jid, text, ctx = {}) {
    const session = await getSession(jid);
    if (!session) return false;

    await runStep(jid, session, text, ctx);
    return true;
  }

  /**
   * Run a single step of the active flow.
   * @param {string} jid
   * @param {object} session
   * @param {string} text
   * @param {object} ctx
   */
  async function runStep(jid, session, text, ctx) {
    const flow = flowDefinitions[session.flow];
    if (!flow) {
      await clearSession(jid);
      return;
    }

    const stepFn = flow[session.step];
    if (typeof stepFn !== 'function') {
      console.warn(`[kango-wa] Step "${session.step}" not found in flow "${session.flow}". Ending flow.`);
      await clearSession(jid);
      return;
    }

    let nextStep;

    try {
      nextStep = await stepFn({
        text,
        data: session.data,
        jid,
        ...ctx,
      });
    } catch (err) {
      console.error(`[kango-wa] Error in flow "${session.flow}" step "${session.step}":`, err.message);
      await clearSession(jid);
      return;
    }

    if (!nextStep) {
      // Flow ended
      await clearSession(jid);
      return;
    }

    // Advance to the next step
    session.step = nextStep;
    await saveSession(jid, session);
  }

  /**
   * Check if a user is currently inside an active flow.
   * @param {string} jid
   * @returns {Promise<boolean>}
   */
  async function isActive(jid) {
    const session = await getSession(jid);
    return session !== null;
  }

  /**
   * Get the current session info for a user.
   * @param {string} jid
   * @returns {Promise<object|null>}
   */
  async function getSessionInfo(jid) {
    return getSession(jid);
  }

  /**
   * Forcefully end a user's active flow.
   * @param {string} jid
   */
  async function end(jid) {
    await clearSession(jid);
  }

  /**
   * List all defined flow names.
   * @returns {string[]}
   */
  function listFlows() {
    return Object.keys(flowDefinitions);
  }

  return { define, start, handle, isActive, getSessionInfo, end, listFlows };
}

module.exports = { createFlowEngine, createMemoryStore };
