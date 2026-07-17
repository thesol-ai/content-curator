import {
  buildLinkedTelegramCaptionHtml,
  buildTelegraphArticleDraft,
  createTelegraphPage,
} from './services/telegraph-instant';

interface PreviewEnv {
  DB: D1Database;
  TELEGRAPH_ACCESS_TOKEN?: string;
  TELEGRAPH_PREVIEW_SECRET?: string;
  TELEGRAPH_INSTANT_ENABLED?: string;
  TELEGRAPH_AUTHOR_NAME?: string;
  TELEGRAPH_AUTHOR_URL?: string;
  TELEGRAPH_TEST_CHAT_ID?: string;
}

interface PublishedQueueRow {
  id: string;
  item_id: string;
  channel_id: string;
  language: string;
  status: string;
  telegram_method: string;
  telegram_message_id: string;
  caption_short: string | null;
  caption_full: string | null;
  source_url: string;
  published_at: number | null;
}

function json(
  value: unknown,
  status = 200,
): Response {
  return Response.json(
    value,
    {
      status,
      headers: {
        'Cache-Control': 'no-store',
        'X-Robots-Tag': 'noindex, nofollow',
      },
    },
  );
}

function isEnabled(
  value: unknown,
): boolean {
  return String(value ?? '')
    .trim()
    .toLowerCase() === 'true';
}

function authorized(
  request: Request,
  env: PreviewEnv,
): boolean {
  const expected =
    String(
      env.TELEGRAPH_PREVIEW_SECRET
      ?? '',
    ).trim();

  const supplied =
    String(
      request.headers.get(
        'x-preview-secret',
      )
      ?? '',
    ).trim();

  return Boolean(
    expected
    && supplied
    && expected === supplied,
  );
}

function parseRoute(
  pathname: string,
): {
  action: 'preview' | 'create';
  messageId: string;
} | null {
  const match =
    /^\/v1\/telegram\/(\d{1,20})\/(preview|create)$/u
      .exec(pathname);

  if (!match) {
    return null;
  }

  return {
    messageId: match[1]!,
    action:
      match[2] as
        | 'preview'
        | 'create',
  };
}

async function loadPublishedPost(
  env: PreviewEnv,
  messageId: string,
): Promise<PublishedQueueRow | null> {
  return env.DB
    .prepare(`
      SELECT
        id,
        item_id,
        channel_id,
        language,
        status,
        telegram_method,
        telegram_message_id,
        caption_short,
        caption_full,
        source_url,
        published_at
      FROM publish_queue
      WHERE CAST(
        telegram_message_id
        AS TEXT
      ) = ?
        AND status = 'published'
      ORDER BY published_at DESC
      LIMIT 1
    `)
    .bind(messageId)
    .first<PublishedQueueRow>();
}

async function handlePreview(
  env: PreviewEnv,
  row: PublishedQueueRow,
): Promise<Response> {
  const draft =
    buildTelegraphArticleDraft(
      row.caption_short,
      row.caption_full,
      row.source_url,
    );

  console.log(
    '[TelegraphPreview]',
    JSON.stringify({
      action: 'preview',
      queueId: row.id,
      telegramMessageId:
        row.telegram_message_id,
      eligible: draft.eligible,
      reason: draft.reason,
      bodyParagraphCount:
        draft.bodyParagraphCount,
      fullChars:
        String(
          row.caption_full
          ?? '',
        ).length,
      shortChars:
        String(
          row.caption_short
          ?? '',
        ).length,
    }),
  );

  return json({
    ok: true,
    mode: 'read_only_preview',
    featureEnabled:
      isEnabled(
        env.TELEGRAPH_INSTANT_ENABLED,
      ),
    telegram: {
      chatId:
        env.TELEGRAPH_TEST_CHAT_ID
        ?? '@thesolcrypto_fa',
      messageId:
        row.telegram_message_id,
      method:
        row.telegram_method,
    },
    queue: {
      id: row.id,
      itemId: row.item_id,
      channelId: row.channel_id,
      status: row.status,
    },
    decision: {
      eligible: draft.eligible,
      reason: draft.reason,
      title: draft.title,
      bodyParagraphCount:
        draft.bodyParagraphCount,
    },
    article: {
      title: draft.title,
      paragraphs:
        draft.bodyParagraphs,
      sourceUrl:
        draft.sourceUrl,
      telegraphContent:
        draft.content,
    },
    caption: {
      short:
        row.caption_short ?? '',
      full:
        row.caption_full ?? '',
      proposedHtmlTemplate:
        draft.eligible
          ? buildLinkedTelegramCaptionHtml(
              row.caption_short,
              'https://telegra.ph/PLACEHOLDER',
            )
          : null,
    },
    sideEffects: {
      d1Write: false,
      telegramEdit: false,
      telegraphPageCreated: false,
      publisherCalled: false,
    },
  });
}

async function handleCreate(
  env: PreviewEnv,
  row: PublishedQueueRow,
): Promise<Response> {
  if (
    !isEnabled(
      env.TELEGRAPH_INSTANT_ENABLED,
    )
  ) {
    return json(
      {
        ok: false,
        error:
          'telegraph_feature_disabled',
      },
      409,
    );
  }

  const draft =
    buildTelegraphArticleDraft(
      row.caption_short,
      row.caption_full,
      row.source_url,
    );

  if (!draft.eligible) {
    return json(
      {
        ok: false,
        error:
          'article_not_eligible',
        reason:
          draft.reason,
        bodyParagraphCount:
          draft.bodyParagraphCount,
      },
      409,
    );
  }

  const page =
    await createTelegraphPage({
      accessToken:
        env.TELEGRAPH_ACCESS_TOKEN
        ?? '',
      title:
        draft.title,
      content:
        draft.content,
      authorName:
        env.TELEGRAPH_AUTHOR_NAME
        ?? 'The Sol Crypto FA',
      authorUrl:
        env.TELEGRAPH_AUTHOR_URL
        ?? 'https://t.me/thesolcrypto_fa',
    });

  const captionHtml =
    buildLinkedTelegramCaptionHtml(
      row.caption_short,
      page.url,
    );

  console.log(
    '[TelegraphPreview]',
    JSON.stringify({
      action: 'create',
      queueId: row.id,
      telegramMessageId:
        row.telegram_message_id,
      eligible: true,
      telegraphPath:
        page.path,
      telegraphUrl:
        page.url,
      telegramEdited: false,
      d1Written: false,
    }),
  );

  return json({
    ok: true,
    mode:
      'telegraph_created_without_telegram_edit',
    telegraph: {
      path:
        page.path,
      url:
        page.url,
      title:
        page.title,
    },
    telegramEditPreview: {
      method:
        'editMessageCaption',
      chatId:
        env.TELEGRAPH_TEST_CHAT_ID
        ?? '@thesolcrypto_fa',
      messageId:
        row.telegram_message_id,
      parseMode:
        'HTML',
      captionHtml,
    },
    sideEffects: {
      d1Write: false,
      telegramEdit: false,
      telegraphPageCreated: true,
      publisherCalled: false,
    },
  });
}

export default {
  async fetch(
    request: Request,
    env: PreviewEnv,
  ): Promise<Response> {
    const url =
      new URL(
        request.url,
      );

    if (
      url.pathname === '/health'
      && request.method === 'GET'
    ) {
      return json({
        ok: true,
        service:
          'telegraph-preview',
        featureEnabled:
          isEnabled(
            env.TELEGRAPH_INSTANT_ENABLED,
          ),
      });
    }

    if (
      !authorized(
        request,
        env,
      )
    ) {
      return json(
        {
          ok: false,
          error: 'unauthorized',
        },
        401,
      );
    }

    const route =
      parseRoute(
        url.pathname,
      );

    if (!route) {
      return json(
        {
          ok: false,
          error: 'not_found',
        },
        404,
      );
    }

    if (
      route.action === 'preview'
      && request.method !== 'GET'
    ) {
      return json(
        {
          ok: false,
          error:
            'method_not_allowed',
        },
        405,
      );
    }

    if (
      route.action === 'create'
      && request.method !== 'POST'
    ) {
      return json(
        {
          ok: false,
          error:
            'method_not_allowed',
        },
        405,
      );
    }

    const row =
      await loadPublishedPost(
        env,
        route.messageId,
      );

    if (!row) {
      return json(
        {
          ok: false,
          error:
            'published_post_not_found',
          telegramMessageId:
            route.messageId,
        },
        404,
      );
    }

    try {
      if (
        route.action === 'preview'
      ) {
        return handlePreview(
          env,
          row,
        );
      }

      return handleCreate(
        env,
        row,
      );
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : String(error);

      console.error(
        '[TelegraphPreview]',
        JSON.stringify({
          action:
            route.action,
          telegramMessageId:
            route.messageId,
          error:
            message.slice(
              0,
              300,
            ),
        }),
      );

      return json(
        {
          ok: false,
          error:
            message.slice(
              0,
              300,
            ),
          sideEffects: {
            d1Write: false,
            telegramEdit: false,
            publisherCalled: false,
          },
        },
        502,
      );
    }
  },
};
