const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  makeCacheableSignalKeyStore,
  fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Store active sessions
const sessions = {};

// ─── AUTH FOLDER ───────────────────────────────────────────────────────────
const AUTH_FOLDER = path.join(__dirname, 'auth_info');
if (!fs.existsSync(AUTH_FOLDER)) fs.mkdirSync(AUTH_FOLDER, { recursive: true });

// ─── PAIR CODE CONNECTION ───────────────────────────────────────────────────
async function connectWithPairCode(phoneNumber, socketId) {
  const socket = io.to(socketId);

  try {
    // Clean old auth for fresh pair
    const authPath = path.join(AUTH_FOLDER, phoneNumber);
    if (fs.existsSync(authPath)) {
      fs.rmSync(authPath, { recursive: true, force: true });
    }
    fs.mkdirSync(authPath, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(authPath);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      version,
      logger: pino({ level: 'silent' }),
      printQRInTerminal: false,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' }))
      },
      browser: ['Chrome (Linux)', 'Chrome', '117.0.0.0'],
      connectTimeoutMs: 60000,
      defaultQueryTimeoutMs: 60000,
      keepAliveIntervalMs: 10000,
      emitOwnEvents: false,
      shouldIgnoreJid: () => false,
      markOnlineOnConnect: true,
    });

    sessions[socketId] = { sock, phone: phoneNumber, connected: false };

    // ── Generate Pair Code ──────────────────────────────────────────────────
    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, isNewLogin } = update;

      // Generate pair code once registered
      if (!sock.authState.creds.registered) {
        try {
          await new Promise(r => setTimeout(r, 2000)); // wait for socket to stabilize
          const cleanPhone = phoneNumber.replace(/[^0-9]/g, '');
          const code = await sock.requestPairingCode(cleanPhone);
          const formatted = code.match(/.{1,4}/g).join('-');

          socket.emit('pair_code', {
            code: formatted,
            phone: cleanPhone,
            message: `Pair code generated! Enter this in WhatsApp → Linked Devices → Link with phone number`
          });

          console.log(`[PAIR CODE] ${cleanPhone}: ${formatted}`);
        } catch (err) {
          console.error('Pair code error:', err.message);
          socket.emit('error', { message: 'Pair code generate nahi hua: ' + err.message });
        }
      }

      if (connection === 'open') {
        sessions[socketId].connected = true;
        await saveCreds();
        const userJid = sock.user?.id || 'Unknown';
        socket.emit('connected', {
          message: '✅ WhatsApp Connected Successfully!',
          phone: userJid.split(':')[0]
        });
        console.log(`[CONNECTED] ${phoneNumber} connected!`);
      }

      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

        if (shouldReconnect && sessions[socketId]?.connected) {
          socket.emit('reconnecting', { message: '🔄 Reconnecting...' });
          setTimeout(() => connectWithPairCode(phoneNumber, socketId), 3000);
        } else {
          delete sessions[socketId];
          socket.emit('disconnected', { message: '❌ Disconnected. Please reconnect.' });
        }
      }
    });

    sock.ev.on('creds.update', saveCreds);

  } catch (err) {
    console.error('Connection error:', err);
    socket.emit('error', { message: 'Connection failed: ' + err.message });
  }
}

// ─── SOCKET.IO EVENTS ──────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log('[SOCKET] Client connected:', socket.id);

  socket.on('generate_pair_code', async (data) => {
    const { phone } = data;
    if (!phone) return socket.emit('error', { message: 'Phone number required!' });

    const cleanPhone = phone.replace(/[^0-9]/g, '');
    if (cleanPhone.length < 10) return socket.emit('error', { message: 'Invalid phone number!' });

    socket.emit('status', { message: '⏳ Connecting to WhatsApp...' });
    await connectWithPairCode(cleanPhone, socket.id);
  });

  socket.on('send_bulk', async (data) => {
    const { numbers, message, delay } = data;
    const session = sessions[socket.id];

    if (!session || !session.connected) {
      return socket.emit('error', { message: 'WhatsApp not connected! Generate pair code first.' });
    }

    if (!numbers || numbers.length === 0) {
      return socket.emit('error', { message: 'No numbers provided!' });
    }

    const delayMs = parseInt(delay) || 2000;
    let sent = 0, failed = 0;

    socket.emit('bulk_start', { total: numbers.length });

    for (let i = 0; i < numbers.length; i++) {
      const num = numbers[i].toString().replace(/[^0-9]/g, '');
      if (!num || num.length < 10) {
        failed++;
        socket.emit('bulk_progress', {
          current: i + 1,
          total: numbers.length,
          sent,
          failed,
          number: num,
          status: 'invalid'
        });
        continue;
      }

      try {
        const jid = `${num}@s.whatsapp.net`;
        await session.sock.sendMessage(jid, { text: message });
        sent++;
        socket.emit('bulk_progress', {
          current: i + 1,
          total: numbers.length,
          sent,
          failed,
          number: num,
          status: 'sent'
        });
        console.log(`[SENT] → ${num}`);
      } catch (err) {
        failed++;
        socket.emit('bulk_progress', {
          current: i + 1,
          total: numbers.length,
          sent,
          failed,
          number: num,
          status: 'failed',
          error: err.message
        });
        console.error(`[FAILED] → ${num}:`, err.message);
      }

      if (i < numbers.length - 1) {
        await new Promise(r => setTimeout(r, delayMs));
      }
    }

    socket.emit('bulk_done', { sent, failed, total: numbers.length });
  });

  socket.on('disconnect', () => {
    console.log('[SOCKET] Client disconnected:', socket.id);
    if (sessions[socket.id]) {
      try { sessions[socket.id].sock.end(); } catch (e) {}
      delete sessions[socket.id];
    }
  });
});

// ─── START SERVER ──────────────────────────────────────────────────────────
const PORT = 3000;
server.listen(PORT, () => {
  console.log(`\n🚀 WhatsApp Bulk Sender running at http://localhost:${PORT}\n`);
});
