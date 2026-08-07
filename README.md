# chat-router-service

Small TypeScript backend for routing and access decisions in chat-based applications.

It accepts a normalized inbound event, loads access context from Postgres, applies routing and entitlement rules, and returns one executable `action` plus the event context that downstream systems need.

This service is intentionally narrow:

- it decides
- another system executes

Typical deployment model:

`event source -> router service -> workflow/app backend -> side effects`

## What It Solves

- command and callback classification
- access checks for gated flows
- terms / subscription / usage-limit checks
- stable idempotency keys for downstream mutations
- a single action-first contract for orchestration layers

## Architecture

```text
POST /v1/router-decision
        |
        v
AccessDecisionService
        |
        v
ChatAccessRepository
        |
        v
Postgres
```

Execution stays outside this service. A workflow engine, bot backend, or queue consumer can call the router and then route only by `action`.

## Request / Response Model

Input:

- normalized chat event
- command / callback / payment / reachability metadata
- user and chat identifiers

Output:

- `domain`
- `intent`
- `action`
- `allowed`
- `idempotency_key`
- passthrough event fields for downstream execution
- access context fields when relevant

Example request:

```json
{
  "chat_id": 123456,
  "source": "telegram",
  "update_id": 987654,
  "source_user_id": 123456,
  "command": "/subscription",
  "event_type": "command.received",
  "message_type": "command"
}
```

Example response:

```json
{
  "domain": "command",
  "intent": "subscription",
  "action": "show_subscription_offer",
  "decision": "show_subscription_offer",
  "allowed": true,
  "chat_id": 123456,
  "source": "telegram",
  "update_id": 987654,
  "idempotency_key": "telegram:987654",
  "subscription_active": false,
  "turns_today": 3,
  "turn_limit": 15
}
```

## Endpoints

### `GET /healthz`

Health probe.

### `POST /v1/router-decision`

Primary endpoint.

### `POST /v1/access-decision`

Backward-compatible alias.

## Repository Layout

```text
chat-router-service/
  .env.example
  .gitignore
  README.md
  package.json
  tsconfig.json
  src/
    accessDecisionService.ts
    chatAccessRepository.ts
    config.ts
    db.ts
    routerDecisionService.ts
    server.ts
    types.ts
  test/
    accessDecisionService.test.ts
    chatAccessRepository.test.ts
```

## Local Development

```bash
npm install
cp .env.example .env
npm run dev
```

Other useful commands:

```bash
npm run check
npm run test
npm run build
npm run start
```

## Environment Variables

- `DATABASE_URL`
- `PORT`
- `HOST`
- `TURN_LIMIT`
- `BUSINESS_TIME_ZONE`
- `TURN_LIMIT_RESET_TEXT`

See [.env.example](./.env.example).

## Design Notes

- The router is the single owner of routing and access logic.
- Postgres access-context is loaded in one query for gated flows.
- Non-gated events can bypass the repository completely.
- `idempotency_key` is returned for downstream side-effect protection.
- Returned `action` values are application-defined. This implementation uses actions such as `show_terms_gate`, `show_subscription_offer`, `handle_scene_mode`, and `run_scene_core`.

## Intended Use

This repository contains the routing and access service used by a larger chat application

It fits well when you want:

- a thin HTTP decision layer in front of a workflow engine
- one place for access and routing policy
- deterministic routing for normalized inbound events
- testable entitlement logic outside low-code orchestration
