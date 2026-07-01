import { describe, expect, it } from 'vitest';
import { getPreAiContentRejectReason } from '../apps/worker-api/src/services/content-policy';

const cryptoCategory = {
  id: 'crypto',
  allow_replies: 0,
  allow_retweets: 1,
  allow_quotes: 1,
  text_only_policy: 'penalize',
  media_mode: 'optional',
} as any;

function item(overrides: Partial<any>) {
  return {
    sourceUrl: 'https://x.com/example/status/1',
    postId: '1',
    platform: 'x',
    sourceAccount: 'Example',
    publishedAt: Math.floor(Date.now() / 1000),
    text: '',
    media: [],
    engagementLikes: 0,
    engagementShares: 0,
    engagementViews: 0,
    isReply: false,
    isRetweet: false,
    isQuote: false,
    ...overrides,
  } as any;
}

describe('crypto pre-AI content gate', () => {
  it('rejects empty text before Claude', () => {
    expect(getPreAiContentRejectReason(item({
      sourceAccount: 'CoinDesk',
      text: '',
    }), cryptoCategory)).toBe('pre_ai_empty_text');
  });

  it('allows broad AI, security, geopolitics, stock, and market commentary to reach Claude scoring', () => {
    const cases = [
      {
        sourceAccount: 'DecryptMedia',
        text: 'Microsoft President Asks Graduates to Stop Fearing AI and Start Adapting',
      },
      {
        sourceAccount: 'SlowMist_Team',
        text: 'Shai-Hulud Hades malware spreads through malicious PyPI packages and injects .pth files.',
      },
      {
        sourceAccount: 'DefiLlama',
        text: 'The second half of 2026 saw around 70 cyberattacks and lower total losses than previous peaks.',
      },
      {
        sourceAccount: 'WatcherGuru',
        text: "Iran says the Strait of Hormuz is still closed despite President Trump's claims.",
      },
      {
        sourceAccount: 'WatcherGuru',
        text: 'JUST IN: $1.15 trillion added to the US stock market today.',
      },
      {
        sourceAccount: 'Cointelegraph',
        text: 'BTC 80K or 50K? Which are you watching?',
      },
      {
        sourceAccount: 'glassnode',
        text: 'Bitcoin options data gives a broader view of market sentiment and what traders may expect next.',
      },
    ];

    for (const row of cases) {
      expect(getPreAiContentRejectReason(item(row), cryptoCategory), row.text).toBeNull();
    }
  });

  it('allows mixed-domain stories to reach Claude whether the crypto connection is explicit or ambiguous', () => {
    const cases = [
      {
        sourceAccount: 'DecryptMedia',
        text: 'Coinbase launches tool for AI agents to trade crypto and make stablecoin payments',
      },
      {
        sourceAccount: 'DecryptMedia',
        text: 'OpenAI-linked tokenized equity products are expanding across crypto trading venues.',
      },
      {
        sourceAccount: 'SlowMist_Team',
        text: 'A GitHub supply-chain attack targeted developers and may affect wallet infrastructure.',
      },
      {
        sourceAccount: 'Pentosh1',
        text: 'Iran tensions pushed Bitcoin lower as oil and crypto liquidity concerns hit risk assets.',
      },
      {
        sourceAccount: 'DecryptMedia',
        text: "Crypto platforms broaden access to Elon Musk's SpaceX through tokenized equity and RWA rails",
      },
    ];

    for (const row of cases) {
      expect(getPreAiContentRejectReason(item(row), cryptoCategory), row.text).toBeNull();
    }
  });

  it('rejects whale-alert unknown-to-unknown spam before Claude', () => {
    expect(getPreAiContentRejectReason(item({
      sourceAccount: 'whale_alert',
      text: '314,843,159 USDC transferred from unknown wallet to unknown wallet',
    }), cryptoCategory)).toBe('pre_ai_whale_unknown_to_unknown');
  });

  it('allows only high-signal whale alert events before Claude', () => {
    expect(getPreAiContentRejectReason(item({
      sourceAccount: 'whale_alert',
      text: '250,000,000 USDC minted at USDC Treasury',
    }), cryptoCategory)).toBeNull();

    expect(getPreAiContentRejectReason(item({
      sourceAccount: 'whale_alert',
      text: '236,000,000 USDT transferred from unknown wallet to Bitfinex',
    }), cryptoCategory)).toBeNull();

    expect(getPreAiContentRejectReason(item({
      sourceAccount: 'whale_alert',
      text: '83,000 ETH (136,700,000 USD) transferred from unknown wallet to Kraken',
    }), cryptoCategory)).toBeNull();

    expect(getPreAiContentRejectReason(item({
      sourceAccount: 'whale_alert',
      text: '135,000,000 USDC transferred from unknown wallet to Aave',
    }), cryptoCategory)).toBeNull();
  });

  it('rejects low-signal or repetitive whale alert events before Claude', () => {
    expect(getPreAiContentRejectReason(item({
      sourceAccount: 'whale_alert',
      text: '1,300 BTC (87,000,000 USD) transferred from Coinbase Institutional to unknown wallet',
    }), cryptoCategory)).toBe('pre_ai_whale_institution_to_unknown');

    expect(getPreAiContentRejectReason(item({
      sourceAccount: 'whale_alert',
      text: '809 BTC (50,700,000 USD) transferred from unknown wallet to Binance',
    }), cryptoCategory)).toBe('pre_ai_whale_low_signal');

    expect(getPreAiContentRejectReason(item({
      sourceAccount: 'whale_alert',
      text: '52,000,000 USD of BTC transferred from Coinbase Institutional to unknown wallet',
    }), cryptoCategory)).toBe('pre_ai_whale_institution_to_unknown');
  });
});
