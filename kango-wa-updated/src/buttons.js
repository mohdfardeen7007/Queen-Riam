// kango-wa/src/buttons.js
// Clean, transparent implementation of WhatsApp interactive button messages.
// Copyright (c) 2026 Hector Manuel. All rights reserved.

'use strict';

const { loadBaileys, isGroup } = require('./utils');

// ─── Button type constants ───────────────────────────────────────────────────

const SPECIAL_FLOW_NAMES = new Set([
  'mpm',
  'cta_catalog',
  'send_location',
  'call_permission_request',
  'wa_payment_transaction_details',
  'automated_greeting_message_view_catalog',
]);

const PAYMENT_FLOW_NAMES = {
  review_and_pay: 'order_details',
  payment_info: 'payment_info',
};

// ─── Button normalization ────────────────────────────────────────────────────

/**
 * Normalize a single button entry into the native_flow format.
 * Accepts either:
 *   - Modern:  { name, buttonParamsJson }
 *   - Legacy:  { id, text } or { buttonId, buttonText: { displayText } }
 *
 * @param {object} btn
 * @param {number} index
 * @returns {object}
 */
function normalizeButton(btn, index) {
  if (!btn || typeof btn !== 'object') {
    throw new Error(`[kango-wa] Button at index ${index} is not a valid object`);
  }

  // Already in native_flow format
  if (btn.name && btn.buttonParamsJson !== undefined) {
    const params =
      typeof btn.buttonParamsJson === 'string'
        ? btn.buttonParamsJson
        : JSON.stringify(btn.buttonParamsJson);
    return { name: btn.name, buttonParamsJson: params };
  }

  // Legacy: { id, text }
  if (btn.id !== undefined || btn.text !== undefined) {
    return {
      name: 'quick_reply',
      buttonParamsJson: JSON.stringify({
        display_text: btn.text || `Option ${index + 1}`,
        id: btn.id || `btn_${index}`,
      }),
    };
  }

  // Legacy: { buttonId, buttonText: { displayText } }
  if (btn.buttonId !== undefined || btn.buttonText !== undefined) {
    return {
      name: 'quick_reply',
      buttonParamsJson: JSON.stringify({
        display_text: btn.buttonText?.displayText || `Option ${index + 1}`,
        id: btn.buttonId || `btn_${index}`,
      }),
    };
  }

  // Unknown shape — pass through and let WhatsApp decide
  return btn;
}

/**
 * Normalize an array of buttons.
 * @param {Array} buttons
 * @returns {Array}
 */
function normalizeButtons(buttons) {
  if (!Array.isArray(buttons)) {
    throw new Error('[kango-wa] buttons must be an array');
  }
  if (buttons.length === 0) {
    throw new Error('[kango-wa] buttons array cannot be empty');
  }
  if (buttons.length > 25) {
    console.warn('[kango-wa] Warning: More than 25 buttons may not render correctly on WhatsApp');
  }
  return buttons.map((btn, i) => normalizeButton(btn, i));
}

// ─── Message conversion ──────────────────────────────────────────────────────

/**
 * Convert a high-level content object into a Baileys interactiveMessage shape.
 * @param {object} content
 * @returns {object}
 */
function convertToInteractiveMessage(content) {
  const buttons = normalizeButtons(content.interactiveButtons || content.buttons || []);

  const interactiveMessage = {
    nativeFlowMessage: { buttons },
    body: { text: content.text || '' },
  };

  if (content.footer) {
    interactiveMessage.footer = { text: content.footer };
  }

  if (content.contextInfo) {
    interactiveMessage.contextInfo = content.contextInfo;
  }

  if (content.title || content.subtitle) {
    interactiveMessage.header = {
      title: content.title || '',
      subtitle: content.subtitle || '',
      hasMediaAttachment: false,
    };
  }

  if (content.image) {
    interactiveMessage.header = {
      ...interactiveMessage.header,
      hasMediaAttachment: true,
      imageMessage: resolveImageMessage(content.image),
    };
  }

  return { interactiveMessage };
}

/**
 * Resolve an image input (URL, buffer, or local path) into a Baileys imageMessage.
 * @param {string|object|Buffer} image
 * @returns {object}
 */
function resolveImageMessage(image) {
  if (typeof image === 'string') {
    // Treat as URL
    return { url: image };
  }
  if (Buffer.isBuffer(image)) {
    return { buffer: image };
  }
  if (image && typeof image === 'object') {
    return image; // Already a Baileys media object
  }
  throw new Error('[kango-wa] Invalid image format. Use a URL string, Buffer, or Baileys media object.');
}

// ─── Binary node building ────────────────────────────────────────────────────

/**
 * Determine the native flow name and version to use for the binary nodes,
 * based on the first button's name.
 * @param {Array} buttons - normalized buttons
 * @returns {{ flowName: string, version: string }}
 */
function getFlowMeta(buttons) {
  const firstName = buttons[0]?.name || '';

  if (PAYMENT_FLOW_NAMES[firstName]) {
    return { flowName: PAYMENT_FLOW_NAMES[firstName], version: '1' };
  }

  if (SPECIAL_FLOW_NAMES.has(firstName)) {
    return { flowName: firstName, version: '2' };
  }

  return { flowName: 'mixed', version: '9' };
}

/**
 * Build the required binary nodes for an interactive message.
 *
 * Private chats:
 *   [ biz > [ interactive > [ native_flow ] ], bot ]
 *
 * Group chats:
 *   [ biz > [ interactive > [ native_flow ] ] ]
 *
 * @param {Array}   buttons  - normalized buttons
 * @param {string}  jid      - destination JID
 * @param {boolean} aiMode   - inject bot node for AI rendering
 * @returns {Array} Binary nodes to pass as additionalNodes
 */
function buildInteractiveNodes(buttons, jid, aiMode = false) {
  const { flowName, version } = getFlowMeta(buttons);
  const isGroupChat = isGroup(jid);

  const nativeFlowNode = {
    tag: 'native_flow',
    attrs: { name: flowName, v: version },
  };

  const interactiveNode = {
    tag: 'interactive',
    attrs: { type: 'native_flow', v: '1' },
    content: [nativeFlowNode],
  };

  const bizNode = {
    tag: 'biz',
    attrs: {},
    content: [interactiveNode],
  };

  const nodes = [bizNode];

  if (!isGroupChat && aiMode) {
    nodes.push({ tag: 'bot', attrs: { biz_bot: '1' } });
  }

  return nodes;
}

// ─── Core send function ──────────────────────────────────────────────────────

/**
 * Send an interactive message with buttons.
 * Low-level power API — use sendButtons() for the common case.
 *
 * @param {object} sock        - Active Baileys socket
 * @param {string} jid         - Destination WhatsApp JID
 * @param {object} content     - Message content
 * @param {object} [options]   - Extra relay options
 * @returns {Promise<object>}  - The constructed WAMessage
 */
async function sendInteractiveMessage(sock, jid, content, options = {}) {
  if (!sock) throw new Error('[kango-wa] sock (socket) is required');
  if (!jid) throw new Error('[kango-wa] jid (destination) is required');

  const quoted = content.quoted || options.quoted || null;

  const baileys = loadBaileys();
  const {
    generateWAMessageFromContent,
    normalizeMessageContent,
    generateMessageIDV2,
    prepareWAMessageMedia,
  } = baileys;

  if (!generateWAMessageFromContent) {
    throw new Error(
      '[kango-wa] Could not load Baileys internals. ' +
      'Make sure you are using a supported Baileys version (>= 6.0.0)'
    );
  }

  // If image is a raw buffer or URL, upload it first so interactive messages can display it
  if (content.image && prepareWAMessageMedia && typeof sock.waUploadToServer === 'function') {
    const needsUpload = Buffer.isBuffer(content.image) || typeof content.image === 'string';
    if (needsUpload) {
      try {
        const imgInput = Buffer.isBuffer(content.image)
          ? { image: content.image }
          : { image: { url: content.image } };

        const uploaded = await prepareWAMessageMedia(imgInput, { upload: sock.waUploadToServer });
        if (uploaded?.imageMessage) {
          content = { ...content, image: uploaded.imageMessage };
        }
      } catch (err) {
        console.warn('[kango-wa] Image upload for interactive message failed, image may not display:', err.message);
      }
    }
  }

  // If interactiveButtons or buttons are provided, convert to interactiveMessage format
  let messageContent = content;
  const rawButtons = content.interactiveButtons || content.buttons;
  if (rawButtons) {
    messageContent = convertToInteractiveMessage(content);
  }

  // Normalize the message
  const normalized = normalizeMessageContent
    ? normalizeMessageContent(messageContent)
    : messageContent;

  // Build the WAMessage
  const msgId = generateMessageIDV2
    ? generateMessageIDV2(sock.user?.id)
    : undefined;

  const msg = generateWAMessageFromContent(jid, normalized, {
    userJid: sock.user?.id,
    ...(msgId ? { messageId: msgId } : {}),
    ...(quoted ? { quoted } : {}),
    ...options,
  });

  // Get the normalized buttons for node building
  const buttons = normalizeButtons(rawButtons || []);
  const aiMode = content.aiMode || content.aimode || false;

  const autoNodes = buildInteractiveNodes(buttons, jid, aiMode);
  const additionalNodes = [...(options.additionalNodes || []), ...autoNodes];

  // Relay the message
  await sock.relayMessage(jid, msg.message, {
    messageId: msg.key.id,
    additionalNodes,
    ...(options.statusJidList ? { statusJidList: options.statusJidList } : {}),
    ...(options.additionalAttributes ? { additionalAttributes: options.additionalAttributes } : {}),
  });

  // Emit locally for private chats if configured
  if (!isGroup(jid) && sock.config?.emitOwnEvents && sock.upsertMessage) {
    await sock.upsertMessage(msg, 'append');
  }

  return msg;
}

/**
 * High-level helper — the easiest way to send buttons.
 *
 * @param {object} sock
 * @param {string} jid
 * @param {object} content
 *   @param {string}         content.text     - Body text (required)
 *   @param {string}         [content.title]  - Header title
 *   @param {string}         [content.footer] - Footer text
 *   @param {string|object}  [content.image]  - Header image (URL, Buffer, or object)
 *   @param {boolean}        [content.aiMode] - Enable AI mode for private chats
 *   @param {Array}          content.buttons  - Array of button objects
 * @returns {Promise<object>}
 *
 * @example
 * await sendButtons(sock, jid, {
 *   text: 'Pick an option below',
 *   footer: 'Powered by Kango-WA',
 *   buttons: [
 *     { id: 'yes', text: 'Yes' },
 *     { name: 'cta_url', buttonParamsJson: JSON.stringify({ display_text: 'Docs', url: 'https://example.com' }) },
 *   ]
 * });
 */
async function sendButtons(sock, jid, content) {
  if (!content.buttons && !content.interactiveButtons) {
    throw new Error('[kango-wa] sendButtons requires a buttons array');
  }
  // Unify field name
  const normalized = {
    ...content,
    interactiveButtons: content.interactiveButtons || content.buttons,
  };
  delete normalized.buttons;
  return sendInteractiveMessage(sock, jid, normalized);
}

module.exports = {
  sendButtons,
  sendInteractiveMessage,
  normalizeButtons,
  normalizeButton,
  convertToInteractiveMessage,
  buildInteractiveNodes,
};
