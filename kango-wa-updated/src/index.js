// kango-wa/src/index.js
// Main entry point — exports the full Kango-WA toolkit.
// Copyright (c) 2026 Hector Manuel. All rights reserved.

'use strict';

// ── Buttons ──────────────────────────────────────────────────────────────────
const {
  sendButtons,
  sendInteractiveMessage,
  normalizeButtons,
  normalizeButton,
  convertToInteractiveMessage,
  buildInteractiveNodes,
} = require('./buttons');

// ── Auto-reconnect ────────────────────────────────────────────────────────────
const { createReconnectManager, DisconnectReason } = require('./reconnect');

// ── Message queue ─────────────────────────────────────────────────────────────
const { createMessageQueue } = require('./queue');

// ── Conversation flows ────────────────────────────────────────────────────────
const { createFlowEngine, createMemoryStore } = require('./flows');

// ── Group metadata cache ──────────────────────────────────────────────────────
const { createGroupCache } = require('./cache');

// ── Auth adapters ─────────────────────────────────────────────────────────────
const { useRedisAuthState } = require('./auth/redis');
const { usePostgresAuthState, createAuthTable } = require('./auth/postgres');

// ── In-memory store ───────────────────────────────────────────────────────────
const { createStore } = require('./store');

// ── JID / LID mapping ─────────────────────────────────────────────────────────
const {
  createJidMapper,
  decodeJid,
  isLid,
  isUserJid,
  isGroupJid,
  isNewsletterJid,
  isStatusJid,
  toPhoneNumber,
} = require('./jid');

// ── Status / Stories ─────────────────────────────────────────────────────────
const {
  createStatusManager,
  detectStatusType,
  extractMediaContent,
  extractStatusText,
  parseColorAndFont,
  resolveQuotedMessage,
  collectStatusJidList,
  processImage,
  processVideo,
  processAudio,
  STATUS_COLORS,
} = require('./status');

// ── Utilities ─────────────────────────────────────────────────────────────────
const { loadBaileys, isGroup, sleep, safeParseJSON } = require('./utils');

module.exports = {
  // Buttons
  sendButtons,
  sendInteractiveMessage,
  normalizeButtons,
  normalizeButton,
  convertToInteractiveMessage,
  buildInteractiveNodes,

  // Reconnect
  createReconnectManager,
  DisconnectReason,

  // Message queue
  createMessageQueue,

  // Flows
  createFlowEngine,
  createMemoryStore,

  // Group cache
  createGroupCache,

  // Auth adapters
  useRedisAuthState,
  usePostgresAuthState,
  createAuthTable,

  // Store
  createStore,

  // JID / LID mapping
  createJidMapper,
  decodeJid,
  isLid,
  isUserJid,
  isGroupJid,
  isNewsletterJid,
  isStatusJid,
  toPhoneNumber,

  // Status / Stories
  createStatusManager,
  detectStatusType,
  extractMediaContent,
  extractStatusText,
  parseColorAndFont,
  resolveQuotedMessage,
  collectStatusJidList,
  processImage,
  processVideo,
  processAudio,
  STATUS_COLORS,

  // Utils
  loadBaileys,
  isGroup,
  sleep,
  safeParseJSON,
};
