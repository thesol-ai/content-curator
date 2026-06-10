#!/usr/bin/env bash
set -euo pipefail

ENV_NAME="${1:-production}"
DEFAULT_WEBHOOK_URL="${TELEGRAM_ADMIN_WEBHOOK_URL:-https://content-curator.thesol-ai.workers.dev/telegram/admin/webhook}"

echo "Configuring Telegram admin bot for Cloudflare env: ${ENV_NAME}"
echo

read -r -p "Allowed Telegram user_ids, comma-separated. Leave empty for discovery mode: " USER_IDS
USER_IDS="${USER_IDS//[[:space:]]/}"

if [[ -z "${USER_IDS}" ]]; then
  USER_IDS="0"
  echo "Discovery mode enabled: nobody is allowed yet, but unauthorized users will receive their user_id."
elif ! [[ "${USER_IDS}" =~ ^[0-9]+(,[0-9]+)*$ ]]; then
  echo "Invalid user_id list. Use only numbers separated by commas, like: 123456789,987654321" >&2
  exit 1
fi

read -r -p "Generate a new Telegram webhook secret? [Y/n]: " GENERATE_SECRET
GENERATE_SECRET="${GENERATE_SECRET:-Y}"

if [[ "${GENERATE_SECRET}" =~ ^[Nn]$ ]]; then
  read -s -p "Enter TELEGRAM_ADMIN_BOT_SECRET: " ADMIN_SECRET
  echo
  if [[ -z "${ADMIN_SECRET}" ]]; then
    echo "Secret cannot be empty." >&2
    exit 1
  fi
else
  ADMIN_SECRET="$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")"
fi

put_secret() {
  local name="$1"
  local value="$2"
  printf "%s" "${value}" | npx wrangler secret put "${name}" --env "${ENV_NAME}"
}

echo
echo "Saving Cloudflare secrets..."
put_secret TELEGRAM_ADMIN_ALLOWED_USER_IDS "${USER_IDS}"
put_secret TELEGRAM_ADMIN_BOT_SECRET "${ADMIN_SECRET}"
put_secret TELEGRAM_ADMIN_BOT_ENABLED "true"

echo
echo "Cloudflare admin bot config saved."
echo "Webhook URL: ${DEFAULT_WEBHOOK_URL}"
echo "Webhook secret: ${ADMIN_SECRET}"
echo
echo "Keep this secret private. It is shared only between Telegram setWebhook and Cloudflare Worker."

read -s -p "TELEGRAM_BOT_TOKEN for Telegram setWebhook. Leave empty to skip: " BOT_TOKEN
echo

if [[ -n "${BOT_TOKEN}" ]]; then
  echo "Setting Telegram webhook..."
  WEBHOOK_URL="${DEFAULT_WEBHOOK_URL}" ADMIN_SECRET="${ADMIN_SECRET}" \
  curl -sS -X POST "https://api.telegram.org/bot${BOT_TOKEN}/setWebhook" \
    -H "Content-Type: application/json" \
    --data "$(WEBHOOK_URL="${DEFAULT_WEBHOOK_URL}" ADMIN_SECRET="${ADMIN_SECRET}" node -e '
      const payload = {
        url: process.env.WEBHOOK_URL,
        secret_token: process.env.ADMIN_SECRET,
        allowed_updates: ["message", "callback_query"]
      };
      process.stdout.write(JSON.stringify(payload));
    ')" \
    | jq .
else
  echo "Skipped Telegram setWebhook."
  echo "You can set it later with this secret_token:"
  echo "${ADMIN_SECRET}"
fi
