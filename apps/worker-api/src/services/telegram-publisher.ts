// ══════════════════════════════════════════════════════════════
// services/telegram-publisher.ts — v4
// Telegram Bot API با fallback chain کامل برای video compatibility
//
// Fallback chain برای ویدئو:
//   1. sendVideo (H.264 MP4 + thumbnail)
//      ↓ اگر media_error از Telegram
//   2. اگر Cloudflare Stream تنظیم شده → transcode → sendVideo
//      ↓ اگر Stream در دسترس نیست یا fail شد
//   3. sendDocument (قابل دانلود اما نه streamable در channel)
//      ↓ اگر document هم fail شد
//   4. sendMessage (متن + لینک به source)
//
// این chain تضمین می‌کند که محتوا در هر حالتی ارسال می‌شود.
// ══════════════════════════════════════════════════════════════

import type { Env, PublishedMediaResult, ChannelRow } from '../types';
import {
  getProcessingMode,
  processMediaBatch,
  buildPhotoForm,
  buildVideoForm,
  buildMediaGroupForm,
  downloadTelegramThumbnail,
} from './media-processor';
import {
  detectMediaType,
  sanitizeCaptionText,
  safeTruncate,
} from './media-resolver';
import {
  transcodeViaStream,
  analyzeVideoBlob,
  deleteStreamVideoFromEnv,
} from './video-transcoder';
import { getStreamTranscodeState } from './stream-config';
import { getRuntimeConfig } from './runtime-config';
import { formatTelegramMessage } from './telegram-message-formatter';

export interface PublishInput {
  chatId: string;
  captionShort: string;
  captionFull: string;
  sourceUrl: string;
  method: string;
  language?: string;
  channel?: ChannelRow;
  captionShortHtml?: string;
  captionFullHtml?: string;
  mediaUrls: string[];
  mediaTypes?: Array<'image' | 'video'>;
  thumbnailUrls?: string[];
  videoMetadata?: Array<{
    width?: number;
    height?: number;
    durationSec?: number;
  }>;
  telegramFileIds?: string[];
}

export interface PublishResult {
  ok: boolean;
  messageId?: string;
  allMessageIds?: string[];
  error?: string;
  errorType?: 'rate_limit' | 'media_error' | 'file_too_large' | 'expired_url' | 'invalid_format' | 'network' | 'auth' | 'unknown';
  retryAfterSec?: number;
  captionError?: string;
  /** اگر ویدئو به‌عنوان document ارسال شد (نه streamable) */
  videoSentAsDocument?: boolean;
  /** اگر Cloudflare Stream برای transcode استفاده شد */
  transcodedViaStream?: boolean;
  newFileIds?: Array<{ mediaIndex: number; fileId: string }>;
  partialMedia?: {
    originalCount: number;
    publishedCount: number;
    failedCount: number;
    failedIndexes: number[];
  };
  mediaResults?: PublishedMediaResult[];
}

export function isPartialMediaGroupEnabled(env: Env): boolean {
  return env.MEDIA_GROUP_PARTIAL_PUBLISH_ENABLED !== 'false';
}

const TG_UPLOAD_TIMEOUT_MS = 120_000;
const TG_TEXT_TIMEOUT_MS   = 20_000;

export interface PreparedCaptions {
  fullHtml: string;
  shortHtml: string;
  mediaHtml: string;
  sendFullFollowUp: boolean;
  fullTruncated?: boolean;
  shortTruncated?: boolean;
  fullFooterIncluded?: boolean;
  shortFooterIncluded?: boolean;
  fullFooterOmitted?: boolean;
  shortFooterOmitted?: boolean;
}

// ── Main publish ──────────────────────────────────────────────

export async function publishToTelegram(
  env: Env,
  input: PublishInput
): Promise<PublishResult> {
  const runtime = await getRuntimeConfig(env);
  if (!runtime.telegramPublishEnabled) return { ok: true, messageId: 'disabled_skip' };

  const token = env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token) return { ok: false, error: 'TELEGRAM_BOT_TOKEN not configured', errorType: 'auth' };

  const base = `https://api.telegram.org/bot${token}`;
  const mode = getProcessingMode(env);
  const captions = prepareTelegramCaptions(input);

  try {
    switch (input.method) {

      case 'sendMessage':
        return callTgJson(base, 'sendMessage', {
          chat_id: input.chatId,
          text: captions.fullHtml,
          parse_mode: 'HTML',
          link_preview_options: { is_disabled: true },
        });

      case 'sendPhoto': {
        const photoUrl = input.mediaUrls[0];
        if (!photoUrl) return { ok: false, error: 'No photo URL', errorType: 'media_error' };

        if (mode !== 'direct_url') {
          const [processed] = await processMediaBatch(env, [{
            url: photoUrl, type: 'image',
            telegramFileId: input.telegramFileIds?.[0],
          }]);

          if (processed?.telegramFileId) {
            const result = await callTgJson(base, 'sendPhoto', {
              chat_id: input.chatId,
              photo: processed.telegramFileId,
              caption: captions.mediaHtml,
              parse_mode: 'HTML',
            });
            return withSingleMediaResult(await withCaptionFollowUp(base, input.chatId, result, captions), 0, processed, processed.telegramFileId);
          }
          if (processed?.ok && processed.blob) {
            const form = buildPhotoForm(input.chatId, processed.blob, captions.mediaHtml);
            const result = await callTgForm(base, 'sendPhoto', form);
            return withSingleMediaResult(await withCaptionFollowUp(base, input.chatId, result, captions), 0, processed);
          }
          if (processed?.ok && processed.stableUrl) {
            const result = await callTgJson(base, 'sendPhoto', {
              chat_id: input.chatId,
              photo: processed.stableUrl,
              caption: captions.mediaHtml,
              parse_mode: 'HTML',
            });
            return withSingleMediaResult(await withCaptionFollowUp(base, input.chatId, result, captions), 0, processed);
          }
          if (!processed?.ok) {
            console.warn(`[Publisher] Photo download failed: ${processed?.error} — falling back to URL`);
          }
        }

        {
          const result = await callTgJson(base, 'sendPhoto', {
            chat_id: input.chatId, photo: photoUrl,
            caption: captions.mediaHtml, parse_mode: 'HTML',
          });
          return withUrlMediaResult(await withCaptionFollowUp(base, input.chatId, result, captions), 0);
        }
      }

      case 'sendVideo': {
        const videoUrl = input.mediaUrls[0];
        if (!videoUrl) return { ok: false, error: 'No video URL', errorType: 'media_error' };

        const thumbnailUrl = input.thumbnailUrls?.[0];
        const videoMeta = input.videoMetadata?.[0];
        return sendVideoWithFallback(env, base, input.chatId, videoUrl, captions,
          thumbnailUrl, input.telegramFileIds?.[0], videoMeta);
      }

      case 'sendMediaGroup': {
        if (input.mediaUrls.length === 0) {
          return { ok: false, error: 'No media URLs', errorType: 'media_error' };
        }

        const types = input.mediaUrls.map((url, i) =>
          input.mediaTypes?.[i] ?? detectMediaType(url)
        );

        if (mode !== 'direct_url') {
          return sendBinaryMediaGroup(env, base, input, types, captions);
        }

        // direct_url mode
        const mediaPayload = buildDirectMediaGroupPayload(input.mediaUrls, types, captions.mediaHtml);
        const result = await callTgJson(base, 'sendMediaGroup', {
          chat_id: input.chatId, media: mediaPayload,
        });

        if (!result.ok) return result;

        let captionError: string | undefined;
        if (captions.sendFullFollowUp) {
          const captionResult = await sendTelegramText(base, input.chatId, captions.fullHtml);
          if (!captionResult.ok) {
            captionError = `caption_send_failed: ${captionResult.error}`;
          }
        }
        return { ...result, captionError, mediaResults: buildDirectMediaResults(result, input.mediaUrls.length) };
      }

      default:
        return { ok: false, error: `Unknown method: ${input.method}`, errorType: 'unknown' };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg.slice(0, 500), errorType: 'unknown' };
  }
}

// ══════════════════════════════════════════════════════════════
// Video fallback chain — قلب راه‌حل codec compatibility
// ══════════════════════════════════════════════════════════════

async function sendVideoWithFallback(
  env: Env,
  base: string,
  chatId: string,
  videoUrl: string,
  captions: PreparedCaptions,
  thumbnailUrl?: string,
  existingFileId?: string,
  videoMeta?: { width?: number; height?: number; durationSec?: number }
): Promise<PublishResult> {
  const mode = getProcessingMode(env);

  // ── تلاش با file_id موجود ─────────────────────────────────
  if (existingFileId) {
    const result = await callTgJson(base, 'sendVideo', {
      chat_id: chatId, video: existingFileId,
      caption: captions.mediaHtml, parse_mode: 'HTML', supports_streaming: true,
    });
    if (result.ok) return withUrlMediaResult(await withCaptionFollowUp(base, chatId, result, captions), 0, existingFileId);
    // اگر file_id کار نکرد، ادامه می‌دهیم
    console.warn(`[Publisher] file_id failed, re-processing: ${result.error}`);
  }

  // ── binary_upload یا r2_storage: دانلود binary ────────────
  if (mode !== 'direct_url') {
    const [processed] = await processMediaBatch(env, [{
      url: videoUrl, type: 'video', thumbnailUrl,
    }]);

    if (processed?.ok && processed.stableUrl && !processed.blob) {
      const stableResult = await sendVideoUrlWithDocumentFallback(base, chatId, processed.stableUrl,
        captions, thumbnailUrl, 'stable_url');
      return withSingleMediaResult(stableResult, 0, processed);
    }

    if (processed?.ok && processed.blob) {
      const analysis = await analyzeVideoBlob(processed.blob);
      console.log(`[Publisher] Video analysis: ${JSON.stringify({
        size: Math.round(analysis.sizeBytes / 1024 / 1024) + 'MB',
        mime: analysis.mimeType,
        validVideo: analysis.looksLikeValidVideo,
        streamable: analysis.mightBeStreamable,
      })}`);

      if (analysis.looksLikeValidVideo) {
        // ── تلاش اول: sendVideo با binary ────────────────────
        const form = buildVideoForm(chatId, processed.blob, captions.mediaHtml, processed.thumbnailBlob, true, videoMeta);
        const result = await callTgForm(base, 'sendVideo', form);

        if (result.ok) return withSingleMediaResult(await withCaptionFollowUp(base, chatId, result, captions), 0, processed);

        // اگر خطای media بود، transcode/document fallback
        if (isTelegramMediaFallbackError(result.errorType)) {
          console.warn(`[Publisher] sendVideo rejected: ${result.error} — trying fallback chain`);

          // ── تلاش دوم: Cloudflare Stream transcode ─────────
          const streamState = getStreamTranscodeState(env);
          if (streamState.enabled) {
            console.log('[Publisher] Attempting Cloudflare Stream transcode...');
            const transcoded = await transcodeViaStream(env, processed.blob);

            if (transcoded.ok && transcoded.mp4Blob) {
              // ارسال نسخه transcoded
              let thumbBlob = processed.thumbnailBlob;
              if (!thumbBlob && transcoded.thumbnailUrl) {
                thumbBlob = (await downloadTelegramThumbnail(transcoded.thumbnailUrl)).blob;
              }

              const transcodedForm = buildVideoForm(chatId, transcoded.mp4Blob, captions.mediaHtml, thumbBlob, true, videoMeta);
              const transcodeResult = await callTgForm(base, 'sendVideo', transcodedForm);

              if (transcodeResult.ok) {
                if (transcoded.streamVideoId) {
                  await deleteStreamVideoFromEnv(env, transcoded.streamVideoId).catch(() => {});
                }
                const withFollowUp = await withCaptionFollowUp(base, chatId, { ...transcodeResult, transcodedViaStream: true }, captions);
                return withSingleMediaResult(withFollowUp, 0, processed);
              }
              console.warn(`[Publisher] Transcoded video also rejected: ${transcodeResult.error}`);
            } else {
              console.warn(`[Publisher] Stream transcode failed: ${transcoded.error}`);
            }
          } else {
            console.info(`[Publisher] Cloudflare Stream skipped: ${streamState.reason}`);
          }

          // ── تلاش سوم: sendDocument ────────────────────────
          const documentResult = await sendVideoAsDocument(base, chatId, processed.blob, captions.mediaHtml);
          if (documentResult.ok) return withSingleMediaResult(await withCaptionFollowUp(base, chatId, documentResult, captions), 0, processed);

          console.warn(`[Publisher] sendDocument binary fallback failed: ${documentResult.error} — falling back to text message`);
          const textResult = await sendTextFallback(base, chatId, captions.fullHtml);
          return {
            ...textResult,
            captionError: `video_fallback_to_text_after_binary_document_failed: ${documentResult.error ?? 'unknown'}`.slice(0, 300),
            mediaResults: [{
              mediaIndex: 0,
              status: processingStatusFromError(documentResult.errorType, processed.status),
              error: documentResult.error ?? result.error ?? processed.error,
              thumbnailStatus: processed.thumbnailStatus,
              thumbnailError: processed.thumbnailError,
            }],
          };
        }

        return result; // خطای غیر-media (network, rate_limit)
      }
    }

    if (!processed?.ok) {
      console.warn(`[Publisher] Video download failed: ${processed?.error}`);
    }
  }

  // ── direct_url یا download failed: ارسال با URL مستقیم ───
  return sendVideoUrlWithDocumentFallback(base, chatId, videoUrl, captions, thumbnailUrl, 'source_url');
}

async function sendVideoUrlWithDocumentFallback(
  base: string,
  chatId: string,
  videoUrl: string,
  captions: PreparedCaptions,
  thumbnailUrl: string | undefined,
  label: 'source_url' | 'stable_url'
): Promise<PublishResult> {
  const urlPayload: any = {
    chat_id: chatId, video: videoUrl,
    caption: captions.mediaHtml, parse_mode: 'HTML', supports_streaming: true,
  };
  if (thumbnailUrl) {
    console.info('[Publisher] URL-based video thumbnail skipped; Telegram video thumbnails are only reliable with multipart upload.');
  }

  const urlResult = await callTgJson(base, 'sendVideo', urlPayload);
  if (urlResult.ok) return withCaptionFollowUp(base, chatId, withUrlMediaResult(urlResult, 0), captions);

  // اگر URL-based هم fail شد، قبل از text fallback یک بار document را امتحان کن.
  if (isTelegramMediaFallbackError(urlResult.errorType)) {
    console.warn(`[Publisher] ${label} sendVideo rejected — trying sendDocument fallback before text link`);
    const documentResult = await sendVideoUrlAsDocument(base, chatId, videoUrl, captions.mediaHtml);
    if (documentResult.ok) return withCaptionFollowUp(base, chatId, withUrlMediaResult(documentResult, 0), captions);

    console.warn(`[Publisher] sendDocument ${label} fallback failed: ${documentResult.error} — falling back to text message`);
    const textResult = await sendTextFallback(base, chatId, captions.fullHtml);
    return {
      ...textResult,
      captionError: `video_fallback_to_text_after_document_failed: ${documentResult.error ?? 'unknown'}`.slice(0, 300),
      mediaResults: [{
        mediaIndex: 0,
        status: processingStatusFromError(documentResult.errorType, 'failed'),
        error: documentResult.error ?? urlResult.error,
      }],
    };
  }

  return urlResult;
}

// ── Document fallback ─────────────────────────────────────────

async function sendVideoAsDocument(
  base: string,
  chatId: string,
  videoBlob: Blob,
  caption: string
): Promise<PublishResult> {
  console.log('[Publisher] Sending video as document (not streamable)');

  const form = new FormData();
  form.append('chat_id', chatId);
  form.append('caption', caption);
  form.append('parse_mode', 'HTML');
  form.append('document', videoBlob, 'video.mp4');

  const result = await callTgForm(base, 'sendDocument', form);
  return { ...result, videoSentAsDocument: result.ok };
}

async function sendVideoUrlAsDocument(
  base: string,
  chatId: string,
  videoUrl: string,
  caption: string
): Promise<PublishResult> {
  console.log('[Publisher] Sending video URL as document fallback (not streamable)');
  const result = await callTgJson(base, 'sendDocument', {
    chat_id: chatId,
    document: videoUrl,
    caption,
    parse_mode: 'HTML',
  });
  return { ...result, videoSentAsDocument: result.ok };
}

// ── Binary media group ────────────────────────────────────────

async function sendBinaryMediaGroup(
  env: Env,
  base: string,
  input: PublishInput,
  types: Array<'image' | 'video'>,
  captions: PreparedCaptions
): Promise<PublishResult> {
  const processedItems = await processMediaBatch(env, input.mediaUrls.map((url, i) => ({
    url,
    type: types[i]!,
    thumbnailUrl: input.thumbnailUrls?.[i],
    telegramFileId: input.telegramFileIds?.[i],
  })));

  // فیلتر آیتم‌های failed. Partial publish عمداً قابل کنترل است، نه یک رفتار پنهان.
  const indexedItems = processedItems.map((p, i) => ({ processed: p, index: i }));
  const validItems = indexedItems.filter(({ processed }) => processed.ok || processed.telegramFileId);
  const failedItems = indexedItems.filter(({ processed }) => !(processed.ok || processed.telegramFileId));
  const failedIndexes = failedItems.map(x => x.index);

  if (validItems.length === 0) {
    return {
      ok: false,
      error: 'All media items failed processing',
      errorType: 'media_error',
      mediaResults: failedItems.map(({ processed, index }) => ({
        mediaIndex: index,
        status: processed.status ?? 'failed',
        error: processed.error,
        thumbnailStatus: processed.thumbnailStatus,
        thumbnailError: processed.thumbnailError,
      })),
    };
  }

  const partialMedia = failedItems.length > 0 ? {
    originalCount: processedItems.length,
    publishedCount: validItems.length,
    failedCount: failedItems.length,
    failedIndexes,
  } : undefined;

  if (partialMedia && !isPartialMediaGroupEnabled(env)) {
    return {
      ok: false,
      error: `media_group_partial_publish_disabled: failed indexes ${failedIndexes.join(',')}`,
      errorType: 'media_error',
      partialMedia,
      mediaResults: buildProcessingOnlyMediaResults(validItems, failedItems),
    };
  }

  const warning = partialMedia
    ? `partial_media_group: ${partialMedia.failedCount}/${partialMedia.originalCount} failed; indexes=${failedIndexes.join(',')}`
    : undefined;
  if (warning) console.warn(`[Publisher] ${warning}`);

  const groupItems = validItems.map(({ processed, index }) => ({
    blob: processed.blob,
    stableUrl: processed.stableUrl,
    telegramFileId: processed.telegramFileId,
    type: types[index]!,
    thumbnailBlob: processed.thumbnailBlob,
  }));

  const { form } = buildMediaGroupForm(input.chatId, groupItems, captions.mediaHtml);
  const mediaResult = await callTgForm(base, 'sendMediaGroup', form);

  if (!mediaResult.ok) return { ...mediaResult, captionError: warning, mediaResults: buildProcessedMediaResults(validItems, failedItems, mediaResult) };

  let captionError: string | undefined = warning;
  if (captions.sendFullFollowUp) {
    const captionResult = await sendTelegramText(base, input.chatId, captions.fullHtml);
    if (!captionResult.ok) {
      captionError = [warning, `caption_send_failed: ${captionResult.error}`].filter(Boolean).join(' | ');
      console.error(`[Publisher] Caption follow-up failed: ${captionResult.error}`);
    }
  }

  return { ...mediaResult, captionError, partialMedia, mediaResults: buildProcessedMediaResults(validItems, failedItems, mediaResult) };
}

// ── Text-only fallback ────────────────────────────────────────

async function sendTextFallback(
  base: string,
  chatId: string,
  html: string
): Promise<PublishResult> {
  return sendTelegramText(base, chatId, html);
}

async function sendTelegramText(
  base: string,
  chatId: string,
  html: string
): Promise<PublishResult> {
  return callTgJson(base, 'sendMessage', {
    chat_id: chatId,
    text: html,
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
  });
}

// ── Telegram API callers ──────────────────────────────────────

async function callTgJson(baseUrl: string, method: string, body: object): Promise<PublishResult> {
  let res: Response;
  try {
    res = await fetch(`${baseUrl}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TG_TEXT_TIMEOUT_MS),
    });
  } catch (err) {
    return {
      ok: false,
      error: `network: ${(err instanceof Error ? err.message : String(err)).slice(0, 200)}`,
      errorType: 'network',
    };
  }
  return parseTgResponse(res);
}

async function callTgForm(baseUrl: string, method: string, form: FormData): Promise<PublishResult> {
  let res: Response;
  try {
    res = await fetch(`${baseUrl}/${method}`, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(TG_UPLOAD_TIMEOUT_MS),
    });
  } catch (err) {
    return {
      ok: false,
      error: `upload_network: ${(err instanceof Error ? err.message : String(err)).slice(0, 200)}`,
      errorType: 'network',
    };
  }
  return parseTgResponse(res);
}

async function parseTgResponse(res: Response): Promise<PublishResult> {
  let data: any;
  try {
    data = await res.json();
  } catch {
    return { ok: false, error: `non_json_response: HTTP ${res.status}`, errorType: 'network' };
  }

  if (!data.ok) {
    const raw = String(data.description ?? 'Telegram API error');
    const safe = raw.replace(/\bbot[A-Za-z0-9_-]{10,}:[A-Za-z0-9_-]{20,}\b/g, 'bot[REDACTED]');

    const retryAfterSec = typeof data.parameters?.retry_after === 'number'
      ? data.parameters.retry_after : undefined;

    let errorType: PublishResult['errorType'] = 'unknown';
    if (data.error_code === 429) errorType = 'rate_limit';
    else if ([401, 403].includes(data.error_code)) errorType = 'auth';
    else if ([400, 404, 410, 413, 422].includes(data.error_code)) {
      errorType = classifyTelegramError(safe, data.error_code);
    }

    if (retryAfterSec) console.warn(`[Publisher] Rate limit — retry_after=${retryAfterSec}s`);

    return { ok: false, error: safe.slice(0, 400), errorType, retryAfterSec };
  }

  const result = data.result;
  const messages = Array.isArray(result) ? result : (result ? [result] : []);
  const allMessageIds: string[] = [];
  const newFileIds: Array<{ mediaIndex: number; fileId: string }> = [];
  messages.forEach((msg: any, i: number) => {
    if (msg?.message_id) allMessageIds.push(String(msg.message_id));
    const fileId = extractTelegramFileId(msg);
    if (fileId) newFileIds.push({ mediaIndex: i, fileId });
  });

  return { ok: true, messageId: allMessageIds[0] ?? '', allMessageIds, newFileIds };
}

// ── Helpers ───────────────────────────────────────────────────

export function prepareTelegramCaptions(input: PublishInput): PreparedCaptions {
  const language = input.language ?? input.channel?.language ?? 'en';

  let fullHtml: string;
  let shortHtml: string;
  let fullTruncated = false;
  let shortTruncated = false;
  let fullFooterIncluded = false;
  let shortFooterIncluded = false;
  let fullFooterOmitted = false;
  let shortFooterOmitted = false;

  if (input.captionFullHtml) {
    fullHtml = input.captionFullHtml;
  } else if (input.channel) {
    const full = formatTelegramMessage({
      body: input.captionFull ?? '',
      sourceUrl: input.sourceUrl,
      language,
      channel: input.channel,
      maxLength: 4096,
    });
    fullHtml = full.html;
    fullTruncated = full.truncated;
    fullFooterIncluded = full.footerIncluded;
    fullFooterOmitted = full.footerOmitted;
  } else {
    fullHtml = safeTruncate(sanitizeCaptionText(input.captionFull ?? ''), 4096);
  }

  const shortSource = input.captionShort || input.captionFull || '';
  if (input.captionShortHtml) {
    shortHtml = input.captionShortHtml;
  } else if (input.channel) {
    const short = formatTelegramMessage({
      body: shortSource,
      sourceUrl: input.sourceUrl,
      language,
      channel: input.channel,
      maxLength: 1024,
    });
    shortHtml = short.html;
    shortTruncated = short.truncated;
    shortFooterIncluded = short.footerIncluded;
    shortFooterOmitted = short.footerOmitted;
  } else {
    shortHtml = safeTruncate(sanitizeCaptionText(shortSource), 1024);
  }

  const mediaHtml = fullHtml.length <= 1024 ? fullHtml : shortHtml;

  return {
    fullHtml,
    shortHtml,
    mediaHtml,
    sendFullFollowUp: fullHtml.length > 1024 && fullHtml !== mediaHtml,
    fullTruncated,
    shortTruncated,
    fullFooterIncluded,
    shortFooterIncluded,
    fullFooterOmitted,
    shortFooterOmitted,
  };
}

function buildDirectMediaGroupPayload(
  mediaUrls: string[],
  mediaTypes: Array<'image' | 'video'>,
  captionHtml: string
): object[] {
  return mediaUrls.map((url, i) => {
    const type = mediaTypes[i] ?? detectMediaType(url);
    const entry: any = {
      type: type === 'video' ? 'video' : 'photo',
      media: url,
      ...(type === 'video' ? { supports_streaming: true } : {}),
    };
    if (i === 0) {
      entry.caption = captionHtml;
      entry.parse_mode = 'HTML';
    }
    return entry;
  });
}

async function withCaptionFollowUp(
  base: string,
  chatId: string,
  result: PublishResult,
  captions: PreparedCaptions
): Promise<PublishResult> {
  if (!result.ok || !captions.sendFullFollowUp) return result;
  const captionResult = await sendTelegramText(base, chatId, captions.fullHtml);
  if (captionResult.ok) return result;
  return {
    ...result,
    captionError: [result.captionError, `caption_send_failed: ${captionResult.error}`]
      .filter(Boolean)
      .join(' | '),
  };
}

function withUrlMediaResult(result: PublishResult, mediaIndex: number, existingFileId?: string): PublishResult {
  if (!result.ok) return result;
  const fileId = existingFileId ?? result.newFileIds?.find(f => f.mediaIndex === 0)?.fileId;
  const messageId = result.allMessageIds?.[0] ?? result.messageId;
  return {
    ...result,
    mediaResults: [{
      mediaIndex,
      status: 'uploaded',
      telegramFileId: fileId,
      telegramMessageId: messageId,
    }],
  };
}

function withSingleMediaResult(
  result: PublishResult,
  mediaIndex: number,
  processed: { status?: any; error?: string; telegramFileId?: string; thumbnailStatus?: any; thumbnailError?: string },
  existingFileId?: string
): PublishResult {
  if (!result.ok) {
    return {
      ...result,
      mediaResults: [{
        mediaIndex,
        status: processingStatusFromError(result.errorType, processed.status),
        error: result.error ?? processed.error,
        thumbnailStatus: processed.thumbnailStatus,
        thumbnailError: processed.thumbnailError,
      }],
    };
  }
  const fileId = existingFileId ?? processed.telegramFileId ?? result.newFileIds?.find(f => f.mediaIndex === 0)?.fileId;
  const messageId = result.allMessageIds?.[0] ?? result.messageId;
  return {
    ...result,
    mediaResults: [{
      mediaIndex,
      status: 'uploaded',
      error: processed.error,
      telegramFileId: fileId,
      telegramMessageId: messageId,
      thumbnailStatus: processed.thumbnailStatus,
      thumbnailError: processed.thumbnailError,
    }],
  };
}

function buildDirectMediaResults(result: PublishResult, count: number): PublishedMediaResult[] | undefined {
  if (!result.ok) return undefined;
  return Array.from({ length: count }, (_, i) => ({
    mediaIndex: i,
    status: 'uploaded' as const,
    telegramFileId: result.newFileIds?.find(f => f.mediaIndex === i)?.fileId,
    telegramMessageId: result.allMessageIds?.[i],
  }));
}

function buildProcessingOnlyMediaResults(
  validItems: Array<{ processed: any; index: number }>,
  failedItems: Array<{ processed: any; index: number }>
): PublishedMediaResult[] {
  const ready = validItems.map(({ processed, index }) => ({
    mediaIndex: index,
    status: processed.status ?? 'ready' as const,
    error: processed.error,
    telegramFileId: processed.telegramFileId,
    thumbnailStatus: processed.thumbnailStatus,
    thumbnailError: processed.thumbnailError,
  }));
  const failed = failedItems.map(({ processed, index }) => ({
    mediaIndex: index,
    status: processed.status ?? 'failed' as const,
    error: processed.error,
    telegramFileId: processed.telegramFileId,
    thumbnailStatus: processed.thumbnailStatus,
    thumbnailError: processed.thumbnailError,
  }));
  return [...ready, ...failed].sort((a, b) => a.mediaIndex - b.mediaIndex);
}

function buildProcessedMediaResults(
  validItems: Array<{ processed: any; index: number }>,
  failedItems: Array<{ processed: any; index: number }>,
  publishResult: PublishResult
): PublishedMediaResult[] {
  const sent = validItems.map(({ processed, index }, sentIndex) => ({
    mediaIndex: index,
    status: publishResult.ok ? 'uploaded' as const : processingStatusFromError(publishResult.errorType, processed.status),
    error: publishResult.ok ? processed.error : (publishResult.error ?? processed.error),
    telegramFileId: processed.telegramFileId ?? publishResult.newFileIds?.find(f => f.mediaIndex === sentIndex)?.fileId,
    telegramMessageId: publishResult.allMessageIds?.[sentIndex],
    thumbnailStatus: processed.thumbnailStatus,
    thumbnailError: processed.thumbnailError,
  }));
  const failed = failedItems.map(({ processed, index }) => ({
    mediaIndex: index,
    status: processed.status ?? 'failed' as const,
    error: processed.error,
    telegramFileId: processed.telegramFileId,
    thumbnailStatus: processed.thumbnailStatus,
    thumbnailError: processed.thumbnailError,
  }));
  return [...sent, ...failed].sort((a, b) => a.mediaIndex - b.mediaIndex);
}

function processingStatusFromError(errorType: PublishResult['errorType'], fallback: any): PublishedMediaResult['status'] {
  if (errorType === 'file_too_large') return 'too_large';
  if (errorType === 'expired_url') return 'expired';
  if (errorType === 'invalid_format' || errorType === 'media_error') return 'unsupported';
  return fallback ?? 'failed';
}

function extractTelegramFileId(msg: any): string | undefined {
  if (!msg || typeof msg !== 'object') return undefined;
  if (Array.isArray(msg.photo) && msg.photo.length > 0) {
    const largest = msg.photo[msg.photo.length - 1];
    return typeof largest?.file_id === 'string' ? largest.file_id : undefined;
  }
  if (typeof msg.video?.file_id === 'string') return msg.video.file_id;
  if (typeof msg.document?.file_id === 'string') return msg.document.file_id;
  if (typeof msg.animation?.file_id === 'string') return msg.animation.file_id;
  return undefined;
}

function isTelegramMediaFallbackError(errorType: PublishResult['errorType']): boolean {
  return errorType === 'media_error' ||
    errorType === 'invalid_format' ||
    errorType === 'file_too_large' ||
    errorType === 'expired_url';
}

function classifyTelegramError(description: string, errorCode: number): PublishResult['errorType'] {
  const text = description.toLowerCase();

  if (errorCode === 413 || text.includes('too large') || text.includes('file is too big') || text.includes('request entity too large')) {
    return 'file_too_large';
  }
  if (text.includes('expired') || text.includes('not found') || text.includes('failed to get') || text.includes('wrong file identifier') || text.includes('url host is empty')) {
    return 'expired_url';
  }
  if (text.includes('wrong type') || text.includes('invalid file') || text.includes('unsupported') || text.includes('codec') || text.includes('format')) {
    return 'invalid_format';
  }
  if (text.includes('video') || text.includes('media') || text.includes('file') || text.includes('photo') || text.includes('document')) {
    return 'media_error';
  }
  return 'unknown';
}

