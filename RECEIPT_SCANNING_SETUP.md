# Setup API untuk Receipt Scanning

## Masalah Saat Ini
Ketika scan resit tanpa API key yang valid, app jatuh ke **mode Demo Fallback** (menampilkan dummy data). Ini terjadi karena:
- ✅ `allowDemoFallback` diaktifkan (fallback to demo ketika API key kosong)
- ❌ API key belum dikonfigurasi

## Solusi: Setup API Key

### Opsi 1: OpenRouter (⭐ Rekomendasi untuk Testing)

**Keuntungan:**
- Gratis untuk testing awal
- Support banyak model AI
- Mudah setup

**Langkah:**
1. Buka https://openrouter.ai
2. Sign up dengan email (gratis)
3. Buka dashboard → API keys
4. Copy API key
5. Kembali ke app → Tab "API & Admin"
6. Ubah Provider dari "Custom API" ke "OpenRouter"
7. Paste API key di field "OpenRouter API Key"
8. Klik "Test API Connection"
9. Jika hijau → OK, siap scan resit!

**Default Model:** `anthropic/claude-sonnet-4` (cocok untuk OCR resit)

---

### Opsi 2: Custom API (Sumopod, OpenAI, dll)

**Setup:**
1. Dapatkan endpoint API yang OpenAI-compatible
2. Dapatkan API key dari provider
3. Di app → Tab "API & Admin" → Provider: "Custom API"
4. Isi:
   - **Endpoint**: URL API (contoh: `https://api.openai.com/v1/chat/completions`)
   - **API Key**: Key dari provider
   - **Model**: Model name (contoh: `gpt-4.1-mini`)
5. Klik "Test API Connection"

---

## Testing Receipt Scanning

### Dengan API Key ✅
1. Go to **Sesi Aktif** tab
2. Klik **"Ambil Foto"** atau **"Upload Galeri"**
3. Upload foto resit
4. App akan scan + extract item, harga, total
5. Hasilnya langsung bisa diedit di form

### Tanpa API Key (Mode Demo) 
- App menampilkan **dummy data** (Restaurant Demo)
- Cocok untuk testing flow, tapi bukan data real resit

---

## Perbaikan Terbaru pada Receipt Scanning

Prompt extraction telah ditingkatkan untuk:
- ✅ Lebih akurat membaca item
- ✅ Better error handling
- ✅ Support diskon items
- ✅ Robust JSON parsing (handle markdown wrapping)
- ✅ Temperature lebih rendah (0.05 → lebih deterministik)
- ✅ Max tokens lebih besar (2000 → untuk resit kompleks)

---

## Error Messages & Troubleshooting

| Error | Penyebab | Solusi |
|-------|---------|--------|
| "API key belum diisi" | Tidak ada API key | Isi API key di Settings |
| "Endpoint tidak ditemukan (404)" | URL API salah | Periksa endpoint URL |
| "Autentikasi gagal (401/403)" | API key salah/expired | Update API key baru |
| "Timeout 30 detik" | Resit terlalu kompleks atau koneksi lambat | Coba resit lebih sederhana atau pakai input manual |
| "JSON tidak valid" | AI mengembalikan format tidak sesuai | Refresh/retry, atau pilih model lain |

---

## Environment Variables (Optional)

Untuk production, bisa set env variables:
```env
VITE_OPENROUTER_API_KEY=sk-or-v1-xxx...
VITE_OPENROUTER_MODEL=anthropic/claude-sonnet-4

# Atau untuk Custom API:
VITE_CUSTOM_API_KEY=sk-xxx...
VITE_CUSTOM_MODEL=gpt-4.1-mini
VITE_CUSTOM_BASE_URL=https://api.openai.com/v1/chat/completions
```

---

## Rekomendasi

**Untuk development/testing:**
- Gunakan OpenRouter → daftar gratis, dapat API key instantly
- Test dengan foto resit asli untuk verifikasi

**Untuk production:**
- Gunakan provider stabil (OpenAI, Anthropic, OpenRouter)
- Set rate limiting + monitoring
- Log failed requests untuk debugging

---

## Contact & Support

Jika ada masalah:
1. Check tab "API & Admin" → lihat "Provider aktif" & "API Key status"
2. Klik "Test API Connection" untuk verify
3. Cek prompt ekstraksi - mungkin perlu tuning untuk resit spesifik
