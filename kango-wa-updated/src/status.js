// kango-wa/src/status.js
// WhatsApp Status/Stories toolkit — view, download, post, track, and process statuses.
// Copyright (c) 2026 Hector Manuel. All rights reserved.
//
// Baileys receives status updates through the standard messages.upsert event
// on the "status@broadcast" JID. This module collects, organizes, and provides
// clean APIs for working with statuses that Baileys doesn't offer.

'use strict';

const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);

const { loadBaileys } = require('./utils');

const STATUS_JID = 'status@broadcast';
const DEFAULT_MAX_STATUSES = 200;
const DEFAULT_TTL = 24 * 60 * 60 * 1000; // 24 hours

// ─── Color palette ────────────────────────────────────────────────────────────

const STATUS_COLORS = {
  1: '#FF0000', 2: '#00FF00', 3: '#0000FF', 4: '#FFD700', 5: '#800080',
  6: '#FFA500', 7: '#FF1493', 8: '#00CED1', 9: '#32CD32', 10: '#FF4500',
  11: '#4B0082', 12: '#DC143C', 13: '#00BFFF', 14: '#8B4513', 15: '#9400D3',
  16: '#228B22', 17: '#FF6347', 18: '#4169E1', 19: '#2F4F4F', 20: '#FF69B4',
  21: '#1E90FF', 22: '#B22222', 23: '#6B8E23', 24: '#BA55D3', 25: '#20B2AA',
  26: '#CD853F', 27: '#483D8B', 28: '#C71585', 29: '#128C7E', 30: '#000000',
};

// ─── Color & font parsing ─────────────────────────────────────────────────────

/**
 * Parse optional color + font prefix from a status text string.
 *
 * Accepted formats:
 *   - `"5 Hello"` → color #800080, default font, text "Hello"
 *   - `"#FF0000 F3 Hello"` → color #FF0000, font 3, text "Hello"
 *   - `"F2 Hello"` → default color, font 2, text "Hello"
 *   - `"Hello"` → defaults for both
 *
 * @param {string} text - Raw command text
 * @returns {{ bgColor: string, fontStyle: number, statusText: string }}
 */
function parseColorAndFont(text) {
  let bgColor = '#128C7E';
  let fontStyle = 2;
  let statusText = text || '';

  if (!text) return { bgColor, fontStyle, statusText };

  const parts = text.split(' ');
  let start = 0;

  const colorNum = parseInt(parts[0]);
  if (!isNaN(colorNum) && colorNum >= 1 && colorNum <= 30 && STATUS_COLORS[colorNum] && String(colorNum) === parts[0]) {
    bgColor = STATUS_COLORS[colorNum];
    start = 1;
  } else if (/^#([A-Fa-f0-9]{6}|[A-Fa-f0-9]{3})$/.test(parts[0])) {
    bgColor = parts[0].toUpperCase();
    start = 1;
  }

  if (parts[start] && /^[Ff][1-5]$/.test(parts[start])) {
    fontStyle = parseInt(parts[start][1]);
    start++;
  }

  statusText = parts.slice(start).join(' ');
  return { bgColor, fontStyle, statusText };
}

// ─── Media type detection ─────────────────────────────────────────────────────

/**
 * Detect the media type of a status message.
 * @param {object} message - The raw Baileys message content
 * @returns {string} One of: 'text', 'image', 'video', 'gif', 'audio', 'ptt', 'document', 'sticker', 'protocol', 'unknown'
 */
function detectStatusType(message) {
  if (!message) return 'unknown';
  if (message.imageMessage) return 'image';
  if (message.videoMessage) return message.videoMessage.gifPlayback ? 'gif' : 'video';
  if (message.audioMessage) return message.audioMessage.ptt ? 'ptt' : 'audio';
  if (message.stickerMessage) return 'sticker';
  if (message.documentMessage) return 'document';
  if (message.extendedTextMessage) return 'text';
  if (message.conversation) return 'text';
  if (message.protocolMessage) return 'protocol';
  return 'unknown';
}

/**
 * Extract the media content node from a message for downloading.
 * @param {object} message
 * @returns {{ content: object, type: string } | null}
 */
function extractMediaContent(message) {
  if (!message) return null;

  const mediaTypes = [
    { key: 'imageMessage',    type: 'image' },
    { key: 'videoMessage',    type: 'video' },
    { key: 'audioMessage',    type: 'audio' },
    { key: 'stickerMessage',  type: 'sticker' },
    { key: 'documentMessage', type: 'document' },
  ];

  for (const { key, type } of mediaTypes) {
    if (message[key]) {
      return { content: message[key], type };
    }
  }
  return null;
}

/**
 * Extract text from a status message.
 * @param {object} message
 * @returns {string}
 */
function extractStatusText(message) {
  if (!message) return '';
  return (
    message.conversation ||
    message.extendedTextMessage?.text ||
    message.imageMessage?.caption ||
    message.videoMessage?.caption ||
    message.documentMessage?.caption ||
    ''
  );
}

// ─── Media processing (ffmpeg) ────────────────────────────────────────────────

/**
 * Optimize an image buffer for status posting via ffmpeg.
 * Scales down to max 1080px wide, outputs JPEG.
 *
 * @param {Buffer} buffer   - Raw image buffer
 * @param {string} [mimeType='image/jpeg'] - Source MIME type
 * @param {string} [tmpDir] - Temp directory (defaults to process.cwd()/tmp)
 * @returns {Promise<Buffer>} Optimized buffer (or original on failure)
 */
async function processImage(buffer, mimeType, tmpDir) {
  const dir = tmpDir || path.join(process.cwd(), 'tmp');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const ts = Date.now();
  const ext = mimeType?.includes('png') ? 'png' : 'jpg';
  const input = path.join(dir, `kw_img_in_${ts}.${ext}`);
  const output = path.join(dir, `kw_img_out_${ts}.jpg`);

  fs.writeFileSync(input, buffer);
  try {
    await execAsync(`ffmpeg -i "${input}" -vf "scale='min(1080,iw)':-2" -q:v 2 -y "${output}"`);
    if (fs.existsSync(output) && fs.statSync(output).size > 0) {
      const result = fs.readFileSync(output);
      _safeUnlink(input, output);
      return result;
    }
  } catch (_) {}

  _safeUnlink(input, output);
  return buffer;
}

/**
 * Optimize a video buffer for status posting via ffmpeg.
 * Scales to max 1080px wide, H.264, fast preset, 3M max bitrate.
 *
 * @param {Buffer} buffer   - Raw video buffer
 * @param {string} [tmpDir] - Temp directory
 * @returns {Promise<Buffer>} Optimized buffer (or original on failure)
 */
async function processVideo(buffer, tmpDir) {
  const dir = tmpDir || path.join(process.cwd(), 'tmp');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const ts = Date.now();
  const input = path.join(dir, `kw_vid_in_${ts}.mp4`);
  const output = path.join(dir, `kw_vid_out_${ts}.mp4`);

  fs.writeFileSync(input, buffer);
  try {
    await execAsync(
      `ffmpeg -i "${input}" -vf "scale='if(gt(iw\\,1080)\\,1080\\,trunc(iw/2)*2)':trunc(ow/a/2)*2" ` +
      `-c:v libx264 -preset fast -crf 23 -pix_fmt yuv420p -maxrate 3M -bufsize 6M ` +
      `-c:a aac -b:a 128k -movflags +faststart -y "${output}"`,
      { timeout: 120000 }
    );
    if (fs.existsSync(output) && fs.statSync(output).size > 0) {
      const result = fs.readFileSync(output);
      _safeUnlink(input, output);
      return result;
    }
  } catch (_) {}

  _safeUnlink(input, output);
  return buffer;
}

/**
 * Convert any audio buffer to Opus OGG format for WhatsApp voice notes.
 * Two-step: strip metadata → convert to opus. Falls back to direct conversion.
 *
 * @param {Buffer} buffer   - Raw audio buffer
 * @param {string} [tmpDir] - Temp directory
 * @returns {Promise<Buffer|null>} Converted buffer, or null on failure
 */
async function processAudio(buffer, tmpDir) {
  const dir = tmpDir || path.join(process.cwd(), 'tmp');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const ts = Date.now();
  const input = path.join(dir, `kw_aud_in_${ts}.bin`);
  const clean = path.join(dir, `kw_aud_clean_${ts}.wav`);
  const output = path.join(dir, `kw_aud_out_${ts}.ogg`);

  fs.writeFileSync(input, buffer);

  try {
    await execAsync(`ffmpeg -y -i "${input}" -vn -map 0:a:0 -map_metadata -1 -ac 1 -ar 48000 -c:a pcm_s16le "${clean}"`);
    await execAsync(`ffmpeg -y -i "${clean}" -c:a libopus -b:a 32k -ar 48000 -ac 1 "${output}"`);
    if (fs.existsSync(output) && fs.statSync(output).size > 0) {
      const result = fs.readFileSync(output);
      _safeUnlink(input, clean, output);
      return result;
    }
  } catch (_) {}

  try {
    await execAsync(`ffmpeg -y -i "${input}" -vn -c:a libopus -b:a 32k -ar 48000 -ac 1 "${output}"`);
    if (fs.existsSync(output) && fs.statSync(output).size > 0) {
      const result = fs.readFileSync(output);
      _safeUnlink(input, clean, output);
      return result;
    }
  } catch (_) {}

  _safeUnlink(input, clean, output);
  return null;
}

function _safeUnlink(...paths) {
  for (const p of paths) {
    try { if (p && fs.existsSync(p)) fs.unlinkSync(p); } catch (_) {}
  }
}

// ─── Status JID list collection ───────────────────────────────────────────────

/**
 * Collect all unique contact JIDs for statusJidList so your posted
 * status is visible to all contacts and group members.
 *
 * Sources:
 *   1. sock.store.contacts (contacts from contacts.upsert / contacts.update)
 *   2. All group participants via sock.groupFetchAllParticipating()
 *   3. Bot's own JID (so you can see your own status)
 *
 * @param {object} sock - Baileys socket
 * @returns {Promise<string[]>} Array of unique JIDs
 */
async function collectStatusJidList(sock) {
  const seen = new Set();
  const rawId = sock.user?.id || '';
  const botJid = typeof sock.decodeJid === 'function'
    ? sock.decodeJid(rawId)
    : rawId.replace(/:\d+@/, '@');

  if (sock.store?.contacts) {
    for (const id of Object.keys(sock.store.contacts)) {
      if (id.endsWith('@s.whatsapp.net') && id !== botJid) seen.add(id);
    }
  }

  try {
    const groups = await sock.groupFetchAllParticipating();
    for (const group of Object.values(groups)) {
      for (const p of (group.participants || [])) {
        const jid = p.phoneNumber || p.id;
        if (jid && jid !== botJid) seen.add(jid);
      }
    }
  } catch (_) {}

  if (botJid) seen.add(botJid);
  return Array.from(seen);
}

// ─── Quoted message extraction ────────────────────────────────────────────────

/**
 * Resolve the target message for status posting — handles quoted replies.
 * If the message is a reply to another message, extracts the quoted message
 * so its media can be reposted as a status.
 *
 * @param {object} message - The raw Baileys message
 * @param {string} chatId  - The chat JID
 * @returns {{ targetMessage: object, hasQuoted: boolean }}
 */
function resolveQuotedMessage(message, chatId) {
  const qi = message.message?.extendedTextMessage?.contextInfo;
  if (qi?.quotedMessage) {
    return {
      targetMessage: {
        key: { remoteJid: chatId, id: qi.stanzaId, participant: qi.participant },
        message: qi.quotedMessage,
      },
      hasQuoted: true,
    };
  }
  return { targetMessage: message, hasQuoted: false };
}

// ─── Core factory ─────────────────────────────────────────────────────────────

/**
 * Create a status manager that collects, organizes, and posts WhatsApp statuses.
 *
 * @param {object} [options]
 * @param {number} [options.maxStatuses=200]   - Max total statuses to keep in memory
 * @param {number} [options.ttl=86400000]      - Auto-expire statuses older than this (ms), default 24h
 * @param {boolean} [options.autoCleanup=true] - Automatically remove expired statuses
 * @param {string}  [options.tmpDir]           - Temp directory for ffmpeg media processing
 * @returns {object} Status manager instance
 *
 * @example
 * const { createStatusManager } = require('kango-wa');
 *
 * const statusManager = createStatusManager();
 * statusManager.bind(sock.ev);
 *
 * // Get all statuses from a contact:
 * const statuses = statusManager.getContactStatuses('2341234567890@s.whatsapp.net');
 *
 * // Download a status media:
 * const buffer = await statusManager.downloadStatus(sock, statuses[0]);
 *
 * // Post a status with color and font:
 * await statusManager.postFromCommand(sock, chatId, message, '5 F3 Hello World');
 */
function createStatusManager(options = {}) {
  const {
    maxStatuses = DEFAULT_MAX_STATUSES,
    ttl = DEFAULT_TTL,
    autoCleanup = true,
    tmpDir,
  } = options;

  const _tmpDir = tmpDir || path.join(process.cwd(), 'tmp');

  // jid -> [{ key, message, sender, timestamp, type, text, pushName }]
  const statusMap = new Map();

  // Track viewers of bot's own statuses: msgId -> [{ jid, timestamp }]
  const viewerMap = new Map();

  let cleanupTimer = null;

  // ── Internal helpers ──────────────────────────────────────────────────────

  function _normalizeJid(jid) {
    if (!jid || typeof jid !== 'string') return jid;
    if (/:\d+@/gi.test(jid)) return jid.replace(/:\d+/, '');
    return jid;
  }

  function _getSender(msg) {
    if (!msg?.key) return null;
    return msg.key.participant || msg.key.remoteJid || null;
  }

  function _addStatus(msg) {
    if (!msg?.key || !msg.message) return;
    if (msg.key.remoteJid !== STATUS_JID) return;

    const sender = _normalizeJid(_getSender(msg));
    if (!sender) return;

    const message = msg.message;
    const unwrapped =
      message.ephemeralMessage?.message ||
      message.viewOnceMessage?.message ||
      message.viewOnceMessageV2?.message ||
      message;

    const type = detectStatusType(unwrapped);
    if (type === 'protocol' || type === 'unknown') return;

    const entry = {
      key: msg.key,
      message: unwrapped,
      sender,
      timestamp: msg.messageTimestamp
        ? (typeof msg.messageTimestamp === 'number'
            ? msg.messageTimestamp * 1000
            : Number(msg.messageTimestamp) * 1000)
        : Date.now(),
      type,
      text: extractStatusText(unwrapped),
      pushName: msg.pushName || '',
    };

    if (!statusMap.has(sender)) statusMap.set(sender, []);
    const list = statusMap.get(sender);
    if (!list.some((s) => s.key.id === entry.key.id)) {
      list.push(entry);
    }
    _trimStatuses();
  }

  function _trimStatuses() {
    let total = 0;
    for (const list of statusMap.values()) total += list.length;
    if (total <= maxStatuses) return;

    const all = [];
    for (const [sender, list] of statusMap.entries()) {
      for (const s of list) all.push({ sender, status: s });
    }
    all.sort((a, b) => a.status.timestamp - b.status.timestamp);

    const toRemove = total - maxStatuses;
    for (let i = 0; i < toRemove; i++) {
      const { sender, status } = all[i];
      const list = statusMap.get(sender);
      if (list) {
        const idx = list.indexOf(status);
        if (idx >= 0) list.splice(idx, 1);
        if (list.length === 0) statusMap.delete(sender);
      }
    }
  }

  function _cleanExpired() {
    const now = Date.now();
    for (const [sender, list] of statusMap.entries()) {
      const filtered = list.filter((s) => now - s.timestamp < ttl);
      if (filtered.length === 0) statusMap.delete(sender);
      else statusMap.set(sender, filtered);
    }
    for (const [msgId, vList] of viewerMap.entries()) {
      const filtered = vList.filter((v) => now - v.timestamp < ttl);
      if (filtered.length === 0) viewerMap.delete(msgId);
      else viewerMap.set(msgId, filtered);
    }
  }

  // ── Event bindings ────────────────────────────────────────────────────────

  /**
   * Bind the status manager to a Baileys socket event emitter.
   * Call once after creating your socket: statusManager.bind(sock.ev)
   *
   * @param {object} ev - sock.ev (Baileys EventEmitter)
   */
  function bind(ev) {
    if (!ev || typeof ev.on !== 'function') {
      throw new Error('[kango-wa] statusManager.bind() requires a Baileys event emitter (sock.ev)');
    }

    ev.on('messages.upsert', ({ messages: msgs }) => {
      if (!Array.isArray(msgs)) return;
      for (const msg of msgs) {
        if (msg?.key?.remoteJid === STATUS_JID) _addStatus(msg);
      }
    });

    ev.on('messages.update', (updates) => {
      if (!Array.isArray(updates)) return;
      for (const { key, update } of updates) {
        if (key?.remoteJid !== STATUS_JID) continue;
        const sender = _normalizeJid(key.participant || key.remoteJid);
        if (!sender) continue;
        const list = statusMap.get(sender);
        if (!list) continue;
        const idx = list.findIndex((s) => s.key.id === key.id);
        if (idx >= 0 && update) list[idx] = { ...list[idx], ...update, key };
      }
    });

    ev.on('message-receipt.update', (updates) => {
      if (!Array.isArray(updates)) return;
      for (const { key, receipt } of updates) {
        if (key?.remoteJid !== STATUS_JID) continue;
        if (!key.fromMe) continue;

        const msgId = key.id;
        if (!viewerMap.has(msgId)) viewerMap.set(msgId, []);
        const viewerJid = _normalizeJid(receipt?.userJid);
        if (!viewerJid) continue;

        const vList = viewerMap.get(msgId);
        if (!vList.some((v) => v.jid === viewerJid)) {
          vList.push({
            jid: viewerJid,
            timestamp: receipt.readTimestamp
              ? Number(receipt.readTimestamp) * 1000
              : Date.now(),
          });
        }
      }
    });

    if (autoCleanup) {
      cleanupTimer = setInterval(_cleanExpired, 5 * 60 * 1000);
      if (cleanupTimer.unref) cleanupTimer.unref();
    }
  }

  // ── Query API ─────────────────────────────────────────────────────────────

  /**
   * Get all collected statuses from a specific contact.
   * @param {string} jid - The contact's JID
   * @returns {Array} Array of status entries, sorted newest first
   */
  function getContactStatuses(jid) {
    const clean = _normalizeJid(jid);
    const list = statusMap.get(clean) || [];
    return [...list].sort((a, b) => b.timestamp - a.timestamp);
  }

  /**
   * Get all contacts who have posted statuses.
   * @returns {Array<{ jid: string, count: number, latest: number, pushName: string }>}
   */
  function getStatusContacts() {
    const result = [];
    for (const [jid, list] of statusMap.entries()) {
      if (list.length === 0) continue;
      const sorted = [...list].sort((a, b) => b.timestamp - a.timestamp);
      result.push({
        jid,
        count: list.length,
        latest: sorted[0].timestamp,
        pushName: sorted[0].pushName || '',
      });
    }
    return result.sort((a, b) => b.latest - a.latest);
  }

  /**
   * Get all statuses across all contacts, sorted newest first.
   * @param {object} [options]
   * @param {number} [options.limit]  - Max statuses to return
   * @param {string} [options.type]   - Filter by type ('image', 'video', 'text', etc.)
   * @returns {Array}
   */
  function getAllStatuses({ limit, type } = {}) {
    let all = [];
    for (const list of statusMap.values()) all.push(...list);
    if (type) all = all.filter((s) => s.type === type);
    all.sort((a, b) => b.timestamp - a.timestamp);
    if (limit && limit > 0) all = all.slice(0, limit);
    return all;
  }

  /**
   * Get viewers of the bot's own status posts.
   * @param {string} [msgId] - Specific message ID. If omitted, returns all unique viewers.
   * @returns {Array<{ jid: string, timestamp: number }>}
   */
  function getStatusViewers(msgId) {
    if (msgId) return [...(viewerMap.get(msgId) || [])];

    const all = [];
    const seen = new Set();
    for (const vList of viewerMap.values()) {
      for (const v of vList) {
        if (!seen.has(v.jid)) {
          seen.add(v.jid);
          all.push(v);
        }
      }
    }
    return all.sort((a, b) => b.timestamp - a.timestamp);
  }

  // ── Download API ──────────────────────────────────────────────────────────

  /**
   * Download the media from a status entry.
   * @param {object} sock   - The Baileys socket
   * @param {object} status - A status entry from getContactStatuses/getAllStatuses
   * @returns {Promise<{ buffer: Buffer, mimetype: string, type: string, filename: string|null } | null>}
   */
  async function downloadStatus(sock, status) {
    if (!status?.message) return null;

    const media = extractMediaContent(status.message);
    if (!media) return null;

    try {
      const baileys = loadBaileys();
      const { downloadContentFromMessage } = baileys;
      if (typeof downloadContentFromMessage !== 'function') {
        throw new Error('downloadContentFromMessage not found in Baileys');
      }

      const stream = await downloadContentFromMessage(media.content, media.type);
      const chunks = [];
      for await (const chunk of stream) chunks.push(chunk);

      return {
        buffer: Buffer.concat(chunks),
        mimetype: media.content.mimetype || `${media.type}/*`,
        type: media.type,
        filename: media.content.fileName || null,
      };
    } catch (err) {
      throw new Error(`[kango-wa] Failed to download status media: ${err.message}`);
    }
  }

  // ── Post API ──────────────────────────────────────────────────────────────

  /**
   * Post a text status.
   * @param {object}   sock - Baileys socket
   * @param {string}   text - The text to post
   * @param {object}   [options]
   * @param {string}   [options.backgroundColor] - Hex color string (e.g. '#FF0000')
   * @param {number}   [options.font]            - Font type (1-5)
   * @param {string[]} [options.statusJidList]   - JIDs to show the status to (auto-collected if omitted)
   * @returns {Promise<object>} The sent message
   */
  async function postText(sock, text, options = {}) {
    let { backgroundColor, font, statusJidList } = options;
    if (!statusJidList) statusJidList = await collectStatusJidList(sock);

    return await sock.sendMessage(STATUS_JID, { text }, {
      statusJidList,
      backgroundColor,
      font: font || 0,
    });
  }

  /**
   * Post an image status.
   * Automatically optimizes the image via ffmpeg if available.
   *
   * @param {object}        sock  - Baileys socket
   * @param {Buffer|string|object} image - Image buffer, file path, or { url }
   * @param {object}        [options]
   * @param {string}        [options.caption]
   * @param {string[]}      [options.statusJidList]
   * @param {boolean}       [options.optimize=true] - Run through ffmpeg optimization
   * @returns {Promise<object>}
   */
  async function postImage(sock, image, options = {}) {
    let { caption, statusJidList, optimize = true } = options;
    if (!statusJidList) statusJidList = await collectStatusJidList(sock);

    let imgData = image;
    if (Buffer.isBuffer(image) && optimize) {
      try { imgData = await processImage(image, 'image/jpeg', _tmpDir); } catch (_) {}
    }

    return await sock.sendMessage(STATUS_JID, {
      image: typeof imgData === 'string' ? { url: imgData } : imgData,
      caption,
    }, { statusJidList });
  }

  /**
   * Post a video status.
   * Automatically optimizes the video via ffmpeg if available.
   *
   * @param {object}        sock  - Baileys socket
   * @param {Buffer|string|object} video - Video buffer, file path, or { url }
   * @param {object}        [options]
   * @param {string}        [options.caption]
   * @param {boolean}       [options.gifPlayback] - Send as GIF
   * @param {string[]}      [options.statusJidList]
   * @param {boolean}       [options.optimize=true]
   * @returns {Promise<object>}
   */
  async function postVideo(sock, video, options = {}) {
    let { caption, gifPlayback, statusJidList, optimize = true } = options;
    if (!statusJidList) statusJidList = await collectStatusJidList(sock);

    let vidData = video;
    if (Buffer.isBuffer(video) && optimize) {
      try { vidData = await processVideo(video, _tmpDir); } catch (_) {}
    }

    return await sock.sendMessage(STATUS_JID, {
      video: typeof vidData === 'string' ? { url: vidData } : vidData,
      caption,
      gifPlayback: !!gifPlayback,
    }, { statusJidList });
  }

  /**
   * Post an audio status (voice note).
   * Automatically converts to Opus OGG via ffmpeg if available.
   *
   * @param {object}        sock  - Baileys socket
   * @param {Buffer|string|object} audio - Audio buffer, file path, or { url }
   * @param {object}        [options]
   * @param {boolean}       [options.ptt=true] - Send as push-to-talk voice note
   * @param {string[]}      [options.statusJidList]
   * @param {boolean}       [options.optimize=true]
   * @returns {Promise<object>}
   */
  async function postAudio(sock, audio, options = {}) {
    let { ptt = true, statusJidList, optimize = true } = options;
    if (!statusJidList) statusJidList = await collectStatusJidList(sock);

    let audData = audio;
    let mimetype = 'audio/mpeg';

    if (Buffer.isBuffer(audio) && optimize) {
      try {
        const converted = await processAudio(audio, _tmpDir);
        if (converted) {
          audData = converted;
          mimetype = 'audio/ogg; codecs=opus';
        }
      } catch (_) {}
    }

    return await sock.sendMessage(STATUS_JID, {
      audio: typeof audData === 'string' ? { url: audData } : audData,
      mimetype,
      ptt,
    }, { statusJidList });
  }

  /**
   * All-in-one status posting from a bot command.
   *
   * Handles:
   *   - Text-only status with color/font parsing: `.poststatus 5 F3 Hello World`
   *   - Reply to image/video/audio to repost it as a status
   *   - Caption for media from remaining text
   *
   * This is the function your bot command handler should call.
   *
   * @param {object} sock    - Baileys socket
   * @param {string} chatId  - The chat JID where the command was received
   * @param {object} message - The raw Baileys message object
   * @param {string} rawText - The text after the command prefix (e.g. "5 F3 Hello")
   * @returns {Promise<string>} Confirmation message to send back to user
   *
   * @example
   * // In your command handler:
   * case 'poststatus':
   *   const result = await statusManager.postFromCommand(sock, chatId, message, args);
   *   await sock.sendMessage(chatId, { text: result });
   *   break;
   */
  async function postFromCommand(sock, chatId, message, rawText) {
    const { bgColor, fontStyle, statusText } = parseColorAndFont(rawText);
    const { targetMessage, hasQuoted } = resolveQuotedMessage(message, chatId);

    const qMsg = targetMessage.message;
    const isImage = !!qMsg?.imageMessage;
    const isVideo = !!qMsg?.videoMessage;
    const isAudio = !!qMsg?.audioMessage;
    const hasMedia = hasQuoted && (isImage || isVideo || isAudio);

    if (!statusText && !hasMedia) {
      throw new Error('Please provide text or reply to an image/video/audio.');
    }

    const participants = await collectStatusJidList(sock);
    const statusOpts = participants.length > 0 ? { statusJidList: participants } : {};

    const baileys = loadBaileys();
    const { downloadMediaMessage } = baileys;

    if (isImage) {
      const mimeType = qMsg.imageMessage.mimetype || 'image/jpeg';
      const raw = await downloadMediaMessage(targetMessage, 'buffer', {}, {
        logger: undefined,
        reuploadRequest: sock.updateMediaMessage,
      });
      const optimized = await processImage(raw, mimeType, _tmpDir);
      await sock.sendMessage(STATUS_JID, {
        image: optimized,
        caption: statusText || '',
      }, { ...statusOpts, backgroundColor: bgColor });
      return 'Image posted to your status!';
    }

    if (isVideo) {
      const raw = await downloadMediaMessage(targetMessage, 'buffer', {}, {
        logger: undefined,
        reuploadRequest: sock.updateMediaMessage,
      });
      const optimized = await processVideo(raw, _tmpDir);
      await sock.sendMessage(STATUS_JID, {
        video: optimized,
        caption: statusText || '',
        gifPlayback: false,
      }, statusOpts);
      return 'Video posted to your status!';
    }

    if (isAudio) {
      const raw = await downloadMediaMessage(targetMessage, 'buffer', {}, {
        logger: undefined,
        reuploadRequest: sock.updateMediaMessage,
      });
      const converted = await processAudio(raw, _tmpDir);
      if (converted) {
        await sock.sendMessage(STATUS_JID, {
          audio: converted,
          mimetype: 'audio/ogg; codecs=opus',
          ptt: true,
        }, { ...statusOpts, backgroundColor: bgColor });
      } else {
        const mime = qMsg.audioMessage.mimetype || 'audio/mpeg';
        await sock.sendMessage(STATUS_JID, {
          audio: raw,
          mimetype: mime,
        }, { ...statusOpts, backgroundColor: bgColor });
      }
      return 'Audio posted to your status!';
    }

    await sock.sendMessage(STATUS_JID, { text: statusText }, {
      ...statusOpts,
      backgroundColor: bgColor,
      font: fontStyle,
    });
    return `Text posted to your status!\nColor: ${bgColor}  |  Font: ${fontStyle}`;
  }

  /**
   * Delete/revoke a status you previously posted.
   * @param {object}   sock - Baileys socket
   * @param {object}   key  - The message key of the status to delete
   * @param {object}   [options]
   * @param {string[]} [options.statusJidList]
   * @returns {Promise<object>}
   */
  async function deleteStatus(sock, key, options = {}) {
    let { statusJidList } = options;
    if (!statusJidList) statusJidList = await collectStatusJidList(sock);
    return await sock.sendMessage(STATUS_JID, { delete: key }, { statusJidList });
  }

  // ── Housekeeping ──────────────────────────────────────────────────────────

  function stats() {
    let totalStatuses = 0;
    for (const list of statusMap.values()) totalStatuses += list.length;
    let totalViewers = 0;
    for (const list of viewerMap.values()) totalViewers += list.length;
    return { contacts: statusMap.size, totalStatuses, totalViewers, maxStatuses, ttl };
  }

  function cleanup() { _cleanExpired(); }
  function clear() { statusMap.clear(); viewerMap.clear(); }
  function destroy() {
    if (cleanupTimer) { clearInterval(cleanupTimer); cleanupTimer = null; }
  }

  return {
    bind,
    getContactStatuses,
    getStatusContacts,
    getAllStatuses,
    getStatusViewers,
    downloadStatus,
    postText,
    postImage,
    postVideo,
    postAudio,
    postFromCommand,
    deleteStatus,
    stats,
    cleanup,
    clear,
    destroy,
  };
}

module.exports = {
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
};
