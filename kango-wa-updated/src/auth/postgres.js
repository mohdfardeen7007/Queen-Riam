// kango-wa/src/auth/postgres.js
// Production-ready PostgreSQL auth state adapter for Baileys.
// Copyright (c) 2026 Hector Manuel. All rights reserved.
// Stores credentials and signal keys in a PostgreSQL database.
//
// Requires: pg  (npm install pg)
// Run createAuthTable() once to set up the required table.

'use strict';

const { loadBaileys } = require('../utils');

/**
 * Create the required PostgreSQL table for auth state storage.
 * Run this once during your app's setup/migration phase.
 *
 * @param {object} pool - A pg Pool instance
 */
async function createAuthTable(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS kango_auth_state (
      session_id  TEXT    NOT NULL,
      key_type    TEXT    NOT NULL,
      key_id      TEXT    NOT NULL,
      value       TEXT    NOT NULL,
      updated_at  TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (session_id, key_type, key_id)
    );

    CREATE INDEX IF NOT EXISTS idx_kango_auth_session
      ON kango_auth_state(session_id);
  `);
  console.log('[kango-wa] PostgreSQL auth table ready.');
}

/**
 * Create a PostgreSQL-backed auth state for Baileys.
 *
 * @param {object} pool          - A pg Pool instance
 * @param {string} [sessionId]   - Unique session identifier (default: 'kango-session')
 * @returns {Promise<{ state, saveCreds, clearSession }>}
 *
 * @example
 * const { Pool } = require('pg');
 * const pool = new Pool({ connectionString: process.env.DATABASE_URL });
 *
 * await createAuthTable(pool); // run once
 *
 * const { state, saveCreds, clearSession } = await usePostgresAuthState(pool, 'my-bot');
 *
 * const sock = makeWASocket({ auth: state });
 * sock.ev.on('creds.update', saveCreds);
 */
async function usePostgresAuthState(pool, sessionId = 'kango-session') {
  if (!pool) {
    throw new Error('[kango-wa] usePostgresAuthState requires a pg Pool instance');
  }

  const { initAuthCreds, BufferJSON } = loadBaileys();

  const CREDS_TYPE = '__creds__';
  const CREDS_ID = '__creds__';

  /**
   * Deserialize a value from the database.
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
   * Serialize a value for database storage.
   * @param {any} value
   * @returns {string}
   */
  function serialize(value) {
    return JSON.stringify(value, BufferJSON?.replacer);
  }

  /**
   * Read a single key from the store.
   * @param {string} type
   * @param {string} id
   * @returns {Promise<any>}
   */
  async function readKey(type, id) {
    const { rows } = await pool.query(
      'SELECT value FROM kango_auth_state WHERE session_id = $1 AND key_type = $2 AND key_id = $3',
      [sessionId, type, id]
    );
    return rows[0] ? deserialize(rows[0].value) : null;
  }

  /**
   * Write a single key to the store.
   * @param {string} type
   * @param {string} id
   * @param {any}    value
   */
  async function writeKey(type, id, value) {
    if (value === null || value === undefined) {
      await pool.query(
        'DELETE FROM kango_auth_state WHERE session_id = $1 AND key_type = $2 AND key_id = $3',
        [sessionId, type, id]
      );
    } else {
      await pool.query(
        `INSERT INTO kango_auth_state (session_id, key_type, key_id, value, updated_at)
         VALUES ($1, $2, $3, $4, NOW())
         ON CONFLICT (session_id, key_type, key_id)
         DO UPDATE SET value = $4, updated_at = NOW()`,
        [sessionId, type, id, serialize(value)]
      );
    }
  }

  // Load existing creds or initialize fresh ones
  const existingCreds = await readKey(CREDS_TYPE, CREDS_ID);
  let creds = existingCreds || initAuthCreds();

  const state = {
    creds,
    keys: {
      get: async (type, ids) => {
        if (!ids || ids.length === 0) return {};

        const placeholders = ids.map((_, i) => `$${i + 3}`).join(', ');
        const { rows } = await pool.query(
          `SELECT key_id, value FROM kango_auth_state
           WHERE session_id = $1 AND key_type = $2 AND key_id IN (${placeholders})`,
          [sessionId, type, ...ids]
        );

        const result = {};
        for (const row of rows) {
          result[row.key_id] = deserialize(row.value);
        }
        return result;
      },

      set: async (data) => {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');

          for (const [type, ids] of Object.entries(data)) {
            for (const [id, value] of Object.entries(ids)) {
              if (value) {
                await client.query(
                  `INSERT INTO kango_auth_state (session_id, key_type, key_id, value, updated_at)
                   VALUES ($1, $2, $3, $4, NOW())
                   ON CONFLICT (session_id, key_type, key_id)
                   DO UPDATE SET value = $4, updated_at = NOW()`,
                  [sessionId, type, id, serialize(value)]
                );
              } else {
                await client.query(
                  'DELETE FROM kango_auth_state WHERE session_id = $1 AND key_type = $2 AND key_id = $3',
                  [sessionId, type, id]
                );
              }
            }
          }

          await client.query('COMMIT');
        } catch (err) {
          await client.query('ROLLBACK');
          throw err;
        } finally {
          client.release();
        }
      },
    },
  };

  /**
   * Save updated credentials to PostgreSQL.
   * Bind this to the 'creds.update' event on your socket.
   */
  async function saveCreds() {
    await writeKey(CREDS_TYPE, CREDS_ID, state.creds);
  }

  /**
   * Delete all auth data for this session from PostgreSQL.
   * Call this when a device is logged out.
   */
  async function clearSession() {
    await pool.query(
      'DELETE FROM kango_auth_state WHERE session_id = $1',
      [sessionId]
    );
    console.log(`[kango-wa] PostgreSQL session "${sessionId}" cleared.`);
  }

  return { state, saveCreds, clearSession };
}

module.exports = { usePostgresAuthState, createAuthTable };
