import { describe, expect, it } from 'vitest';
import {
  applyPersianCaptionQualityGuard,
  buildCryptoStoryClusterKey,
  buildCryptoThemeKey,
  getSourceAudienceRejectReason,
  repairPersianCaptionText,
} from '../apps/worker-api/src/services/story-quality-guard';

describe('story quality guard', () => {
  it('clusters repeated USDT/XMR laundering stories across different source wording', () => {
    expect(buildCryptoStoryClusterKey('monero-xmr-price-move-usdt-laundering', 'ZachXBT linked a $120M USDT laundering transfer to Monero XMR', 'DefiantNews')).toBe('story:usdt-xmr-tether-laundering');
    expect(buildCryptoStoryClusterKey('tether-usdt-wallet-blacklist-aml', 'Tether blacklisted a wallet routed through Monero swaps', 'Cointelegraph')).toBe('story:usdt-xmr-tether-laundering');
  });

  it('clusters Metaplanet repeated securities/yield stories', () => {
    expect(buildCryptoStoryClusterKey('metaplanet-securities-firm-bitcoin-yield', 'Metaplanet acquired a Japanese securities firm for Bitcoin yield products', 'DecryptMedia')).toBe('story:metaplanet-bitcoin-products');
    expect(buildCryptoStoryClusterKey('metaplanet-siiibo-securities-btc-products', 'Metaplanet will acquire Siiibo Securities to launch BTC-linked products', 'WuBlockchain')).toBe('story:metaplanet-bitcoin-products');
  });

  it('detects broad RWA/tokenized asset theme for daily caps', () => {
    expect(buildCryptoThemeKey('exodus-ondo-markets-solana-rwa-launch', '200 tokenized stocks, ETFs and RWAs on Solana', 'Cointelegraph')).toBe('theme:rwa-tokenized-assets');
  });

  it('rejects project and exchange marketing that is low-value for Iranian crypto readers', () => {
    expect(getSourceAudienceRejectReason({ sourceAccount: 'binance', text: 'Introducing the bStocks Trading Competition. $240,000 in token vouchers. Trade tokenized stocks to claim your share.' })).toBe('iran_audience_promotional_campaign');
    expect(getSourceAudienceRejectReason({ sourceAccount: 'solana', text: 'SpaceX SPCX is live on Solana. Here is where to get access.' })).toBe('iran_audience_project_marketing');
    expect(getSourceAudienceRejectReason({ sourceAccount: 'chainlink', text: 'High-speed prediction markets powered by Chainlink integrations.' })).toBe('iran_audience_project_marketing');
  });

  it('repairs common Persian spacing defects', () => {
    expect(repairPersianCaptionText('اینفناوری در حوزهدارایی‌های توکنیزه شده ۴.۹۵ میلیوندلار خروجی داشت.')).toContain('این فناوری در حوزه دارایی‌های توکنیزه شده ۴.۹۵ میلیون دلار خروجی داشت.');
  });

  it('blocks Persian captions with year mismatch against source text', () => {
    const decision = applyPersianCaptionQualityGuard('fa', {
      captionShort: 'در سه ماهه دوم ۲۰۲۴، ۷۰ حمله رخ داد.',
      captionFull: 'در سه ماهه دوم سال ۲۰۲۴، ۷۰ سوءاستفاده امنیتی ثبت شد.',
      hashtags: [],
    }, 'Q2 2026 saw ~70 DeFi exploits with $746M stolen.');
    expect(decision.ok).toBe(false);
    expect(decision.reason).toBe('caption_year_mismatch');
  });
});
