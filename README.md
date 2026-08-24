# Telegram Gateway

This service was created for a conversational AI product and handles access control and routing of incoming events.

Works as the Telegram backend and contains the logic for a small companion-selection app, including business rules and transaction-related scenarios. The service makes decisions and stores state, while the actual actions in production are performed in n8n, where workflows handle UX and commercial flows.

## Endpoints

### `/v1/router-decision`

Classifies messages, commands, and callbacks, decides whether the user can access the chat, checks the daily limit, and returns the next action for the workflow.

### `/v1/media-commerce-decision`

Handles decisions related to paid actions: media delivery, callback actions, subscriptions, and Telegram Stars payments. It uses the current database state to process commercial actions and build the offers available to the user.

## Implementation

The service is written in TypeScript using Fastify. State is stored in PostgreSQL, while input data and configuration are validated with Zod.

Simple data operations are handled in the backend code, while more complex operations, especially those sensitive to concurrent processing, are moved to PostgreSQL functions.

Callback and payment flows use server-side tokens and separate payment states to protect against duplicate event processing.

Pricing plans, paid actions, and temporary promotions are configured through environment settings.

The main scenarios are covered by automated tests, and requests and errors are logged with a request ID.

## Workflows used in production

The screenshot shows the two main n8n workflows that use the gateway.

On the left is the main Telegram router workflow. It receives and normalizes incoming events, calls `/v1/router-decision`, and routes the user to the correct product flow.

On the right is the media / payment workflow. It calls `/v1/media-commerce-decision` and handles flows related to media, callback actions, subscriptions, and Telegram Stars payments.

<img width="1460" height="700" alt="image" src="https://github.com/user-attachments/assets/2a963e36-decd-482e-a77f-16a9d1836523" />



