# content-curator — راهنمای کامل اصلاحات و معماری

## فازبندی اصلاحات

---

## ✅ فاز ۱ — اصلاحات پایه (نسخه اول)

| # | مشکل | وضعیت |
|---|------|--------|
| 14-16 | Timezone/window enforcement | ✅ رفع شد |
| 17-19 | Daily quota + min_gap | ✅ رفع شد |
| 21-22 | Webhook dataset scoping | ✅ رفع شد |
| 26 | Rejected item reprocessing | ✅ رفع شد |
| 27-28 | Branding/Finance profiles | ✅ اضافه شد |
| 31-32 | AI JSON parsing fragility | ✅ رفع شد |
| 35-36 | HTML caption safety | ✅ رفع شد |
| 37 | Caption failure hidden | ✅ رفع شد |
| 38-41 | retry_after + retry status | ✅ رفع شد |

---

## ✅ فاز ۲ — مدیا (نسخه دوم — این نسخه)

### معماری جدید مدیا

سه حالت عملکرد با `MEDIA_PROCESSING_MODE`:

#### `direct_url` (پیش‌فرض — برای تست)
```
Apify URL → Telegram Bot API (URL-based fetch)
```
سریع اما:
- CDN URLs اینستاگرام/لینکدین ممکن است expire شوند
- Telegram گاهی نمی‌تواند URL خارجی fetch کند
- بدون thumbnail ویدئو

#### `binary_upload` ⭐ توصیه برای Production
```
Apify URL → Download (fetch binary) → Multipart upload به Telegram
```
مزایا:
- مشکل expire شدن URL را حل می‌کند
- Thumbnail ویدئو پشتیبانی می‌شود
- خطاهای per-media track می‌شوند
- یک مدیای خراب کل album را fail نمی‌کند

#### `r2_storage` — بهترین قابلیت اطمینان
```
Apify URL → Download → R2 Bucket → URL پایدار → Telegram
```
نیاز به:
```toml
[[r2_buckets]]
binding = "MEDIA_BUCKET"
bucket_name = "content-curator-media"
```
و: `R2_PUBLIC_BASE_URL = "https://media.yourdomain.com"`

### تغییرات فایل‌ها (فاز ۲)

| فایل | تغییرات |
|------|---------|
| `services/media-processor.ts` | **جدید** — دانلود، اعتبارسنجی، R2 ذخیره |
| `services/telegram-publisher.ts` | binary upload با FormData، thumbnail support |
| `services/apify-client.ts` | استخراج `thumbnailUrl` از هر پلتفرم |
| `services/media-resolver.ts` | `thumbnailUrls[]` موازی با `mediaUrls[]` |
| `services/curation-orchestrator.ts` | ذخیره thumbnail در DB و queue |
| `types.ts` | `MediaItem.thumbnailUrl`, `ProcessedMedia`, `MediaProcessingStatus` |
| `migrations/0004_media_processing.sql` | فیلدهای جدید discovery_media + category/channel |
| `migrations/0005_thumbnail_urls.sql` | `thumbnail_urls` در publish_queue |

### Thumbnail Support

برای هر پلتفرم:
- **Twitter/X**: `media_url_https` برای ویدئوها (عکس پیش‌فرض Twitter)
- **Instagram**: `displayUrl` همان child post برای ویدئوهای carousel
- **LinkedIn**: `postVideo.thumbnailUrl` از Apify

---

## ✅ فاز ۳ — سیستم کتگوری/زبان مقیاس‌پذیر

### هر تعداد کتگوری — بدون تغییر کد

دو روش برای اضافه کردن کتگوری جدید:

**روش ۱: از طریق API**
```bash
curl -X POST https://your-worker.workers.dev/internal/categories \
  -H "x-internal-api-secret: YOUR_SECRET" \
  -H "Content-Type: application/json" \
  -d '{
    "id": "health",
    "label": "سلامت",
    "prompt_profile": "default_editorial",
    "custom_prompt": "Curate health content for Persian-speaking audience. Focus on evidence-based medicine. Risk flags: misinformation, pseudoscience, dangerous_advice.",
    "score_threshold": 80,
    "freshness_hours": 48,
    "media_mode": "preferred",
    "language_targets": ["fa", "en", "ar"]
  }'
```

**روش ۲: Migration SQL**
```sql
INSERT INTO categories (id, label, prompt_profile, custom_prompt, score_threshold, ...)
VALUES ('health', 'سلامت', 'default_editorial', 'Custom prompt here...', 80, ...);
```

### هر تعداد زبان — برای هر کتگوری

**اضافه کردن کانال جدید:**
```bash
curl -X POST https://your-worker.workers.dev/internal/channels \
  -H "x-internal-api-secret: YOUR_SECRET" \
  -d '{
    "category_id": "crypto",
    "telegram_chat_id": "@mycryptoar",
    "language": "ar",
    "timezone": "Asia/Dubai",
    "custom_instructions": "Write in formal Arabic. Use Islamic finance terminology when relevant.",
    "tone_profile": "formal",
    "channel_label": "كريبتو عربي",
    "allowed_windows": ["09:00-12:00", "18:00-22:00"],
    "max_per_day": 8
  }'
```

### زبان‌های پشتیبانی‌شده

| کد | زبان | کد | زبان |
|----|------|----|------|
| `fa` | فارسی | `ar` | عربی |
| `en` | انگلیسی | `tr` | ترکی |
| `ru` | روسی | `de` | آلمانی |
| `fr` | فرانسوی | `es` | اسپانیایی |
| `zh` | چینی | `hi` | هندی |
| `id` | اندونزیایی | `ko` | کره‌ای |
| `ja` | ژاپنی | `pt` | پرتغالی |

---

## مشکلات باقی‌مانده (نیاز به معماری بزرگتر)

| # | مشکل | راه‌حل پیشنهادی |
|---|------|-----------------|
| 3-4 | تضمین compatibility ویدئو | ffprobe API یا Cloudflare Stream |
| 4 | thumbnail generation | Cloudflare Images یا ffmpeg worker |
| 47 | Structured logging | Cloudflare Logpush یا Workers Analytics |
| 20 | Cron granularity | Cloudflare Queues با delay |
| 15.1 | Media model کم‌عمق | migration 0004 بهبود داده، ولی lifecycle کامل نیست |

---

## راه‌اندازی سریع

```bash
# ۱. ایجاد D1 database
wrangler d1 create content-curator-db

# ۲. اجرای migrations
wrangler d1 migrations apply content-curator-db

# ۳. تنظیم secrets
wrangler secret put APIFY_TOKEN
wrangler secret put ANTHROPIC_API_KEY
wrangler secret put GEMINI_API_KEY
wrangler secret put TELEGRAM_BOT_TOKEN
wrangler secret put INTERNAL_API_SECRET

# ۴. (اختیاری) R2 برای binary storage
wrangler r2 bucket create content-curator-media

# ۵. Deploy
wrangler deploy --env production
```
