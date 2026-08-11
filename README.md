# chat-router-service

TypeScript backend for decision-making in chat products.

It keeps routing, access checks, and media-commerce policy outside workflow automation, while leaving side effects to the caller.

## Bounded Contexts

- `router-decision`
  Classifies normalized inbound events and returns a single executable `action`.
- `media-commerce-decision`
  Decides media offer, callback, invoice, pre-checkout, payment, and fulfillment behavior for a media add-on flow.

Typical deployment model:

`event source -> chat-router-service -> workflow/app backend -> external side effects`

## What Stays In This Service

- routing and intent classification
- terms / subscription / usage-limit checks
- idempotency key generation for downstream mutations
- media offer and payment decision logic
- token ownership and payment lifecycle validation

## What Stays Outside

- Telegram API calls
- message send/edit/delete operations
- invoice link creation
- workflow orchestration

## API

### Public

- `GET /healthz`

### Internal

All `/v1/*` endpoints require an internal API key header.

- Header name: `INTERNAL_API_KEY_HEADER`
- Header value: `INTERNAL_API_KEY`

Endpoints:

- `POST /v1/router-decision`
- `POST /v1/access-decision`
- `POST /v1/media-commerce-decision`

## Request / Response Shape

The service accepts normalized events and returns decision objects that preserve the context required by downstream execution.

Router responses include fields such as:

- `action`
- `allowed`
- `idempotency_key`
- passthrough event metadata
- access-context fields when relevant

Media-commerce responses include fields such as:

- `route`
- `operation`
- `invoice_token`
- `reply_markup`
- `payment_kind`
- `reason`

## Repository Layout

```text
chat-router-service/
  .env.example
  README.md
  package.json
  src/
    accessDecisionService.ts
    chatAccessRepository.ts
    config.ts
    db.ts
    internalApiAuth.ts
    mediaCommerceDecisionService.ts
    mediaCommerceRepository.ts
    mediaCommerceTypes.ts
    routerDecisionService.ts
    server.ts
    types.ts
  test/
    accessDecisionService.test.ts
    chatAccessRepository.test.ts
    internalApiAuth.test.ts
    mediaCommerceDecisionService.test.ts
```

## Local Development

```bash
npm install
cp .env.example .env
npm run dev
```

Useful commands:

```bash
npm run check
npm run test
npm run build
npm run start
```

## Environment Variables

Core:

- `DATABASE_URL`
- `PORT`
- `HOST`
- `INTERNAL_API_KEY`
- `INTERNAL_API_KEY_HEADER`

Access / router:

- `TURN_LIMIT`
- `BUSINESS_TIME_ZONE`
- `TURN_LIMIT_RESET_TEXT`

Media commerce:

- `MEDIA_PAYMENT_CURRENCY`
- `MEDIA_STORAGE_BASE_URL`
- `MEDIA_CATALOG_RELATION`
- `MEDIA_DEFAULT_BUCKET_NAME`
- `MEDIA_BUCKET_ALIAS_MAP_JSON`
- `MEDIA_SUBSCRIPTION_PLANS_JSON`

See [.env.example](./.env.example).

## Design Notes

- The service is decision-only; callers own execution.
- `/v1/*` is intended for trusted internal callers only.
- Subscription pricing and plan metadata are environment-driven.
- Media catalog storage names are configurable so public code stays product-neutral.
