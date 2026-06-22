# Group Chat Messaging Fixes - V1

**Tanggal**: 22 Juni 2026  
**Status**: ✅ COMPLETED  
**Masalah**: Bot tidak membalas di thread, spam multiple screenshot, dan screenshot tidak terkirim di grup

---

## Ringkasan Perbaikan

### 1. Thread Handling Fix
**File**: `src/utils.js`, `src/botCoding.js`

**Masalah**: Bot tidak membalas di thread yang benar di group chat  
**Solusi**:
- `replyToUser()` sekarang return `messageId` dan `threadId` dari response SeaTalk API
- Auto-threading di `botCoding.js` menggunakan `messageId` dari response untuk reply selanjutnya
- Logging tambahan untuk track thread_id flow

**Code Changes**:
```javascript
// src/utils.js - replyToUser() sekarang return:
return {
  ...result,
  messageId: result.message?.message_id || null,
  threadId: result.message?.thread_id || null
};

// src/botCoding.js - Gunakan messageId untuk thread:
const newThreadId = initResp?.messageId || initResp?.message?.message_id || originalMessageId;
```

### 2. Rate Limiting untuk Screenshot
**File**: `src/botSheet.js`

**Masalah**: User bisa spam multiple `/screenshot` commands, bot tidak bisa handle  
**Solusi**:
- Tambahkan `checkScreenshotRateLimit()` - cek flag di KV sebelum proses
- Tambahan `clearScreenshotRateLimit()` - hapus flag setelah selesai
- Maksimal 1 screenshot concurrent per user (TTL 120 detik)
- Fail-open strategy: jika rate limit check error, tetap allow request

**Code Changes**:
```javascript
// Cek rate limit SEBELUM proses
const rateLimitResult = await checkScreenshotRateLimit(env, targetId);
if (!rateLimitResult.allowed) {
  return await replyToUser(env, rateLimitResult.message, ...);
}

// Bersihkan flag di finally block
finally {
  await clearScreenshotRateLimit(env, targetId);
}
```

### 3. Group Chat Screenshot Threading
**File**: `src/botSheet.js`

**Masalah**: Screenshot tidak terkirim di thread yang benar di group chat  
**Solusi**:
- Kirim "processing" message dan tangkap `messageId`-nya sebagai `currentThreadId`
- Gunakan `currentThreadId` untuk semua reply selanjutnya (screenshot + konfirmasi)
- Fallback ke group chat umum jika thread reply gagal

**Code Changes**:
```javascript
// Buat thread untuk processing message
if (isGroup) {
  const processingResp = await replyToUser(env, "⏳ Sedang memproses...", ...);
  if (processingResp?.messageId) {
    currentThreadId = processingResp.messageId;
  }
}

// Gunakan currentThreadId untuk screenshot dan konfirmasi
await sendScreenshotToUser(env, pngBuffer, targetId, isGroup, currentThreadId);
await replyToUser(env, "✅ Screenshot berhasil dikirim!", targetId, isGroup, currentThreadId, ...);

// Fallback jika thread gagal
if (isGroup && confirmResp?.code !== 0 && currentThreadId !== threadId) {
  await replyToUser(env, "✅ Screenshot berhasil dikirim!", targetId, isGroup, threadId, ...);
}
```

### 4. HF Spaces Integration Hardening
**File**: `api/pdf-to-png.js`

**Masalah**: Vercel → HF Spaces integration butuh timeout dan retry handling  
**Solusi**:
- Timeout 45 detik untuk request ke HF Spaces (via AbortController)
- Retry mechanism: 1 retry dengan delay 2 detik
- Error classification: timeout vs network vs server error
- User-friendly error messages
- maxDuration: 60 detik di Vercel config

**Code Changes**:
```javascript
// Timeout + Retry configuration
const HF_SPACES_TIMEOUT = 45000;
const MAX_RETRIES = 1;
const RETRY_DELAY = 2000;

// Retry loop dengan timeout
for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), HF_SPACES_TIMEOUT);
  
  const response = await fetch(HF_SPACES_URL, {
    ...,
    signal: controller.signal
  });
  
  clearTimeout(timeoutId);
  
  // Retry hanya untuk 5xx errors
  if (!response.ok && response.status >= 500 && attempt < MAX_RETRIES) {
    continue;
  }
}

// User-friendly error messages
if (err.name === 'AbortError') {
  errorMessage = 'HF Spaces processing timeout (>45s)';
}
```

---

## Testing Checklist

### Thread Handling
- [ ] Bot membalas di thread yang benar di group chat
- [ ] Auto-threading untuk jawaban panjang (>20 kata) bekerja
- [ ] Thread chain terjaga dengan benar

### Rate Limiting
- [ ] User tidak bisa spam multiple screenshot
- [ ] Pesan "Sedang memproses screenshot sebelumnya" muncul jika spam
- [ ] Rate limit otomatis terhapus setelah screenshot selesai

### Group Chat Screenshot
- [ ] Screenshot terkirim di thread yang benar
- [ ] Fallback ke group chat umum jika thread gagal
- [ ] Processing message masuk di thread yang sama dengan screenshot

### HF Spaces Integration
- [ ] Timeout handling bekerja (HF Spaces lambat >45s)
- [ ] Retry mechanism bekerja (HF Spaces error 5xx)
- [ ] Error message user-friendly
- [ ] Vercel timeout 60s tidak terpicu

---

## Files Modified

1. `src/utils.js` - Thread handling improvements
2. `src/botCoding.js` - Auto-threading dengan messageId
3. `src/botSheet.js` - Rate limiting + group chat screenshot threading
4. `api/pdf-to-png.js` - Timeout + retry + error handling

---

## Next Steps

- [ ] Test di SeaTalk group chat dengan user nyata
- [ ] Monitor logs untuk thread_id flow
- [ ] Verify HF Spaces health check
- [ ] Deploy ke production setelah testing

---

## Rollback Plan

Jika ada masalah, rollback dengan git:
```bash
git revert HEAD
git push origin main
```

Atau rollback per file:
```bash
git checkout HEAD~1 -- src/utils.js src/botCoding.js src/botSheet.js api/pdf-to-png.js