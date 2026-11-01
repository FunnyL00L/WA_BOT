import express from 'express';
import cors from 'cors';
import multer from 'multer';
import QRCode from 'qrcode';
import path from 'path';
import fs from 'fs';
import pino from 'pino';
import cron from 'node-cron';
import makeWASocket, {
  Browsers,
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  downloadMediaMessage
} from '@whiskeysockets/baileys';
import qrcodeTerminal from 'qrcode-terminal';

import {
  loadBotData,
  saveBotConfig,
  getAvailableModel,
  hasActiveSession,
  touchUserSession,
  generateAIResponse,
  processReceiptImage,
  getDatabaseRecords,
  deleteDatabaseRecord,
  getActiveContactsCount
} from './dataService.js';

const app = express();
const PORT = 3000;
const HOST = '0.0.0.0';

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.resolve('public')));

const upload = multer({ storage: multer.memoryStorage() });

let activeSock = null;

let waStatus = {
  connectionStatus: 'connecting',
  qrCodeDataUrl: null,
  pairingCode: null,
  activeModel: 'Gemini / Groq AI',
  lastError: null
};

function clearAuthSessionFolder() {
  const authDir = path.resolve('auth_session');
  if (fs.existsSync(authDir)) {
    try {
      fs.rmSync(authDir, { recursive: true, force: true });
      console.log('🧹 Folder auth_session berhasil dibersihkan.');
    } catch (e) {
      console.warn('Gagal membersihkan auth_session:', e.message);
    }
  }
}

// WhatsApp Socket Connection
async function connectToWhatsApp(resetSession = false) {
  if (resetSession) {
    clearAuthSessionFolder();
  }

  try {
    const { state, saveCreds } = await useMultiFileAuthState('auth_session');
    let version;
    try {
      const vObj = await fetchLatestBaileysVersion();
      version = vObj.version;
    } catch {
      version = [2, 3000, 1015901307];
    }

    const sock = makeWASocket({
      version,
      logger: pino({ level: 'silent' }),
      auth: state,
      printQRInTerminal: false,
      browser: Browsers.macOS('Desktop'),
      syncFullHistory: false,
      markOnlineOnConnect: false,
      connectTimeoutMs: 60000,
      defaultQueryTimeoutMs: 60000,
      keepAliveIntervalMs: 30000
    });

    activeSock = sock;

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        waStatus.connectionStatus = 'qr_ready';
        try {
          waStatus.qrCodeDataUrl = await QRCode.toDataURL(qr);
        } catch (qrErr) {
          console.error('Gagal generate QR DataURL:', qrErr);
        }
        console.log('\nSilakan scan QR code berikut via WhatsApp:');
        qrcodeTerminal.generate(qr, { small: true });
      }

      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

        waStatus.connectionStatus = 'disconnected';
        waStatus.qrCodeDataUrl = null;
        waStatus.pairingCode = null;
        console.log(`Koneksi terputus (Status: ${statusCode}). Reconnecting: ${shouldReconnect}`);

        if (statusCode === DisconnectReason.loggedOut) {
          clearAuthSessionFolder();
        }

        if (shouldReconnect) {
          setTimeout(() => connectToWhatsApp(false), 5000);
        }
      } else if (connection === 'open') {
        waStatus.connectionStatus = 'connected';
        waStatus.qrCodeDataUrl = null;
        waStatus.pairingCode = null;
        const modelName = await getAvailableModel();
        waStatus.activeModel = modelName;
        console.log('✅ WhatsApp Bot terhubung dan siap digunakan!');
        console.log(`🤖 Menggunakan model aktif: ${modelName}`);
      }
    });

    // Handler pesan masuk via WhatsApp
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify' || !messages || messages.length === 0) return;

      const msg = messages[0];
      if (msg.key.fromMe || msg.key.remoteJid === 'status@broadcast') return;
      if (msg.key.remoteJid.endsWith('@g.us') || msg.key.remoteJid.endsWith('@newsletter')) return;

      const senderJid = msg.key.remoteJid;
      const senderName = msg.pushName || 'Kak';

      const rawMsg = msg.message?.ephemeralMessage?.message || msg.message;
      const isImage = Boolean(rawMsg?.imageMessage);

      const incomingText = (
        rawMsg?.conversation ||
        rawMsg?.extendedTextMessage?.text ||
        rawMsg?.imageMessage?.caption ||
        rawMsg?.videoMessage?.caption ||
        ''
      ).trim();

      if (!incomingText && !isImage) return;

      console.log(`[WA Message] Dari: ${senderName} (${senderJid}) | Jenis: ${isImage ? 'Gambar' : 'Teks'}`);

      try {
        const botData = loadBotData();
        const isFirstMessage = !hasActiveSession(senderJid);

        touchUserSession(senderJid, senderName, async (timeoutMessage) => {
          if (timeoutMessage) {
            try {
              await sock.sendMessage(senderJid, { text: timeoutMessage });
            } catch (err) {
              console.error('Gagal mengirim notifikasi timeout:', err.message);
            }
          }
        });

        if (isFirstMessage) {
          await sock.sendPresenceUpdate('composing', senderJid);
          const sapaanTemplate = botData?.pesanSistem?.sapaanAwal || 'Halo, {nama}! Pesan kamu sudah diterima.';
          const greetingText = sapaanTemplate.replace('{nama}', senderName);
          await sock.sendMessage(senderJid, { text: greetingText });
        }

        await sock.sendPresenceUpdate('composing', senderJid);
        let replyText = '';

        if (isImage) {
          await sock.sendMessage(senderJid, { text: '⏳ Sedang membaca dan memproses nota belanja...' });

          const imageBuffer = await downloadMediaMessage(
            msg,
            'buffer',
            {},
            {
              logger: pino({ level: 'silent' }),
              reuploadRequest: sock.updateMediaMessage
            }
          );

          replyText = await processReceiptImage(senderJid, imageBuffer, incomingText);
        } else {
          replyText = await generateAIResponse(senderJid, incomingText, senderName);
        }

        await sock.sendMessage(senderJid, { text: replyText });
        await sock.sendPresenceUpdate('paused', senderJid);
      } catch (err) {
        console.error('Gagal memproses pesan WA:', err);
        await sock.sendMessage(senderJid, { text: '⚠️ Terjadi kendala saat memproses pesan.' });
      }
    });

  } catch (err) {
    console.warn('WhatsApp Socket Connection Error:', err.message);
    waStatus.connectionStatus = 'standby';
    waStatus.lastError = err.message;
  }
}

// Fungsi Mengirim Pesan Harian Otomatis
async function triggerDailyScheduledMessages() {
  const config = loadBotData();
  const schedule = config.jadwalHarian;

  if (!schedule || !schedule.aktif) return;
  const targets = schedule.targetNomor || [];
  if (targets.length === 0) return;

  const now = new Date();
  const optionsDate = { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' };
  const formattedDate = now.toLocaleDateString('id-ID', optionsDate);

  const totalTrans = getDatabaseRecords().length;
  const totalContacts = getActiveContactsCount();

  let messageBody = schedule.templatePesan || 'Hari ini tanggal {tanggal}';
  messageBody = messageBody
    .replace('{tanggal}', formattedDate)
    .replace('{total_transaksi}', totalTrans)
    .replace('{total_kontak}', totalContacts);

  console.log(`[Scheduled Daily Message] Mengirim ke ${targets.length} nomor...`);

  for (let target of targets) {
    let clean = target.replace(/[^0-9]/g, '');
    if (!clean.endsWith('@s.whatsapp.net')) clean += '@s.whatsapp.net';

    if (activeSock && waStatus.connectionStatus === 'connected') {
      try {
        await activeSock.sendMessage(clean, { text: messageBody });
        console.log(`✅ Pesan harian terkirim ke: ${clean}`);
      } catch (err) {
        console.error(`Gagal mengirim pesan harian ke ${clean}:`, err.message);
      }
    } else {
      console.warn(`[Simulasi Scheduler] Pesan Harian disimulasikan ke ${clean}:\n${messageBody}`);
    }
  }
}

// Cron job harian
cron.schedule('* * * * *', () => {
  const config = loadBotData();
  const schedule = config.jadwalHarian;
  if (!schedule || !schedule.aktif) return;

  const now = new Date();
  const currentHours = String(now.getHours()).padStart(2, '0');
  const currentMinutes = String(now.getMinutes()).padStart(2, '0');
  const currentTime = `${currentHours}:${currentMinutes}`;

  if (currentTime === schedule.jam && now.getSeconds() < 10) {
    triggerDailyScheduledMessages();
  }
});

// REST API Endpoints
app.get('/api/status', async (req, res) => {
  const model = await getAvailableModel();
  res.json({
    connectionStatus: waStatus.connectionStatus,
    qrCodeDataUrl: waStatus.qrCodeDataUrl,
    pairingCode: waStatus.pairingCode,
    model: model || waStatus.activeModel,
    lastError: waStatus.lastError
  });
});

async function requestFreshPairingCode(cleanPhone) {
  // Clear old session files if not connected yet to prevent stale creds handshake failure
  if (waStatus.connectionStatus !== 'connected') {
    await connectToWhatsApp(true);
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }

  if (!activeSock) {
    throw new Error('Socket WhatsApp belum siap');
  }

  const code = await activeSock.requestPairingCode(cleanPhone);
  return code;
}

app.post('/api/wa/request-pairing', async (req, res) => {
  try {
    let { phoneNumber } = req.body;
    if (!phoneNumber) {
      return res.status(400).json({ error: 'Nomor WhatsApp wajib diisi (contoh: 628123456789)' });
    }

    const cleanPhone = phoneNumber.replace(/[^0-9]/g, '');
    if (cleanPhone.length < 9) {
      return res.status(400).json({ error: 'Format nomor WhatsApp tidak valid. Gunakan format 628123456789.' });
    }

    const code = await requestFreshPairingCode(cleanPhone);
    waStatus.pairingCode = code;

    console.log(`[WA Pairing Code OTP Fresh] Nomor: ${cleanPhone} | Code: ${code}`);

    res.json({
      success: true,
      phoneNumber: cleanPhone,
      pairingCode: code,
      formattedCode: code?.match(/.{1,4}/g)?.join('-') || code
    });
  } catch (err) {
    console.error('Error requestPairingCode:', err);
    res.status(500).json({
      error: `Gagal menghasilkan Kode Pairing OTP: ${err.message}. Silakan klik 'Minta Kode OTP' sekali lagi.`
    });
  }
});

app.post('/api/wa/reset-session', (req, res) => {
  clearAuthSessionFolder();
  connectToWhatsApp(true);
  res.json({ success: true, message: 'Sesi WhatsApp berhasil direset.' });
});

app.post('/api/scheduler/test-run', async (req, res) => {
  try {
    await triggerDailyScheduledMessages();
    res.json({ success: true, message: 'Pesan harian berhasil dipicu untuk dikirim.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/config', (req, res) => {
  const config = loadBotData();
  const safeConfig = {
    ...config,
    groqApiKeyMasked: config.groqApiKey ? `${config.groqApiKey.substring(0, 6)}...` : '',
    geminiApiKeyMasked: config.geminiApiKey ? `${config.geminiApiKey.substring(0, 6)}...` : '',
    supabaseAnonKeyMasked: config.supabaseAnonKey ? `${config.supabaseAnonKey.substring(0, 6)}...` : ''
  };
  res.json(safeConfig);
});

app.post('/api/config', (req, res) => {
  const updated = saveBotConfig(req.body);
  res.json({ success: true, config: updated });
});

app.get('/api/expenses', (req, res) => {
  const records = getDatabaseRecords();
  res.json({ expenses: records });
});

app.delete('/api/expenses/:id', (req, res) => {
  const { id } = req.params;
  deleteDatabaseRecord(id);
  res.json({ success: true });
});

app.post('/api/chat', upload.single('image'), async (req, res) => {
  try {
    const { senderJid = 'simulated@s.whatsapp.net', senderName = 'Pengguna Test', text = '' } = req.body;
    let reply = '';

    if (req.file && req.file.buffer) {
      reply = await processReceiptImage(senderJid, req.file.buffer, text);
    } else {
      reply = await generateAIResponse(senderJid, text, senderName);
    }

    res.json({ success: true, reply });
  } catch (err) {
    console.error('API chat error:', err);
    res.status(500).json({ error: 'Gagal memproses pesan' });
  }
});

// Start Express Server
app.listen(PORT, HOST, () => {
  console.log(`🚀 WA Bot & Expense Tracker Web Server running on http://${HOST}:${PORT}`);
  connectToWhatsApp(false);
});