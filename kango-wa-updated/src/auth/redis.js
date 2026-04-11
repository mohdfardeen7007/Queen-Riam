// kango-wa/src/auth/redis.js
// Production-ready Redis auth state adapter for Baileys.
// Copyright (c) 2026 Hector Manuel. All rights reserved.
// Replaces the file-based useMultiFileAuthState which Baileys marks as "demo only".
//
// Requires: ioredis  (npm install ioredis)

'use strict';

const { loadBaileys } = require('../utils');

/**
 * Create a Redis-backed auth state for Baileys.
 * Stores all credentials and signal keys in Redis under a namespaced prefix.
 *
 * @param {object} redisClient   - An ioredis client instance
 * @param {string} [sessionId]   - Unique session identifier (default: 'kango-session')
 * @returns {Promise<{ state, saveCreds, clearSession }>}
 *
 * @example
 * const Redis = require('ioredis');
 * const redis = new Redis({ host: 'localhost', port: 6379 });
 *
 * const { state, saveCreds, clearSession } = await useRedisAuthState(redis, 'my-bot');
 *
 * const sock = makeWASocket({ auth: state });
 * sock.ev.on('creds.update', saveCreds);
 *
 * // On logout:
 * await clearSession();
 */
async function useRedisAuthState(redisClient, sessionId = 'kango-session') {
  if (!redisClient) {
    throw new Error('[kango-wa] useRedisAuthState requires an ioredis client instance');
  }

  const { initAuthCreds, BufferJSON, proto } = loadBaileys();

  const KEY_PREFIX = `kango:auth:${sessionId}`;
  const CREDS_KEY = `${KEY_PREFIX}:creds`;

  /**
   * Build the Redis hash field name for a signal key.
   * @param {string} type
   * @param {string} id
   * @returns {string}
   */
  function keyField(type, id) {
    return `${type}:${id}`;
  }

  /**
   * Deserialize a value from Redis.
   * @param {string|null} raw
   * @returns {any}
   */
  function deserialize(raw) {
    if (!raw) return null;
    try {
      return JSON.parse(raw, BufferJSON?.reviver);
    } catch (_) {
      return null;
    }
  }

  /**
   * Serialize a value for Redis storage.
   * @param {any} value
   * @returns {string}
   */
  function serialize(value) {
    return JSON.stringify(value, BufferJSON?.replacer);
  }

  // Load existing creds or initialize fresh ones
  const rawCreds = await redisClient.get(CREDS_KEY);
  let creds = rawCreds ? deserialize(rawCreds) : initAuthCreds();

  const state = {
    creds,
    keys: {
      get: async (type, ids) => {
        const fields = ids.map((id) => keyField(type, id));
        const values = await redisClient.hmget(`${KEY_PREFIX}:keys`, ...fields);

        const result = {};
        ids.forEach((id, index) => {
          const raw = values[index];
          if (raw) result[id] = deserialize(raw);
        });
        return result;
      },

      set: async (data) => {
        const pipeline = redisClient.pipeline();

        for (const [type, ids] of Object.entries(data)) {
          for (const [id, value] of Object.entries(ids)) {
            if (value) {
              pipeline.hset(`${KEY_PREFIX}:keys`, keyField(type, id), serialize(value));
            } else {
              pipeline.hdel(`${KEY_PREFIX}:keys`, keyField(type, id));
            }
          }
        }

        await pipeline.exec();
      },
    },
  };

  /**
   * Save updated credentials to Redis.
   * Bind this to the 'creds.update' event on your socket.
   */
  async function saveCreds() {
    await redisClient.set(CREDS_KEY, serialize(state.creds));
  }

  /**
   * Delete all auth data for this session from Redis.
   * Call this when a device is logged out.
   */
  async function clearSession() {
    const pipeline = redisClient.pipeline();
    pipeline.del(CREDS_KEY);
    pipeline.del(`${KEY_PREFIX}:keys`);
    await pipeline.exec();
    console.log(`[kango-wa] Redis session "${sessionId}" cleared.`);
  }

  return { state, saveCreds, clearSession };
}

module.exports = { useRedisAuthState };
