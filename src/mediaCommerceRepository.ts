import { sql } from "./db.js";
import type {
  InteractionTokenRow,
  LoadedCallbackToken,
  LoadedInvoiceToken,
  MediaContext,
  MediaFinalizeResult,
  MediaOfferStats,
  PaidInvoiceToken,
  StoredInvoiceToken,
} from "./mediaCommerceTypes.js";
import { MediaCatalogRepository } from "./mediaCommerceRepository/catalogRepository.js";
import { MediaEventRepository } from "./mediaCommerceRepository/mediaEventRepository.js";
import { MediaPaymentRepository } from "./mediaCommerceRepository/paymentRepository.js";
import {
  type ActivateSubscriptionInput,
  type LoadMediaContextInput,
  type LoadOfferStatsInput,
  type MarkInvoicePaidInput,
  type QueryClient,
  type StorePanelInput,
  type StorePhotoEventInput,
  type StorePrecheckoutResultInput,
  type UpsertInvoiceTokenInput,
} from "./mediaCommerceRepository/shared.js";
import { MediaInteractionTokenRepository } from "./mediaCommerceRepository/tokenRepository.js";

export class MediaCommerceRepository {
  private readonly catalogRepository: MediaCatalogRepository;

  private readonly tokenRepository: MediaInteractionTokenRepository;

  private readonly paymentRepository: MediaPaymentRepository;

  private readonly mediaEventRepository: MediaEventRepository;

  constructor(query: QueryClient = sql) {
    this.catalogRepository = new MediaCatalogRepository(query);
    this.tokenRepository = new MediaInteractionTokenRepository(query);
    this.paymentRepository = new MediaPaymentRepository(query);
    this.mediaEventRepository = new MediaEventRepository(query);
  }

  async loadOfferStats(input: LoadOfferStatsInput): Promise<MediaOfferStats | null> {
    return this.catalogRepository.loadOfferStats(input);
  }

  async upsertCallbackTokens(tokenRows: InteractionTokenRow[]): Promise<number> {
    return this.tokenRepository.upsertCallbackTokens(tokenRows);
  }

  async upsertInvoiceToken(
    input: UpsertInvoiceTokenInput,
  ): Promise<StoredInvoiceToken | null> {
    return this.tokenRepository.upsertInvoiceToken(input);
  }

  async loadCallbackToken(
    token: string | null,
    chatId: number | null,
  ): Promise<LoadedCallbackToken | null> {
    return this.tokenRepository.loadCallbackToken(token, chatId);
  }

  async loadMediaContext(input: LoadMediaContextInput): Promise<MediaContext | null> {
    return this.catalogRepository.loadMediaContext(input);
  }

  async storePanel(input: StorePanelInput): Promise<MediaFinalizeResult> {
    return this.mediaEventRepository.storePanel(input);
  }

  async loadInvoiceToken(
    token: string | null,
    chatId: number | null,
  ): Promise<LoadedInvoiceToken | null> {
    return this.tokenRepository.loadInvoiceToken(token, chatId);
  }

  async storePrecheckoutResult(input: StorePrecheckoutResultInput): Promise<void> {
    return this.paymentRepository.storePrecheckoutResult(input);
  }

  async markInvoicePaid(input: MarkInvoicePaidInput): Promise<PaidInvoiceToken | null> {
    return this.paymentRepository.markInvoicePaid(input);
  }

  async activateSubscription(
    input: ActivateSubscriptionInput,
  ): Promise<number> {
    return this.paymentRepository.activateSubscription(input);
  }

  async storePhotoEvent(input: StorePhotoEventInput): Promise<MediaFinalizeResult> {
    return this.mediaEventRepository.storePhotoEvent(input);
  }

  async storeInvoiceLinks(
    items: Array<{ token: string; chat_id: number; invoice_link: string }>,
  ): Promise<number> {
    return this.tokenRepository.storeInvoiceLinks(items);
  }

  async loadStoredInvoiceTokens(tokens: string[]): Promise<StoredInvoiceToken[]> {
    return this.tokenRepository.loadStoredInvoiceTokens(tokens);
  }

  async storeSubscriptionOfferMessageId(
    tokens: string[],
    chatId: number,
    offerMessageId: number,
  ): Promise<number> {
    return this.tokenRepository.storeSubscriptionOfferMessageId(
      tokens,
      chatId,
      offerMessageId,
    );
  }
}
