# Backend Capability Audit — UI Coverage Map

Status of every `/internal/*` endpoint exposed by `apps/worker-api` against the
operations dashboard (`apps/dashboard/index.html`). Goal: every backend-supported
capability is either reachable from the UI, or has a documented reason for not
being exposed.

Auth model: a single shared `x-internal-api-secret`. There is **no per-user
identity or role/permission system** server-side, so all authenticated operators
have full access. This is why the change log's "who" is a locally-set operator
name (see Epic 7 below) and why there is no permission-based hiding of actions.

## Hierarchy & scope (category → channel)
The dashboard is organised around the core hierarchy: a **category** is the
parent; its **channels are its language versions** (e.g. Crypto → Persian,
Arabic, English…). The sidebar shows a live category→channel tree, and a top-bar
**Category / Channel scope** selector drives the analytics views:
- Category-scoped (pass `?category=`): Pipeline, Sources, Content, Cost, Queue.
- Channel-scoped (pass `?channel=`): Queue's diversity / cap / gap-fill, which
  are inherently single-channel; the Queue page also lists per-channel health
  for every language channel in the category.
- Global by backend design (no category param): Monitoring, Overview, Settings,
  the topbar runtime pills (`/internal/stats`, `/internal/report/timeseries`,
  `/internal/report/daily` are not category-scoped server-side).

## Categories
| Endpoint | Method | UI surface |
|---|---|---|
| `/internal/categories` | GET | Categories & Channels page; Category Detail; editor category picker |
| `/internal/categories` | POST | "New category" → category editor |
| `/internal/categories/{id}` | PATCH | Category editor (all fields) + Enable/Disable toggle |
| _delete category_ | — | **Not exposed — no backend DELETE endpoint exists.** Disable (`enabled=0`) is the supported mechanism and is wired up. |

All category columns are editable in the UI: `label, prompt_profile,
score_threshold, freshness_hours, media_mode, language_targets, custom_prompt,
editorial_guidelines, selection_criteria, rejection_criteria, required_context,
avoid_duplicate_people_stories, allow_replies, allow_retweets, allow_quotes,
text_only_policy, min_score_for_text_only, min_score_for_media, enabled` (+ `id`
on create). `created_at` is read-only.

## Channels
| Endpoint | Method | UI surface |
|---|---|---|
| `/internal/channels` (`?category=`) | GET | Categories & Channels page; Category Detail channels list; Channel Detail |
| `/internal/channels` | POST | "New channel" / "+ Channel" → channel editor |
| `/internal/channels/{id}` | PATCH | Channel editor (all 33 editable columns) + Enable/Disable |
| `/internal/channels/{id}/publish` | POST | Publish toggle (list, Channel Detail) — disabled when master `enabled=0` |
| _delete channel_ | — | **Not exposed — no backend DELETE endpoint exists.** Disable is the mechanism. |

All channel columns are surfaced. Editable via PATCH: `telegram_chat_id, language*,
timezone, allowed_windows, blocked_windows, max_per_day, max_per_hour,
min_gap_minutes, max_posts_per_source_per_day, custom_instructions, tone_profile,
channel_label, source_enabled, source_label_override, signature_enabled,
signature_text, channel_id_footer_enabled, channel_id_footer_text,
disable_link_preview, semantic_dedupe_enabled, semantic_dedupe_window_hours,
editorial_mode, audience_level, caption_style, creativity_level, caption_max_chars,
caption_short_max_chars, language_prompt, terminology_notes, forbidden_phrases,
enabled` (+ `id`, `category_id` on create). `publish_enabled` via the publish
endpoint; `created_at` read-only. (*`language` editable via PATCH per backend.)

## Sources (structural)
| Endpoint | Method | UI surface |
|---|---|---|
| `/internal/apify-sources` | GET | Sources page; Channel/Category Detail "Apify sources" |
| `/internal/apify-sources` | POST | "+ Add" Apify source editor |
| `/internal/apify-sources/{id}` | PATCH | Apify source editor + enable/disable |
| `/internal/apify-sources/{id}` | DELETE | "Delete" (with confirm) in detail |
| `/internal/source-accounts` (`?category=`) | GET | Channel/Category Detail "Source accounts" |
| `/internal/source-accounts` | POST | "+ Add" source-account editor |
| `/internal/source-accounts/{id}` | DELETE | "Disable" (soft-disable) in detail |

## Publish queue
| Endpoint | Method | UI surface |
|---|---|---|
| `/internal/queue` (`?channel=&status=`) | GET | Channel Detail → Publish queue (status filter) |
| `/internal/queue/{id}/preview` | GET | "Preview" — real Telegram render |
| `/internal/queue/{id}/publish-now` | POST | "Publish now" (with confirm) |
| `/internal/queue/{id}/retry` | POST | "Retry" |
| `/internal/queue/{id}` | DELETE | "Cancel" (with confirm) |
| `/internal/publish/due` | POST | Not surfaced — scheduler-internal batch trigger; the per-item "Publish now" covers the operator need. |
| `/internal/media` | GET | Not surfaced — media diagnostics; candidate for a future Developer panel. |

## Reports (read/display)
| Endpoint | Method | UI surface |
|---|---|---|
| `/internal/stats` | GET | Overview; topbar pills/runtime; Sources/Channels counts |
| `/internal/report/timeseries` | GET | Monitoring |
| `/internal/report/daily` | GET | Overview funnel KPIs + status chart |
| `/internal/report/funnel` (`?category=`) | GET | Pipeline Health; Category Detail analytics |
| `/internal/report/queue-health` (`?category=`) | GET | Queue; Channel Detail runtime |
| `/internal/report/queue-quality` (`?channel=`) | GET | Queue; Channel Detail runtime |
| `/internal/report/source-cap-preview` (`?channel=`) | GET | Queue; Channel Detail runtime |
| `/internal/report/gap-fill-preview` (`?channel=`) | GET | Queue; Channel Detail runtime |
| `/internal/report/source-yield` (`?category=`) | GET | Sources; Category Detail analytics |
| `/internal/report/source-performance` (`?category=`) | GET | Sources (reputation) |
| `/internal/report/apify-query-yield` (`?category=`) | GET | Sources (dupes column) |
| `/internal/report/ai-cost-by-source` (`?category=`) | GET | Cost |
| `/internal/report/topic-mix` (`?category=`) | GET | Content; Category Detail analytics |
| `/internal/report/story-intelligence` (`?category=`) | GET | Content |
| `/internal/report/source-reputation-preview` | GET | Indirectly via source-performance; raw endpoint not separately surfaced. |
| `/internal/report/market-trending` | GET | Not surfaced — feeds the market-snapshot feature; snapshot send is exposed in Channel Detail. |
| `/internal/report/ops` + `/ops/telegram-preview` | GET | Not surfaced — Telegram-formatted ops digest, duplicates data already shown across Overview/Queue/Sources. |
| `/internal/items` (`?status=&category=`) | GET | Content (recent); Raw Item Tracker |
| `/internal/runs` | GET | Rotation Runs |
| `/internal/pipeline-health` | GET | Not surfaced — superset duplicated by Pipeline Health + Overview. |

## Settings / actions
| Endpoint | Method | UI surface |
|---|---|---|
| `/internal/admin/settings` | GET | Settings (read-only table) |
| `/internal/admin/toggle` | POST | Settings toggles (the 4 ALLOWED_KEYS), state from runtime_config |
| `/internal/curation/trigger` | POST | Rotation Runs → "Trigger curation run" |
| `/internal/backlog/stats` | GET | Logs & Events |
| `/internal/backlog/drain` | POST | Logs & Events → "Run drain" |
| `/internal/market-snapshot/send-now` | POST | Channel Detail → "Send market snapshot" |
| `/internal/market-snapshot/preview` | GET | Not surfaced — preview-only; send-now covers the action. |
| `/internal/market-snapshot/enqueue` | POST | Not applicable — backend returns 410 (deprecated). |
| `/internal/apify/rotation/run` | POST | Not surfaced — low-level rotation trigger; "Trigger curation run" covers it. |
| `/internal/debug/crypto-pipeline` | GET | Debug Tools |
| `/internal/debug/runs/{id}/events`,`/items` | GET | Not surfaced — deep run forensics; candidate for a future per-run drill-down. |
| `/internal/debug/discovery-runs/{id}/mark-failed` | POST | Not surfaced — recovery tool; intentionally kept out of the default surface. |
| `/health` | GET | Boot connectivity + environment pill |

## Notes on epics not fully satisfiable by the current backend
- **Delete (categories/channels):** no backend endpoint; disable is used instead.
- **Audit "who":** no server-side actor identity; the change log records a
  locally-set operator name + what + when. A true multi-user audit would need a
  backend change-log table and per-user auth.
- **Permission-based UI hiding:** there are no server-side roles; all
  authenticated operators are equivalent, so no actions are permission-gated.
