# ✅ وضعیت نهاییِ واحد (این بخش بر همهٔ بخش‌های پایین‌تر مقدم است)

> بخش‌های پایین‌ترِ این فایل «تاریخچهٔ نوبت‌به‌نوبت» هستند و ممکن است حرف‌های
> قدیمی داشته باشند. **مرجعِ درست، همین جدول است.**

## آنچه با merge + flagهای خاموش رخ می‌دهد
هیچ تغییر رفتاری. فقط endpointهای گزارشِ read-only فعال می‌شوند. رفتار pipeline
دقیقاً مثل Phase 6D است.

## دسته‌بندیِ قطعیِ قابلیت‌ها

**فعال به‌صورت پیش‌فرض:** هیچ‌کدام، جز گزارش‌های read-only.

**Observe-only (ثبت/گزارش، بدون reject):**
- 6K story intelligence — ساختِ `story_key` و ثبت در `run_item_events.metadata` و جدولِ `story_intelligence_events` (وقتی `STORY_INTELLIGENCE_ENABLED=true`).
- caption_quality_score (تابع خالص؛ در مسیر repair وقتی روشن شود استفاده می‌شود).
- گزارش‌ها: queue-quality، source-yield، topic-mix، source-cap-preview، story-intelligence، ai-cost-by-source، apify-query-yield، gap-fill-preview.

**کدِ active آماده ولی پیش‌فرض خاموش (فقط flag را روشن کن، نیازی به برگشت به cloud نیست):**
- `APIFY_ROTATION_CONTINUOUS_ENABLED` (چرخش پخش‌شدهٔ slot-level)
- `QUEUE_HEALTH_CONTROLLER_ENABLED` (drain تطبیقی + rotation اضطراری)
- `PUBLISH_SCHEDULER_GAP_FILL_ENABLED`
- `BACKLOG_TRANSLATE_AFTER_GATES_ENABLED`
- `AUDIENCE_PROFILE_SCORING_ENABLED`
- `STORY_INTELLIGENCE_REJECT_ENABLED` (+ `_WINDOW_HOURS`, `_FOLLOWUP_ALLOW_ENABLED`) → reason `similar_story_key_recent_channel`
- `CAPTION_QUALITY_REPAIR_ENABLED` / `CAPTION_QUALITY_REJECT_ENABLED` → reason `caption_quality_low`
- `SOURCE_REPUTATION_WEIGHTING_ENABLED` (+ exploration/min-sample/max-min-weight)
- `QUEUE_QUALITY_CONTROLLER_ENABLED` (steer به‌سوی تنوع)
- `AI_COST_ATTRIBUTION_ENABLED` (نوشتن جدول attribution)
- `PUBLISH_ENFORCE_SOURCE_DAILY_CAP_ENABLED` (آخر از همه)

**نیازمند migration (افزایشی، در 0019؛ بی‌اثر تا وقتی flag مربوط روشن شود):**
- `story_intelligence_events` (برای dedupe/گزارشِ story_key)
- `ai_usage_attribution` (برای cost-per-source)

**پیاده‌شده (تأیید):**
- attribution هزینهٔ **scoring و translation** هر دو پیاده‌اند (با کلیدهای کامل source و `ai_usage_id`)؛ تخصیصِ token به‌ازای هر item تقسیمِ مساوی در batch است (تخمینی، نه per-token دقیق).
- cleanup خودکارِ هر دو جدولِ `0019` (`ai_usage_attribution` و `story_intelligence_events`) با retention و daily-guard در cron وصل است.

**هنوز پیاده نشده (آگاهانه):**
- cohort/query_tag در گزارش query-yield (فعلاً سطح source_account/source_id؛ خروجی صراحتاً `queryLevelAvailable:false` دارد).

## وضعیت کیفیت
۴۱۴ تست سبز، `tsc` پاک، `wrangler build --dry-run` موفق، همهٔ flagهای رفتاری
`false`، `AI_TRANSLATION_MAX_TEXT_CHARS="400"`. migration 0019 افزایشی است.

## ترتیب امنِ روشن‌کردن flagها (تک‌به‌تک، نه باهم)
1) merge + deploy (همه خاموش) → خواندن گزارش‌ها
2) `APIFY_ROTATION_CONTINUOUS_ENABLED`
3) `QUEUE_HEALTH_CONTROLLER_ENABLED`
4) `AUDIENCE_PROFILE_SCORING_ENABLED`
5) `PUBLISH_SCHEDULER_GAP_FILL_ENABLED`
6) `BACKLOG_TRANSLATE_AFTER_GATES_ENABLED` → سپس `AI_TRANSLATION_MAX_TEXT_CHARS=900`
7) apply migration 0019 → `AI_COST_ATTRIBUTION_ENABLED` → چند روز داده →
   `STORY_INTELLIGENCE_ENABLED` (observe) → بررسی گزارش story_key →
   `STORY_INTELLIGENCE_REJECT_ENABLED`
8) `CAPTION_QUALITY_REPAIR_ENABLED` → بعداً `CAPTION_QUALITY_REJECT_ENABLED`
9) `SOURCE_REPUTATION_WEIGHTING_ENABLED` و `QUEUE_QUALITY_CONTROLLER_ENABLED`
10) آخر از همه: `PUBLISH_ENFORCE_SOURCE_DAILY_CAP_ENABLED`


---

# ⛔️ — Appendix: Superseded Historical Notes (پایین این خط معتبر نیست) —

> همهٔ بخش‌های زیر **منسوخ (SUPERSEDED)** هستند و فقط برای تاریخچه نگه داشته شده‌اند.
> مرجعِ معتبر، بخشِ «وضعیت نهاییِ واحد» در بالای همین فایل و سندِ
> `MERGE_AND_REVIEW_GUIDE_6E-6J.md` است. اگر این بخش‌ها با بالا تناقض داشتند، بالا درست است.


> # 🧭 فازهای بعدی — پیاده‌سازیِ observe-only/report-only

> **فاز بعدی پیاده شد (observe-only)، بدون تغییر رفتار و بدون migration.** طبق
> اصرارِ هر چهار دور ریویو، همه‌چیز یا گزارشِ read-only است یا پشت flagِ خاموش/observe:
>
> - **6K هوش داستان (observe-only):** ماژول `story-intelligence.ts` با
>   `buildStoryKey` (کلید ساختاریافتهٔ `entities|event_type|date`)، پارسِ tolerant،
>   تزریقِ flag-دارِ فیلدها به پرامپت scoring (`STORY_INTELLIGENCE_ENABLED`، پیش‌فرض
>   off) و ثبتِ `story_key` در `run_item_events.metadata_json` (فقط ثبت، **هرگز
>   reject**). گزارشِ پایداری فینگرپرینت: `/internal/report/story-intelligence`.
> - **گزارش‌های جدید read-only:** `/internal/report/queue-quality` (تنوع صف، نه فقط
>   تعداد)، `/internal/report/source-yield` (بازده هر اکانت: candidate→rejected→
>   published)، `/internal/report/topic-mix` (توزیع تمِ خروجی)،
>   `/internal/report/source-cap-preview` (اینکه سقف منبع چه چیزی را *می‌برید*، بدون
>   اعمال).
> - **caption_quality_score (observe، deterministic):** تابع خالصِ `scoreCaptionQuality`
>   برای سنجشِ وضوح/مستندبودن/native بودنِ کپشن؛ فقط برای رصد، در مسیر reject نیست.
>
> **عمداً به فازِ بعدتر موکول ماند (با دلیل):**
> - **6L source-reputation فعال (تصمیم‌گیر در rotation):** هر چهار بازبین گفتند این
>   باید *بعد از چند روز داده* و با سهمِ exploration بیاید؛ پیاده‌سازیِ شتاب‌زده‌اش
>   می‌تواند دقیقاً همان dominance‌ای را که حل می‌کنیم بدتر کند. هستهٔ امتیاز
>   (`computeSourceReputation`) و گزارشش آماده است؛ وزن‌دهیِ rotation فاز بعد.
> - **انتساب هزینه به منبع (cost-per-source):** نیازمندِ افزودنِ ستون به `ai_usage`
>   است و ما خطِ «بدون migration» را نگه داشتیم؛ پس موکول شد.
>
> وضعیت: **۳۹۱ تست سبز**، typecheck/build پاک، همهٔ flagهای رفتاری + 6K خاموش،
> `AI_TRANSLATION_MAX_TEXT_CHARS="400"`، بدون migration.

> ## پاسخ به ریویوِ چهارم (نقشهٔ راه + یک فیکس)
>
> دورِ چهارم عمدتاً **نقشهٔ راهِ فازهای بعدی** بود (خودِ بازبین همه را «فاز بعدی /
> observe-only / بعد از rollout» خواند)، نه فهرستِ باگ. تفکیک:
>
> **فیکس‌های کد در همین نسخه:**
> - **(#9) مدیریت خطای ترجمه در مسیر 6H:** `attachTranslations` حالا داخل try/catch
>   است؛ اگر provider لحظه‌ای خطا بدهد، survivorها با `releaseClaimedCandidatesToPending`
>   به `pending` برمی‌گردند (retryable) و دیگر در وضعیت `claimed` گیر نمی‌مانند؛
>   rejectهای همان batch هم درست ثبت می‌شوند. تست شکست‌ترجمه اضافه شد.
> - **(#14) لاگِ پاکسازی چرخش:** `cleanupOldRotationClaims` حالا تعداد کلیدهای حذف‌شده
>   را log می‌کند (برای رصد در اولین deployها). منطق DELETE بدون تغییر و امن است.
>
> **عمداً موکول‌شده به فاز بعد (با تأکید و موافقت بازبین) — نقشهٔ راه:**
> 6K هوش داستان (entity/event/`story_key` + dedupe ساختاریافته، observe-only اول)؛
> 6L source-reputation فعال (تصمیم‌گیر، با سهم exploration ۲۰٪)؛ گزارش‌های
> queue-quality (تنوع صف، نه فقط تعداد)، apify-query-yield (کیفیت query)،
> topic-mix، و cost-per-source/AI-cache/semantic-dedupe پیش از AI؛ حالت report-only
> برای source-cap و gap-fill؛ caption_quality_score (observe، repair-first). هیچ‌کدام
> «باگ نسخهٔ فعلی» نیستند؛ بهبودهای بعدی‌اند و باید مرحله‌ای و observe-first بیایند.
>
> وضعیت: **۳۸۰ تست سبز**، typecheck/build پاک، flagها خاموش، بدون migration.

> # ✅ وضعیت نهایی (پس از سه دور ریویو مستقل)
>
> هر سه دور ریویو پاسخ داده شد. دورِ سوم **تأییدِ پذیرش** بود و هیچ باگ کد جدیدی
> پیدا نکرد؛ موارد باقی‌مانده همگی «فاز بعدی» یا «وابسته به rollout در production»
> هستند (در بخش‌های زیر مستند شده). QA نهایی: **۳۷۹ تست سبز**، `tsc` پاک،
> `wrangler build --dry-run` موفق، **هر ۶ flag رفتاری `false`**،
> `AI_TRANSLATION_MAX_TEXT_CHARS="400"`، و **بدون هیچ migration** (یکسان با 6D).
> یعنی merge با flagهای خاموش رفتار production فعلی را دقیقاً حفظ می‌کند.
>
> مواردِ عمداً موکول‌شده به فاز بعد (با موافقت بازبین): لایهٔ «هوش داستان»
> (فینگرپرینت ساختاریافتهٔ entity/event برای رفع ۴۱٪ فینگرپرینتِ ناپایدار)،
> فعال‌شدنِ source-reputation به‌عنوان تصمیم‌گیر (نه فقط گزارش)، grounding تک‌به‌تکِ
> اعداد، و گزارش‌های cost-per-source / AI cache / semantic-dedupe پیش از AI.

# گزارش پیاده‌سازی فازهای 6E تا 6J — content-curator

## ۰٫۰۰. پاسخ به ریویوِ دوم (اصلاحات تکمیلی)

بازبینِ مستقل نسخهٔ هاتفیک‌شده را پذیرفت («کابل‌های اصلی وصل شده‌اند») و چند نکتهٔ
باقی‌مانده داد. تفکیک شد به «باگ گزارش» (رفع شد) و «کار آینده» (مستند شد):

| مورد | نوع | اقدام |
|---|---|---|
| گزارش‌ها «منتشرشده در N ساعت اخیر» را با `q.created_at` می‌سنجیدند | باگ دقت گزارش | **رفع شد** — حالا با `q.published_at` سنجیده می‌شود (هم در `source-reputation` هم در `rejection-funnel`؛ `failed` چون ستون `failed_at` ندارد روی `created_at` ماند) |
| `source-performance` فقط سطح `source_account` داشت | درخواست بازبین | **اضافه شد** — `publishedByBucket` با تفکیک `source_account + source_id` (مثلاً CoinDesk داخل `src_crypto_x_news_text`) از طریق join با `ai_candidate_queue` روی `candidate_id` |
| starvation rotation با `force` ممکن بود در یک slot طولانی دوبار همان منبع را بزند | edge جزئی | **سفت‌تر شد** — آستانهٔ guard از ثابتِ `>20` به `>= APIFY_ROTATION_SLOT_MINUTES` تغییر کرد؛ حداکثر یک rotation اضطراری در هر طول‌slot |
| per-figure grounding اعداد | کار آینده | **عمداً نگه داشته شد** (بازبین موافق بود؛ ریسک false-positive در شرایط کم‌حجم) |
| لایهٔ هوش داستان (۴۱٪ فینگرپرینت ناپایدار) | فاز بعدی | **کد نشد** — بزرگ‌ترین مورد باقی‌مانده؛ به‌عنوان فاز بعدی با طرح مشخص مستند شده |

وضعیت: **۳۷۹ تست سبز**، typecheck و build پاک. چک‌های pre-merge بازبین تأیید شد:
هر ۶ flag رفتاری `false` و `AI_TRANSLATION_MAX_TEXT_CHARS = "400"` (merge بی‌اثر).

---

# گزارش پیاده‌سازی فازهای 6E تا 6J — content-curator

## ۰٫۰. پاسخ به ریویوِ فنی (هاتفیکس‌های اعمال‌شده)

یک بازبینِ مستقل ۱۰ ایراد گزارش کرد. هر ۱۰ مورد روی کد راستی‌آزمایی شد؛ ۸ مورد
باگ واقعی بودند و **اصلاح شدند**، ۱ مورد بهبود محافظه‌کارانه شد، و ۱ مورد عمداً
به‌خاطر ریسک false-positive دست‌نخورده ماند (با توضیح).

| # | ایراد | وضعیت | اصلاح |
|---|---|---|---|
| ۱ | چرخش پیوسته در یک slot همهٔ منابع را یکی‌یکی claim می‌کرد (burst دوباره) | **رفع شد** | claim حالا **slot-level** است (`apify_rotation_slot_{slot}`)؛ فقط منبعِ designated همان slot اجرا و بقیهٔ tickها skip می‌شوند |
| ۲ | `maxBatches` کنترلر دوباره به نرمال clamp می‌شد → بی‌اثر | **رفع شد** | clamp مستقل با `hardMaxBatches` + بالا بردن `drainLimit` تا batchهای اضافه واقعاً اجرا شوند (تست رگرسیون اضافه شد) |
| ۳ | `QUEUE_HEALTH_STARVING_SCORING_CALL_BONUS` تعریف ولی بی‌استفاده | **رفع شد** | به `checkScoringBudgetForBacklog(env, callBonus)` و گزینهٔ `scoringCallBonus` در drain سیم‌کشی شد |
| ۴ | starvation rotation با `force` همیشه اولین منبع (الفبایی) را می‌زد | **رفع شد** | `getStarvationRotationSourceId` منبعِ designated همان slot را برمی‌گرداند (نوبتی، نه همیشه اولی) |
| ۵ | قیف رد category را واقعی filter نمی‌کرد | **رفع شد** | join‌های `run_id→discovery_runs` و `item_id→discovery_items` در حالت categoryId |
| ۶ | source-performance category را filter نمی‌کرد | **رفع شد** | همان join‌ها؛ (سطح `source_account` نگه داشته شد؛ تفکیک `source_id` به‌عنوان کار آینده) |
| ۷ | `pendingCandidates` همهٔ category‌ها را می‌شمرد | **رفع شد** | بر اساس `category_id`ِ کانال filter می‌شود |
| ۸ | `AI_TRANSLATION_MAX_TEXT_CHARS=900` رفتار prod را بدون flag عوض می‌کرد | **رفع شد** | پیش‌فرض wrangler به `400` برگشت (merge کاملاً بی‌اثر)؛ برای بهبود کپشن دستی به ۹۰۰ ببرید |
| ۹ | گارد filler فقط کپشن کاملاً توخالی را رد می‌کرد | **بهبود یافت** | `stripTrailingFillerClauses`: جملهٔ کلیشهٔ پایانی حذف می‌شود ولی جملهٔ واقعی می‌ماند (به‌جای رد کل پست) |
| ۱۰ | `caption_unsupported_figure` با یک match همه را می‌بخشید | **عمداً نگه داشته شد** | بررسی per-figure ریسک false-positive بالا دارد (فرمت‌های عددی فا/لاتین)؛ چون اولویت «حجم» است، محافظه‌کارانه ماند و در کار آینده مستند شد |

نتیجه: **۳۷۸ تست سبز** (۴ تست رگرسیون جدید برای هاتفیک‌های ۲ و ۹)، typecheck و
build پاک. اکنون merge با همهٔ flagها خاموش **۱۰۰٪ بی‌اثر** است (دیگر هیچ مقدار
پیش‌فرضی رفتار را عوض نمی‌کند).

> ترتیب امن روشن‌کردن flagها بعد از این هاتفیک‌ها بدون تغییر است (بخش ۰٫۱)، اما
> حالا گام‌های 6F واقعاً کار می‌کنند: continuous دیگر burst نمی‌سازد، کنترلر واقعاً
> نرخ scoring را بالا می‌برد، و starvation rotation منبع را نوبتی انتخاب می‌کند.

---

# گزارش پیاده‌سازی فازهای 6E تا 6J — content-curator

## ۰٫۱. بازبینی دوم با دادهٔ ۷۲ ساعته (Evidence Pack 2026-06-13 16:23)

این بخش پس از تحلیل Evidence Pack ۷۲ساعته (production هنوز روی **Phase 6D**؛
هیچ‌کدام از فازهای من هنوز deploy نشده) اضافه شد. پس این داده «قبل از تغییرات
من» است و فرضیه‌ها را می‌سنجد.

**چه چیزی قطعی تأیید شد:**
- **صف کاملاً خالی و pending=0**: کوئری ۲۲ → next_1h..24h همه ۰، total_active=۰،
  next_scheduled=null؛ کوئری ۶۲ → هیچ کاندیدای pending نیست. یعنی starvation
  **سمت تأمین/پذیرش** است نه سمت نرخ drain. ← اهرم درستِ من «rotation اضطراری
  وقتی starving و pending=0» (6F) است؛ «drain تندتر» وقتی pending=0 بی‌اثر است
  (ولی بی‌ضرر).
- **`ai_not_publish` = ۳۴۵ (~۶۵٪ ردِ مرحلهٔ AI)** سقفِ اصلی حجم است (کوئری ۶۴).
  بقیهٔ ریزش‌ها کوچک‌اند (pre-AI جمعاً ۱۱۹، dedupe داستانی ۱۲). این عدداً تأیید
  می‌کند که مشکل حجم، «تصمیم publishِ مدل» است نه گیت‌های پایین‌دستی.
- **۲۵٪ کپشن‌ها filler دارند** (کوئری ۴۰: «نشان‌دهنده»=۳۱، «می‌تواند»=۲۸ از ۱۲۲).
  ← فاز 6G و تشخیص stem-based تأیید شد؛ علاوه بر آن **قانون ضدِّ گمانه‌زنی** اضافه
  شد (پایین).
- **۷۴٪ خروجی از ۵ منبع برتر** (کوئری ۳۴: Cointelegraph ۲۷٪، WuBlockchain ۱۴٪،
  CoinDesk ۱۳٪، …). سقف per-source (۵) در prod هیچ‌وقت اعمال نمی‌شد ← فاز 6I.
- **whale_alert سیلِ پست‌های گمانه‌زن** تولید کرده که اپراتور **دستی cancel** کرده
  (کوئری ۱۰۱: ۱۳ مورد `manual_whale_throttle_cleanup`)، و repeatهای
  SpaceX/SPCX هم با `manual_cancel..duplicate_or_low_utility` لغو شده‌اند.
- **۴۱٪ فینگرپرینت‌ها ناپایدارند** (کوئری ۸۴: ۲۷۴ از ۶۶۵) ← dedupe وابسته به
  فینگرپرینت سوراخ دارد؛ exact-dupe منتشرشده ۰ بود (کوئری ۸۱) ولی repeatهای
  تم‌سطح از همین‌جا نشت می‌کنند. (اولویت بعدی؛ پایین.)
- **هزینه معقول است**: ۶۹۴۶ توکن به‌ازای هر پست منتشرشده (کوئری ۷۲)؛ ترجمه ≈
  scoring. پس بهینه‌سازی هزینه ثانویه است.

**اصلاحات/افزوده‌های این دور (فقط جایی که داده گفت لازم است، نه بازنویسی):**
1. **فاز 6J — راهنمای انتخابِ آگاه به مخاطب (درخواست صریح شما + پایهٔ چندزبانه):**
   ماژول جدید `services/audience-profile.ts` که یک بلوک راهنمای «نیازهای مخاطب»
   را به پرامپت scoring تزریق می‌کند تا Claude بر اساس نیاز کاربران ایرانی بهترین
   پست‌ها را انتخاب کند (پروفایل `fa` فعال؛ `ar/en/ru` به‌صورت placeholderِ آمادهٔ
   بهینه‌سازی جداگانه). **آستانه را تغییر نمی‌دهد**، فقط ربط‌سنجی را هدایت می‌کند.
   flag `AUDIENCE_PROFILE_SCORING_ENABLED` (پیش‌فرض off). این مستقیماً سقفِ
   `ai_not_publish` را هدف می‌گیرد بدون پایین‌آوردن کیفیت.
2. **قانون ضدِّ گمانه‌زنی در کپشن** (داده: ۲۸/۱۲۲ «می‌تواند…باشد»، whaleها گمانه‌زنِ
   محض): پرامپت ترجمه حالا صراحتاً «می‌تواند نشان‌دهنده…باشد/ممکن است…باشد» را برای
   آیتم‌های انتقال/whale ممنوع می‌کند و فقط واقعیتِ تأییدشده را می‌خواهد.

**چه چیزی عمداً تغییر نکرد (صادقانه):**
- آستانهٔ scoring پایین نیامد (ریسک کیفیت). 6J انتخاب را هوشمندتر می‌کند، نه شل‌تر.
- کلیدهای theme برای SpaceX/SPCX قبلاً وجود داشت (`story:spacex-tokenized-equity`،
  `theme:rwa-tokenized-assets` با cap ۲)؛ کلید تکراری اضافه نشد. علت اصلی نشتِ
  repeat، **ناپایداری ۴۱٪ فینگرپرینت** است که اولویت بعدی (لایهٔ هوش داستان با
  فینگرپرینت ساختاریافتهٔ entity/event) معرفی شده ولی برای پرهیز از بازنویسی پرریسک
  اکنون کد نشد.
- سقف per-source (6I) همچنان پیش‌فرض off است؛ چون در شرایط فعلیِ starvation،
  روشن‌کردنِ سقف منبع غالب می‌تواند حجم را کمتر کند. بعد از روشن‌شدن 6F فعالش کنید.

**ترتیب استقرار پیشنهادی (به‌روز شده با داده):**
۱) 6E (گزارش‌ها، بی‌اثر) → ۲) `APIFY_ROTATION_CONTINUOUS_ENABLED` + 
`QUEUE_HEALTH_CONTROLLER_ENABLED` (هستهٔ ضدِّ خالی‌شدن صف) → ۳)
`AUDIENCE_PROFILE_SCORING_ENABLED` (کیفیت/ربط انتخاب) → ۴) پایش کپشن با کوئری ۴۰
→ ۵) بعد از پایدارشدن تأمین: `PUBLISH_ENFORCE_SOURCE_DAILY_CAP_ENABLED` و
`PUBLISH_SCHEDULER_GAP_FILL_ENABLED`.

---



## ۰. تطبیق با دادهٔ واقعی production (Evidence Pack 2026-06-13)

این بخش پس از تحلیل Evidence Pack (snapshot دیتابیس production، کانال
`crypto_fa_pilot`، روی Phase 6D) اضافه شد. هر ادعا با داده پشتیبانی می‌شود؛
چند کوئریِ خودِ اپراتور به‌دلیل نام‌ستون اشتباه شکست خورده بود (۱۴/۱۵/۱۶/۱۷)،
پس فقط به کوئری‌های موفق استناد شده است.

**چه چیزی تأیید شد:**
- **صف واقعاً خالی است.** کوئری‌های ۰۲/۰۳ (publish_queue با وضعیت
  scheduled/retry) خروجی `[]` دادند → در لحظهٔ snapshot هیچ پست فعالی در صف نبود.
  این مستقیماً فاز 6F را به‌عنوان اولویت اول تأیید می‌کند.
- **چرخش انفجاری است.** در `settings`، برای هر باکت زمانی (164915، 164916، …)
  **هر ۶ منبع** claim شده‌اند و ۱۵۷ کلید claim انباشته شده است. ۱۹۶ discovery_run
  در ۴۸ ساعت با خوشه‌بندی شدید (مثلاً ۴ run در یک دقیقه) ← دقیقاً الگوی
  «انفجار سپس بیابان». فاز 6F (چرخش پیوسته) درست هدف‌گذاری شده است.
- **قیف رد (۴۸h):** بزرگ‌ترین ریزش‌ها به‌ترتیب: `ai_not_publish` = ۱۹۶ (خودِ مدل
  رد می‌کند)، سپس pre-AI جمعاً ۱۱۸ (non_crypto ۵۴، equity/spacex ۳۴، …)، و
  dedupe داستانی فقط ۹. یعنی **dedupe داستانی مشکلِ حجمی نیست**؛ سقف حجم را
  «تصمیمِ publish مدل» و «سخت‌گیری pre-AI» تعیین می‌کنند.
- **کیفیت کپشن واقعاً ضعیف است.** نمونه‌های published شامل همان کلیشه‌های brief
  بودند: «نشان‌دهنده پذیرش دارایی‌های سنتی…»، «نشان‌دهنده افزایش تمرکز…»،
  «یکی از بزرگترین رویدادهای تاریخ… محسوب می‌شود». ← فاز 6G تأیید شد، و لیست
  banned آن **بر اساس همین متن‌ها گسترده شد** (stem-based، نه عبارت کامل).
- **سلطهٔ منبع واقعی است.** published ۴۸h: مجموع ۹۰ پست؛ سه حساب برتر
  (Cointelegraph ۲۵، WuBlockchain ۱۷، CoinDesk ۱۰) = **۵۸٪** کل. باکت‌های
  voices (سیگنال متخصص/هشدار امنیتی) تقریباً هیچ سهمی نداشتند (۶ از ۹۰).

**چه چیزی تصحیح/کشف شد (و در این نسخه اصلاح شد):**
1. **باگ تأییدشده با داده:** `channels.max_posts_per_source_per_day` در production
   روی **۵** تنظیم است ولی **هیچ‌جای pipeline اعمال نمی‌شد** (فقط در admin
   ذخیره/اعتبارسنجی می‌شد). Cointelegraph ~۱۲.۵/روز منتشر کرده بود. → اعمال این
   سقف به مسیر صف اضافه شد (flag `PUBLISH_ENFORCE_SOURCE_DAILY_CAP_ENABLED`،
   پیش‌فرض off چون در شرایط starvation فعلی می‌تواند حجم را کم کند؛ بعد از 6F
   روشن شود).
2. **6G خیلی تحت‌اللفظی بود:** عبارات واقعی مثل «نشان‌دهنده پذیرش *دارایی‌های
   سنتی*» با لیست عبارت‌کاملِ قبلی گرفته نمی‌شدند. به **stem** تبدیل شد
   («نشان‌دهنده پذیرش»، «نشان‌دهنده افزایش»، «محسوب می‌شود»، …) هم در پرامپت هم در
   گارد.
3. **انباشت کلیدهای rotation:** داده ۱۵۷ کلید stale نشان داد (و کلیدهای slotِ 6F
   هم رشد می‌کردند). تابع `cleanupOldRotationClaims` اضافه و به cron وصل شد.
4. **6H کم‌اثر است (صادقانه):** چون رد پس از ترجمه فقط ~۹ مورد/۴۸h است، صرفهٔ
   هزینهٔ 6H در عمل کوچک است. نگه داشته شد (بی‌خطر، flag-off) ولی اولویت روشن‌کردنش
   پایین است.
5. **`skipped` (۲۰۸) عمدتاً تاریخی است** (جدیدترین ۲۰۲۶-۰۶-۱۲)، نه مشکل جاری؛ پس
   `AI_CANDIDATE_MAX_AGE_HOURS` تهاجمی افزایش نیافت.

**فاز بعدی که کد زده شد (6I، فقط مشاهده):** گزارش read-only
`/internal/report/source-performance` + امتیاز شهرت خالص
(`source-reputation.ts`) که کوئری خرابِ خود اپراتور (۱۷) را با schema درست
جایگزین می‌کند و پایهٔ لایهٔ شهرت فعال آینده است. هنوز هیچ تصمیمی در pipeline
نمی‌گیرد.

---



این سند خلاصهٔ تغییراتی است که روی این نسخه از مخزن اعمال شد. همهٔ تغییرات
**flag-دار** هستند و **پیش‌فرض = رفتار فعلی production**؛ یعنی استقرار این نسخه
به‌تنهایی هیچ رفتاری را عوض نمی‌کند تا زمانی که flagها را روشن کنید.

پایهٔ سنجش: قبل از تغییرات `typecheck` پاک و **۳۳۸ تست** سبز بود. بعد از این
فازها: `typecheck` پاک، `wrangler build --dry-run` موفق، و **۳۶۳ تست** سبز
(۲۵ تست جدید). هیچ تست موجودی نشکست.

---

## چه چیزهایی تغییر کرد و چرا

### فاز 6E — رصدپذیری (فقط خواندنی، بدون تغییر رفتار)
**چرا:** بدون دیدنِ «کجا کاندیداها از بین می‌روند» و «صف واقعاً خالی است یا
عقب‌بارگذاری‌شده»، هر تغییر رفتاری کورکورانه است.

- فایل جدید `apps/worker-api/src/services/queue-health.ts`: محاسبهٔ سلامت صف
  (تعداد پست‌های زمان‌بندی‌شده در ۶/۲۴ ساعت آینده، pending، سن آخرین rotation،
  زمان آخرین انتشار) + تشخیص حالت `healthy/lean/starving` و حالت «عقب‌بارگذاری».
- فایل جدید `apps/worker-api/src/services/rejection-funnel.ts`: تجمیع
  `discovery_runs` و `run_item_events` به یک «قیف رد» (pre-AI / AI / story-theme /
  rule-gate / other) تا پاسخ «چرا صف خالی است؟» در یک نگاه روشن شود.
- دو endpoint فقط‌خواندنی در `routes/admin.ts`:
  - `GET /internal/report/queue-health?category=crypto`
  - `GET /internal/report/funnel?category=crypto&hours=24`

### فاز 6F — چرخش تطبیقی + کنترلر سلامت صف + زمان‌بندی gap-fill
**چرا:** ریشهٔ اصلی خالی‌شدن صف، الگوی «انفجار ۱۵دقیقه‌ای هر ۳ ساعت + بیابان
۲ساعت‌و۴۵» در چرخش Apify بود؛ به‌علاوهٔ زمان‌بندی که آیتم‌ها را پشت
`MAX(scheduled_at)` به آینده هل می‌داد.

- `services/apify-rotation-runner.ts`:
  - حالت **پیوسته** (`APIFY_ROTATION_CONTINUOUS_ENABLED`): در هر «اسلات زمانی»
    (`APIFY_ROTATION_SLOT_MINUTES`، پیش‌فرض ۳۰ دقیقه) فقط **یک منبع مشخص** اسکرپ
    می‌شود؛ پس ۶ منبع به‌صورت **پخش‌شده** در طول بازه پوشش داده می‌شوند، نه انفجاری.
  - گزینهٔ `maxSources` برای سقف‌گذاری حتی در حالت force (برای rotation نجات تک‌منبعی).
  - تابع خالصِ `orderPlansForSlot` (تست‌پذیر).
- `index.ts` (cron): کنترلر سلامت صف (`QUEUE_HEALTH_CONTROLLER_ENABLED`). فقط
  **نرخ** امتیازدهی را وقتی صف starving است بالا می‌برد (`decideDrainBatches`) و
  در صورت starving و نبودِ کاندیدای pending، **یک** منبع اضافه را زودتر اسکرپ
  می‌کند. هیچ گیت کیفیتی را شل نمی‌کند.
- `services/rule-gate.ts`: زمان‌بندی **gap-fill** (`PUBLISH_SCHEDULER_GAP_FILL_ENABLED`):
  به‌جای افزودن پشت آخرین زمان، اولین شکافِ آزاد از «اکنون» را پر می‌کند (با حفظ
  `min_gap`، پنجره‌ها و سهمیهٔ روزانه). تابع خالصِ `findEarliestGapSlot` (تست‌پذیر).

### فاز 6G — کیفیت کپشن فارسی
**چرا:** context کم (۴۰۰ کاراکتر) + ممنوعیت نرم کلیشه + نبود بازبینی factual
باعث کپشن‌های کلیشه‌ای/اغراق‌آمیز می‌شد.

- `services/ai-gate.ts`:
  - جداسازی سقف کاراکترِ **ترجمه** از **امتیازدهی** (`AI_TRANSLATION_MAX_TEXT_CHARS`،
    پیش‌فرض ۹۰۰): مدلِ کپشن context بیشتری از متن منبع می‌بیند → حدس و speculation کمتر.
  - ممنوعیت **قطعی** عبارات کلیشه‌ای + مثال «بد→خوب» فارسی + الزام «هر عدد/درصد/
    تیکر/تاریخ باید در متن منبع باشد».
- `services/story-quality-guard.ts` (تابع `applyPersianCaptionQualityGuard`):
  - رد کپشن‌هایی که صرفاً پر از کلیشه‌اند و هیچ سیگنال مشخصی ندارند
    (`caption_generic_filler`).
  - **بررسی grounding عددی**: اگر کپشن figureهای `$`/`%`/میلیون-میلیارد دارد و
    هیچ‌کدام در متن منبع نباشد → `caption_unsupported_figure` (محافظهٔ factuality
    که محافظه‌کارانه طراحی شده تا حجم را کم نکند).

### فاز 6H — کنترل هزینه: گیت‌های ارزان قبل از ترجمهٔ گران
**چرا:** در مسیر backlog، ترجمهٔ Gemini برای آیتم‌هایی هم پرداخت می‌شد که بعداً با
story/theme/audience رد می‌شدند.

- `services/ai-gate.ts`: تابع `runAIGate` به دو تابع خالص‌تر شکسته شد:
  `scoreItems` (فقط امتیاز + فینگرپرینت) و `attachTranslations` (ترجمهٔ فقط
  آیتم‌های واجد شرایط). `runAIGate` اکنون از همین دو استفاده می‌کند، پس رفتارش
  دقیقاً مثل قبل است (تمام تست‌های موجود سبز ماندند).
- `services/backlog-drain.ts` (پشت `BACKLOG_TRANSLATE_AFTER_GATES_ENABLED`):
  ابتدا امتیاز، سپس همهٔ گیت‌های قطعی (dedupe/theme/audience) با حفظ
  **dedupe درون‌batch** (با مجموعه‌های in-memory)، و در نهایت ترجمه **فقط برای
  بازماندگان**. منطق تصمیم و صف‌سازی در توابع مشترک (`evaluateCandidateDb`،
  `resolveCandidateRejectReason`، `persistCandidateDecision`) فاکتور شد تا مسیر
  legacy و مسیر جدید هرگز از هم جدا نشوند.

---

## flagهای جدید (همه در `wrangler.toml` بخش `[env.production]`، پیش‌فرض امن)

| Flag | پیش‌فرض | اثر |
|---|---|---|
| `APIFY_ROTATION_CONTINUOUS_ENABLED` | `false` | چرخش پخش‌شده به‌جای انفجاری |
| `APIFY_ROTATION_SLOT_MINUTES` | `30` | طول هر اسلات منبع |
| `QUEUE_HEALTH_CONTROLLER_ENABLED` | `false` | کنترلر سلامت صف |
| `QUEUE_HEALTH_MIN_SCHEDULED_NEXT_6H` | `3` | کفِ سالم برای ۶ ساعت آینده |
| `QUEUE_HEALTH_STARVING_MAX_BATCHES` | `3` | batchهای امتیازدهی در حالت starving |
| `QUEUE_HEALTH_CHANNEL_ID` | `crypto_fa_pilot` | کانال هدف کنترلر |
| `PUBLISH_SCHEDULER_GAP_FILL_ENABLED` | `false` | پر کردن شکاف نزدیک به‌جای عقب‌بارگذاری |
| `AI_TRANSLATION_MAX_TEXT_CHARS` | `900` | context بیشتر برای کپشن |
| `BACKLOG_TRANSLATE_AFTER_GATES_ENABLED` | `false` | ترجمه فقط برای بازماندگان (صرفهٔ هزینه) |

---

## ساختار نهایی (بخش‌های تغییریافته/جدید)

```
apps/worker-api/src/
  index.ts                         (+ کنترلر سلامت صف در cron)
  types.ts                         (+ تعریف flagهای جدید)
  routes/admin.ts                  (+ ۲ endpoint گزارش فقط‌خواندنی)
  services/
    queue-health.ts                (جدید — رصد + تصمیم‌های خالص)
    rejection-funnel.ts            (جدید — قیف رد)
    apify-rotation-runner.ts       (+ حالت چرخش پیوسته + maxSources)
    rule-gate.ts                   (+ زمان‌بندی gap-fill)
    ai-gate.ts                     (+ scoreItems/attachTranslations + پرامپت کپشن)
    backlog-drain.ts               (+ مسیر گیت‌قبل‌از‌ترجمه + توابع مشترک)
    story-quality-guard.ts         (+ گاردهای کلیشه و grounding عددی)
tests/
  queue-health-funnel.test.ts                  (جدید)
  rotation-scheduler-phase6f.test.ts           (جدید)
  caption-quality-phase6g.test.ts              (جدید)
  backlog-translate-after-gates-phase6h.test.ts(جدید)
wrangler.toml                       (+ flagهای جدید با پیش‌فرض امن)
docs/IMPLEMENTATION_SUMMARY.md      (همین فایل)
```

---

## نصب و اجرا

```bash
npm install
npm run typecheck      # بررسی نوع‌ها
npm test               # کل تست‌ها (vitest)
npm run build          # wrangler deploy --dry-run
# اجرای محلی:
npm run dev
# استقرار:
npm run deploy         # wrangler deploy --env production
```

برای دیتابیس (D1):

```bash
npm run db:migrate:local
npm run db:migrate:remote
```

## تست

```bash
npm test                                   # همه
npx vitest run tests/queue-health-funnel.test.ts
npx vitest run tests/rotation-scheduler-phase6f.test.ts
npx vitest run tests/caption-quality-phase6g.test.ts
npx vitest run tests/backlog-translate-after-gates-phase6h.test.ts
```

---

## نقشهٔ استقرار پیشنهادی (تدریجی، تک‌flag)

۱. این نسخه را deploy کنید (هیچ رفتاری عوض نمی‌شود).
۲. گزارش‌ها را ببینید: `/internal/report/funnel` و `/internal/report/queue-health`
   — ۲۴ تا ۴۸ ساعت داده جمع کنید تا فرض‌ها با واقعیت سنجیده شوند.
۳. `APIFY_ROTATION_CONTINUOUS_ENABLED=true` (پخش پوشش).
۴. `QUEUE_HEALTH_CONTROLLER_ENABLED=true` (پایش `scheduledNext6h`).
۵. `BACKLOG_TRANSLATE_AFTER_GATES_ENABLED=true` (صرفهٔ هزینهٔ ترجمه).
۶. در آخر `PUBLISH_SCHEDULER_GAP_FILL_ENABLED=true` (ضدّ عقب‌بارگذاری) و در صورت
   نیاز `AI_TRANSLATION_MAX_TEXT_CHARS` را تثبیت کنید.

برای rollback هر گام، کافی است همان flag را `false` کنید؛ هیچ migration مخربی
وجود ندارد.

---

## پیشنهادهای بعدی (فاز 6I و فراتر)

- **شهرت منبع پویا (6I):** جدول `source_reputation` (tجمیع روزانه از
  `run_item_events`) با متریک‌های yield/dup/تبدیل/هزینه و وزن‌دهی چرخش و
  rescue-pool بر اساس آن (به‌جای لیست‌های دستی فعلی). فقط-observe را اول روشن کنید.
- **لایهٔ هوش داستان:** فینگرپرینت ساختاریافته (entities + event_type + date) از
  مدل scoring و کلید خوشهٔ قطعی، به‌جای کلیدهای دست‌نوشتهٔ `buildCryptoStoryClusterKey`.
- **بررسی dedupe در زمان انتشار** در `publishQueueItem` به‌عنوان لایهٔ دوم.
- تنظیم داده‌ای: `AI_CANDIDATE_MAX_AGE_HOURS` و `semantic_dedupe_window_hours`
  کانال `crypto_fa_pilot` (به ۴۸–۷۲) پس از دیدن قیف رد.
