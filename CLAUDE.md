# korner-billing-service

Billing and payments service. Handles subscriptions, wallet, payouts, payment processing, cards, and fees.

## Commands

```bash
npm run build     # tsc
npm run dev       # ts-node-dev --respawn --transpile-only src/main.ts
npm run start     # node dist/main.js
npm run lint      # eslint 'src/**/*.ts' --fix
```

## Port

**3002** (default)

## Modules

| Module | Description |
|--------|-------------|
| `payment` | Payment processing via OpenVision gateway |
| `subscription` | Subscription plans, renewal, cancellation |
| `wallet` | User wallet balance, transactions |
| `payout-requests` | Creator payout requests and processing |
| `card` | Saved payment cards management |
| `fee` | Platform fee calculation |

## Background Services

- `subscriptionRenewalService` — starts on boot, handles automatic subscription renewals

## Middleware

- `authMiddleware` / `optionalAuthMiddleware` — JWT Bearer auth

## Key Utilities

- `src/utils/errorCodes.ts` — Centralized error codes
- `src/utils/mainServiceClient.ts` — HTTP client to korner-main-service
- `src/utils/telegramNotifications.service.ts` — Team notifications via Telegram bot
- `src/utils/payment.ts` — OpenVision payment gateway integration
- `src/utils/wallet.ts` — Wallet operations
- `src/utils/subscription.ts` — Subscription logic helpers
- `src/utils/lokiService.ts` — Loki logging

## Models

Located in `src/models/`: `fee`, `payment`, `payout-requests`, `subscription`, `token`, `wallet`

## Environment Variables

```
PORT=3002
NODE_ENV=development
ACTIVE_ENV=dev
PGHOST, PGPORT, PGDB, PGUSER, PGPASSWORD
ACCESS_TOKEN_SECRET
REDIS_URL
KORNER_MAIN_SERVICE_URL=http://localhost:3001
OV_MERCHANT_ID, OV_SECRET_KEY, OV_API_URL
TEAM_TELEGRAM_BOT_TOKEN, TEAM_TELEGRAM_CHAT_ID, PAYOUTS_REQUESTS_TELEGRAM_CHATID
LOKI_URL, SERVICE_NAME=korner-billing-service
```

## Dependencies on Other Services

- **korner-main-service** — user data via `mainServiceClient`
