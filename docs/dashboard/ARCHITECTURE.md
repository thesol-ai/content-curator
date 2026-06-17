# Content Curator — Operations Dashboard

**Architecture & Technical Reference (final version)**

This document describes the final state of the operations dashboard shipped in
`apps/dashboard/`. It covers the deployment model, the high‑level architecture,
every subsystem, every page/section, the detail drawers, the form/field
schemas, the backend contract it depends on, and the known limitations.

---

## 1. Purpose & deployment

The dashboard is the human control surface for the Content Curator pipeline. It
is a **single static HTML file** (`apps/dashboard/index.html`) plus a tiny
`config.js`. There is **no build step, no framework, and no bundler** — it is
vanilla HTML/CSS/JS that talks directly to the Worker API.

| Item | Value |
|---|---|
| Entry file | `apps/dashboard/index.html` (~2,150 lines, all logic inline) |
| Config | `config.js` — sets `window.CURATOR_API_URL` default |
| External dependency | Chart.js 4.4.1 via cdnjs (only third‑party script) |
| Auth | `x-internal-api-secret` header; URL + secret stored in `localStorage` |
| State persistence | `localStorage` (api url, secret, change log, operator name) |
| Hosting | Open the file directly, or serve it from the Worker origin if CORS blocks cross‑origin calls |

`config.js`:
```js
window.CURATOR_API_URL = 'https://content-curator.thesol-ai.workers.dev';
// The secret is never stored here — the dashboard prompts for it and keeps it
// only in browser localStorage.
```

---

## 2. Core design principle — the category → channel hierarchy

Everything in the dashboard is organised around one structure:

```
Category (parent)
 ├─ Channel  (Persian)    ← language version
 ├─ Channel  (Arabic)     ← language version
 ├─ Channel  (English)    ← language version
 └─ …
```

A **category** is the top‑level editorial entity (e.g. *Crypto*). Its
**channels are language versions** of that category (Persian today; Arabic,
English, Russian, … later). This hierarchy is the spine of:

- the **sidebar tree** (categories expand to reveal their channels),
- the **global scope selector** (Category → Channel) in the top bar,
- the **scoped analytics** pages, and
- the **detail drawers** (a category shows its child channels; a channel shows
  its parent category).

---

## 3. Application shell & layout

```
┌──────────── .layout (height:100vh, overflow:hidden) ────────────┐
│ .sidebar (sticky, 100vh, own scroll)  │ .main (100vh, hidden)   │
│  • brand + env pill                   │  ┌─ .topbar (sticky) ──┐ │
│  • Structure group (tree)             │  │ title · scope · win │ │
│  • Analytics group                    │  │ · runtime pills     │ │
│  • Developer group + Sign out         │  └─────────────────────┘ │
│                                       │  .content (own scroll)   │
└───────────────────────────────────────┴──────────────────────────┘
```

**Independent scrolling (Epic 1).** `.layout` is locked to `height:100vh` with
`overflow:hidden`. The sidebar is `position:sticky; top:0; height:100vh;
overflow-y:auto`, and `.main` is `height:100vh; overflow:hidden` with the
top bar fixed (`flex:0 0 54px`) and only `.content` scrolling (`overflow:auto;
flex:1`). Result: the sidebar and the top bar stay put; only content scrolls.

A right‑hand **modal/drawer** (`#modal-root`) overlays the shell for editors and
detail views, with its own scrollable body.

---

## 4. Subsystems (technical)

### 4.1 API layer
- `getApiUrl()` / `getSecret()` read from `localStorage` (fallback to `config.js`).
- `api(path, {method, body})` — single fetch helper. Sends JSON + the secret
  header; on `401` it logs out; on other non‑OK it throws and **surfaces the
  backend's `error`/`message`** so validation failures are visible in a toast.
- `safeCard(el, loader)` — wraps a render so one failing endpoint shows an
  inline error instead of blanking the page.
- `fetchRuntime()` — returns `/internal/stats → runtime_config`, the single
  authoritative source for the runtime flags (pills + Settings toggles).

### 4.2 Navigation model
Three groups, rendered by `renderNav()`:
- **Structure** — the `structure` page link plus `renderStructureTree()`: each
  category is an expandable row (caret toggles `STRUCT.expanded`), showing an
  enabled dot and a channel‑count badge; expanding lists its channels by
  language name + code, each with a state dot. `navCategory()` / `navChannel()`
  set scope and open the relevant detail drawer.
- **Analytics** — `monitoring, overview, pipeline, sources, queue, content,
  cost, settings, changelog`.
- **Developer** — `runs, logs, tracker, debug` (behind a banner).

`nav(page)` sets `CURRENT_PAGE`, updates the (scope‑aware) title, re‑renders the
nav, and calls `loadPage(page)`.

### 4.3 Scope system (category → channel)
- State: `SCOPE = { categoryId, channelId }`; structure cache
  `STRUCT = { categories, channelsByCat, expanded }`.
- `loadStructure()` fetches `/internal/categories` + `/internal/channels`,
  builds the tree, sorts channels by language, populates the scope selectors.
- `setScope(catId, chId)` — selecting a channel implies its category.
- Helpers consumed by renderers: `catParam(joiner)` → `…category=<id>` when a
  category is scoped; `scopedChannelId()` → the selected channel, else the first
  channel of the scoped category (for inherently single‑channel reports).
- `CATEGORY_SCOPED_PAGES = [pipeline, sources, queue, content, cost]` and
  `CHANNEL_SCOPED_PAGES = [queue]` declare which pages honour scope.
- `scopedTitle()` annotates the page title with the active scope; the top‑bar
  `scope-category` / `scope-channel` selects call `onScopeCategoryChange()` /
  `onScopeChannelChange()`.
- Language display: `LANG_NAMES` + `langName(code)` (fa→Persian, ar→Arabic, …).

### 4.4 Page router
- `PAGE_RENDERERS[page]` — each renderer is `async (host) => {…}`, filling a
  detached node that `loadPage()` then mounts. Dev pages get a banner.
- `destroyCharts()` runs before each render; `queueChart()` / `flushCharts()`
  defer Chart.js instantiation until the canvases are in the DOM.

### 4.5 Pagination engine (Epic 2)
- `TABLE_REG[key]` holds a table's config + full row HTML; `PAGER[key]` holds
  `{page, pageSize}` (persists across the 45 s poll).
- `tableCard(key, cfg)` registers and renders a `.card[data-table=key]`;
  `tableInner(key)` slices the current page and emits the table + `pagerHtml()`
  (range read‑out, page‑size select 10/25/50/100, prev/next, numeric window).
- Interaction uses **event delegation** wired on both `#content` and
  `#modal-root` (`wireTableDelegation(root)`), so pagers work after any
  `innerHTML` replacement and inside drawers. `rerenderTable()` re‑renders only
  the affected card (document‑wide lookup).

### 4.6 Modal / drawer system
- `openModal({title, sub, bodyHtml, onSave, saveLabel, wide})` renders the
  right‑hand drawer; the footer (Cancel/Save) appears only when `onSave` is
  given (detail views have no single save and use inline action buttons).
- `closeModal()`, `modalSave(btn)` (runs `onSave` inside `withBtn`).

### 4.7 Form engine
- Field **schemas** drive both the editor forms and the change‑log diff, so UI
  and backend stay aligned: `CATEGORY_FIELDS` (20), `CHANNEL_FIELDS` (33),
  `SOURCE_ACCOUNT_FIELDS` (5), `APIFY_SOURCE_FIELDS` (9).
- `renderForm(fields, row, isCreate)` groups fields into sections; `collectForm`
  reads inputs back into a payload.
- Field types: `text, textarea, number, select, catselect` (category picker),
  `toggle` (switch), `csv` (→ array), `windows` (HH:MM‑HH:MM → array), `json`
  (parsed object). `createOnly` fields render read‑only when editing.
- Bounds/enums in the schemas mirror the backend sanitizers exactly (see §7).

### 4.8 Change log & operator identity (Epic 7)
- `logChange(entity, id, action, changes)` prepends an entry to `localStorage`
  key `curator_changelog` (capped 300), recording **who / what / when**:
  timestamp, operator name, entity, id, action, and a field‑level diff.
- `diffFields(original, body, fields)` computes `from → to` per changed field.
- `getOperator()` / `setOperator()` store an operator name (`curator_operator`)
  used as the "who", since the API has no per‑user identity (see §9).
- Surfaced on the **Change Log** page (paginated) and the latest 5 on the
  Structure page.

### 4.9 Charts
Chart.js helpers: `drawBar`, `drawDonut`, `drawFunnel`, `drawLine`, themed via
the CSS palette; registered in `CHART_REGISTRY` for clean teardown.

### 4.10 State‑correctness mechanisms (Epic 6)
- **Runtime‑sourced state.** Top‑bar pills (`loadPills()`) and the four Settings
  toggles read `runtime_config` from `/internal/stats`, so the displayed
  enable/disable state always matches actual system state (this fixed the old
  bug where pills read the settings array with wrong keys).
- **Dependent publish state.** A channel's *Publish* control is disabled while
  the channel's master `enabled=false` (publishing requires both flags).
- **In‑flight guard.** `withBtn(btn, fn)` disables a button and shows `…` while
  its async action runs, preventing double‑fire.
- **Destructive‑action confirms.** Disable, publish, cancel, delete, clear‑log,
  and send‑snapshot all confirm first.

### 4.11 Polling
`startPolling()` refreshes the active non‑dev page + pills every 45 s, **pauses
when the tab is hidden or a modal is open**, and skips heavy dev tabs.

---

## 5. Pages / sections

### Structure — *Categories & Channels* (landing page)
The hierarchical management home. Lists every category as a card (id, label,
enabled, profile/threshold/freshness/media/langs/created) with **Manage / Edit /
Enable‑Disable / + Channel**; each card embeds its channels sub‑table (language,
chat, state, publish, and **Manage / Edit / Enable / Publish**). Footer shows the
five most recent changes. Refreshing this page also re‑syncs the sidebar tree.

### Monitoring
Executive trends from `/internal/report/timeseries` (daily/weekly/monthly):
headline KPIs (published, scraped, select rate, AI tokens) + line charts.
*Global* (no category param server‑side).

### Overview
`/internal/stats` + `/internal/report/daily`: queue/publish/scrape KPIs, funnel
rates, AI call/token budgets (tone‑coded), media counts, and the runtime flags
panel. *Global.*

### Pipeline Health *(category‑scoped)*
`/internal/report/funnel`: fetched→published funnel KPIs + a horizontal funnel
chart, plus four paginated rejection tables (pre‑AI, AI score, story/theme,
rule‑gate).

### Sources *(category‑scoped)*
Published‑volume chart + paginated per‑account **yield**, **reputation**, and
**configured sources** (filtered by scope, with a Category column and
enable/disable).

### Queue *(category‑ and channel‑scoped)*
**Per‑channel** queue health: a "Queue health by channel (language)" table for
every channel in the category, plus focused KPIs for the selected/first channel
(`queue-health`, `queue-quality`, `source-cap-preview`, `gap-fill-preview`),
diversity guardrails, and the cap‑preview table.

### Content *(category‑scoped)*
Story‑intelligence KPIs, topic‑mix donut + theme table, and a paginated recent
items table (`/internal/items`).

### Cost *(category‑scoped)*
`/internal/report/ai-cost-by-source`: paginated tokens/$ per source with a
wasted‑spend note and an attribution‑off banner when applicable.

### Settings
The four runtime‑toggleable flags (`telegram_publish_enabled`,
`apify_curation_enabled`, `apify_curation_dry_run`, `maintenance_mode`) with
state read from `runtime_config`; a paginated read‑only table of all settings.
High‑impact toggles confirm first.

### Change Log
Audit trail (who/what/when) from `localStorage`, paginated, with **Set
operator** and **Clear log** (confirmed).

### Developer zone
- **Rotation Runs** — recent runs + "Trigger curation run".
- **Logs & Events** — backlog drain stats + manual drain.
- **Raw Item Tracker** — items by status (tabs) with reject reasons.
- **Debug Tools** — crypto pipeline debug snapshot.

---

## 6. Detail drawers

### Channel Detail (`openChannelDetail`)
The comprehensive per‑channel surface:
- **All 35 attributes** grouped read‑only + **Edit / Enable / Publish / Send
  market snapshot**.
- **Runtime health** — `queue-health?category=`, `queue-quality?channel=`,
  `source-cap-preview?channel=`, `gap-fill-preview?channel=`.
- **Publish queue** — `/internal/queue?channel=&status=` with status filter and
  per‑item **Preview** (real Telegram render via `/internal/queue/{id}/preview`),
  **Publish now**, **Retry**, **Cancel**.
- **Structural sources** — source accounts (add/disable) and Apify sources
  (add/edit/enable/disable/delete) for the channel's category.

### Category Detail (`openCategoryDetail`)
- All category attributes read‑only + **Edit / Enable / + New channel**.
- **Channels** list (children) with Manage/Edit.
- **Category analytics** — funnel KPIs, topic mix, source yield (scoped).
- **Structural sources** for the category.

Both drawers track `DETAIL_CTX` so editors and source actions return to the
correct view via `reopenDetail()`.

---

## 7. Field schema reference (mirrors backend)

**Category (`CATEGORY_FIELDS`, 20):** `id`*(create)*, `label`*(req)*, `enabled`,
`prompt_profile`*(req; enum of 8 profiles)*, `score_threshold` 0–100,
`freshness_hours` ≥1, `media_mode` {optional|preferred|disabled},
`language_targets` (2‑letter csv), `custom_prompt` ≤4000, `editorial_guidelines`
≤3000, `selection_criteria`/`rejection_criteria`/`required_context` ≤2000,
`avoid_duplicate_people_stories`, `allow_replies`, `allow_retweets`,
`allow_quotes`, `text_only_policy` {allow|penalize|reject},
`min_score_for_text_only`/`min_score_for_media` 0–100 nullable.

**Channel (`CHANNEL_FIELDS`, 33):** `id`/`category_id`*(create)*, `language`*(req)*,
`telegram_chat_id`*(req)*, `channel_label`, `enabled`; `timezone`,
`max_per_day` 1–100, `max_per_hour` 1–20, `min_gap_minutes` 1–1440,
`allowed_windows`/`blocked_windows`; `source_enabled`, `source_label_override`
≤32, `signature_enabled`, `signature_text` ≤300, `channel_id_footer_enabled`,
`channel_id_footer_text` ≤80, `disable_link_preview`; `semantic_dedupe_enabled`,
`semantic_dedupe_window_hours` 1–168, `max_posts_per_source_per_day` 1–50
nullable; `editorial_mode` {news|educational|analytical|brief|explainer},
`audience_level` {beginner|intermediate|professional}, `caption_style`
{contextual|straight_news|educational_summary|insight_first}, `creativity_level`
0–1, `caption_max_chars` 280–3500, `caption_short_max_chars` 80–900,
`tone_profile` ≤40, `custom_instructions`/`language_prompt`/`terminology_notes`
≤2000, `forbidden_phrases` (csv, max 30). `publish_enabled` via the publish
endpoint; `created_at` read‑only.

**Source account (5):** `category_id`*(create)*, `platform`
{x|instagram|linkedin|rss}, `account_handle`, `display_name`, `trust_level`
{high|medium|low}.

**Apify source (9):** `id`*(create)*, `category_id`, `platform`, `label`,
`apify_dataset_id`*(req)*, `apify_actor_id`, `apify_task_id`, `source_config`
(JSON), `enabled`.

---

## 8. Backend contract

Full endpoint → UI coverage is in `BACKEND_COVERAGE.md`. Summary of what the
dashboard calls: categories/channels CRUD‑less‑delete + publish; apify‑sources
full CRUD; source‑accounts create/list/disable; the queue item lifecycle
(list/preview/publish‑now/retry/cancel); the report family (timeseries, daily,
funnel, queue‑health, queue‑quality, source‑cap/gap‑fill, source‑yield/
performance, apify‑query‑yield, ai‑cost, topic‑mix, story‑intelligence); stats;
settings + toggle; curation trigger; backlog stats/drain; market‑snapshot
send‑now; debug snapshot; health.

---

## 9. Known limitations (by backend design)

- **No hard delete for categories/channels** — the API exposes no DELETE; the
  supported mechanism is disable (`enabled=0`), which the UI uses.
- **No server‑side identity / RBAC** — auth is a single shared secret, so all
  operators are equal and no actions are permission‑gated. The change log's
  "who" is a locally‑set operator name; a true multi‑user audit would require a
  backend change‑log table + per‑user auth.
- **Global pages** — Monitoring, Overview, Settings and the runtime pills are
  not category‑scoped because `stats`/`timeseries`/`daily` take no category
  param server‑side.
- **Change log is per‑browser** (localStorage), not shared across devices.

---

## 10. Extending the dashboard

- **Add a page:** add to `ADMIN_PAGES`/`DEV_PAGES`, add a `PAGE_RENDERERS[id]`
  renderer, and (if scoped) to `CATEGORY_SCOPED_PAGES`.
- **Add a table:** call `tableCard(uniqueKey, {head, rows, empty, pageSize,
  title?, note?})` — pagination is automatic.
- **Add an editable field:** add an entry to the relevant `*_FIELDS` schema;
  the form, payload, and change‑log diff pick it up automatically.
- **Scope a report:** append `catParam('&')` (or use `scopedChannelId()`).
