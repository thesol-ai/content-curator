// ══════════════════════════════════════════════════════════════
// config.js — تنظیمات Dashboard
// این فایل را در Cloudflare Pages به عنوان environment variable تنظیم کنید
// یا مستقیم ویرایش کنید (secret را commit نکنید!)
// ══════════════════════════════════════════════════════════════

// Worker API URL شما
// مثال: https://content-curator.your-account.workers.dev
window.CURATOR_API_URL = 'https://content-curator.YOUR_ACCOUNT.workers.dev';

// اگر secret را hardcode نکنید، Dashboard هنگام اولین استفاده آن را می‌پرسد
// و در localStorage مرورگر ذخیره می‌کند.
// window.CURATOR_SECRET = ''; // خالی بگذارید
