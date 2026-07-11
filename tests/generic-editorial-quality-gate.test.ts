import { describe, expect, it } from 'vitest';
import {
  getGenericCryptoEditorialRejectReason,
  getHardCryptoRelevanceRejectReason,
  getSourceAudienceRejectReason,
  hasExplicitCryptoDomainLink,
} from '../apps/worker-api/src/services/story-quality-guard';

describe('generic editorial quality gate', () => {
  it('rejects generic marketing or campaign language even when the brand name is new', () => {
    expect(getGenericCryptoEditorialRejectReason(
      'randomprotocol',
      'Our integration is now live. Get access to the new crypto product and start trading today.',
    )).toBe('iran_audience_generic_marketing_or_campaign');
  });

  it('rejects low-utility private asset access stories without relying on a specific company name', () => {
    expect(getGenericCryptoEditorialRejectReason(
      'marketnews',
      'Retail access to private assets expands through tokenized stocks and private shares.',
    )).toBe('iran_audience_low_utility_product_access');
  });

  it('rejects evergreen interviews and explainers when there is no material market or user-impact signal', () => {
    expect(getGenericCryptoEditorialRejectReason(
      'cointelegraph',
      'Watch the full interview to learn what crypto founders think about adoption.',
    )).toBe('iran_audience_evergreen_or_interview_low_utility');
  });

  it('rejects soft speculation when the text has no concrete evidence or event', () => {
    expect(getGenericCryptoEditorialRejectReason(
      'watcherguru',
      'This could signal growing adoption and may pave the way for a bullish crypto future.',
    )).toBe('iran_audience_soft_speculation_without_evidence');
  });

  it('allows material crypto news with concrete security, regulatory, or liquidity impact', () => {
    expect(getGenericCryptoEditorialRejectReason(
      'securityresearcher',
      'A DeFi protocol exploit stole $120 million and the team froze affected smart contracts.',
    )).toBeNull();

    expect(getSourceAudienceRejectReason({
      sourceAccount: 'CoinDesk',
      text: 'The SEC approved a spot Bitcoin ETF filing after months of regulatory review.',
    })).toBeNull();
  });

  it('hard rejects general politics, surveillance, and finance stories without a crypto-domain link', () => {
    expect(getHardCryptoRelevanceRejectReason({
      sourceAccount: 'Cointelegraph',
      text: 'Pavel Durov criticized EU chat-control surveillance rules and called the process a banana republic tactic.',
    }, {
      topicFingerprint: 'telegram-eu-chat-control-surveillance',
      riskFlags: [],
    })).toBe(
      'iran_audience_missing_explicit_crypto_relevance',
    );

    expect(getSourceAudienceRejectReason({
      sourceAccount: 'CoinDesk',
      text: 'Goldman Sachs banned employees from trading prediction markets covering elections, macro events, and bank-related news.',
    }, {
      score: 82,
      topicFingerprint: 'goldman-sachs-prediction-market-ban',
      riskFlags: [],
      publishPriority: 'normal',
    })).toBe(
      'iran_audience_missing_explicit_crypto_relevance',
    );
  });

  it('keeps crypto-native and materially crypto-adjacent stories eligible', () => {
    const eligible = [
      {
        sourceAccount: 'CoinDesk',
        text: 'Kraken is developing AI agents that can execute trades on its crypto exchange.',
      },
      {
        sourceAccount: 'Cointelegraph',
        text: 'Coinbase received a MiFID license for its European derivatives business.',
      },
      {
        sourceAccount: 'cryptodotnews',
        text: 'Polymarket applied to offer margin trading in the United States.',
      },
      {
        sourceAccount: 'CoinDesk',
        text: 'A US bill would prohibit a central bank digital currency, or CBDC.',
      },
      {
        sourceAccount: 'CoinDesk',
        text: 'GenLayer, MetaMask and OKX formed a protocol for resolving disputes between AI agents.',
      },
      {
        sourceAccount: 'WuBlockchain',
        text: 'Ethereum electricity use fell 99.9% after the Merge.',
      },
    ];

    for (const candidate of eligible) {
      expect(
        getHardCryptoRelevanceRejectReason(candidate),
      ).toBeNull();
    }
  });

  it('does not treat generic prediction markets or generic regulation as crypto by themselves', () => {
    expect(
      hasExplicitCryptoDomainLink(
        'A bank restricted employee trading in election prediction markets.',
      ),
    ).toBe(false);

    expect(
      hasExplicitCryptoDomainLink(
        'The European Union approved new surveillance regulation for messaging apps.',
      ),
    ).toBe(false);

    expect(
      hasExplicitCryptoDomainLink(
        'A regulator approved a spot Bitcoin ETF filing.',
      ),
    ).toBe(true);
  });

});
