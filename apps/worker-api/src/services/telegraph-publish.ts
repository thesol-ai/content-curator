import type { Env } from '../types';
import type { PublishInput } from './telegram-publisher';
import {
  buildTelegraphArticleDraft,
  createTelegraphPage,
} from './telegraph-instant';
import {
  buildSourceLink,
  escapeHtml,
  formatTelegramMessage,
  resolveChannelFooter,
} from './telegram-message-formatter';

export type TelegraphPublishReason =
  | 'created'
  | 'disabled'
  | 'retry'
  | 'text_only'
  | 'no_media'
  | 'channel_missing'
  | 'channel_not_allowed'
  | 'short_caption_missing'
  | 'source_missing'
  | 'token_missing'
  | 'ineligible'
  | 'create_failed';

export interface TelegraphPublishContext {
  channelId: string;
  retryCount: number;
}

export interface TelegraphPublishPreparation {
  input: PublishInput;
  applied: boolean;
  reason: TelegraphPublishReason;
  pageUrl?: string;
  detail?: string;
}

function isEnabled(value: unknown): boolean {
  return String(value ?? '')
    .trim()
    .toLowerCase() === 'true';
}

function parseAllowlist(value: unknown): Set<string> {
  return new Set(
    String(value ?? '')
      .split(',')
      .map(item => item.trim())
      .filter(Boolean),
  );
}

function resolveTimeout(value: unknown): number {
  const parsed = Number(value);

  if (!Number.isFinite(parsed)) {
    return 5_000;
  }

  return Math.max(
    1_000,
    Math.min(
      8_000,
      Math.floor(parsed),
    ),
  );
}

function errorDetail(error: unknown): string {
  return (
    error instanceof Error
      ? error.message
      : String(error)
  )
    .replace(
      /[A-Za-z0-9_-]{8,}:[A-Za-z0-9_-]{20,}/g,
      '[REDACTED]',
    )
    .slice(0, 180);
}

export async function prepareTelegraphPublishInput(
  env: Env,
  input: PublishInput,
  context: TelegraphPublishContext,
): Promise<TelegraphPublishPreparation> {
  const original = (): TelegraphPublishPreparation => ({
    input,
    applied: false,
    reason: 'disabled',
  });

  if (!isEnabled(env.TELEGRAPH_INSTANT_ENABLED)) {
    return original();
  }

  if (context.retryCount > 0) {
    return {
      input,
      applied: false,
      reason: 'retry',
    };
  }

  if (input.method === 'sendMessage') {
    return {
      input,
      applied: false,
      reason: 'text_only',
    };
  }

  if (!input.mediaUrls?.length) {
    return {
      input,
      applied: false,
      reason: 'no_media',
    };
  }

  if (!input.channel) {
    return {
      input,
      applied: false,
      reason: 'channel_missing',
    };
  }

  const allowlist = parseAllowlist(
    env.TELEGRAPH_INSTANT_CHANNEL_ALLOWLIST,
  );

  if (
    allowlist.size === 0
    || !allowlist.has(context.channelId)
  ) {
    return {
      input,
      applied: false,
      reason: 'channel_not_allowed',
    };
  }

  const shortCaption =
    String(input.captionShort ?? '').trim();

  if (!shortCaption) {
    return {
      input,
      applied: false,
      reason: 'short_caption_missing',
    };
  }

  const draft = buildTelegraphArticleDraft(
    input.captionShort,
    input.captionFull,
    input.sourceUrl,
  );

  if (!draft.eligible) {
    return {
      input,
      applied: false,
      reason: 'ineligible',
      detail: draft.reason,
    };
  }

  if (!draft.sourceUrl) {
    return {
      input,
      applied: false,
      reason: 'source_missing',
    };
  }

  const accessToken =
    String(
      env.TELEGRAPH_ACCESS_TOKEN ?? '',
    ).trim();

  if (!accessToken) {
    return {
      input,
      applied: false,
      reason: 'token_missing',
    };
  }

  try {
    const page = await createTelegraphPage({
      accessToken,
      title: draft.title,
      content: draft.content,
      authorName:
        String(
          env.TELEGRAPH_INSTANT_AUTHOR_NAME
            ?? '',
        ).trim() || undefined,
      authorUrl:
        String(
          env.TELEGRAPH_INSTANT_AUTHOR_URL
            ?? '',
        ).trim() || undefined,
      timeoutMs: resolveTimeout(
        env.TELEGRAPH_INSTANT_TIMEOUT_MS,
      ),
    });

    const linkLabel =
      String(
        env.TELEGRAPH_INSTANT_LINK_LABEL
          ?? '',
      ).trim() || '📖 ادامه مطلب';

    const sourceLink =
      buildSourceLink(
        linkLabel,
        page.url,
      );

    if (!sourceLink) {
      throw new Error(
        'telegraph_page_url_invalid',
      );
    }

    // Telegraph posts have their own exact layout:
    //
    // body
    // 📖 ادامه مطلب
    //
    // @channel
    //
    // The ordinary formatter remains unchanged.
    const bodyOnlyChannel = {
      ...input.channel,
      source_enabled: 0,
      signature_enabled: 0,
      channel_id_footer_enabled: 0,
    };

    const channelFooter =
      resolveChannelFooter(
        input.channel,
      );

    const footerHtml =
      channelFooter
        ? `${sourceLink}

${escapeHtml(channelFooter)}`
        : sourceLink;

    // One blank line between the body and the link.
    // Two newlines between link and channel ID.
    const bodyMaxLength =
      Math.max(
        1,
        1024 - footerHtml.length - 2,
      );

    const bodyHtml =
      formatTelegramMessage({
        body: shortCaption,
        sourceUrl: '',
        language:
          input.language
          ?? input.channel.language
          ?? 'en',
        channel: bodyOnlyChannel,
        maxLength: bodyMaxLength,
      }).html;

    const instantCaptionHtml =
      `${bodyHtml}\n\n${footerHtml}`;

    return {
      input: {
        ...input,

        // Keep both equal so the existing publisher
        // cannot send a second full-caption message.
        captionShort: shortCaption,
        captionFull: shortCaption,

        sourceUrl: page.url,

        // Exact Telegraph-only caption layout.
        captionShortHtml:
          instantCaptionHtml,
        captionFullHtml:
          instantCaptionHtml,
      },
      applied: true,
      reason: 'created',
      pageUrl: page.url,
    };
  } catch (error) {
    return {
      input,
      applied: false,
      reason: 'create_failed',
      detail: errorDetail(error),
    };
  }
}
