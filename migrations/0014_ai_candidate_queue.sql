-- ══════════════════════════════════════════════════════════════
-- 0014_ai_candidate_queue.sql
-- AI candidate backlog — Phase 1
--
-- این جدول یک لایه میانی دائمی بین dedupe و AI scoring ایجاد می‌کند.
-- هر آیتم تازه‌ای که از dedupe رد می‌شود، قبل از ارسال به Claude
-- در اینجا ذخیره می‌شود تا در صورت اتمام ظرفیت batch فعلی، در
-- اجراهای بعدی (cron یا webhook continuation) پردازش شود.
--
-- Safety: این migration فقط جدول و ایندکس‌ها را اضافه می‌کند.
-- هیچ جدول موجودی تغییر نمی‌کند. رفتار pipeline تغییر نمی‌کند
-- مگر اینکه AI_CANDIDATE_BACKLOG_ENABLED=true باشد.
-- ══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS ai_candidate_queue (
  -- شناسه یکتا — با generateId('cand') ساخته می‌شود
  id                   TEXT PRIMARY KEY,

  -- ارجاع به منبع Apify
  source_id            TEXT,
  run_id               TEXT,

  -- دسته‌بندی و پلتفرم
  category_id          TEXT NOT NULL,
  platform             TEXT NOT NULL,

  -- شناسه حساب منبع (برای fair source picker)
  source_account       TEXT,

  -- URL اصلی پست — برای dedup جلوگیری از ورودی تکراری
  source_url           TEXT NOT NULL,

  -- شناسه پست در پلتفرم
  post_id              TEXT,

  -- زمان انتشار اصلی (unix timestamp)
  published_at         INTEGER,

  -- آیتم normalize‌شده به صورت JSON — همان NormalizedItem
  normalized_item_json TEXT NOT NULL,

  -- کلیدهای dedupe محاسبه‌شده — برای ثبت در dedupe_keys پس از scoring
  dedupe_keys_json     TEXT NOT NULL,

  -- امتیاز اولویت برای انتخاب از صف (بالاتر = اولویت بالاتر)
  priority_score       REAL NOT NULL DEFAULT 0,

  -- وضعیت کنونی candidate
  -- pending    → منتظر scoring
  -- scoring    → claimed برای یک batch scoring
  -- ai_selected → Claude این item را تأیید کرد
  -- ai_rejected → Claude این item را رد کرد
  -- queued     → حداقل یک publish_queue row ایجاد شده
  -- failed     → بعد از رسیدن به attempt_count حداکثر، شکست خورده
  -- skipped    → به خاطر stale بودن یا policy از صف حذف شده
  status               TEXT NOT NULL DEFAULT 'pending',

  -- تعداد تلاش‌های scoring
  attempt_count        INTEGER NOT NULL DEFAULT 0,

  -- آخرین خطا (برای debugging)
  last_error           TEXT,

  -- زمان‌ها
  created_at           TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  claimed_at           TEXT,
  scored_at            TEXT
);

-- ایندکس اصلی برای واکشی pending candidates مرتب‌شده بر اساس زمان
CREATE INDEX IF NOT EXISTS idx_ai_candidate_queue_status_created
  ON ai_candidate_queue(status, created_at);

-- ایندکس برای fair source picker — گروه‌بندی بر اساس source_account
CREATE INDEX IF NOT EXISTS idx_ai_candidate_queue_account_status
  ON ai_candidate_queue(source_account, status);

-- ایندکس برای lookup بر اساس run_id (گزارش‌دهی)
CREATE INDEX IF NOT EXISTS idx_ai_candidate_queue_run
  ON ai_candidate_queue(run_id);

-- ایندکس برای جلوگیری از ورودی تکراری در همان source_url
-- UNIQUE است تا INSERT OR IGNORE واقعاً duplicate را ignore کند
CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_candidate_queue_source_url_unique
  ON ai_candidate_queue(source_url);
