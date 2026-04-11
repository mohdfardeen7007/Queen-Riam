// kango-wa/src/queue.js
// Message queue with rate limiting to prevent WhatsApp account bans.
// Copyright (c) 2026 Hector Manuel. All rights reserved.
// Queues outgoing messages and sends them at a safe, controlled pace.

'use strict';

const { sleep } = require('./utils');

/**
 * Create a message queue with rate limiting.
 *
 * WhatsApp will flag or ban accounts that send too many messages too fast.
 * This queue ensures messages are sent with a minimum delay between each one,
 * with optional burst support and priority handling.
 *
 * @param {object} options
 * @param {number} [options.minDelay=500]    - Minimum ms between messages
 * @param {number} [options.maxDelay=1500]   - Maximum ms between messages (adds jitter)
 * @param {number} [options.maxQueueSize=500]- Max messages allowed in queue before rejecting
 * @param {Function} [options.onSent]        - Called after each message is sent
 * @param {Function} [options.onError]       - Called when a message fails to send
 * @returns {object} Queue instance
 *
 * @example
 * const queue = createMessageQueue({ minDelay: 800, maxDelay: 2000 });
 * await queue.add(sock, jid, { text: 'Hello!' });
 * await queue.add(sock, jid, { text: 'World!' }, { priority: 'high' });
 */
function createMessageQueue(options = {}) {
  const {
    minDelay = 500,
    maxDelay = 1500,
    maxQueueSize = 500,
    onSent = null,
    onError = null,
  } = options;

  const highPriorityQueue = [];
  const normalQueue = [];
  let processing = false;
  let totalSent = 0;
  let totalFailed = 0;

  /**
   * Get a random delay between minDelay and maxDelay.
   * @returns {number}
   */
  function getRandomDelay() {
    return minDelay + Math.random() * (maxDelay - minDelay);
  }

  /**
   * Get total queue size.
   * @returns {number}
   */
  function size() {
    return highPriorityQueue.length + normalQueue.length;
  }

  /**
   * Get the next item from the queue (high priority first).
   * @returns {object|undefined}
   */
  function dequeue() {
    return highPriorityQueue.shift() || normalQueue.shift();
  }

  /**
   * Process the queue one message at a time.
   */
  async function processQueue() {
    if (processing) return;
    processing = true;

    while (size() > 0) {
      const item = dequeue();
      if (!item) break;

      const { sock, jid, message, options: sendOpts, resolve, reject } = item;

      try {
        const result = await sock.sendMessage(jid, message, sendOpts || {});
        totalSent++;
        resolve(result);
        if (typeof onSent === 'function') onSent({ jid, message, result });
      } catch (err) {
        totalFailed++;
        reject(err);
        if (typeof onError === 'function') onError({ jid, message, error: err });
        else console.error('[kango-wa] Queue send error:', err.message);
      }

      if (size() > 0) {
        await sleep(getRandomDelay());
      }
    }

    processing = false;
  }

  /**
   * Add a message to the queue.
   *
   * @param {object} sock          - Baileys socket
   * @param {string} jid           - Destination JID
   * @param {object} message       - Message content (same as sock.sendMessage)
   * @param {object} [opts]
   * @param {string} [opts.priority='normal'] - 'high' or 'normal'
   * @param {object} [opts.sendOptions]       - Extra options passed to sock.sendMessage
   * @returns {Promise<object>} Resolves when the message is sent
   */
  function add(sock, jid, message, opts = {}) {
    if (size() >= maxQueueSize) {
      return Promise.reject(
        new Error(`[kango-wa] Queue is full (max ${maxQueueSize} messages)`)
      );
    }

    return new Promise((resolve, reject) => {
      const item = {
        sock,
        jid,
        message,
        options: opts.sendOptions,
        resolve,
        reject,
      };

      if (opts.priority === 'high') {
        highPriorityQueue.push(item);
      } else {
        normalQueue.push(item);
      }

      processQueue();
    });
  }

  /**
   * Add multiple messages to the queue at once.
   * Each message is an object: { sock, jid, message, opts }
   *
   * @param {Array} messages
   * @returns {Promise<Array>} Resolves when all messages are sent
   */
  function addBatch(messages) {
    return Promise.all(
      messages.map(({ sock, jid, message, opts }) => add(sock, jid, message, opts))
    );
  }

  /**
   * Clear all pending messages from the queue.
   * Already-in-flight messages will still complete.
   */
  function clear() {
    const dropped = size();
    highPriorityQueue.length = 0;
    normalQueue.length = 0;
    console.log(`[kango-wa] Queue cleared. ${dropped} messages dropped.`);
  }

  /**
   * Get queue stats.
   * @returns {object}
   */
  function stats() {
    return {
      pending: size(),
      highPriority: highPriorityQueue.length,
      normal: normalQueue.length,
      totalSent,
      totalFailed,
      processing,
    };
  }

  return { add, addBatch, clear, size, stats };
}

module.exports = { createMessageQueue };
