import fs from 'fs';
import path from 'path';
import Groq from 'groq-sdk';
import dotenv from 'dotenv';
import { createWorker } from 'tesseract.js';

dotenv.config();

const apiKey = process.env.GROQ_API_KEY || '';
if (!apiKey) {
  console.warn('⚠️ PERINGATAN: GROQ_API_KEY belum terisi di file .env!');
}

const groq = new Groq({ apiKey });

const DB_FILE = path.resolve('pengeluaran.json');
const userSessions = new Map();

// Model teks fallback yang valid di Groq
const CANDIDATE_MODELS = [
  'openai/gpt-oss-20b',
  'openai/gpt-oss-120b',
  'qwen/qwen3.8-27b'
];

let selectedModel = 'openai/gpt-oss-20b';

export function loadBotData() {
  return {
    pesanSistem: {
      sapaanAwal: 'Halo, {nama}! Pesan kamu sudah diterima oleh asisten bot.'
    }
  };
}

/**
 * Otomatis mendeteksi model aktif yang tersedia di Groq
 */
export async function getAvailableModel() {
  if (!apiKey) return selectedModel;
  try {
    const list = await groq.models.list();
    const activeIds = list.data.map((m) => m.id);

    const match = CANDIDATE_MODELS.find((candidate) => activeIds.includes(candidate));
    if (match) {
      selectedModel = match;
    } else if (activeIds.length > 0) {
      // Ambil model text chat pertama yang tersedia
      const fallback = activeIds.find((id) => !id.includes('whisper') && !id.includes('safeguard'));
      if (fallback) selectedModel = fallback;
    }
  } catch (err) {
    console.warn('Gagal fetch daftar model Groq, menggunakan default:', selectedModel);
  }
  return selectedModel;
}

export function hasActiveSession(jid) {
  return userSessions.has(jid);
}

export function touchUserSession(jid, name, onTimeout) {
  if (userSessions.has(jid)) {
    clearTimeout(userSessions.get(jid).timer);
  }

  const timer = setTimeout(() => {
    userSessions.delete(jid);
    if (typeof onTimeout === 'function') {
      onTimeout('Sesi percakapan berakhir karena tidak ada interaksi selama 1 menit.');
    }
  }, 60 * 1000);

  userSessions.set(jid, { timer, name });
}

/**
 * Respon teks biasa dengan Groq AI
 */
export async function generateAIResponse(senderJid, incomingText, senderName) {
  if (!apiKey) {
    return '⚠️ API Key Groq belum disetting di file .env.';
  }

  try {
    const chatCompletion = await groq.chat.completions.create({
      messages: [
        {
          role: 'system',
          content: `Kamu adalah asisten WhatsApp pribadi yang cerdas, ramah, dan solutif. Lawan bicaramu bernama ${senderName}. Berikan jawaban ringkas.`
        },
        {
          role: 'user',
          content: incomingText
        }
      ],
      model: selectedModel,
      temperature: 0.7,
      max_tokens: 500
    });

    return chatCompletion.choices[0]?.message?.content || 'Maaf, saya tidak dapat merespon saat ini.';
  } catch (error) {
    console.error('Error Groq API:', error.message);
    return 'Terjadi kendala saat menghubungi server AI.';
  }
}

function simpanKeDatabase(dataBaru) {
  let records = [];
  if (fs.existsSync(DB_FILE)) {
    try {
      const fileContent = fs.readFileSync(DB_FILE, 'utf-8');
      records = fileContent ? JSON.parse(fileContent) : [];
    } catch {
      records = [];
    }
  }
  records.push(dataBaru);
  fs.writeFileSync(DB_FILE, JSON.stringify(records, null, 2), 'utf-8');
}

/**
 * Membaca nota belanja menggunakan Tesseract OCR + Groq Text Parsing
 */
export async function processReceiptImage(senderJid, imageBuffer, caption = '') {
  try {
    // 1. Ekstraksi teks nota menggunakan OCR lokal
    const worker = await createWorker('ind+eng');
    const { data: { text: ocrText } } = await worker.recognize(imageBuffer);
    await worker.terminate();

    if (!ocrText || ocrText.trim().length < 5) {
      return '⚠️ Gambar nota buram atau tidak ada tulisan yang terbaca. Coba kirim ulang dengan foto lebih dekat dan jelas.';
    }

    // 2. Kirim teks hasil OCR ke Groq untuk di-parse menjadi JSON rapi
    const prompt = `
Berikut adalah teks hasil scan OCR dari nota/struk belanja:
"""
${ocrText}
"""
${caption ? `Keterangan tambahan pengguna: "${caption}"` : ''}

Tugas:
Analisis dan ekstrak data di atas ke dalam format JSON murni TANPA tanda kutip markdown (\`\`\`json):
{
  "is_receipt": true,
  "merchant": "Nama Toko / Minimarket",
  "tanggal": "YYYY-MM-DD",
  "items": [
    {"nama": "Nama Barang", "qty": 1, "harga": 10000}
  ],
  "total": 50000
}

Jika teks sama sekali bukan struk belanja atau tidak masuk akal, kembalikan hanya:
{
  "is_receipt": false,
  "alasan": "Teks tidak memuat informasi struk belanja yang valid"
}
`;

    const chatCompletion = await groq.chat.completions.create({
      messages: [
        {
          role: 'user',
          content: prompt
        }
      ],
      model: selectedModel,
      temperature: 0.1,
      max_tokens: 800
    });

    let raw = chatCompletion.choices[0]?.message?.content?.trim() || '{}';
    if (raw.startsWith('```')) {
      raw = raw.replace(/^```(json)?\n?/, '').replace(/\n?```$/, '').trim();
    }

    const data = JSON.parse(raw);

    if (!data.is_receipt) {
      return `⚠️ Gagal mencatat nota: ${data.alasan || 'Format struk tidak terbaca.'}`;
    }

    const transaksi = {
      id: `trx_${Date.now()}`,
      senderJid,
      timestamp: new Date().toISOString(),
      merchant: data.merchant || 'Tidak Diketahui',
      tanggal: data.tanggal || new Date().toISOString().split('T')[0],
      items: data.items || [],
      total: Number(data.total) || 0
    };

    simpanKeDatabase(transaksi);

    const listItems = transaksi.items.length > 0
      ? transaksi.items.map((i) => `• ${i.nama} (${i.qty}x) = Rp${Number(i.harga || 0).toLocaleString('id-ID')}`).join('\n')
      : '- Tidak ada rincian item terdeteksi';

    return `🧾 *NOTA BERHASIL DICATAT!*\n\n` +
      `🏪 *Toko:* ${transaksi.merchant}\n` +
      `📅 *Tanggal:* ${transaksi.tanggal}\n\n` +
      `📦 *Rincian Item:*\n${listItems}\n\n` +
      `💰 *Total Belanja:* Rp${transaksi.total.toLocaleString('id-ID')}\n\n` +
      `_Tersimpan otomatis ke database pengeluaran._`;

  } catch (error) {
    console.error('Error processReceiptImage:', error);
    return '⚠️ Terjadi kesalahan saat membaca nota. Pastikan struk terlihat jelas dan coba lagi.';
  }
}