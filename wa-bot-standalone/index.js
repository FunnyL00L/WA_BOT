import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  downloadMediaMessage
} from '@whiskeysockets/baileys';
import qrcode from 'qrcode-terminal';
import pino from 'pino';

import {
  loadBotData,
  getAvailableModel,
  hasActiveSession,
  touchUserSession,
  generateAIResponse,
  processReceiptImage
} from './dataService.js';

async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_session');
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    logger: pino({ level: 'silent' }),
    auth: state,
    printQRInTerminal: false
  });

  sock.ev.on('creds.update', saveCreds);

  // Monitor status koneksi
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log('\nSilakan scan QR code berikut via WhatsApp:');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

      console.log(`Koneksi terputus (Status: ${statusCode}). Reconnecting: ${shouldReconnect}`);
      if (shouldReconnect) {
        setTimeout(connectToWhatsApp, 3000);
      } else {
        console.log('Sesi logout. Hapus folder auth_session dan scan ulang.');
      }
    } else if (connection === 'open') {
      const activeModel = await getAvailableModel();
      console.log('✅ WhatsApp Bot terhubung dan siap digunakan!');
      console.log(`🤖 Menggunakan model Groq aktif: ${activeModel}`);
    }
  });

  // Handler pesan masuk
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify' || !messages || messages.length === 0) return;

    const msg = messages[0];

    // Lewati pesan status, grup, atau pesan dari bot sendiri
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

    console.log(`[Pesan Masuk] Dari: ${senderName} (${senderJid}) | Jenis: ${isImage ? 'Gambar' : 'Teks'}`);

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
      console.log(`[Balasan Terkirim] Ke: ${senderName}`);

      await sock.sendPresenceUpdate('paused', senderJid);
    } catch (err) {
      console.error('Gagal memproses pesan:', err);
      await sock.sendMessage(senderJid, { text: '⚠️ Terjadi kendala saat memproses pesan.' });
    }
  });
}

connectToWhatsApp();