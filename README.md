# Telegram Gateway

This service was created for a conversational AI product and is used as a backend layer between Telegram/n8n and PostgreSQL.

The gateway receives normalized Telegram events, loads the current user state, and returns a decision about what should happen next. It contains the rules for chat access, chat management, commercial logic, payment states, free credits, rewards, and part of the configuration for user-facing flows.

The service makes business decisions and updates access- and commerce-related state in PostgreSQL. Actions in Telegram are performed through n8n: workflows send messages, images, invoices, and update the interface based on gateway responses.

## Access and routing

### `/v1/router-decision`

The main endpoint for incoming Telegram events.

It processes messages, commands, and callback events and determines the next flow for the user.

This includes:

- checking acceptance of the user terms;
- character and chat mode selection;
- starting and resetting chats;
- `/start`, `/menu`, `/subscription`, and `/paysupport`, as well as the callback flow for confirming a new chat;
- the daily message limit;
- access through an active subscription or unlocked chat;
- reachability updates through Telegram `my_chat_member`;
- routing callback and payment events into the commerce flow.

The gateway loads the current user state from PostgreSQL and returns a ready decision to n8n: continue the chat, show the menu, open the paywall, request confirmation for a new chat, or perform another action.

## Media and commerce

### `/v1/media-commerce-decision`

The endpoint for commercial and media-related flows.

It handles:

- subscriptions;
- microtransaction actions;
- free credits for microtransaction actions;
- Telegram Stars;
- SBP;
- creation and reuse of commercial offers;
- callback token processing;
- pre-checkout, successful, canceled, and chargeback payment events;
- finalization of photo events and subscription offers.

A single commercial action can have multiple payment methods. The gateway builds the available options and returns the data required by n8n to render the corresponding Telegram UI.

Payment and access states are stored separately from Telegram messages. Reprocessing a callback or payment event does not grant access to the user twice.

## Payments

Telegram Stars and SBP are implemented as separate payment adapters.

For SBP, the gateway also exposes a public redirect endpoint:

### `/v1/pay/sbp/:token`

The endpoint validates the payment token state and redirects the user to the current checkout URL.

Expired, already completed, or inconsistent payment attempts are not reused.

Commercial operations use server-side tokens and separate payment states. Operations that are sensitive to concurrent processing are executed through PostgreSQL functions.

## Free balances and access

The gateway tracks several independent types of access:

- active subscription;
- access to the current chat;
- balances for free microtransaction actions.

These states are used both in routing decisions and inside the commerce flow.

When the daily limit is checked, an active subscription and chat access take precedence over the paywall.

## Reward campaigns

The gateway contains a separate mechanism for granting rewards to users.

Rewards can include:

- chat unlocks;
- opening skips;
- photo unlocks;
- additional subscription days.

A reward campaign is configured through server-side configuration and can have a validity window, success text shown after activation, and a next action after claim.

### `/v1/rewards/grants`

Creates a reward grant for a user based on a configured reward slot.

The reward configuration is stored in the grant at assignment time, so later changes to server configuration do not change an already issued reward.

### `/v1/rewards/grants/:grantId/bind-message`

Binds a grant to a specific Telegram message.

This is used for broadcasts: a grant is created first, then the Telegram message is sent, and its `message_id` is stored in the grant.

### `/v1/rewards/claim-slot`

Activates a reward from a configured reward slot.

During claim, the user, slot, and Telegram message bound to the grant are checked.

Claiming an already used reward again does not issue the reward twice.

### `/v1/rewards/claim`

Supports claims by `campaign_id` for flows where a reward grant is not created in advance.

## A/B testing

Commercial offers can be changed through server-side A/B test configuration.

An experiment can change:

- subscription offer text;
- available subscription plans;
- prices;
- chat unlock parameters;
- visibility of individual commercial actions.

A user receives a variant when first entering an experiment. The assignment is stored in the database and reused in later requests, so the variant remains stable within a single experiment run.

Experiment information is also passed further into the commerce flow and can be stored together with offer delivery events.

## Configuration

The main product configuration is stored in environment variables and validated when the application starts.

Configuration includes:

- subscription plans;
- photo plans;
- paid actions;
- temporary promotions;
- Telegram UX copy;
- reward slots;
- A/B experiments;
- the daily limit;
- payment provider settings.

Complex structures are stored as JSON configuration and validated with Zod.

Invalid configuration causes startup to fail instead of leaving the service in a partially working state.

## Internal API

All `/v1/*` endpoints, except for the public SBP redirect, are protected by an internal API key.

It is used by n8n workflows when calling the gateway.

API input is validated with Zod.

## Implementation

The service is written in TypeScript using Fastify.

PostgreSQL is used as the main storage for user state, payments, tokens, access state, reward grants, and experiment assignments.

Simple operations are handled in backend code. Operations that require atomicity or protection against concurrent execution are moved to PostgreSQL functions.

The commerce flow is built around server-side tokens and idempotent state transitions. This allows repeated callbacks and payment events to be processed safely.

Commerce operation errors are logged together with the request ID, operation type, and error code.

## Testing

The repository contains automated tests for the main parts of the gateway:

- access decisions;
- media commerce decisions;
- repositories;
- request validation;
- Telegram Stars;
- SBP;
- reward system;
- A/B testing;
- internal API authentication;
- configuration parsing;
- invoice payloads and numeric normalization.

Tests separately cover business logic, repository and migration contracts, payment adapters, and the HTTP layer.

## Workflows used in production

The gateway is used by two main n8n workflows.

The first workflow receives Telegram updates, normalizes events, calls `/v1/router-decision`, and routes the user into the appropriate product flow.

The second workflow handles media and commerce flows. It calls `/v1/media-commerce-decision`, renders commercial offers, sends Telegram invoices, processes callbacks, and finalizes operations after payment or free activation.

Business decisions and transactional state remain in the gateway and PostgreSQL, while n8n is used as the orchestration layer and performs external Telegram actions.

[image](https://github.com/user-attachments/assets/2a963e36-decd-482e-a77f-16a9d1836523)



