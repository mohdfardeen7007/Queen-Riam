// kango-wa/src/reconnect.js
// Smart auto-reconnect with exponential backoff for Baileys sockets.
// Copyright (c) 2026 Hector Manuel. All rights reserved.
// Handles every disconnect reason cleanly so you don't write this boilerplate yourself.

'use strict';

const { sleep, clamp } = require('./utils');

// Baileys DisconnectReason codes
const DisconnectReason = {
  badSession: 500,
  connectionClosed: 428,
  connectionLost: 408,
  connectionReplaced: 440,
  loggedOut: 401,
  multideviceMismatch: 411,
  restartRequired: 515,
  timedOut: 408,
};

/**
 * Create a managed auto-reconnect handler for a Baileys socket.
 *
 * @param {object}   options
 * @param {Function} options.connect         - Function that creates and returns a new socket
 * @param {number}   [options.maxRetries=10] - Max reconnect attempts before giving up (0 = unlimited)
 * @param {number}   [options.baseDelay=2000]- Initial delay in ms before first retry
 * @param {number}   [options.maxDelay=60000]- Maximum delay between retries
 * @param {Function} [options.onReconnect]   - Called each time a reconnect attempt starts (attempt #)
 * @param {Function} [options.onGiveUp]      - Called when all retries are exhausted
 * @param {Function} [options.onLoggedOut]   - Called when WhatsApp logs the device out
 * @returns {object} { start, stop, getSocket }
 *
 * @example
 * const manager = createReconnectManager({
 *   connect: () => makeWASocket({ auth: state }),
 *   maxRetries: 5,
 *   onLoggedOut: () => console.log('Logged out — scan QR again'),
 * });
 * manager.start();
 */
function createReconnectManager(options = {}) {
  const {
    connect,
    maxRetries = 10,
    baseDelay = 2000,
    maxDelay = 60000,
    onReconnect = null,
    onGiveUp = null,
    onLoggedOut = null,
  } = options;

  if (typeof connect !== 'function') {
    throw new Error('[kango-wa] createReconnectManager requires a connect function');
  }

  let currentSocket = null;
  let attempts = 0;
  let running = false;
  let stopped = false;

  /**
   * Calculate delay for a given attempt using exponential backoff + jitter.
   * @param {number} attempt
   * @returns {number} delay in ms
   */
  function getDelay(attempt) {
    const exponential = baseDelay * Math.pow(2, attempt);
    const jitter = Math.random() * 1000;
    return clamp(exponential + jitter, baseDelay, maxDelay);
  }

  /**
   * Handle a connection update event from the socket.
   * @param {object} update
   */
  async function handleConnectionUpdate(update) {
    const { connection, lastDisconnect } = update;

    if (connection === 'open') {
      console.log('[kango-wa] Connected to WhatsApp');
      attempts = 0; // Reset on successful connection
      return;
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const reason = Object.keys(DisconnectReason).find(
        (k) => DisconnectReason[k] === statusCode
      ) || 'unknown';

      console.log(`[kango-wa] Connection closed. Reason: ${reason} (${statusCode})`);

      // Permanent logout — do not retry
      if (statusCode === DisconnectReason.loggedOut) {
        console.log('[kango-wa] Device was logged out. Manual re-authentication required.');
        if (typeof onLoggedOut === 'function') onLoggedOut();
        stopped = true;
        return;
      }

      // Connection replaced by another device — do not retry
      if (statusCode === DisconnectReason.connectionReplaced) {
        console.log('[kango-wa] Connection replaced by another session. Stopping.');
        stopped = true;
        return;
      }

      if (!stopped) {
        await attemptReconnect();
      }
    }
  }

  /**
   * Attempt to reconnect with exponential backoff.
   */
  async function attemptReconnect() {
    if (stopped) return;
    if (maxRetries > 0 && attempts >= maxRetries) {
      console.log(`[kango-wa] Max retries (${maxRetries}) reached. Giving up.`);
      if (typeof onGiveUp === 'function') onGiveUp(attempts);
      return;
    }

    attempts++;
    const delay = getDelay(attempts - 1);

    console.log(`[kango-wa] Reconnecting in ${Math.round(delay / 1000)}s (attempt ${attempts}${maxRetries > 0 ? `/${maxRetries}` : ''})...`);

    if (typeof onReconnect === 'function') onReconnect(attempts);

    await sleep(delay);

    if (!stopped) {
      start();
    }
  }

  /**
   * Start or restart the socket connection.
   */
  function start() {
    if (stopped) {
      console.warn('[kango-wa] Manager is stopped. Call reset() before starting again.');
      return;
    }

    running = true;

    try {
      currentSocket = connect();

      if (!currentSocket) {
        throw new Error('[kango-wa] connect() did not return a socket');
      }

      currentSocket.ev.on('connection.update', handleConnectionUpdate);
    } catch (err) {
      console.error('[kango-wa] Error during connect():', err.message);
      attemptReconnect();
    }
  }

  /**
   * Stop the reconnect manager permanently.
   */
  function stop() {
    stopped = true;
    running = false;
    console.log('[kango-wa] Reconnect manager stopped.');
  }

  /**
   * Reset the manager so it can be started again after stopping.
   */
  function reset() {
    stopped = false;
    running = false;
    attempts = 0;
  }

  /**
   * Get the currently active socket instance.
   * @returns {object|null}
   */
  function getSocket() {
    return currentSocket;
  }

  /**
   * Get the current reconnect attempt count.
   * @returns {number}
   */
  function getAttempts() {
    return attempts;
  }

  return { start, stop, reset, getSocket, getAttempts };
}

module.exports = { createReconnectManager, DisconnectReason };
