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
  it('rejects generic AI news before Claude', () => {
    expect(getPreAiContentRejectReason(item({
      sourceAccount: 'DecryptMedia',
      text: 'Microsoft President Asks Graduates to Stop Fearing AI and Start Adapting',
    }), cryptoCategory)).toBe('pre_ai_generic_ai_news');

    expect(getPreAiContentRejectReason(item({
      sourceAccount: 'DecryptMedia',
      text: 'OpenAI Wants a Price War With Anthropic',
    }), cryptoCategory)).toBe('pre_ai_generic_ai_news');
  });

  it('allows AI items with a clear crypto connection', () => {
    expect(getPreAiContentRejectReason(item({
      sourceAccount: 'DecryptMedia',
      text: 'Coinbase launches tool for AI agents to trade crypto and make stablecoin payments',
    }), cryptoCategory)).toBeNull();
  });

  it('rejects generic software supply-chain security even from crypto security accounts', () => {
    expect(getPreAiContentRejectReason(item({
      sourceAccount: 'SlowMist_Team',
      text: 'Shai-Hulud Hades malware spreads through malicious PyPI packages like openai_mcp-2.41.2 and bramin-0.0.4, injects .pth files, and continues execution when Bun is detected.',
    }), cryptoCategory)).toBe('pre_ai_generic_software_security');
  });

  it('allows security incidents only when explicitly connected to crypto assets, wallets, protocols, or on-chain funds', () => {
    expect(getPreAiContentRejectReason(item({
      sourceAccount: 'SlowMist_Team',
      text: 'A DeFi protocol exploit on Ethereum drained user wallets and moved stolen funds on-chain through a crypto bridge.',
    }), cryptoCategory)).toBeNull();
  });

  it('rejects generic cyberattack statistics without explicit crypto-security impact even from DefiLlama', () => {
    expect(getPreAiContentRejectReason(item({
      sourceAccount: 'DefiLlama',
      text: 'The second half of 2026 saw around 70 cyberattacks, the highest number of attacks in a quarter. Despite attacks doubling, total losses were below previous peaks.',
    }), cryptoCategory)).toBe('pre_ai_generic_software_security');
  });

  it('strictly rejects broad non-crypto news domains even from crypto-native accounts', () => {
    const cases = [
      {
        sourceAccount: 'DefiLlama',
        text: 'A major cloud outage affected API availability for thousands of developers worldwide.',
      },
      {
        sourceAccount: 'SlowMist_Team',
        text: 'A ransomware campaign targeted hospitals and public agencies after a data breach.',
      },
      {
        sourceAccount: 'DecryptMedia',
        text: 'OpenAI released a new model for coding and general productivity tasks.',
      },
      {
        sourceAccount: 'CoinDesk',
        text: 'SpaceX is reportedly preparing a new tender offer at a higher valuation.',
      },
      {
        sourceAccount: 'WatcherGuru',
        text: 'Tesla shares climbed after strong quarterly vehicle delivery numbers.',
      },
      {
        sourceAccount: 'Cointelegraph',
        text: 'A celebrity lawsuit drew attention after new court documents were released.',
      },
      {
        sourceAccount: 'TheBlock__',
        text: 'A national election poll showed a shift in voter sentiment.',
      },
      {
        sourceAccount: 'DefiLlama',
        text: 'The second half of 2026 saw around 70 cyberattacks and lower total losses than previous peaks.',
      },
    ];

    for (const row of cases) {
      expect(getPreAiContentRejectReason(item(row), cryptoCategory), row.text).not.toBeNull();
    }
  });

  it('does not allow source reputation to replace explicit crypto relevance', () => {
    expect(getPreAiContentRejectReason(item({
      sourceAccount: 'SlowMist_Team',
      text: 'Researchers found malicious Python packages using .pth injection and Bun runtime checks.',
    }), cryptoCategory)).not.toBeNull();

    expect(getPreAiContentRejectReason(item({
      sourceAccount: 'DefiLlama',
      text: 'A weekly cybersecurity report counted dozens of attacks but did not mention digital assets.',
    }), cryptoCategory)).not.toBeNull();

    expect(getPreAiContentRejectReason(item({
      sourceAccount: 'DecryptMedia',
      text: 'A gaming company announced layoffs after weaker quarterly revenue.',
    }), cryptoCategory)).not.toBeNull();
  });

  it('allows mixed-domain stories only when the crypto connection is explicit in the source text', () => {
    expect(getPreAiContentRejectReason(item({
      sourceAccount: 'DecryptMedia',
      text: 'GameStop extended support for Bitcoin payments across selected online purchases.',
    }), cryptoCategory)).toBeNull();

    expect(getPreAiContentRejectReason(item({
      sourceAccount: 'DecryptMedia',
      text: 'Crypto platforms cancelled a tokenized SpaceX equity product tied to RWA markets.',
    }), cryptoCategory)).toBeNull();

    expect(getPreAiContentRejectReason(item({
      sourceAccount: 'SlowMist_Team',
      text: 'A DeFi protocol exploit drained on-chain funds from user wallets through a bridge attack.',
    }), cryptoCategory)).toBeNull();
  });


  it('rejects generic equity, SpaceX, and stock-market items without crypto rails', () => {
    expect(getPreAiContentRejectReason(item({
      sourceAccount: 'WatcherGuru',
      text: 'JUST IN: $1.15 trillion added to the US stock market today.',
    }), cryptoCategory)).toBe('pre_ai_generic_equity_or_spacex');

    expect(getPreAiContentRejectReason(item({
      sourceAccount: 'WatcherGuru',
      text: "JUST IN: Elon Musk's SpaceX projected to trade above $2 trillion valuation tomorrow.",
    }), cryptoCategory)).toBe('pre_ai_generic_equity_or_spacex');
  });

  it('allows tokenized equity or RWA stories with crypto rails', () => {
    expect(getPreAiContentRejectReason(item({
      sourceAccount: 'DecryptMedia',
      text: "Crypto platforms broaden access to Elon Musk's SpaceX through tokenized equity and RWA rails",
    }), cryptoCategory)).toBeNull();
  });

  it('rejects generic geopolitics without a crypto or digital-asset market angle', () => {
    expect(getPreAiContentRejectReason(item({
      sourceAccount: 'WatcherGuru',
      text: "Iran says the Strait of Hormuz is still closed despite President Trump's claims.",
    }), cryptoCategory)).toBe('pre_ai_generic_geopolitics');
  });

  it('allows geopolitics when the text explicitly connects to crypto markets', () => {
    expect(getPreAiContentRejectReason(item({
      sourceAccount: 'Pentosh1',
      text: 'Iran tensions pushed Bitcoin lower as oil and crypto liquidity concerns hit risk assets.',
    }), cryptoCategory)).toBeNull();
  });

  it('rejects whale-alert unknown-to-unknown spam before Claude', () => {
    expect(getPreAiContentRejectReason(item({
      sourceAccount: 'whale_alert',
      text: '314,843,159 USDC transferred from unknown wallet to unknown wallet',
    }), cryptoCategory)).toBe('pre_ai_whale_unknown_to_unknown');
  });

  it('rejects price engagement bait before Claude', () => {
    expect(getPreAiContentRejectReason(item({
      sourceAccount: 'Cointelegraph',
      text: 'BTC 80K or 50K? Which are you watching?',
    }), cryptoCategory)).toBe('pre_ai_engagement_bait');
  });

  it('allows clear crypto regulation and ETF items', () => {
    expect(getPreAiContentRejectReason(item({
      sourceAccount: 'BitcoinMagazine',
      text: 'CFTC Chair says the Clarity Act will help future-proof Bitcoin and crypto regulation.',
    }), cryptoCategory)).toBeNull();

    expect(getPreAiContentRejectReason(item({
      sourceAccount: 'EricBalchunas',
      text: 'New spot Bitcoin ETF filing appears on the SEC website.',
    }), cryptoCategory)).toBeNull();
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
