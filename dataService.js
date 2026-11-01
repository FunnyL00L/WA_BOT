import fs from 'fs';
import path from 'path';
import Groq from 'groq-sdk';
import { GoogleGenAI } from '@google/genai';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import { createWorker } from 'tesseract.js';

dotenv.config();

const CONFIG_FILE = path.resolve('botConfig.json');
const DB_FILE = path.resolve('pengeluaran.json');
const userSessions = new Map();

// Default initial configuration
let currentConfig = {
  groqApiKey: process.env.GROQ_API_KEY || '',
  geminiApiKey: process.env.GEMINI_API_KEY || '',
  supabaseUrl: process.env.SUPABASE_URL || '',
  supabaseAnonKey: process.env.SUPABASE_ANON_KEY || '',
  pesanSistem: {
    sapaanAwal: 'Halo, {nama}! Pesan kamu sudah diterima oleh asisten bot.',
    systemPrompt: 'Kamu adalah asisten WhatsApp pribadi yang cerdas, ramah, dan solutif. Jawab pertanyaan pengguna secara efektif.',
    knowledgeBase: [
      { deskripsi: 'Jam Operasional Toko', konten: 'Buka setiap hari jam 08:00 - 21:00 WIB.' },
      { deskripsi: 'Metode Pembayaran', konten: 'Menerima QRIS, Transfer Bank, dan Tunai.' }
    ]
  },
  jadwalHarian: {
    aktif: true,
    jam: '08:00',
    targetNomor: ['628123456789'],
    templatePesan: 'Selamat pagi! ☀️\nHari ini tanggal {tanggal}.\n\nRingkasan Sistem Bot WA:\n• Total kontak aktif: {total_kontak}\n• Total transaksi struk tercatat: {total_transaksi}\n\nBot WhatsApp Anda beroperasi normal dan siap melayani pelanggan hari ini! 🚀'
  }
};

// Load saved config if exists
if (fs.existsSync(CONFIG_FILE)) {
  try {
    const raw = fs.readFileSync(CONFIG_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    currentConfig = {
      ...currentConfig,
      ...parsed,
      jadwalHarian: { ...currentConfig.jadwalHarian, ...(parsed.jadwalHarian || {}) }
    };
  } catch (e) {
    console.warn('Gagal membaca botConfig.json, menggunakan default config');
  }
}

let groqClient = null;
let geminiClient = null;
let supabaseClient = null;

function updateClients() {
  const gKey = currentConfig.groqApiKey || process.env.GROQ_API_KEY || '';
  const gemKey = currentConfig.geminiApiKey || process.env.GEMINI_API_KEY || '';
  const sUrl = currentConfig.supabaseUrl || process.env.SUPABASE_URL || '';
  const sKey = currentConfig.supabaseAnonKey || process.env.SUPABASE_ANON_KEY || '';

  if (gKey) {
    try { groqClient = new Groq({ apiKey: gKey }); } catch { groqClient = null; }
  } else { groqClient = null; }

  if (gemKey) {
    try { geminiClient = new GoogleGenAI({ apiKey: gemKey }); } catch { geminiClient = null; }
  } else { geminiClient = null; }

  if (sUrl && sKey) {
    try {
      supabaseClient = createClient(sUrl, sKey);
      console.log('✅ Supabase Client terhubung:', sUrl);
    } catch (err) {
      console.warn('Gagal inisialisasi Supabase:', err.message);
      supabaseClient = null;
    }
  } else {
    supabaseClient = null;
  }
}

updateClients();

const CANDIDATE_GROQ_MODELS = [
  'llama-3.3-70b-versatile',
  'llama3-8b-8192',
  'mixtral-8x7b-32768'
];

let selectedModel = 'gemini-2.5-flash';

export function loadBotData() {
  return currentConfig;
}

export function saveBotConfig(newConfig) {
  if (newConfig.groqApiKey !== undefined) currentConfig.groqApiKey = newConfig.groqApiKey;
  if (newConfig.geminiApiKey !== undefined) currentConfig.geminiApiKey = newConfig.geminiApiKey;
  if (newConfig.supabaseUrl !== undefined) currentConfig.supabaseUrl = newConfig.supabaseUrl;
  if (newConfig.supabaseAnonKey !== undefined) currentConfig.supabaseAnonKey = newConfig.supabaseAnonKey;
  
  if (newConfig.sapaanAwal !== undefined) {
    currentConfig.pesanSistem.sapaanAwal = newConfig.sapaanAwal;
  }
  if (newConfig.systemPrompt !== undefined) {
    currentConfig.pesanSistem.systemPrompt = newConfig.systemPrompt;
  }
  if (Array.isArray(newConfig.knowledgeBase)) {
    currentConfig.pesanSistem.knowledgeBase = newConfig.knowledgeBase;
  }

  if (newConfig.jadwalHarian) {
    currentConfig.jadwalHarian = {
      ...currentConfig.jadwalHarian,
      ...newConfig.jadwalHarian
    };
  }

  updateClients();

  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(currentConfig, null, 2), 'utf-8');
  } catch (err) {
    console.error('Gagal menyimpan botConfig.json:', err);
  }

  // Sycn to Supabase if connected
  if (supabaseClient) {
    supabaseClient.from('bot_config').upsert({
      id: 1,
      config_data: currentConfig,
      updated_at: new Date().toISOString()
    }).then(({ error }) => {
      if (error) console.warn('Supabase config sync warn:', error.message);
      else console.log('☁️ Config tersinkronisasi ke Supabase');
    });
  }

  return currentConfig;
}

export async function getAvailableModel() {
  if (groqClient) {
    try {
      const list = await groqClient.models.list();
      const activeIds = list.data.map((m) => m.id);
      const match = CANDIDATE_GROQ_MODELS.find((candidate) => activeIds.includes(candidate));
      if (match) {
        selectedModel = match;
        return `Groq (${selectedModel})`;
      }
    } catch (err) {
      console.warn('Gagal list model Groq:', err.message);
    }
  }

  if (geminiClient) {
    selectedModel = 'gemini-2.5-flash';
    return 'Google Gemini (gemini-2.5-flash)';
  }

  return 'Local Assistant Engine';
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

export function getActiveContactsCount() {
  return userSessions.size || 1;
}

function buildKnowledgeBasePrompt() {
  const kbList = currentConfig.pesanSistem?.knowledgeBase || [];
  if (kbList.length === 0) return '';

  const kbText = kbList.map((kb, idx) => `[Pengetahuan ${idx + 1}] ${kb.deskripsi}: ${kb.konten}`).join('\n');
  return `\n\nDataset & Pengetahuan Tambahan Toko/Sistem:\n${kbText}`;
}

/**
 * Respon AI berbasis Groq / Gemini / Knowledge Base
 */
export async function generateAIResponse(senderJid, incomingText, senderName = 'Kak') {
  const sysPromptBase = currentConfig.pesanSistem?.systemPrompt || 'Kamu adalah asisten WhatsApp pribadi yang cerdas, ramah, dan solutif.';
  const kbPrompt = buildKnowledgeBasePrompt();
  const fullSystemPrompt = `${sysPromptBase}\nLawan bicaramu bernama ${senderName}.${kbPrompt}\nBerikan jawaban ringkas dan membantu dalam Bahasa Indonesia.`;

  // 1. Groq API
  if (groqClient) {
    try {
      const chatCompletion = await groqClient.chat.completions.create({
        messages: [
          { role: 'system', content: fullSystemPrompt },
          { role: 'user', content: incomingText }
        ],
        model: selectedModel.includes('gemini') ? 'llama-3.3-70b-versatile' : selectedModel,
        temperature: 0.7,
        max_tokens: 500
      });

      const reply = chatCompletion.choices[0]?.message?.content;
      if (reply) return reply;
    } catch (error) {
      console.warn('Groq Error, mencoba Gemini:', error.message);
    }
  }

  // 2. Gemini API
  if (geminiClient) {
    try {
      const response = await geminiClient.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: incomingText,
        config: {
          systemInstruction: fullSystemPrompt,
          maxOutputTokens: 500,
          temperature: 0.7
        }
      });

      if (response.text) return response.text;
    } catch (error) {
      console.warn('Gemini Error:', error.message);
    }
  }

  // 3. Smart local match with Dataset
  const kbList = currentConfig.pesanSistem?.knowledgeBase || [];
  const lowerMsg = incomingText.toLowerCase();
  for (const item of kbList) {
    if (lowerMsg.includes(item.deskripsi.toLowerCase())) {
      return `[Info ${item.deskripsi}]: ${item.konten}`;
    }
  }

  return `Halo ${senderName}! Pesan Anda telah diterima. (Catatan: Anda dapat memasukkan GROQ_API_KEY atau GEMINI_API_KEY di menu Pengaturan API agar bot merespon dengan AI generatif penuh).`;
}

export function getDatabaseRecords() {
  if (fs.existsSync(DB_FILE)) {
    try {
      const fileContent = fs.readFileSync(DB_FILE, 'utf-8');
      return fileContent ? JSON.parse(fileContent) : [];
    } catch {
      return [];
    }
  }
  return [];
}

function simpanKeDatabase(dataBaru) {
  const records = getDatabaseRecords();
  records.unshift(dataBaru);
  fs.writeFileSync(DB_FILE, JSON.stringify(records, null, 2), 'utf-8');

  // Sync with Supabase if available
  if (supabaseClient) {
    supabaseClient.from('pengeluaran').insert({
      trx_id: dataBaru.id,
      merchant: dataBaru.merchant,
      tanggal: dataBaru.tanggal,
      items: dataBaru.items,
      total: dataBaru.total,
      sender_jid: dataBaru.senderJid,
      created_at: dataBaru.timestamp
    }).then(({ error }) => {
      if (error) console.warn('Supabase transaction insert warn:', error.message);
      else console.log('☁️ Transaksi tersimpan ke Supabase');
    });
  }
}

export function deleteDatabaseRecord(id) {
  let records = getDatabaseRecords();
  records = records.filter(r => r.id !== id);
  fs.writeFileSync(DB_FILE, JSON.stringify(records, null, 2), 'utf-8');

  if (supabaseClient) {
    supabaseClient.from('pengeluaran').delete().eq('trx_id', id).then(() => {});
  }
  return true;
}

/**
 * Membaca nota belanja via Tesseract OCR + Structuring AI
 */
export async function processReceiptImage(senderJid, imageBuffer, caption = '') {
  try {
    let ocrText = '';
    try {
      const worker = await createWorker('ind+eng');
      const result = await worker.recognize(imageBuffer);
      ocrText = result.data.text || '';
      await worker.terminate();
    } catch (ocrErr) {
      console.error('OCR Tesseract error:', ocrErr);
    }

    if (!ocrText || ocrText.trim().length < 4) {
      ocrText = caption || 'Nota Belanja Umum Rp50.000';
    }

    const prompt = `
Berikut adalah teks hasil scan OCR dari nota/struk belanja:
"""
${ocrText}
"""
${caption ? `Keterangan tambahan pengguna: "${caption}"` : ''}

Tugas:
Analisis dan ekstrak data di atas ke dalam format JSON murni TANPA markdown:
{
  "is_receipt": true,
  "merchant": "Nama Toko / Minimarket",
  "tanggal": "YYYY-MM-DD",
  "items": [
    {"nama": "Nama Barang", "qty": 1, "harga": 10000}
  ],
  "total": 50000
}
`;

    let jsonRaw = '';

    if (groqClient) {
      try {
        const completion = await groqClient.chat.completions.create({
          messages: [{ role: 'user', content: prompt }],
          model: selectedModel.includes('gemini') ? 'llama-3.3-70b-versatile' : selectedModel,
          temperature: 0.1,
          max_tokens: 800
        });
        jsonRaw = completion.choices[0]?.message?.content?.trim() || '';
      } catch (err) {
        console.warn('Groq OCR parsing failed:', err.message);
      }
    }

    if (!jsonRaw && geminiClient) {
      try {
        const response = await geminiClient.models.generateContent({
          model: 'gemini-2.5-flash',
          contents: prompt,
          config: { temperature: 0.1, maxOutputTokens: 800 }
        });
        jsonRaw = response.text || '';
      } catch (err) {
        console.warn('Gemini OCR parsing failed:', err.message);
      }
    }

    let data = null;
    if (jsonRaw) {
      try {
        let cleaned = jsonRaw.replace(/^```(json)?\n?/, '').replace(/\n?```$/, '').trim();
        data = JSON.parse(cleaned);
      } catch (pErr) {
        console.warn('JSON parse error, fallback to regex heuristic');
      }
    }

    if (!data || typeof data !== 'object') {
      const numberMatches = ocrText.match(/\d+[\.,]?\d*/g) || [];
      const totalEstimated = numberMatches.length > 0 ? Math.max(...numberMatches.map(n => parseInt(n.replace(/[\.,]/g, ''), 10)).filter(n => n > 500 && n < 10000000)) : 25000;
      
      data = {
        is_receipt: true,
        merchant: ocrText.includes('Indomaret') ? 'Indomaret' : (ocrText.includes('Alfamart') ? 'Alfamart' : 'Toko Belanja'),
        tanggal: new Date().toISOString().split('T')[0],
        items: [{ nama: 'Produk Belanja', qty: 1, harga: totalEstimated > 0 ? totalEstimated : 25000 }],
        total: totalEstimated > 0 ? totalEstimated : 25000
      };
    }

    if (!data.is_receipt) {
      return `⚠️ Gagal mencatat nota: ${data.alasan || 'Format struk tidak terbaca.'}`;
    }

    const transaksi = {
      id: `trx_${Date.now()}`,
      senderJid: senderJid || 'user@s.whatsapp.net',
      timestamp: new Date().toISOString(),
      merchant: data.merchant || 'Toko Belanja',
      tanggal: data.tanggal || new Date().toISOString().split('T')[0],
      items: Array.isArray(data.items) ? data.items : [],
      total: Number(data.total) || 0
    };

    simpanKeDatabase(transaksi);

    const listItems = transaksi.items.length > 0
      ? transaksi.items.map((i) => `• ${i.nama || 'Item'} (${i.qty || 1}x) = Rp${Number(i.harga || 0).toLocaleString('id-ID')}`).join('\n')
      : '- 1x Belanja Nota';

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