# Apify Actors — Setup Guide & Media Reality Check

## پاسخ کوتاه

| Actor | ویدئو URL | Thumbnail | Carousel | هزینه اضافه؟ |
|-------|-----------|-----------|----------|-------------|
| `apify/instagram-post-scraper` | ✅ `videoUrl` | ⚠️ `displayUrl` (همان تصویر) | ✅ `childPosts[]` | ❌ خیر |
| `kaitoeasyapi/twitter-x-...` | ✅ `video_info.variants` | ✅ `media_url_https` | — | ❌ خیر |
| `harvestapi/linkedin-profile-posts` | ✅ `postVideo.videoUrl` | ✅ `postVideo.thumbnailUrl` | ⚠️ فقط cover pages | ❌ خیر |

**این فیلدها در خروجی فعلی اکتورها وجود دارند. هزینه اضافه ندارند.**  
تنها تغییر این است که کد ما حالا آن‌ها را می‌خواند.

---

## 1. Instagram — `apify/instagram-post-scraper`

### وضعیت مدیا

#### تصویر یک‌تایی
```json
{
  "displayUrl": "https://scontent-den2-1.cdninstagram.com/...jpg",
  "videoUrl": null
}
```
- `displayUrl` → URL تصویر اصلی ✅
- **expire می‌شود** در چند ساعت تا ۲ روز

#### Reel / ویدئو
```json
{
  "videoUrl": "https://scontent-den2-1.cdninstagram.com/...mp4",
  "displayUrl": "https://scontent-den2-1.cdninstagram.com/...jpg"
}
```
- `videoUrl` → MP4 واقعی ✅
- `displayUrl` → تصویر ثابت (thumbnail) ⚠️ همان فیلد — کد ما این را به‌عنوان thumbnail استفاده می‌کند
- **هر دو URL expire می‌شوند**

#### Carousel (چند تصویر/ویدئو)
```json
{
  "childPosts": [
    {
      "displayUrl": "https://....jpg",
      "videoUrl": null
    },
    {
      "videoUrl": "https://....mp4",
      "displayUrl": "https://....jpg"
    }
  ]
}
```
- ✅ پشتیبانی می‌شود
- `childPosts[].displayUrl` برای تصاویر
- `childPosts[].videoUrl` برای ویدئوهای carousel
- `childPosts[].displayUrl` به‌عنوان thumbnail ویدئو

### مشکل مهم: CDN Expiry
Instagram CDN URL ها بعد از چند ساعت (گاهی ۲ روز) expire می‌شوند.  
**راه‌حل اجباری:** `MEDIA_PROCESSING_MODE = "binary_upload"` در wrangler.toml

### تنظیمات Apify Actor

```json
{
  "directUrls": [
    "https://www.instagram.com/username1/",
    "https://www.instagram.com/username2/"
  ],
  "resultsLimit": 10,
  "onlyPostsNewerThan": "2 days"
}
```

**مهم:** `directUrls` باید URL پروفایل (نه پست) باشد.

### تنظیم Schedule در Apify

```
Cron: 0 */6 * * *   (هر ۶ ساعت — چون URL ها زود expire می‌شوند)
یا:   0 9,20 * * *   (دو بار در روز)
```

### تنظیم Webhook

```
Event: ACTOR.RUN.SUCCEEDED
URL: https://your-worker.workers.dev/webhook/apify
Headers:
  x-webhook-secret: YOUR_INTERNAL_API_SECRET
```

### ثبت در سیستم

```bash
curl -X POST https://your-worker.workers.dev/internal/apify-sources \
  -H "x-internal-api-secret: SECRET" \
  -d '{
    "category_id": "crypto",
    "platform": "instagram",
    "apify_dataset_id": "DATASET_ID_FROM_APIFY",
    "label": "instagram-crypto-accounts"
  }'
```

---

## 2. Twitter/X — `kaitoeasyapi/twitter-x-data-tweet-scraper-pay-per-result-cheapest`

### وضعیت مدیا

این اکتور داده خام Twitter API را با normalize جزئی برمی‌گرداند.  
خروجی ممکن است به یکی از این دو شکل باشد:

#### شکل الف — extendedEntities (خروجی معمول)
```json
{
  "text": "tweet content...",
  "extendedEntities": {
    "media": [
      {
        "type": "photo",
        "media_url_https": "https://pbs.twimg.com/media/...jpg"
      },
      {
        "type": "video",
        "media_url_https": "https://pbs.twimg.com/tweet_video_thumb/...jpg",
        "video_info": {
          "variants": [
            { "content_type": "video/mp4", "bitrate": 2176000, "url": "https://video.twimg.com/...1280x720.mp4" },
            { "content_type": "video/mp4", "bitrate": 832000, "url": "https://video.twimg.com/...640x360.mp4" },
            { "content_type": "application/x-mpegURL", "url": "https://video.twimg.com/...m3u8" }
          ]
        }
      }
    ]
  }
}
```

#### شکل ب — media مستقیم (normalize شده)
```json
{
  "media": [
    {
      "type": "photo",
      "media_url_https": "https://pbs.twimg.com/media/...jpg"
    },
    {
      "type": "video",
      "media_url_https": "https://pbs.twimg.com/tweet_video_thumb/...jpg",
      "video_info": { "variants": [...] }
    }
  ]
}
```

**کد ما هر دو شکل را پشتیبانی می‌کند** (به ترتیب: `media[]`, `extendedEntities.media[]`, `entities.media[]`).

### چه چیزی استخراج می‌شود
- `media_url_https` → برای تصویر: URL تصویر اصلی ✅
- `media_url_https` → برای ویدئو: URL thumbnail ✅ (Twitter این را به‌صورت thumbnail عکس ثابت می‌دهد)
- بالاترین bitrate MP4 از `video_info.variants` → URL ویدئوی اصلی ✅
- HLS/m3u8 stream ها **نادیده گرفته می‌شوند** (Telegram پشتیبانی نمی‌کند)

### ⚠️ نکته مهم: این اکتور Community است

رتبه‌بندی: ۳.۷ — کیفیت متغیر. ممکن است خروجی تغییر کند.  
اگر مشکل داشتید، بررسی کنید که فیلد `extendedEntities` یا `media` در dataset موجود است.

**برای تست:** یک اکتور run کنید با چند حساب که ویدئو پست کرده‌اند و خروجی dataset را در Apify Console بررسی کنید.

### تنظیمات Apify Actor

```json
{
  "twitterHandles": [
    "elonmusk",
    "naval",
    "aantonop"
  ],
  "maxItems": 30,
  "addUserInfo": false,
  "tweetsDesired": 30
}
```

**توجه:** `addUserInfo: false` هزینه را کاهش می‌دهد.

### تنظیم Schedule

```
Cron: 0 */6 * * *   (هر ۶ ساعت — Twitter محتوای breaking دارد)
یا:   0 8,14,20 * * * (سه بار در روز)
```

### ثبت در سیستم

```bash
curl -X POST https://your-worker.workers.dev/internal/apify-sources \
  -H "x-internal-api-secret: SECRET" \
  -d '{
    "category_id": "crypto",
    "platform": "x",
    "apify_dataset_id": "DATASET_ID_FROM_APIFY",
    "label": "twitter-crypto-accounts"
  }'
```

---

## 3. LinkedIn — `harvestapi/linkedin-profile-posts`

### وضعیت مدیا — بهترین Actor از نظر schema

این اکتور از HarvestAPI است و schema ثابت و مستند دارد. خروجی تأیید شده:

#### پست با تصویر
```json
{
  "postImages": [
    {
      "url": "https://media.licdn.com/...jpg",
      "width": 1200,
      "height": 630,
      "expiresAt": 1748000000
    }
  ]
}
```
- ✅ URL تصویر با `expiresAt` مشخص
- ⚠️ معمولاً ۲۴-۴۸ ساعت عمر دارد

#### پست با ویدئو
```json
{
  "postVideo": {
    "videoUrl": "https://dms.licdn.com/...mp4",
    "thumbnailUrl": "https://media.licdn.com/...jpg"
  }
}
```
- ✅ `videoUrl` — MP4 مستقیم
- ✅ `thumbnailUrl` — thumbnail اختصاصی ویدئو (تنها اکتوری که این field را دارد!)
- هر دو expire می‌شوند

#### Document / PDF Carousel
```json
{
  "document": {
    "title": "Report Title",
    "transcribedDocumentUrl": "...",
    "coverPages": [
      {
        "imageUrls": ["https://media.licdn.com/...jpg"],
        "width": 1200,
        "height": 628
      }
    ]
  }
}
```
- ⚠️ فقط cover page ها (نه PDF کامل)
- سیستم ما تا ۱۰ cover page استخراج می‌کند

### تنظیمات Apify Actor

```json
{
  "profileUrls": [
    "https://www.linkedin.com/in/username1/",
    "https://www.linkedin.com/in/username2/"
  ],
  "maxPostsPerProfile": 5,
  "scrapeReactions": false,
  "scrapeComments": false
}
```

**هزینه:** $2 / 1000 posts — با `maxPostsPerProfile: 5` و ۱۰ حساب = ۵۰ post = $0.10

### تنظیم Schedule

```
Cron: 0 10 * * 1,4   (دوشنبه و پنج‌شنبه ساعت ۱۰)
یا:   0 10 * * *     (روزانه اگر حساب‌های پرپست دارید)
```

### ثبت در سیستم

```bash
curl -X POST https://your-worker.workers.dev/internal/apify-sources \
  -H "x-internal-api-secret: SECRET" \
  -d '{
    "category_id": "design",
    "platform": "linkedin",
    "apify_dataset_id": "DATASET_ID_FROM_APIFY",
    "label": "linkedin-design-accounts"
  }'
```

---

## راه‌اندازی کامل Step-by-Step

### مرحله ۱: ساخت Task برای هر category

در Apify Console برای هر دسته‌بندی و پلتفرم یک **Task** بسازید (نه Actor مستقیم):

```
Apify Console → Tasks → Create Task → انتخاب Actor مربوطه
```

**مثال:** برای crypto:
- Task 1: `crypto-twitter` با `kaitoeasyapi/twitter-x-...`
- Task 2: `crypto-instagram` با `apify/instagram-post-scraper`

**Dataset ID را کجا پیدا کنید:**
```
بعد از اولین run: Task → Last run → Dataset → Copy dataset ID
مثال: rHuMJAdfBf5pFQNkQ
```

### مرحله ۲: تنظیم Webhook برای هر Task

```
Task → Settings → Webhooks → Add Webhook:
  ┌─────────────────────────────────────────────────────┐
  │ Event: ACTOR.RUN.SUCCEEDED                          │
  │ URL: https://your-worker.workers.dev/webhook/apify  │
  │                                                     │
  │ Headers:                                            │
  │   x-webhook-secret: YOUR_INTERNAL_API_SECRET        │
  └─────────────────────────────────────────────────────┘
```

**⚠️ امنیت:** از header `x-webhook-secret` استفاده کنید (نه query param `?secret=`).  
Query param در log های Apify ظاهر می‌شود.

### مرحله ۳: تنظیم Schedule برای هر Task

```
Task → Schedules → Create Schedule:
  ┌─────────────────────────────────────────────────────┐
  │ Type: Cron                                          │
  │                                                     │
  │ Twitter:   0 */6 * * *    (هر ۶ ساعت)              │
  │ Instagram: 0 9,20 * * *   (دو بار در روز)           │
  │ LinkedIn:  0 10 * * 1,4   (دوشنبه و پنج‌شنبه)      │
  └─────────────────────────────────────────────────────┘
```

### مرحله ۴: ثبت Dataset ID در سیستم

```bash
BASE="https://your-worker.workers.dev"
AUTH="x-internal-api-secret: YOUR_SECRET"

# Twitter
curl -X POST $BASE/internal/apify-sources -H "$AUTH" \
  -d '{"category_id":"crypto","platform":"x","apify_dataset_id":"TWITTER_DATASET_ID","label":"crypto-twitter"}'

# Instagram
curl -X POST $BASE/internal/apify-sources -H "$AUTH" \
  -d '{"category_id":"crypto","platform":"instagram","apify_dataset_id":"INSTAGRAM_DATASET_ID","label":"crypto-instagram"}'

# LinkedIn
curl -X POST $BASE/internal/apify-sources -H "$AUTH" \
  -d '{"category_id":"design","platform":"linkedin","apify_dataset_id":"LINKEDIN_DATASET_ID","label":"design-linkedin"}'
```

### مرحله ۵: تست قبل از production

```bash
# ۱. یک run دستی در Apify Console انجام دهید
# ۲. بعد از run، webhook باید trigger شود
# ۳. بررسی کنید که آیتم‌ها process شدند:
curl "$BASE/internal/runs?limit=3" -H "$AUTH"

# ۴. اگر curation فعال نیست، دستی trigger کنید:
curl -X POST "$BASE/internal/curation/trigger" -H "$AUTH" \
  -d '{"dryRun": true}'

# ۵. نتایج scoring را ببینید:
curl "$BASE/internal/items?status=ai_selected&limit=20" -H "$AUTH"
```

---

## راه‌حل نهایی مدیا: Binary Upload

### چرا binary_upload؟

| مشکل | direct_url | binary_upload |
|------|-----------|---------------|
| Instagram URL expire | ❌ Fail | ✅ قبل از expire دانلود می‌شود |
| LinkedIn URL expire | ❌ Fail | ✅ قبل از expire دانلود می‌شود |
| Telegram نتواند URL را fetch کند | ❌ Fail | ✅ ما آپلود می‌کنیم |
| ویدئو بدون thumbnail | ❌ ندارد | ✅ thumbnail blob جداگانه |
| یک مدیای خراب، کل album fail | ❌ بله | ✅ فقط آن یک آیتم حذف می‌شود |

### تنظیم

```toml
# wrangler.toml - production
MEDIA_PROCESSING_MODE      = "binary_upload"
MEDIA_MAX_DOWNLOAD_MB      = "50"
MEDIA_DOWNLOAD_TIMEOUT_SEC = "90"
```

### محدودیت‌ها

| محدودیت | مقدار | راه‌حل |
|---------|-------|--------|
| حداکثر حجم فایل | ۵۰ مگابایت | ویدئوهای بزرگ‌تر skip می‌شوند |
| Memory Worker | ۱۲۸ مگابایت (free) / ۱ گیگابایت (paid) | Workers Paid برای ویدئوهای بزرگ |
| CPU time | ۳۰ ثانیه (free) / ۳۰ دقیقه (paid) | Workers Paid توصیه می‌شود |
| Telegram upload timeout | ۲ دقیقه (در کد) | برای فایل‌های بزرگ ممکن است timeout بزند |

### توصیه Workers Plan

برای production با مدیای سنگین:
- **Workers Free:** مناسب برای تصاویر و ویدئوهای کوچک (< ۱۵ مگابایت)
- **Workers Paid ($5/month):** مناسب برای ویدئوهای تا ۵۰ مگابایت

---

## آنچه تضمین نمی‌شود

### ویدئو compatibility با Telegram

حتی با binary_upload، Telegram ممکن است ویدئو را reject کند اگر:
- Codec ناسازگار باشد (نه H.264)
- Container نامناسب باشد (نه MP4 standard)
- ابعاد خیلی بزرگ یا کوچک باشد
- موز هوش مصنوعی (DASH/HLS segment) باشد

**راه‌حل کامل (خارج از scope فعلی):** Cloudflare Stream یا FFmpeg Worker جداگانه برای transcode کردن ویدئو به H.264 MP4.

**وضعیت فعلی کد:** اگر ویدئو reject شود، item به `retry` می‌رود و بعد از ۳ بار fail به `failed` تبدیل می‌شود. می‌توانید از `/internal/queue/{id}/retry` برای retry استفاده کنید.

### Instagram Video via Kaito Actor

اگر از Kaito برای Instagram هم استفاده می‌کنید (برخی content curator ها این را می‌کنند):
- Kaito برای X بهینه شده، نه Instagram
- برای Instagram فقط از `apify/instagram-post-scraper` استفاده کنید

---

## هزینه‌ها — خلاصه واقعی

### با ۳ دسته‌بندی، ۶ کانال، ۳ پلتفرم

| اکتور | تعداد run/ماه | آیتم/run | هزینه/ماه |
|-------|--------------|---------|-----------|
| Twitter (Kaito) | 90 | ۳۰ = ۲۷۰۰ tweet | **$0.68** |
| Instagram | 60 | ۱۰ = ۶۰۰ post | **$0.60** |
| LinkedIn | 8 | ۵۰ = ۴۰۰ post | **$0.80** |
| **جمع Apify** | | | **~$2.10** |

**این هزینه خیلی کمتر از تخمین قبلی است** چون برای هر اکتور فقط تعداد محدودی account اسکرپ می‌کنیم.

اگر ۵۰ account تویتر با ۳۰ توئیت/account داشته باشید و روزانه ۲ بار run کنید:
- ۵۰ account × ۳۰ × ۶۰ run/ماه = ۹۰,۰۰۰ tweet/ماه = **$22.50**

---

## تست سریع

```bash
# ۱. یک run دستی در Apify Console
# ۲. Dataset ID را copy کنید
# ۳. Curation را با آن dataset test کنید:

curl -X POST https://your-worker.workers.dev/webhook/apify \
  -H "x-webhook-secret: YOUR_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"datasetId":"YOUR_DATASET_ID","actorRunId":"test-001"}'

# ۴. بعد از چند ثانیه نتایج را ببینید:
curl "https://your-worker.workers.dev/internal/runs?limit=1" \
  -H "x-internal-api-secret: YOUR_SECRET"

# ۵. آیتم‌های انتخاب شده:
curl "https://your-worker.workers.dev/internal/items?status=ai_selected" \
  -H "x-internal-api-secret: YOUR_SECRET"
```
