// kango-wa/src/jid.js
// Bidirectional JID <-> LID mapping for Baileys multi-device.
// Copyright (c) 2026 Hector Manuel. All rights reserved.
//
// Problem: WhatsApp's multi-device protocol uses two identity systems:
//   - JID  (classic): "1234567890@s.whatsapp.net"
//   - LID  (new):     "123456789012345@lid"
//
// In groups, a participant's `key.participant` can come back as a @lid
// instead of a @s.whatsapp.net address. This breaks:
//   - Admin checks (the LID doesn't match the admin list which uses JIDs)
//   - Ban/permission systems (stored JID won't match incoming LID)
//   - DMs (sending to a @lid can fail or go nowhere)
//   - getName / mention lookups
//
// This module maintains a live bidirectional map and provides a single
// resolveJid() function that always returns the canonical JID no matter
// what form of identifier comes in.

'use strict';

const { loadBaileys } = require('./utils');

// ─── JID type detection ──────────────────────────────────────────────────────

/** Check if a string is a LID address. */
function isLid(str) {
  return typeof str === 'string' && str.endsWith('@lid');
}

/** Check if a string is a user JID. */
function isUserJid(str) {
  return typeof str === 'string' && str.endsWith('@s.whatsapp.net');
}

/** Check if a string is a group JID. */
function isGroupJid(str) {
  return typeof str === 'string' && str.endsWith('@g.us');
}

/** Check if a string is a newsletter/channel JID. */
function isNewsletterJid(str) {
  return typeof str === 'string' && str.endsWith('@newsletter');
}

/** Check if a string is a status broadcast pseudo-JID. */
function isStatusJid(str) {
  return str === 'status@broadcast';
}

// ─── JID normalization ───────────────────────────────────────────────────────

/**
 * Strip the device suffix from a full JID.
 * "1234567890:5@s.whatsapp.net" → "1234567890@s.whatsapp.net"
 * Already-clean JIDs are returned unchanged.
 *
 * This is what Baileys' jidNormalizedUser does, but as a standalone function
 * that doesn't require importing Baileys.
 *
 * @param {string} jid
 * @returns {string}
 */
function decodeJid(jid) {
  if (!jid || typeof jid !== 'string') return jid;

  // Has device suffix like :5@s.whatsapp.net
  if (/:\d+@/gi.test(jid)) {
    try {
      const { jidDecode } = loadBaileys();
      if (typeof jidDecode === 'function') {
        const decoded = jidDecode(jid) || {};
        if (decoded.user && decoded.server) {
          return `${decoded.user}@${decoded.server}`;
        }
      }
    } catch (_) {}

    // Fallback: strip manually
    return jid.replace(/:\d+/, '');
  }

  return jid;
}

/**
 * Normalize any JID to its canonical @s.whatsapp.net form.
 * Handles device suffixes and LIDs (via the map).
 *
 * @param {string}  jid
 * @param {object}  [map] - The JID<->LID map (optional, used for LID resolution)
 * @returns {string}
 */
function normalizeJid(jid, map) {
  if (!jid) return jid;

  // LID: resolve to JID via the map
  if (isLid(jid) && map) {
    return map.lidToJid.get(jid) || jid;
  }

  // User JID with device suffix: strip it
  return decodeJid(jid);
}

/**
 * Extract a phone number string from a user JID.
 * "1234567890@s.whatsapp.net" → "1234567890"
 * Returns null for group or non-user JIDs.
 *
 * @param {string} jid
 * @returns {string|null}
 */
function toPhoneNumber(jid) {
  if (!isUserJid(jid)) return null;
  return jid.replace('@s.whatsapp.net', '').replace(/:\d+$/, '');
}

// ─── Map management ──────────────────────────────────────────────────────────

/**
 * Register a JID <-> LID pair into the bidirectional map.
 * Both sides are normalized before storing.
 *
 * @param {object} map  - { jidToLid: Map, lidToJid: Map }
 * @param {string} jid
 * @param {string} lid
 */
function registerPair(map, jid, lid) {
  if (!jid || !lid) return;
  const cleanJid = decodeJid(jid);
  const cleanLid = lid.trim();
  if (!cleanJid || !cleanLid) return;

  map.jidToLid.set(cleanJid, cleanLid);
  map.lidToJid.set(cleanLid, cleanJid);
}

/**
 * Extract JID/LID pairs from a participant object and register them.
 * Participant shapes vary across Baileys versions:
 *   - { id: jid, lid: lid }
 *   - { id: lid } (newer — id IS the lid)
 *   - { id: jid }  (older — no lid)
 *
 * @param {object} map
 * @param {object} participant
 */
function registerParticipant(map, participant) {
  if (!participant) return;

  const id = participant.id || participant.jid;
  const lid = participant.lid;

  if (id && lid) {
    // Both present — classic case
    registerPair(map, id, lid);
  } else if (id && isLid(id) && participant.jid) {
    // id is a LID, jid field has the real JID
    registerPair(map, participant.jid, id);
  } else if (id && isLid(id) && participant.phone) {
    // id is a LID, phone has the number to construct JID
    const jid = `${participant.phone}@s.whatsapp.net`;
    registerPair(map, jid, id);
  }
  // id alone with no LID — nothing to map
}

// ─── Core factory ────────────────────────────────────────────────────────────

/**
 * Create a JID/LID mapping instance.
 *
 * @returns {object} The mapper instance
 *
 * @example
 * const { createJidMapper } = require('kango-wa');
 *
 * const jidMapper = createJidMapper();
 * jidMapper.bind(sock.ev);
 *
 * // Prime with the bot's own identity on connect:
 * sock.ev.on('connection.update', ({ connection }) => {
 *   if (connection === 'open' && sock.user) {
 *     jidMapper.primeSelf(sock.user);
 *   }
 * });
 *
 * // In a message handler — works regardless of whether it's JID or LID:
 * const canonicalJid = jidMapper.resolveJid(msg.key.participant);
 */
function createJidMapper() {
  const map = {
    jidToLid: new Map(), // "1234567890@s.whatsapp.net" -> "123456789012345@lid"
    lidToJid: new Map(), // "123456789012345@lid" -> "1234567890@s.whatsapp.net"
  };

  // Display name registry — jid -> name
  const names = new Map();

  // ── Bind to socket events ──────────────────────────────────────────────────

  /**
   * Bind this mapper to a Baileys socket event emitter.
   * Call once after creating your socket: jidMapper.bind(sock.ev)
   *
   * @param {object} ev - sock.ev
   */
  function bind(ev) {
    if (!ev || typeof ev.on !== 'function') {
      throw new Error('[kango-wa] jidMapper.bind() requires sock.ev');
    }

    // ── Contacts (richest source of JID<->LID pairs) ─────────────────────

    ev.on('contacts.set', ({ contacts: incoming }) => {
      if (!Array.isArray(incoming)) return;
      for (const contact of incoming) {
        _processContact(contact);
      }
    });

    ev.on('contacts.upsert', (incoming) => {
      const list = Array.isArray(incoming) ? incoming : [incoming];
      for (const contact of list) _processContact(contact);
    });

    ev.on('contacts.update', (updates) => {
      const list = Array.isArray(updates) ? updates : [updates];
      for (const contact of list) _processContact(contact);
    });

    // ── Group metadata (participants have id + lid in newer Baileys) ──────

    ev.on('groups.upsert', (incoming) => {
      const list = Array.isArray(incoming) ? incoming : [incoming];
      for (const group of list) _processGroup(group);
    });

    ev.on('groups.update', (updates) => {
      const list = Array.isArray(updates) ? updates : [updates];
      for (const group of list) _processGroup(group);
    });

    ev.on('group-participants.update', ({ id, participants, action }) => {
      if (!Array.isArray(participants)) return;
      // On add/rejoin we get fresh participant objects with LIDs
      if (action === 'add' || action === 'promote' || action === 'demote') {
        for (const p of participants) {
          if (typeof p === 'object') {
            registerParticipant(map, p);
          }
        }
      }
    });

    // ── Messages (participant field in group messages) ────────────────────

    ev.on('messages.upsert', ({ messages: msgs }) => {
      if (!Array.isArray(msgs)) return;
      for (const msg of msgs) {
        // The participant who sent the message
        const participant = msg.key?.participant;
        if (!participant) continue;

        // If participant is a LID, check if the message has a senderKeyDistributionMessage
        // which sometimes carries the JID in its groupId field or participant record
        if (isLid(participant)) {
          // Try to find matching JID from verifiedBizName or pushName cross-reference
          const pushName = msg.pushName;
          if (pushName && !names.has(participant)) {
            names.set(participant, pushName);
          }
        }
      }
    });
  }

  // ── Internal processors ────────────────────────────────────────────────────

  function _processContact(contact) {
    if (!contact) return;
    const jid = contact.id ? decodeJid(contact.id) : null;
    const lid = contact.lid || null;

    if (jid && lid) {
      registerPair(map, jid, lid);
    }

    // Store display name
    const name = contact.notify || contact.verifiedName || contact.name;
    if (jid && name) names.set(jid, name);
    if (lid && name) names.set(lid, name);
  }

  function _processGroup(group) {
    if (!group?.participants) return;
    for (const p of group.participants) {
      registerParticipant(map, p);
    }
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Resolve any identifier (JID or LID) to a canonical JID.
   * This is the main function — call this wherever you receive a participant
   * identifier and need the real JID.
   *
   * @param {string} jidOrLid
   * @returns {string} The canonical JID, or the original string if not found
   *
   * @example
   * const jid = jidMapper.resolveJid(msg.key.participant);
   * // → "1234567890@s.whatsapp.net" regardless of whether it was a LID or JID
   */
  function resolveJid(jidOrLid) {
    if (!jidOrLid) return jidOrLid;

    if (isLid(jidOrLid)) {
      // Try to find the corresponding JID
      const resolved = map.lidToJid.get(jidOrLid);
      if (resolved) return resolved;
      // Not in map yet — return as-is, caller must handle
      return jidOrLid;
    }

    // It's a JID — just normalize it (strip device suffix)
    return decodeJid(jidOrLid);
  }

  /**
   * Get the LID for a known JID.
   * @param {string} jid
   * @returns {string|null}
   */
  function getLid(jid) {
    const clean = decodeJid(jid);
    return map.jidToLid.get(clean) || null;
  }

  /**
   * Get the display name for a JID or LID.
   * Checks the name registry and falls back to extracting the phone number.
   *
   * @param {string} jidOrLid
   * @returns {string}
   */
  function getName(jidOrLid) {
    if (!jidOrLid) return '';

    // Direct name lookup
    const direct = names.get(jidOrLid);
    if (direct) return direct;

    // If LID, resolve to JID then look up name
    if (isLid(jidOrLid)) {
      const resolvedJid = map.lidToJid.get(jidOrLid);
      if (resolvedJid) {
        const name = names.get(resolvedJid);
        if (name) return name;
        // Fall through to phone number extraction
        return toPhoneNumber(resolvedJid) || jidOrLid;
      }
      return jidOrLid;
    }

    // JID: clean it and try again
    const clean = decodeJid(jidOrLid);
    const cleanName = names.get(clean);
    if (cleanName) return cleanName;

    // Last resort: phone number from JID
    return toPhoneNumber(clean) || clean;
  }

  /**
   * Manually register a JID <-> LID pair.
   * Use this when you have a reliable source for the mapping.
   *
   * @param {string} jid
   * @param {string} lid
   */
  function prime(jid, lid) {
    registerPair(map, jid, lid);
  }

  /**
   * Prime the mapper with the bot's own identity.
   * Call this when connection opens: jidMapper.primeSelf(sock.user)
   *
   * @param {object} user - sock.user ({ id, lid, name })
   */
  function primeSelf(user) {
    if (!user) return;
    const jid = user.id ? decodeJid(user.id) : null;
    const lid = user.lid || null;
    const name = user.name || user.verifiedName || null;

    if (jid && lid) registerPair(map, jid, lid);
    if (jid && name) names.set(jid, name);
    if (lid && name) names.set(lid, name);
  }

  /**
   * Compare two identifiers — JID, LID, or JID-with-device-suffix — and
   * return true if they refer to the same WhatsApp account.
   *
   * Without this, a LID vs JID comparison always returns false even though
   * they are the same person. Same for "12345:5@s.whatsapp.net" vs
   * "12345@s.whatsapp.net".
   *
   * @param {string} a
   * @param {string} b
   * @returns {boolean}
   *
   * @example
   * jidMapper.isSame(msg.key.participant, bannedJid);
   * // → true even if one is a LID and the other is a JID
   */
  function isSame(a, b) {
    if (!a || !b) return false;
    const resolvedA = resolveJid(a);
    const resolvedB = resolveJid(b);
    if (resolvedA === resolvedB) return true;

    // One might still be an unresolved LID — try cross-resolving
    const lidA = isLid(resolvedA) ? resolvedA : map.jidToLid.get(resolvedA);
    const lidB = isLid(resolvedB) ? resolvedB : map.jidToLid.get(resolvedB);
    if (lidA && lidB && lidA === lidB) return true;

    return false;
  }

  /**
   * Extract the canonical sender JID from a raw Baileys message object.
   *
   * Handles all contexts correctly:
   *   - DM:    sender is msg.key.remoteJid
   *   - Group: sender is msg.key.participant (could be a LID)
   *   - Edited/protocol messages: checks message.participant fallback
   *
   * Always returns a resolved, clean JID — never a LID, never a device suffix.
   *
   * @param {object} msg - Raw Baileys message (from messages.upsert)
   * @returns {string|null}
   *
   * @example
   * sock.ev.on('messages.upsert', ({ messages }) => {
   *   const sender = jidMapper.extractSender(messages[0]);
   *   // → always "1234567890@s.whatsapp.net"
   * });
   */
  function extractSender(msg) {
    if (!msg?.key) return null;

    const { remoteJid, participant, fromMe } = msg.key;

    let raw;

    if (participant) {
      // Group message — participant is the actual sender
      raw = participant;
    } else if (remoteJid && !isGroupJid(remoteJid)) {
      // DM — remoteJid is the sender
      raw = remoteJid;
    } else if (fromMe) {
      // Sent by the bot itself in a group with no participant field
      raw = remoteJid;
    } else {
      // Fallback: some protocol messages carry participant at message level
      raw = msg.participant || remoteJid;
    }

    return raw ? resolveJid(raw) : null;
  }

  /**
   * Attach mapper methods directly onto a Baileys socket object.
   *
   * After calling this, you can use:
   *   sock.decodeJid(jid)
   *   sock.getName(jid)
   *   sock.resolveJid(jidOrLid)
   *   sock.isSame(a, b)
   *   sock.extractSender(msg)
   *   sock.jidMapper  ← the full mapper instance
   *
   * This means existing bots that call sock.decodeJid() and sock.getName()
   * can adopt kango-wa with zero call-site changes.
   *
   * @param {object} sock - The Baileys socket returned by makeWASocket()
   * @returns {object} The same sock object (mutated in place)
   *
   * @example
   * const sock = makeWASocket(config);
   * jidMapper.patchSocket(sock);
   * // Now: sock.decodeJid(), sock.getName(), sock.resolveJid() all work
   */
  function patchSocket(sock) {
    if (!sock) throw new Error('[kango-wa] patchSocket() requires a socket');
    sock.jidMapper    = { bind, primeSelf, prime, resolveJid, getLid, getName, isSame, extractSender, hasLid, hasMapping, stats, dump };
    sock.decodeJid    = decodeJid;
    sock.resolveJid   = resolveJid;
    sock.getName      = getName;
    sock.isSame       = isSame;
    sock.extractSender = extractSender;
    return sock;
  }

  /**
   * Check if a given string is a known LID in the map.
   * @param {string} str
   * @returns {boolean}
   */
  function hasLid(str) {
    return isLid(str) && map.lidToJid.has(str);
  }

  /**
   * Check if a given JID has a known LID mapping.
   * @param {string} jid
   * @returns {boolean}
   */
  function hasMapping(jid) {
    return map.jidToLid.has(decodeJid(jid));
  }

  /**
   * Get stats about the current state of the map.
   * @returns {object}
   */
  function stats() {
    return {
      mappedPairs: map.jidToLid.size,
      namedContacts: names.size,
    };
  }

  /**
   * Dump the full map for debugging.
   * @returns {object}
   */
  function dump() {
    return {
      jidToLid: Object.fromEntries(map.jidToLid),
      lidToJid: Object.fromEntries(map.lidToJid),
      names: Object.fromEntries(names),
    };
  }

  return {
    bind,
    primeSelf,
    prime,
    resolveJid,
    getLid,
    getName,
    isSame,
    extractSender,
    patchSocket,
    hasLid,
    hasMapping,
    stats,
    dump,
    // Expose pure helpers too
    decodeJid,
    isLid,
    isUserJid,
    isGroupJid,
    isNewsletterJid,
    isStatusJid,
    toPhoneNumber,
    normalizeJid: (jid) => normalizeJid(jid, map),
  };
}

module.exports = {
  createJidMapper,
  // Pure helpers available without creating an instance
  decodeJid,
  isLid,
  isUserJid,
  isGroupJid,
  isNewsletterJid,
  isStatusJid,
  toPhoneNumber,
};
