# Hourly all-profiles Apify task input

Use this JSON as the saved input for the new Apify task.

Important:
- It follows the same actor input shape as the current working crypto_v2 tasks.
- It includes all 8 profiles.
- It intentionally does NOT include `-filter:media`.
- It allows text-only and media tweets.
- It excludes replies and retweets.
- `maxItems` is 60 for the 48h test.
- Worker rotation will inject `since_time` dynamically during production runs.

Accounts:
- Cointelegraph
- CoinDesk
- WuBlockchain
- cryptodotnews
- CryptoRank_io
- WhaleFactor
- cryptomanran
- CryptoMichNL
