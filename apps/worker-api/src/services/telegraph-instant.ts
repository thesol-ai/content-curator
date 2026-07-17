export type TelegraphNode =
  | string
  | {
      tag: string;
      attrs?: Record<string, string>;
      children?: TelegraphNode[];
    };

export interface TelegraphArticleDraft {
  eligible: boolean;
  reason:
    | 'eligible'
    | 'empty_full_caption'
    | 'same_short_and_full'
    | 'missing_title'
    | 'single_body_paragraph';
  title: string;
  bodyParagraphs: string[];
  bodyParagraphCount: number;
  sourceUrl: string | null;
  content: TelegraphNode[];
}

export interface TelegraphPage {
  path: string;
  url: string;
  title: string;
  description?: string;
  views?: number;
}

export interface TelegraphCreateOptions {
  accessToken: string;
  title: string;
  content: TelegraphNode[];
  authorName?: string;
  authorUrl?: string;
  timeoutMs?: number;
}

function normalizeCaption(value: unknown): string {
  return String(value ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function splitCaptionBlocks(value: unknown): string[] {
  const normalized = normalizeCaption(value);

  if (!normalized) {
    return [];
  }

  return normalized
    .split(/\n\s*\n/u)
    .map(block => block.trim())
    .filter(Boolean);
}

function truncateUnicode(
  value: string,
  maxCharacters: number,
): string {
  return Array.from(value)
    .slice(0, maxCharacters)
    .join('')
    .trim();
}

function validHttpUrl(value: unknown): string | null {
  const raw = String(value ?? '').trim();

  if (!raw) {
    return null;
  }

  try {
    const url = new URL(raw);

    if (
      url.protocol !== 'https:'
      && url.protocol !== 'http:'
    ) {
      return null;
    }

    return url.toString();
  } catch {
    return null;
  }
}

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function buildTelegraphArticleDraft(
  captionShort: unknown,
  captionFull: unknown,
  sourceUrl: unknown,
): TelegraphArticleDraft {
  const normalizedShort =
    normalizeCaption(captionShort);

  const normalizedFull =
    normalizeCaption(captionFull);

  if (!normalizedFull) {
    return {
      eligible: false,
      reason: 'empty_full_caption',
      title: '',
      bodyParagraphs: [],
      bodyParagraphCount: 0,
      sourceUrl: validHttpUrl(sourceUrl),
      content: [],
    };
  }

  if (
    normalizedShort
    && normalizedShort === normalizedFull
  ) {
    return {
      eligible: false,
      reason: 'same_short_and_full',
      title: '',
      bodyParagraphs: [],
      bodyParagraphCount: 0,
      sourceUrl: validHttpUrl(sourceUrl),
      content: [],
    };
  }

  const blocks =
    splitCaptionBlocks(normalizedFull);

  const title =
    truncateUnicode(
      blocks[0] ?? '',
      256,
    );

  if (!title) {
    return {
      eligible: false,
      reason: 'missing_title',
      title: '',
      bodyParagraphs: [],
      bodyParagraphCount: 0,
      sourceUrl: validHttpUrl(sourceUrl),
      content: [],
    };
  }

  const bodyParagraphs =
    blocks
      .slice(1)
      .map(paragraph => paragraph.trim())
      .filter(Boolean);

  const normalizedSourceUrl =
    validHttpUrl(sourceUrl);

  const content: TelegraphNode[] =
    bodyParagraphs.map(paragraph => ({
      tag: 'p',
      children: [paragraph],
    }));

  if (normalizedSourceUrl) {
    content.push(
      {
        tag: 'hr',
      },
      {
        tag: 'p',
        children: [
          {
            tag: 'a',
            attrs: {
              href: normalizedSourceUrl,
            },
            children: [
              'مشاهده منبع اصلی',
            ],
          },
        ],
      },
    );
  }

  if (bodyParagraphs.length <= 1) {
    return {
      eligible: false,
      reason: 'single_body_paragraph',
      title,
      bodyParagraphs,
      bodyParagraphCount:
        bodyParagraphs.length,
      sourceUrl: normalizedSourceUrl,
      content,
    };
  }

  return {
    eligible: true,
    reason: 'eligible',
    title,
    bodyParagraphs,
    bodyParagraphCount:
      bodyParagraphs.length,
    sourceUrl: normalizedSourceUrl,
    content,
  };
}

export function buildLinkedTelegramCaptionHtml(
  captionShort: unknown,
  telegraphUrl: unknown,
): string {
  const shortCaption =
    normalizeCaption(captionShort);

  const safeUrl =
    validHttpUrl(telegraphUrl);

  if (!shortCaption) {
    throw new Error(
      'caption_short_required',
    );
  }

  if (!safeUrl) {
    throw new Error(
      'valid_telegraph_url_required',
    );
  }

  return [
    escapeHtml(shortCaption),
    '',
    `<a href="${escapeHtml(safeUrl)}">خبر کامل</a>`,
  ].join('\n');
}

export async function createTelegraphPage(
  options: TelegraphCreateOptions,
): Promise<TelegraphPage> {
  const accessToken =
    String(options.accessToken ?? '')
      .trim();

  if (!accessToken) {
    throw new Error(
      'telegraph_access_token_missing',
    );
  }

  const title =
    truncateUnicode(
      options.title,
      256,
    );

  if (!title) {
    throw new Error(
      'telegraph_title_missing',
    );
  }

  if (
    !Array.isArray(options.content)
    || options.content.length === 0
  ) {
    throw new Error(
      'telegraph_content_missing',
    );
  }

  const body =
    new URLSearchParams();

  body.set(
    'access_token',
    accessToken,
  );

  body.set(
    'title',
    title,
  );

  body.set(
    'content',
    JSON.stringify(
      options.content,
    ),
  );

  body.set(
    'return_content',
    'false',
  );

  const authorName =
    String(options.authorName ?? '')
      .trim();

  const authorUrl =
    validHttpUrl(
      options.authorUrl,
    );

  if (authorName) {
    body.set(
      'author_name',
      truncateUnicode(
        authorName,
        128,
      ),
    );
  }

  if (authorUrl) {
    body.set(
      'author_url',
      authorUrl,
    );
  }

  const response =
    await fetch(
      'https://api.telegra.ph/createPage',
      {
        method: 'POST',
        headers: {
          'Content-Type':
            'application/x-www-form-urlencoded;charset=UTF-8',
        },
        body,
        signal:
          AbortSignal.timeout(
            options.timeoutMs ?? 12_000,
          ),
      },
    );

  const payload =
    await response.json()
      .catch(() => null) as {
        ok?: boolean;
        result?: TelegraphPage;
        error?: string;
      } | null;

  if (
    !response.ok
    || !payload?.ok
    || !payload.result?.url
  ) {
    const error =
      String(
        payload?.error
        ?? `HTTP_${response.status}`,
      )
        .slice(0, 200);

    throw new Error(
      `telegraph_create_failed:${error}`,
    );
  }

  return payload.result;
}
