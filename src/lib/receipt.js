import { demoReceipt } from '../data/mockReceipt';
import { normalizeReceipt } from './bill';
import { uid } from './format';

export const DEFAULT_RECEIPT_PROMPT = `Kamu adalah asisten OCR profesional untuk mengekstraksi data resit restoran Indonesia.

INSTRUKSI PENTING:
1. Baca SETIAP item makanan/minuman dengan TELITI
2. Untuk setiap item, ekstraksi: nama, harga per unit, dan jumlah
3. Jika ada item yang samar/buram, gunakan konteks untuk estimasi terbaik
4. Harga HARUS dalam angka integer (contoh: 45000, bukan 45.000 atau "45ribu")
5. Quantity default = 1 jika tidak tertera

FORMAT JSON OUTPUT (WAJIB DIIKUTI):
{
  "restaurantName": "nama restoran (dari header/footer resit)",
  "items": [
    { "name": "Nasi Goreng", "price": 45000, "quantity": 1 },
    { "name": "Es Teh Manis", "price": 10000, "quantity": 2 }
  ],
  "subtotal": 65000,
  "tax": 6500,
  "taxRate": 0.1,
  "serviceCharge": 3250,
  "serviceRate": 0.05,
  "grandTotal": 74750
}

ATURAN EKSTRAKSI:
- Abaikan logo, watermark, barcode, no resit, timestamp
- Fokus HANYA pada nama item + harga + jumlah
- Jika ada diskon terpisah, tambahkan sebagai item negatif dengan nama "[DISKON] ..."
- Subtotal = total harga semua item (sebelum pajak & layanan)
- Tax = pajak PPN (cari label "PPn", "Pajak", "PB1")
- Service = biaya layanan (cari label "Service", "Layanan")
- Grand Total = Subtotal + Tax + Service
- Jika field tidak ditemukan, isi NULL

PENTING: Balas HANYA dengan JSON valid, tanpa markdown, komentar, atau teks lain.`;

export const DEFAULT_AI_SETTINGS = {
  provider: 'custom',
  allowDemoFallback: true,
  prompt: DEFAULT_RECEIPT_PROMPT,
  openrouter: {
    apiKey: '',
    model: 'anthropic/claude-sonnet-4',
    baseUrl: 'https://openrouter.ai/api/v1/chat/completions',
    appName: 'Split Bill App',
    siteUrl: '',
  },
  custom: {
    apiKey: '',
    model: 'gpt-4o-mini',
    baseUrl: 'https://ai.sumopod.com/v1/chat/completions',
    appName: 'Split Bill App',
    siteUrl: '',
  },
};

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('Gagal membaca file gambar.'));
    reader.readAsDataURL(file);
  });
}

function extractJsonPayload(text) {
  // Coba ekstraksi JSON dari teks
  let json = text.trim();
  
  console.log('Raw text from API (first 500 chars):', json.substring(0, 500));
  
  // Jika wrapped dalam markdown code block, hapus
  if (json.startsWith('```')) {
    json = json.replace(/^```[\w]*\n?/, '').replace(/\n?```$/, '');
  }
  
  // Cari first brace
  const firstBrace = json.indexOf('{');
  const lastBrace = json.lastIndexOf('}');

  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
    console.error('❌ No JSON found. Text:', json.substring(0, 300));
    throw new Error('Respons API tidak mengandung JSON yang valid. Coba dengan resit yang lebih jelas.');
  }

  try {
    return JSON.parse(json.slice(firstBrace, lastBrace + 1));
  } catch (e) {
    console.error('❌ JSON parse failed:', e.message, 'Text:', json.substring(firstBrace, Math.min(lastBrace + 100, json.length)));
    throw new Error(`JSON parsing gagal: ${e.message}. Pastikan resit terbaca dengan jelas.`);
  }
}

function normalizeApiPayload(payload, rawImage) {
  // Validasi & bersihkan items
  let items = Array.isArray(payload.items) ? payload.items : [];
  
  // Filter item yang valid (punya nama atau harga)
  items = items
    .filter(item => {
      const hasName = item.name && String(item.name).trim().length > 0;
      const hasPrice = Number(item.price) > 0;
      return hasName || hasPrice;
    })
    .map((item, index) => ({
      id: uid('item'),
      name: (item.name || `Item ${index + 1}`).substring(0, 60),
      price: Number.parseInt(item.price, 10) || 0,
      quantity: Math.max(1, Number.parseInt(item.quantity, 10) || 1),
    }));

  // Jika tidak ada item yang valid, buat item placeholder
  if (items.length === 0) {
    items = [{ id: uid('item'), name: 'Item 1', price: 0, quantity: 1 }];
  }

  // Validasi & bersihkan harga
  const subtotal = Math.max(0, Number.parseInt(payload.subtotal, 10) || 0);
  const tax = Math.max(0, Number.parseInt(payload.tax, 10) || 0);
  const serviceCharge = Math.max(0, Number.parseInt(payload.serviceCharge, 10) || 0);
  const grandTotal = Math.max(0, Number.parseInt(payload.grandTotal, 10) || subtotal + tax + serviceCharge);

  // Hitung tax rate & service rate
  const taxRate = subtotal > 0 ? Math.min(1, tax / subtotal) : 0;
  const serviceRate = subtotal > 0 ? Math.min(1, serviceCharge / subtotal) : 0;

  return normalizeReceipt({
    rawImage,
    restaurantName: (payload.restaurantName || '').substring(0, 60),
    items,
    subtotal,
    tax,
    taxRate,
    serviceCharge,
    serviceRate,
    grandTotal,
  });
}

function resolveAiSettings(settings) {
  return {
    ...DEFAULT_AI_SETTINGS,
    ...settings,
    prompt: settings?.prompt || DEFAULT_AI_SETTINGS.prompt,
    openrouter: {
      ...DEFAULT_AI_SETTINGS.openrouter,
      ...settings?.openrouter,
      apiKey:
        settings?.openrouter?.apiKey || import.meta.env.VITE_OPENROUTER_API_KEY || '',
      model:
        settings?.openrouter?.model ||
        import.meta.env.VITE_OPENROUTER_MODEL ||
        DEFAULT_AI_SETTINGS.openrouter.model,
      baseUrl:
        settings?.openrouter?.baseUrl ||
        import.meta.env.VITE_OPENROUTER_BASE_URL ||
        DEFAULT_AI_SETTINGS.openrouter.baseUrl,
      appName:
        settings?.openrouter?.appName ||
        import.meta.env.VITE_OPENROUTER_APP_NAME ||
        DEFAULT_AI_SETTINGS.openrouter.appName,
      siteUrl:
        settings?.openrouter?.siteUrl ||
        import.meta.env.VITE_OPENROUTER_SITE_URL ||
        DEFAULT_AI_SETTINGS.openrouter.siteUrl,
    },
    custom: {
      ...DEFAULT_AI_SETTINGS.custom,
      ...settings?.custom,
      apiKey: settings?.custom?.apiKey || import.meta.env.VITE_CUSTOM_API_KEY || '',
      model:
        settings?.custom?.model ||
        import.meta.env.VITE_CUSTOM_MODEL ||
        DEFAULT_AI_SETTINGS.custom.model,
      baseUrl:
        settings?.custom?.baseUrl ||
        import.meta.env.VITE_CUSTOM_BASE_URL ||
        DEFAULT_AI_SETTINGS.custom.baseUrl,
      appName:
        settings?.custom?.appName ||
        import.meta.env.VITE_CUSTOM_APP_NAME ||
        DEFAULT_AI_SETTINGS.custom.appName,
      siteUrl:
        settings?.custom?.siteUrl ||
        import.meta.env.VITE_CUSTOM_SITE_URL ||
        DEFAULT_AI_SETTINGS.custom.siteUrl,
    },
  };
}

function extractOpenRouterText(payload) {
  const content = payload?.choices?.[0]?.message?.content;

  if (typeof content === 'string') {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') {
          return part;
        }

        return part?.text || '';
      })
      .join('\n');
  }

  // Debug: log unexpected format
  console.error('Unexpected content format:', { content, payload });
  throw new Error('API tidak mengembalikan konten teks yang bisa diparse.');
}

function getFriendlyProviderError(providerName, baseUrl, status, rawBody) {
  let detail = rawBody;

  try {
    const parsed = JSON.parse(rawBody);
    detail =
      parsed?.error?.message ||
      parsed?.message ||
      parsed?.detail ||
      rawBody;
  } catch {
    detail = rawBody;
  }

  if (status === 404) {
    return `Endpoint ${providerName} tidak ditemukan. Periksa URL API di Settings. Saat ini: ${baseUrl}`;
  }

  if (status === 401 || status === 403) {
    return `Autentikasi ${providerName} gagal. Periksa API key yang aktif.`;
  }

  if (!detail) {
    return `Gagal menghubungi ${providerName}.`;
  }

  return `${providerName}: ${detail}`;
}

function getProviderConfig(aiSettings) {
  if (aiSettings.provider === 'custom') {
    return {
      name: 'Custom API',
      ...aiSettings.custom,
    };
  }

  return {
    name: 'OpenRouter',
    ...aiSettings.openrouter,
  };
}

function validateProviderConfig(providerConfig) {
  if (!providerConfig.apiKey) {
    throw new Error(`API key ${providerConfig.name} belum diisi. Buka Settings lalu isi konfigurasi AI.`);
  }

  if (!providerConfig.baseUrl) {
    throw new Error(`Endpoint ${providerConfig.name} belum diisi. Buka Settings lalu isi Base URL API.`);
  }
}

export function createManualReceipt() {
  return normalizeReceipt({
    restaurantName: '',
    items: [{ id: uid('item'), name: '', price: 0, quantity: 1 }],
    subtotal: 0,
    tax: 0,
    taxRate: 0,
    serviceCharge: 0,
    serviceRate: 0,
    grandTotal: 0,
  });
}

export async function scanReceiptWithAI(file, settings) {
  const rawImage = await fileToDataUrl(file);
  const aiSettings = resolveAiSettings(settings);
  const providerConfig = getProviderConfig(aiSettings);
  const apiKey = providerConfig.apiKey;

  if (aiSettings.provider === 'demo' || (!apiKey && aiSettings.allowDemoFallback)) {
    await new Promise((resolve) => window.setTimeout(resolve, 1200));
    return {
      mode: 'demo',
      receipt: normalizeReceipt({
        ...demoReceipt,
        rawImage,
        restaurantName: file.name ? `${demoReceipt.restaurantName} Demo` : demoReceipt.restaurantName,
      }),
    };
  }

  validateProviderConfig(providerConfig);

  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), 30000);

  try {
    const response = await fetch(providerConfig.baseUrl, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
        'http-referer': providerConfig.siteUrl || window.location.origin,
        'x-title': providerConfig.appName || 'Split Bill App',
      },
      body: JSON.stringify({
        model: providerConfig.model,
        max_tokens: 2000,
        temperature: 0.05,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: aiSettings.prompt || DEFAULT_RECEIPT_PROMPT },
              {
                type: 'image_url',
                image_url: {
                  url: rawImage,
                },
              },
            ],
          },
        ],
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        getFriendlyProviderError(
          providerConfig.name,
          providerConfig.baseUrl,
          response.status,
          errorText,
        ),
      );
    }

    const payload = await response.json();

    const textContent = extractOpenRouterText(payload);
    console.log('✓ API response text:', textContent.substring(0, 200));
    
    const jsonPayload = extractJsonPayload(textContent);
    console.log('✓ Extracted JSON:', jsonPayload);
    
    const normalized = normalizeApiPayload(jsonPayload, rawImage);
    console.log('✓ Normalized:', { items: normalized.items.length, subtotal: normalized.subtotal });

    return {
      mode: 'live',
      receipt: normalized,
    };
  } catch (error) {
    console.error('❌ Scan error:', error.message);
    if (error.name === 'AbortError') {
      throw new Error('Timeout lebih dari 30 detik. Resit mungkin terlalu kompleks. Coba pakai input manual atau resit yang lebih jelas.');
    }

    throw new Error(error.message || `Gagal memproses resit dengan ${providerConfig.name}.`);
  } finally {
    window.clearTimeout(timeoutId);
  }
}

export async function testAiConnection(settings) {
  const aiSettings = resolveAiSettings(settings);
  const providerConfig = getProviderConfig(aiSettings);
  validateProviderConfig(providerConfig);

  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), 15000);

  try {
    const response = await fetch(providerConfig.baseUrl, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${providerConfig.apiKey}`,
        'http-referer': providerConfig.siteUrl || window.location.origin,
        'x-title': providerConfig.appName || 'Split Bill App',
      },
      body: JSON.stringify({
        model: providerConfig.model,
        max_tokens: 12,
        temperature: 0,
        messages: [
          {
            role: 'user',
            content: 'Reply with exactly: OK',
          },
        ],
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        getFriendlyProviderError(
          providerConfig.name,
          providerConfig.baseUrl,
          response.status,
          errorText,
        ),
      );
    }

    const payload = await response.json();
    const text = extractOpenRouterText(payload);

    return {
      ok: true,
      providerName: providerConfig.name,
      model: providerConfig.model,
      message: `${providerConfig.name} terhubung. Respons test: ${text.trim() || 'OK'}`,
    };
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error('Test koneksi timeout lebih dari 15 detik.');
    }

    throw error;
  } finally {
    window.clearTimeout(timeoutId);
  }
}
