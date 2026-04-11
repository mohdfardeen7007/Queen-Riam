// kango-wa/src/utils.js
// Shared utility helpers used across modules
// Copyright (c) 2026 Hector Manuel. All rights reserved.

'use strict';

const path = require('path');

/**
 * Try to load a supported Baileys package — whichever is installed.
 *
 * Resolution order (widest net possible so kango-wa works whether it is
 * installed normally, symlinked, or referenced via "file:" in package.json):
 *
 *  1. kango-wa's own directory  (standard install inside the app's node_modules)
 *  2. process.cwd()             (the bot's working directory — catches "file:" symlinks)
 *  3. require.main directory    (entry-point of the running process)
 *
 * Throws a clear, actionable error if none of the candidates are found anywhere.
 *
 * @returns {object} The Baileys module exports
 */
function loadBaileys() {
  const candidates = ['@whiskeysockets/baileys', 'baileys'];

  // Build a de-duped list of directories to search from, widest scope last.
  const searchDirs = [];

  // 1. kango-wa's own src directory (standard npm install)
  searchDirs.push(__dirname);

  // 2. The process working directory at the time the bot was started
  try { searchDirs.push(process.cwd()); } catch (_) {}

  // 3. Directory of the process entry-point (e.g. bot-test/index.js → bot-test/)
  try {
    if (require.main && require.main.filename) {
      searchDirs.push(path.dirname(require.main.filename));
    }
  } catch (_) {}

  // Try every (candidate × searchDir) combination
  for (const pkg of candidates) {
    for (const dir of searchDirs) {
      try {
        const resolved = require.resolve(pkg, { paths: [dir] });
        return require(resolved);
      } catch (_) {}
    }
  }

  throw new Error(
    '[kango-wa] No Baileys installation found.\n' +
    'Please install one of: @whiskeysockets/baileys or baileys\n' +
    `Searched from: ${[...new Set(searchDirs)].join(', ')}`
  );
}

/**
 * Determine if a JID belongs to a group.
 * @param {string} jid
 * @returns {boolean}
 */
function isGroup(jid) {
  if (!jid) return false;
  try {
    const { isJidGroup } = loadBaileys();
    if (typeof isJidGroup === 'function') return isJidGroup(jid);
  } catch (_) {}
  return jid.endsWith('@g.us');
}

/**
 * Sleep for a given number of milliseconds.
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Clamp a number between min and max.
 * @param {number} value
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

/**
 * Safely parse a JSON string. Returns null on failure.
 * @param {string} str
 * @returns {any}
 */
function safeParseJSON(str) {
  try {
    return JSON.parse(str);
  } catch (_) {
    return null;
  }
}

/**
 * Check if a value is a plain object.
 * @param {any} value
 * @returns {boolean}
 */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

module.exports = { loadBaileys, isGroup, sleep, clamp, safeParseJSON, isPlainObject };
