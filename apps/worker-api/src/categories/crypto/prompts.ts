export function buildCryptoScoringPolicy(): string {
  return [
    'CRYPTO HARD GATE:',
    'Default to publish=false unless the source text itself contains an explicit crypto/digital-asset connection.',
    'Source account reputation is not enough. A post from SlowMist, DefiLlama, Decrypt, CoinDesk, or any crypto-native account can still be non-crypto.',
    'The text must directly mention at least one strong crypto anchor such as Bitcoin/BTC, Ethereum/ETH, Solana, stablecoin/USDT/USDC, DeFi, blockchain, on-chain, smart contract, wallet drain, crypto exchange, ETF tied to Bitcoin/Ethereum/crypto, tokenization/RWA, or named crypto venues/chains.',
    'Reject generic cybersecurity, software supply-chain, AI, macro, politics, stocks, SpaceX, sports, tech, legal, or business news unless the crypto connection is explicit in the source text.',
    'EDITORIAL SUBSTANCE GATE:',
    'Crypto relevance alone is not enough. Reject low-substance crypto market commentary that only says an analysis/report/data may provide clues, shows sentiment, or explains positioning without a concrete signal.',
    'For market-analysis posts, require at least one concrete item: numeric market level, percentage move, USD value, ETF flow, liquidation amount, funding/open-interest/volatility direction, support/resistance level, clear bullish/bearish conclusion, or a specific new event.',
    'Reject posts that merely advertise a report/thread/analysis from Glassnode, Santiment, CryptoQuant, Kaiko, CoinShares, or similar sources without the actual takeaway.',
    'Do not over-score polished but vague wording such as "deeper picture", "market sentiment", "trader positioning", "may provide clues", or "short- and medium-term trend" unless the text states the concrete conclusion.',
    'If publish=false because the item lacks a concrete takeaway, include risk_flags containing "low_substance_market_commentary".',
    'If you are unsure whether it is crypto or publish-worthy, publish=false.',
    'If publish=false because crypto relevance is missing, include risk_flags containing "missing_explicit_crypto_relevance".',
  ].join('\n');
}
