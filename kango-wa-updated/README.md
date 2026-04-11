# kango-wa

**Author: Hector Manuel**

A clean, production-ready WhatsApp toolkit for Baileys — written in plain JavaScript with zero obfuscation.

Fills the gaps the Baileys ecosystem is missing: interactive buttons, auto-reconnect, message queue, conversation flows, group metadata cache, production auth state adapters, and a complete JID/LID mapping system for multi-device.

Works with `@whiskeysockets/baileys` and `baileys`.

---

## Installation

```bash
npm install kango-wa
# plus whichever Baileys fork you use:
npm install @whiskeysockets/baileys
# or
npm install baileys
```

Optional — only needed for the auth adapters you choose:
```bash
npm install ioredis   # for Redis auth state
npm install pg        # for PostgreSQL auth state
```

---

## Quick start — full bot setup

```js
const makeWASocket = require('baileys');
const {
  createStore,
  createGroupCache,
  createReconnectManager,
  createJidMapper,
  sendButtons,
} = require('kango-wa');

const store     = createStore();
const groupCache = createGroupCache({ ttl: 5 * 60 * 1000 });
const jidMapper  = createJidMapper();

const manager = createReconnectManager({
  connect() {
    const { state } = /* your auth state */;

    const sock = makeWASocket({
      auth: state,
      getMessage: store.getMessageLoader(),
      cachedGroupMetadata: groupCache.cachedGroupMetadata,
    });

    store.bind(sock.ev);
    jidMapper.bind(sock.ev);

    sock.ev.on('connection.update', ({ connection }) => {
      if (connection === 'open') {
        jidMapper.primeSelf(sock.user);
        jidMapper.patchSocket(sock); // adds sock.decodeJid(), sock.getName(), etc.
      }
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.upsert', async ({ messages }) => {
      const msg   = messages[0];
      const sender = jidMapper.extractSender(msg);
      const text   = msg.message?.conversation || '';
      console.log(`Message from ${sender}: ${text}`);
    });

    return sock;
  },

  maxRetries: 10,
  onLoggedOut: () => console.log('Logged out — re-authenticate'),
});

manager.start();
```

---

## Modules

### Buttons (`sendButtons`, `sendInteractiveMessage`)

Sends interactive button messages that work in WhatsApp today. The old `buttonsMessage` was removed by WhatsApp — this uses the correct `nativeFlowMessage` format.

```js
const { sendButtons } = require('kango-wa');

// Simple quick-reply buttons
await sendButtons(sock, jid, {
  text: 'Choose an option:',
  footer: 'Powered by kango-wa',
  buttons: [
    { id: 'yes', text: 'Yes' },
    { id: 'no',  text: 'No'  },
  ],
});

// URL button
await sendButtons(sock, jid, {
  text: 'Visit our website',
  buttons: [
    {
      name: 'cta_url',
      buttonParamsJson: JSON.stringify({
        display_text: 'Open Docs',
        url: 'https://example.com',
        merchant_url: 'https://example.com',
      }),
    },
  ],
});

// With header image
await sendButtons(sock, jid, {
  title: 'Pick a plan',
  text: 'Choose your subscription:',
  image: 'https://example.com/plans.jpg',
  buttons: [
    { id: 'free',  text: 'Free'  },
    { id: 'pro',   text: 'Pro'   },
  ],
});
```

**Button types supported:**

| Button name           | What it does                        |
|-----------------------|-------------------------------------|
| `quick_reply`         | Sends a text reply when tapped      |
| `cta_url`             | Opens a URL                         |
| `cta_call`            | Initiates a phone call              |
| `cta_copy`            | Copies text to clipboard            |
| `send_location`       | Requests location from user         |
| `cta_reminder`        | Sets a reminder                     |
| `mpm`                 | Multi-product message               |
| `cta_catalog`         | Opens a catalog                     |

**Reading button replies in your message handler:**

```js
sock.ev.on('messages.upsert', ({ messages }) => {
  const msg = messages[0];
  // Button reply ID is here:
  const selectedId = msg.message?.interactiveResponseMessage?.nativeFlowResponseMessage?.paramsJson;
  if (selectedId) {
    const { id } = JSON.parse(selectedId);
    console.log('User tapped button:', id);
  }
});
```

---

### Auto-reconnect (`createReconnectManager`)

Handles every disconnect reason correctly. Uses exponential backoff with jitter. Does not retry on logout (status 401) or connection replaced (440).

```js
const { createReconnectManager } = require('kango-wa');

const manager = createReconnectManager({
  connect: () => makeWASocket({ auth: state }),

  maxRetries: 10,      // 0 = unlimited
  baseDelay:  2000,    // first retry after 2s
  maxDelay:   60000,   // never wait more than 60s

  onReconnect: (attempt) => console.log(`Reconnecting (attempt ${attempt})`),
  onGiveUp:    (attempts) => console.log(`Gave up after ${attempts} attempts`),
  onLoggedOut: () => {
    // Delete session files and re-authenticate
  },
});

manager.start();

// Later, if you want to stop:
manager.stop();

// Check current socket:
const sock = manager.getSocket();
```

---

### Message Queue (`createMessageQueue`)

Queues outgoing messages and sends them at a safe, human-like pace. Prevents account bans from sending too fast.

```js
const { createMessageQueue } = require('kango-wa');

const queue = createMessageQueue({
  minDelay: 800,    // minimum ms between messages
  maxDelay: 2000,   // maximum ms (adds jitter)
  maxQueueSize: 500,

  onSent:  ({ jid }) => console.log('Sent to', jid),
  onError: ({ jid, error }) => console.error('Failed to send to', jid, error),
});

// Queue a message (returns a Promise that resolves when sent)
await queue.add(sock, jid, { text: 'Hello!' });

// High priority — goes to front of queue
await queue.add(sock, jid, { text: 'Urgent!' }, { priority: 'high' });

// Broadcast to multiple users
await queue.addBatch([
  { sock, jid: jid1, message: { text: 'Hey 1' } },
  { sock, jid: jid2, message: { text: 'Hey 2' } },
  { sock, jid: jid3, message: { text: 'Hey 3' } },
]);

// Check status
console.log(queue.stats());
// → { pending: 2, highPriority: 0, normal: 2, totalSent: 10, ... }
```

---

### Conversation Flows (`createFlowEngine`)

Build multi-step chat interactions without nested callbacks or global state. Each user gets their own session, stored in memory (or Redis/PostgreSQL if you plug in a custom store).

```js
const { createFlowEngine } = require('kango-wa');

const flows = createFlowEngine({ ttl: 30 * 60 * 1000 }); // 30 min session TTL

// Define a flow
flows.define('register', {
  // First step runs immediately when flow starts
  ask_name: async ({ reply }) => {
    await reply('What is your name?');
    return 'ask_email'; // advance to next step
  },

  ask_email: async ({ text, data, reply }) => {
    data.name = text; // store input in session
    await reply(`Hi ${text}! What is your email?`);
    return 'confirm';
  },

  confirm: async ({ text, data, reply }) => {
    data.email = text;
    await reply(`Registered!\nName: ${data.name}\nEmail: ${data.email}`);
    return null; // null ends the flow
  },
});

// In your message handler:
sock.ev.on('messages.upsert', async ({ messages }) => {
  const msg  = messages[0];
  const jid  = msg.key.remoteJid;
  const text = msg.message?.conversation || '';

  const reply = (t) => sock.sendMessage(jid, { text: t });

  if (text === '!register') {
    await flows.start(jid, 'register', { reply });
    return;
  }

  // If user is inside a flow, route the message to the flow engine
  const handled = await flows.handle(jid, text, { reply });
  if (handled) return; // message was consumed by flow

  // Normal command handling here...
});
```

**Using a Redis store instead of memory:**

```js
const Redis = require('ioredis');
const redis = new Redis(process.env.REDIS_URL);

const flows = createFlowEngine({
  store: {
    async get(key)              { const v = await redis.get(key); return v ? JSON.parse(v) : null; },
    async set(key, val, ttlMs)  { await redis.set(key, JSON.stringify(val), 'PX', ttlMs); },
    async del(key)              { await redis.del(key); },
  },
});
```

---

### Group Metadata Cache (`createGroupCache`)

Every group message can trigger a metadata fetch. This cache returns fresh data instantly and refreshes stale entries in the background.

```js
const { createGroupCache } = require('kango-wa');

const { cachedGroupMetadata, invalidate, stats } = createGroupCache({
  ttl:               5 * 60 * 1000, // 5 minutes
  maxEntries:        500,
  backgroundRefresh: true,           // return stale data, refresh behind the scenes
});

const sock = makeWASocket({
  auth: state,
  cachedGroupMetadata, // plug directly into socket config
});

// When group participants change — invalidate that group's cache:
sock.ev.on('group-participants.update', ({ id }) => invalidate(id));

// Check cache performance:
console.log(stats());
// → { entries: 12, hits: 450, misses: 23, hitRate: '95.1%', ... }
```

---

### In-memory Store (`createStore`)

A full replacement for the removed `makeInMemoryStore`. Tracks messages, chats, contacts, and group metadata. The key feature is `getMessageLoader()` which lets Baileys resolve quoted messages automatically.

```js
const { createStore } = require('kango-wa');

const store = createStore({
  maxMessagesPerChat: 200,  // how many messages to keep per chat
  maxChats: 1000,           // max chats to track in memory
});

const sock = makeWASocket({
  auth: state,
  getMessage: store.getMessageLoader(), // enables quoted message resolution
});

store.bind(sock.ev); // attach to socket events — call this once

// Query the store anytime:
const msg      = store.getMessage(jid, msgId);        // single message lookup
const msgs     = store.getMessages(jid);              // all messages for a chat
const chat     = store.getChat(jid);
const contact  = store.getContact(jid);
const meta     = store.getGroupMetadata(jid);

console.log(store.stats());
// → { chats: 5, contacts: 120, groups: 3, totalMessages: 847, ... }
```

---

### JID / LID Mapping (`createJidMapper`)

WhatsApp's multi-device protocol uses two identity systems: the classic JID (`1234567890@s.whatsapp.net`) and the newer LID (`123456789012345@lid`). In groups, the `participant` field can come back as a LID, which silently breaks admin checks, ban lists, and DM sending.

This module maintains a live bidirectional map and always returns the canonical JID.

```js
const { createJidMapper } = require('kango-wa');

const jidMapper = createJidMapper();

// Bind to socket events — auto-populates from contacts, groups, and messages
jidMapper.bind(sock.ev);

// Prime with the bot's own identity when connection opens
sock.ev.on('connection.update', ({ connection }) => {
  if (connection === 'open') {
    jidMapper.primeSelf(sock.user);
  }
});

// Optionally patch the socket for drop-in compatibility with sock.decodeJid() etc.
jidMapper.patchSocket(sock);
// Now you can use: sock.decodeJid(), sock.getName(), sock.resolveJid(), sock.isSame(), sock.extractSender()
```

**In your message handler:**

```js
sock.ev.on('messages.upsert', async ({ messages }) => {
  const msg = messages[0];

  // Always returns a clean JID — handles LID, device suffix, DM, and group correctly
  const sender = jidMapper.extractSender(msg);

  // Safe comparison — works even if one is a LID and the other is a JID
  const isOwner = jidMapper.isSame(sender, '233509977126@s.whatsapp.net');

  // Resolve any identifier to canonical JID
  const jid = jidMapper.resolveJid(msg.key.participant);

  // Get display name
  const name = jidMapper.getName(sender);
});
```

**All JID mapper methods:**

| Method                       | Description                                                    |
|------------------------------|----------------------------------------------------------------|
| `bind(sock.ev)`              | Auto-populate map from socket events                           |
| `primeSelf(sock.user)`       | Seed the bot's own JID/LID pair on connect                     |
| `prime(jid, lid)`            | Manually register a known pair                                 |
| `patchSocket(sock)`          | Add mapper methods directly onto the socket object             |
| `resolveJid(jidOrLid)`       | Always returns canonical JID, strips device suffix             |
| `extractSender(msg)`         | Get clean sender JID from a raw Baileys message                |
| `isSame(a, b)`               | Compare two identifiers regardless of form (JID, LID, suffix)  |
| `getLid(jid)`                | Get the LID for a known JID                                    |
| `getName(jidOrLid)`          | Get display name, falls back to phone number                   |
| `hasLid(lid)`                | Check if a LID is in the map                                   |
| `hasMapping(jid)`            | Check if a JID has a known LID mapping                         |
| `stats()`                    | `{ mappedPairs, namedContacts }`                               |
| `dump()`                     | Full map dump for debugging                                    |

**Standalone JID helpers (no instance needed):**

```js
const { decodeJid, isLid, isUserJid, isGroupJid, toPhoneNumber } = require('kango-wa');

decodeJid('1234567890:5@s.whatsapp.net')  // → '1234567890@s.whatsapp.net'
isLid('123456789012345@lid')              // → true
isUserJid('1234567890@s.whatsapp.net')    // → true
isGroupJid('1234-5678@g.us')              // → true
toPhoneNumber('233509977126@s.whatsapp.net') // → '233509977126'
```

---

### Auth Adapters

Baileys ships `useMultiFileAuthState` which stores session data as plain files — it is marked as a demo and not recommended for production. These adapters store auth state in Redis or PostgreSQL instead.

#### Redis (`useRedisAuthState`)

```js
const Redis = require('ioredis');
const { useRedisAuthState } = require('kango-wa');

const redis = new Redis(process.env.REDIS_URL);

const { state, saveCreds, clearSession } = await useRedisAuthState(redis, 'my-bot');

const sock = makeWASocket({ auth: state });
sock.ev.on('creds.update', saveCreds);

// On logout — delete all session data from Redis:
await clearSession();
```

Auth data is stored under the key prefix `kango:auth:<sessionId>`. Multiple bots can share the same Redis instance with different session IDs.

#### PostgreSQL (`usePostgresAuthState`)

```js
const { Pool } = require('pg');
const { usePostgresAuthState, createAuthTable } = require('kango-wa');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// Run once during app setup:
await createAuthTable(pool);

const { state, saveCreds, clearSession } = await usePostgresAuthState(pool, 'my-bot');

const sock = makeWASocket({ auth: state });
sock.ev.on('creds.update', saveCreds);

// On logout:
await clearSession();
```

The table created is `kango_auth_state`. Multiple bots can share the same database.

---

## Putting it all together — production bot template

```js
'use strict';

const makeWASocket       = require('@whiskeysockets/baileys');
const { useRedisAuthState } = require('kango-wa/src/auth/redis');
const Redis              = require('ioredis');

const {
  createStore,
  createGroupCache,
  createReconnectManager,
  createMessageQueue,
  createFlowEngine,
  createJidMapper,
  sendButtons,
} = require('kango-wa');

const redis = new Redis(process.env.REDIS_URL);

// ── Shared instances ──────────────────────────────────────────────────────────
const store      = createStore({ maxMessagesPerChat: 200 });
const groupCache = createGroupCache({ ttl: 5 * 60 * 1000 });
const queue      = createMessageQueue({ minDelay: 800, maxDelay: 2000 });
const flows      = createFlowEngine({ ttl: 30 * 60 * 1000 });
const jidMapper  = createJidMapper();

// ── Conversation flow definitions ─────────────────────────────────────────────
flows.define('onboard', {
  ask_name: async ({ reply }) => {
    await reply("Welcome! What should I call you?");
    return 'done';
  },
  done: async ({ text, reply }) => {
    await reply(`Nice to meet you, ${text}!`);
    return null;
  },
});

// ── Bot factory ───────────────────────────────────────────────────────────────
async function createBot() {
  const { state, saveCreds } = await useRedisAuthState(redis, 'my-bot');

  const manager = createReconnectManager({
    connect() {
      const sock = makeWASocket({
        auth:                state,
        getMessage:          store.getMessageLoader(),
        cachedGroupMetadata: groupCache.cachedGroupMetadata,
      });

      store.bind(sock.ev);
      jidMapper.bind(sock.ev);

      sock.ev.on('connection.update', ({ connection }) => {
        if (connection === 'open') {
          jidMapper.primeSelf(sock.user);
          jidMapper.patchSocket(sock);
          console.log('Bot connected:', sock.user.id);
        }
      });

      sock.ev.on('creds.update', saveCreds);

      sock.ev.on('group-participants.update', ({ id }) => {
        groupCache.invalidate(id); // keep cache fresh on participant changes
      });

      sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;

        const msg    = messages[0];
        if (!msg?.key?.remoteJid) return;

        const jid    = msg.key.remoteJid;
        const sender = jidMapper.extractSender(msg);
        const text   = msg.message?.conversation
                    || msg.message?.extendedTextMessage?.text
                    || '';

        // Route to active flow first
        const inFlow = await flows.handle(jid, text, {
          reply: (t) => queue.add(sock, jid, { text: t }),
        });
        if (inFlow) return;

        // Commands
        if (text === '!start') {
          await flows.start(jid, 'onboard', {
            reply: (t) => queue.add(sock, jid, { text: t }),
          });
          return;
        }

        if (text === '!menu') {
          await sendButtons(sock, jid, {
            text: 'What would you like to do?',
            footer: 'My Bot',
            buttons: [
              { id: 'help',  text: 'Help'      },
              { id: 'about', text: 'About'      },
              { id: 'stop',  text: 'Stop bot'   },
            ],
          });
          return;
        }
      });

      return sock;
    },

    maxRetries: 0, // unlimited
    onLoggedOut: () => {
      console.log('Logged out — clear session and re-authenticate');
      process.exit(1);
    },
  });

  manager.start();
}

createBot().catch(console.error);
```

---

## API reference summary

| Export                   | What it does                                             |
|--------------------------|----------------------------------------------------------|
| `sendButtons`            | Send interactive button messages                         |
| `sendInteractiveMessage` | Low-level interactive message sender                     |
| `normalizeButton`        | Normalize a single button to native_flow format          |
| `normalizeButtons`       | Normalize an array of buttons                            |
| `createReconnectManager` | Auto-reconnect with exponential backoff                  |
| `createMessageQueue`     | Rate-limited outgoing message queue                      |
| `createFlowEngine`       | Multi-step conversation flow engine                      |
| `createMemoryStore`      | Simple in-memory store for flow sessions                 |
| `createGroupCache`       | Group metadata cache with background refresh             |
| `createStore`            | Full in-memory store (messages, chats, contacts, groups) |
| `createJidMapper`        | Bidirectional JID ↔ LID mapping                         |
| `useRedisAuthState`      | Redis-backed production auth state                       |
| `usePostgresAuthState`   | PostgreSQL-backed production auth state                  |
| `createAuthTable`        | Create the PostgreSQL table for auth state               |
| `decodeJid`              | Strip device suffix from JID                             |
| `isLid`                  | Check if string is a LID address                         |
| `isUserJid`              | Check if string is a user JID                            |
| `isGroupJid`             | Check if string is a group JID                           |
| `isNewsletterJid`        | Check if string is a newsletter JID                      |
| `isStatusJid`            | Check if string is the status broadcast JID              |
| `toPhoneNumber`          | Extract phone number from a JID                          |

---

## License

MIT
