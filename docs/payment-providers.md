# Payment providers

Commerce owns SKU selection, server prices, eligibility, order identity, entitlement binding and atomic fulfillment. An adapter receives a priced order and deals only with an external payment transport. `src/payments/providers.ts` defines that boundary.

`PaymentProviderRegistry` selects by configured provider ID and platform. `StarsProvider` is Telegram-only; `SbpProvider` supports Telegram and Web; `NowPaymentsProvider` is Web-only. Registration of a test provider requires no SKU or fulfillment changes. The existing Stars and SBP classes and their legacy routes remain available; the facades call those same clients.

## Contract

- `create(ProviderCreateInput)` returns `ProviderCheckout`: external ID and its kind (`invoice` or `payment`), checkout URL and optional expiry.
- `getStatus(paymentId, expected?)` returns normalized `ProviderPayment`. SBP requires the persisted expected order, because its existing client exposes only the status. No amount is guessed from an incoming browser request.
- `verifyNotification(rawBody, signature)` is optional because transports have different ingress rules. NOWPayments implements it; existing Telegram/Platega ingress retains its own verification.
- `ProviderError.outcome` distinguishes `definite_failure` from `ambiguous`. A create timeout must retain the same pending attempt and freeze automatic creation of another external payment. The adapter does not retry creation itself.

`ProviderPayment` contains provider, order ID, external payment ID, external invoice ID, normalized status, provider status, order price/currency, requested crypto amount, actual paid amount and crypto currency. Monetary values are decimal strings. Optional crypto values are null while incomplete.

Commerce must check the returned order ID, invoice/payment association and price against its persisted immutable order before applying a verified result. An adapter's `paid` result alone is not an authorization to grant an arbitrary SKU. A paid order whose SQL fulfillment failed is retried through the same atomic fulfillment function; no provider recreation is needed.

## NOWPayments

The implementation uses hosted `POST /invoice`: the user chooses a payment currency on the returned invoice page. The response invoice `id` is stored separately from the eventual IPN `payment_id`. Status reconciliation uses `GET /payment/{payment_id}` and checks the returned payment ID. The price is the server Commerce price; XTR is rejected as a NOWPayments quote currency. This follows the [official API reference](https://documenter.getpostman.com/view/7907941/S1a32n38).

The callback must receive the original JSON body and `x-nowpayments-sig`. Verification uses alphabetically sorted object keys recursively, JSON serialization, HMAC SHA-512 with the configured IPN secret and constant-time comparison. Duplicated top-level fields are rejected. Body size is limited. Signature errors do not mutate Commerce. The provider recommends a prompt response within three seconds, so durable receipt and fulfillment recovery belong in the Gateway orchestration. See the [official IPN instructions](https://nowpayments.zendesk.com/hc/en-us/articles/21395546303389-IPN-and-how-to-setup).

Only `finished` with a positive requested crypto amount and `actually_paid >= pay_amount` becomes `paid`. `confirmed` and `sending` remain pending; partial/failed/expired/refunded stay distinct. An underpaid `finished` record stays partial. The comparison is between amounts in `pay_currency`, never crypto against RUB/XTR. The success redirect is presentation only and does not confirm payment.

`normalizeDecimal` and `compareDecimals` use decimal strings and scaled integers. Incoming numeric JSON lexemes are retained. If a numeric literal contains precision lost by the documented JavaScript signature canonicalization, it is rejected rather than rounded; exact decimal strings are accepted with up to 80 fractional digits. Such a rejected payment needs provider reconciliation/review and never receives an unverified entitlement.

No live payment or real funds were used in tests. Production API examples were exercised through injected HTTP/IPN fixtures. The downloaded official Sandbox collection warns that it has not been actively maintained or kept synchronized with production since 2025; a Sandbox success is not asserted here as proof of production compatibility. Account setup requires API credentials, a payout wallet and IPN configuration, as described in the [integration guide](https://nowpayments.zendesk.com/hc/en-us/articles/21341613323421-NOWPayments-Integration-Guide).

## Configuration

Keep `NOWPAYMENTS_ENABLED=false` until the local SQL is applied to the intended deployment and provider credentials are configured. Required when enabled:

- `NOWPAYMENTS_API_KEY` and `NOWPAYMENTS_IPN_SECRET`.
- `NOWPAYMENTS_IPN_URL`, `NOWPAYMENTS_SUCCESS_URL`, `NOWPAYMENTS_CANCEL_URL` as HTTPS URLs without embedded credentials.
- `NOWPAYMENTS_API_BASE_URL` defaults to `https://api.nowpayments.io/v1`.
- `NOWPAYMENTS_TIMEOUT_MS` defaults to 15000.

API keys and the IPN secret stay on the server. Return URLs come from server configuration; Web clients cannot replace them. No API key is placed into the checkout URL, payment DTO or n8n event.

## Adding another provider

Implement `PaymentProvider` with its own creation/status/notification rules, register the adapter and configure the available platforms. Return the common decimal/status contract. Reuse the same order ownership checks and atomic Commerce fulfillment. Do not add SKU branches to the adapter or bypass persisted amount and ID checks. A test-only fourth adapter is included in the tests; it is never registered in production configuration.

Adapter tests cover hosted creation, exact decimals, invalid signatures, malformed/duplicated payloads, status transitions, partial payments, ambiguous creation, status association and the existing Stars/SBP wire contracts. Cross-repository fulfillment and n8n E2E coverage belongs to the central integration harness in `Dialogue-Engine-n8n-Flow`.
