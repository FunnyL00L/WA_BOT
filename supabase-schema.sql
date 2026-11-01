-- Supabase Database Schema Script
-- Jalankan query berikut di Supabase SQL Editor untuk membuat tabel otomatis:

CREATE TABLE IF NOT EXISTS pengeluaran (
  id BIGSERIAL PRIMARY KEY,
  trx_id TEXT UNIQUE NOT NULL,
  merchant TEXT,
  tanggal DATE,
  items JSONB,
  total NUMERIC,
  sender_jid TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS bot_config (
  id INT PRIMARY KEY DEFAULT 1,
  config_data JSONB,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Atur Kebijakan Akses (RLS) Publik
ALTER TABLE pengeluaran ENABLE ROW LEVEL SECURITY;
ALTER TABLE bot_config ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow public read/write pengeluaran" ON pengeluaran FOR ALL USING (true);
CREATE POLICY "Allow public read/write bot_config" ON bot_config FOR ALL USING (true);
