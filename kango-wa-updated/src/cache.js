// kango-wa/src/cache.js
// Group metadata cache — avoids redundant WhatsApp API calls for group info.
// Copyright (c) 2026 Hector Manuel. All rights reserved.
// Every group message triggers a metadata fetch by default; this caches the result.

'use strict';

const { isGroup } = require('./utils');

/**
 * Create a group metadata cache.
 *
 * Pass the returned cachedGroupMetadata function into your makeWASocket config.
 * The cache automatically refreshes stale entries in the background.
 *
 * @param {object} [options]
 * @param {number} [options.ttl=300000]          - Cache TTL in ms (default 5 minutes)
 * @param {number} [options.maxEntries=500]      - Max groups to cache
 * @param {boolean} [options.backgroundRefresh]  - Refresh stale entries in background (default true)
 * @returns {object} { cachedGroupMetadata, getCache, clearCache, stats }
 *
 * @example
 * const { cachedGroupMetadata } = createGroupCache({ ttl: 5 * 60 * 1000 });
 *
 * const sock = makeWASocket({
 *   auth: state,
 *   cachedGroupMetadata,  // <-- plug directly into socket config
 * });
 */
function createGroupCache(options = {}) {
  const {
    ttl = 5 * 60 * 1000,
    maxEntries = 500,
    backgroundRefresh = true,
  } = options;

  // Map of jid -> { metadata, fetchedAt }
  const cache = new Map();
  let hits = 0;
  let misses = 0;

  /**
   * Check if a cache entry is still fresh.
   * @param {object} entry
   * @returns {boolean}
   */
  function isFresh(entry) {
    return Date.now() - entry.fetchedAt < ttl;
  }

  /**
   * Evict the oldest entry if the cache is full.
   */
  function evictIfFull() {
    if (cache.size >= maxEntries) {
      const oldestKey = cache.keys().next().value;
      cache.delete(oldestKey);
    }
  }

  /**
   * The function to pass into makeWASocket({ cachedGroupMetadata }).
   * Baileys calls this with a jid and a fetchFn to retrieve fresh metadata.
   *
   * @param {string}   jid
   * @param {Function} fetchFn - Baileys-provided function to fetch real metadata
   * @returns {Promise<object>}
   */
  async function cachedGroupMetadata(jid, fetchFn) {
    if (!isGroup(jid)) return null;

    const entry = cache.get(jid);

    if (entry && isFresh(entry)) {
      hits++;
      return entry.metadata;
    }

    // Cache miss or stale entry
    misses++;

    if (entry && !isFresh(entry) && backgroundRefresh) {
      // Return stale data immediately, refresh in background
      refreshInBackground(jid, fetchFn);
      return entry.metadata;
    }

    // No entry or background refresh disabled — fetch synchronously
    return fetchAndStore(jid, fetchFn);
  }

  /**
   * Fetch metadata from WhatsApp and store it in the cache.
   * @param {string}   jid
   * @param {Function} fetchFn
   * @returns {Promise<object>}
   */
  async function fetchAndStore(jid, fetchFn) {
    try {
      const metadata = await fetchFn(jid);
      evictIfFull();
      cache.set(jid, { metadata, fetchedAt: Date.now() });
      return metadata;
    } catch (err) {
      console.error(`[kango-wa] Failed to fetch group metadata for ${jid}:`, err.message);
      // Return stale data if available
      return cache.get(jid)?.metadata || null;
    }
  }

  /**
   * Refresh a cache entry in the background without blocking.
   * @param {string}   jid
   * @param {Function} fetchFn
   */
  function refreshInBackground(jid, fetchFn) {
    fetchAndStore(jid, fetchFn).catch(() => {
      // Silently fail — we already returned stale data
    });
  }

  /**
   * Manually prime the cache with known group metadata.
   * Useful on bot startup if you already have stored metadata.
   * @param {string} jid
   * @param {object} metadata
   */
  function prime(jid, metadata) {
    evictIfFull();
    cache.set(jid, { metadata, fetchedAt: Date.now() });
  }

  /**
   * Manually invalidate a cached entry (e.g., when group participants change).
   * @param {string} jid
   */
  function invalidate(jid) {
    cache.delete(jid);
  }

  /**
   * Get the raw cache map (for inspection/debugging).
   * @returns {Map}
   */
  function getCache() {
    return cache;
  }

  /**
   * Clear the entire cache.
   */
  function clearCache() {
    cache.clear();
    hits = 0;
    misses = 0;
  }

  /**
   * Get cache statistics.
   * @returns {object}
   */
  function stats() {
    const total = hits + misses;
    return {
      entries: cache.size,
      hits,
      misses,
      hitRate: total > 0 ? `${((hits / total) * 100).toFixed(1)}%` : '0%',
      maxEntries,
      ttlMs: ttl,
    };
  }

  return { cachedGroupMetadata, prime, invalidate, getCache, clearCache, stats };
}

module.exports = { createGroupCache };
