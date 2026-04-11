// kango-wa/src/store.js
// In-memory store for Baileys — replaces the removed makeInMemoryStore.
// Copyright (c) 2026 Hector Manuel. All rights reserved.
// Keeps a live snapshot of messages, chats, contacts, and group metadata
// by listening to socket events. Plug it in with store.bind(sock.ev).

'use strict';

/**
 * Create an in-memory store that listens to Baileys socket events.
 *
 * @param {object} [options]
 * @param {number} [options.maxMessagesPerChat=100] - Max messages to keep per chat
 * @param {number} [options.maxChats=1000]          - Max chats to track
 * @returns {object} Store instance
 *
 * @example
 * const { createStore } = require('kango-wa');
 *
 * const store = createStore({ maxMessagesPerChat: 200 });
 * store.bind(sock.ev);
 *
 * // Look up a message (e.g. for quoted reply context):
 * sock.ev.on('messages.upsert', ({ messages }) => {
 *   const msg = messages[0];
 *   const quoted = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
 *   if (quoted) {
 *     const original = store.getMessage(
 *       msg.key.remoteJid,
 *       msg.message.extendedTextMessage.contextInfo.stanzaId
 *     );
 *     console.log('Original message:', original);
 *   }
 * });
 */
function createStore(options = {}) {
  const {
    maxMessagesPerChat = 100,
    maxChats = 1000,
  } = options;

  // Internal data maps
  // jid -> { id, conversationTimestamp, unreadCount, lastMessage, name, ... }
  const chats = new Map();

  // jid -> Map(msgId -> message)
  const messages = new Map();

  // jid -> { notify, verifiedName, ... }
  const contacts = new Map();

  // jid -> group metadata object
  const groupMetadata = new Map();

  // ─── Internal helpers ────────────────────────────────────────────────────

  /**
   * Get or create a message map for a JID.
   * @param {string} jid
   * @returns {Map}
   */
  function getMessageMap(jid) {
    if (!messages.has(jid)) {
      messages.set(jid, new Map());
    }
    return messages.get(jid);
  }

  /**
   * Add a message to the store, trimming to maxMessagesPerChat.
   * @param {object} msg - Baileys WAMessage
   */
  function storeMessage(msg) {
    if (!msg?.key?.remoteJid || !msg?.key?.id) return;

    const jid = msg.key.remoteJid;
    const msgMap = getMessageMap(jid);

    msgMap.set(msg.key.id, msg);

    // Trim oldest messages if over limit
    if (msgMap.size > maxMessagesPerChat) {
      const oldest = msgMap.keys().next().value;
      msgMap.delete(oldest);
    }
  }

  /**
   * Evict the oldest chat if over maxChats.
   */
  function evictChatIfFull() {
    if (chats.size >= maxChats) {
      const oldest = chats.keys().next().value;
      chats.delete(oldest);
      messages.delete(oldest);
    }
  }

  // ─── Event bindings ──────────────────────────────────────────────────────

  /**
   * Bind the store to a Baileys EventEmitter.
   * Call this once after creating your socket:
   *   store.bind(sock.ev)
   *
   * @param {object} ev - sock.ev (Baileys EventEmitter)
   */
  function bind(ev) {
    if (!ev || typeof ev.on !== 'function') {
      throw new Error('[kango-wa] store.bind() requires a Baileys event emitter (sock.ev)');
    }

    // ── Chats ──────────────────────────────────────────────────────────────

    ev.on('chats.set', ({ chats: incoming }) => {
      if (!Array.isArray(incoming)) return;
      for (const chat of incoming) {
        if (!chat?.id) continue;
        evictChatIfFull();
        chats.set(chat.id, { ...chats.get(chat.id), ...chat });
      }
    });

    ev.on('chats.upsert', (incoming) => {
      const list = Array.isArray(incoming) ? incoming : [incoming];
      for (const chat of list) {
        if (!chat?.id) continue;
        evictChatIfFull();
        chats.set(chat.id, { ...chats.get(chat.id), ...chat });
      }
    });

    ev.on('chats.update', (updates) => {
      const list = Array.isArray(updates) ? updates : [updates];
      for (const update of list) {
        if (!update?.id) continue;
        const existing = chats.get(update.id) || {};
        chats.set(update.id, { ...existing, ...update });
      }
    });

    ev.on('chats.delete', (ids) => {
      const list = Array.isArray(ids) ? ids : [ids];
      for (const id of list) {
        chats.delete(id);
        messages.delete(id);
      }
    });

    // ── Messages ───────────────────────────────────────────────────────────

    ev.on('messages.set', ({ messages: incoming }) => {
      if (!Array.isArray(incoming)) return;
      for (const msg of incoming) storeMessage(msg);
    });

    ev.on('messages.upsert', ({ messages: incoming, type }) => {
      if (!Array.isArray(incoming)) return;
      for (const msg of incoming) {
        storeMessage(msg);

        // Update the chat's last message timestamp
        if (msg?.key?.remoteJid && msg?.messageTimestamp) {
          const jid = msg.key.remoteJid;
          const chat = chats.get(jid) || { id: jid };
          chat.conversationTimestamp = msg.messageTimestamp;
          if (type === 'notify' && !msg.key.fromMe) {
            chat.unreadCount = (chat.unreadCount || 0) + 1;
          }
          chats.set(jid, chat);
        }
      }
    });

    ev.on('messages.update', (updates) => {
      const list = Array.isArray(updates) ? updates : [updates];
      for (const { key, update } of list) {
        if (!key?.remoteJid || !key?.id) continue;
        const msgMap = getMessageMap(key.remoteJid);
        const existing = msgMap.get(key.id);
        if (existing) {
          msgMap.set(key.id, { ...existing, ...update, key });
        }
      }
    });

    ev.on('messages.delete', ({ keys }) => {
      const list = Array.isArray(keys) ? keys : [keys];
      for (const key of list) {
        if (!key?.remoteJid || !key?.id) continue;
        const msgMap = messages.get(key.remoteJid);
        if (msgMap) msgMap.delete(key.id);
      }
    });

    ev.on('message-receipt.update', (updates) => {
      const list = Array.isArray(updates) ? updates : [updates];
      for (const { key, receipt } of list) {
        if (!key?.remoteJid || !key?.id) continue;
        const msgMap = messages.get(key.remoteJid);
        if (!msgMap) continue;
        const msg = msgMap.get(key.id);
        if (msg) {
          msg.userReceipt = msg.userReceipt || [];
          const existing = msg.userReceipt.findIndex((r) => r.userJid === receipt.userJid);
          if (existing >= 0) {
            msg.userReceipt[existing] = { ...msg.userReceipt[existing], ...receipt };
          } else {
            msg.userReceipt.push(receipt);
          }
          msgMap.set(key.id, msg);
        }
      }
    });

    // ── Contacts ───────────────────────────────────────────────────────────

    ev.on('contacts.set', ({ contacts: incoming }) => {
      if (!Array.isArray(incoming)) return;
      for (const contact of incoming) {
        if (!contact?.id) continue;
        contacts.set(contact.id, { ...contacts.get(contact.id), ...contact });
      }
    });

    ev.on('contacts.upsert', (incoming) => {
      const list = Array.isArray(incoming) ? incoming : [incoming];
      for (const contact of list) {
        if (!contact?.id) continue;
        contacts.set(contact.id, { ...contacts.get(contact.id), ...contact });
      }
    });

    ev.on('contacts.update', (updates) => {
      const list = Array.isArray(updates) ? updates : [updates];
      for (const update of list) {
        if (!update?.id) continue;
        const existing = contacts.get(update.id) || {};
        contacts.set(update.id, { ...existing, ...update });
      }
    });

    // ── Group metadata ─────────────────────────────────────────────────────

    ev.on('groups.upsert', (incoming) => {
      const list = Array.isArray(incoming) ? incoming : [incoming];
      for (const meta of list) {
        if (!meta?.id) continue;
        groupMetadata.set(meta.id, meta);
      }
    });

    ev.on('groups.update', (updates) => {
      const list = Array.isArray(updates) ? updates : [updates];
      for (const update of list) {
        if (!update?.id) continue;
        const existing = groupMetadata.get(update.id) || {};
        groupMetadata.set(update.id, { ...existing, ...update });
      }
    });

    ev.on('group-participants.update', ({ id, participants, action }) => {
      if (!id) return;
      const meta = groupMetadata.get(id);
      if (!meta) return;

      // Newer Baileys sends participants as objects {id, lid}, older sends strings.
      // Normalize to a Set of JID strings for reliable lookups.
      const participantIds = new Set(
        participants.map((p) => (typeof p === 'string' ? p : p?.id)).filter(Boolean)
      );

      if (action === 'add') {
        const newParticipants = [...participantIds].map((pid) => {
          const raw = participants.find((p) => (typeof p === 'string' ? p : p?.id) === pid);
          return typeof raw === 'object' && raw !== null
            ? { isAdmin: false, isSuperAdmin: false, ...raw }
            : { id: pid, isAdmin: false, isSuperAdmin: false };
        });
        meta.participants = [...(meta.participants || []), ...newParticipants];
      } else if (action === 'remove') {
        meta.participants = (meta.participants || []).filter(
          (p) => !participantIds.has(p.id)
        );
      } else if (action === 'promote') {
        meta.participants = (meta.participants || []).map((p) =>
          participantIds.has(p.id) ? { ...p, isAdmin: true } : p
        );
      } else if (action === 'demote') {
        meta.participants = (meta.participants || []).map((p) =>
          participantIds.has(p.id) ? { ...p, isAdmin: false } : p
        );
      }

      groupMetadata.set(id, meta);
    });
  }

  // ─── Public query API ────────────────────────────────────────────────────

  /**
   * Get all messages for a chat, sorted oldest-first.
   * @param {string} jid
   * @returns {Array}
   */
  function getMessages(jid) {
    return Array.from(messages.get(jid)?.values() || []);
  }

  /**
   * Get a single message by JID and message ID.
   * This is the key method for quoted message lookups.
   * @param {string} jid
   * @param {string} msgId
   * @returns {object|null}
   */
  function getMessage(jid, msgId) {
    return messages.get(jid)?.get(msgId) || null;
  }

  /**
   * Get a loadMessage-compatible function to pass into makeWASocket.
   * This lets Baileys resolve quoted messages automatically.
   *
   * @example
   * const sock = makeWASocket({
   *   auth: state,
   *   getMessage: store.getMessageLoader(),
   * });
   *
   * @returns {Function}
   */
  function getMessageLoader() {
    return async (key) => {
      if (!key?.remoteJid || !key?.id) return undefined;
      const msg = getMessage(key.remoteJid, key.id);
      return msg?.message || undefined;
    };
  }

  /**
   * Get all chats.
   * @returns {Array}
   */
  function getChats() {
    return Array.from(chats.values());
  }

  /**
   * Get a single chat by JID.
   * @param {string} jid
   * @returns {object|null}
   */
  function getChat(jid) {
    return chats.get(jid) || null;
  }

  /**
   * Get a contact by JID.
   * @param {string} jid
   * @returns {object|null}
   */
  function getContact(jid) {
    return contacts.get(jid) || null;
  }

  /**
   * Get all contacts.
   * @returns {Array}
   */
  function getContacts() {
    return Array.from(contacts.values());
  }

  /**
   * Get group metadata by JID.
   * @param {string} jid
   * @returns {object|null}
   */
  function getGroupMetadata(jid) {
    return groupMetadata.get(jid) || null;
  }

  /**
   * Check if a JID is a known group in the store.
   * @param {string} jid
   * @returns {boolean}
   */
  function isKnownGroup(jid) {
    return groupMetadata.has(jid);
  }

  /**
   * Clear all stored data.
   */
  function clear() {
    chats.clear();
    messages.clear();
    contacts.clear();
    groupMetadata.clear();
  }

  /**
   * Get store statistics.
   * @returns {object}
   */
  function stats() {
    let totalMessages = 0;
    for (const msgMap of messages.values()) {
      totalMessages += msgMap.size;
    }
    return {
      chats: chats.size,
      contacts: contacts.size,
      groups: groupMetadata.size,
      totalMessages,
      maxMessagesPerChat,
      maxChats,
    };
  }

  return {
    bind,
    // Messages
    getMessages,
    getMessage,
    getMessageLoader,
    // Chats
    getChats,
    getChat,
    // Contacts
    getContacts,
    getContact,
    // Groups
    getGroupMetadata,
    isKnownGroup,
    // Housekeeping
    clear,
    stats,
  };
}

module.exports = { createStore };
