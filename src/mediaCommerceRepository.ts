import { sql } from "./db.js";
import type { AbTestAssignment } from "./abTesting.js";
import type {
  InteractionTokenRow,
  LoadedCallbackToken,
  LoadedInvoiceToken,
  MediaContext,
  MediaFinalizeResult,
  FreeActionRedeemResult,
  FreeCredits,
  MediaOfferStats,
  PaidInvoiceToken,
  StoredInvoiceToken,
} from "./mediaCommerceTypes.js";
import { MediaCatalogRepository } from "./mediaCommerceRepository/catalogRepository.js";
import { MediaEventRepository } from "./mediaCommerceRepository/mediaEventRepository.js";
import { MediaPaymentRepository } from "./mediaCommerceRepository/paymentRepository.js";
import {
  type ActivateSubscriptionInput,
  type ActivateSceneAccessInput,
  type LoadMediaContextInput,
  type LoadOfferStatsInput,
  type MarkInvoicePaidInput,
  type QueryClient,
  type RecordAbTestDeliveredInput,
  type SceneAccessStatus,
  type SceneAccessStatusInput,
  type SbpCheckoutCreationClaim,
  type StorePanelInput,
  type StorePhotoEventInput,
  type StorePrecheckoutResultInput,
  type UpsertInvoiceTokenBatchInput,
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

  async upsertInvoiceTokens(
    inputs: UpsertInvoiceTokenBatchInput,
  ): Promise<StoredInvoiceToken[]> {
    return this.tokenRepository.upsertInvoiceTokens(inputs);
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

  async loadInvoiceTokenByExternalPaymentId(
    externalPaymentId: string | null,
  ): Promise<LoadedInvoiceToken | null> {
    return this.tokenRepository.loadInvoiceTokenByExternalPaymentId(
      externalPaymentId,
    );
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

  async activateSceneAccess(
    input: ActivateSceneAccessInput,
  ): Promise<number> {
    return this.paymentRepository.activateSceneAccess(input);
  }

  async loadSceneAccessStatus(
    input: SceneAccessStatusInput,
  ): Promise<SceneAccessStatus | null> {
    return this.paymentRepository.loadSceneAccessStatus(input);
  }

  async loadFreeCredits(chatId: number): Promise<FreeCredits | null> {
    return this.paymentRepository.loadFreeCredits(chatId);
  }

  async redeemFreeFastSceneSkip(
    token: string | null,
    chatId: number | null,
  ): Promise<FreeActionRedeemResult | null> {
    return this.paymentRepository.redeemFreeFastSceneSkip(token, chatId);
  }

  async redeemFreeSceneUnlock(
    token: string | null,
    chatId: number | null,
  ): Promise<FreeActionRedeemResult | null> {
    return this.paymentRepository.redeemFreeSceneUnlock(token, chatId);
  }

  async storePhotoEvent(input: StorePhotoEventInput): Promise<MediaFinalizeResult> {
    return this.mediaEventRepository.storePhotoEvent(input);
  }

  async storeInvoiceLinks(
    items: Array<{
      token: string;
      chat_id: number;
      invoice_link?: string | null;
      checkout_url?: string | null;
      external_payment_id?: string | null;
    }>,
  ): Promise<number> {
    return this.tokenRepository.storeInvoiceLinks(items);
  }

  async claimSbpCheckoutCreation(
    token: string | null,
    chatId: number | null,
  ): Promise<SbpCheckoutCreationClaim | null> {
    return this.tokenRepository.claimSbpCheckoutCreation(token, chatId);
  }

  async releaseSbpCheckoutCreation(
    token: string | null,
    chatId: number | null,
  ): Promise<number> {
    return this.tokenRepository.releaseSbpCheckoutCreation(token, chatId);
  }

  async loadStoredInvoiceTokens(tokens: string[]): Promise<StoredInvoiceToken[]> {
    return this.tokenRepository.loadStoredInvoiceTokens(tokens);
  }

  async loadAbTestAssignment(
    chatId: number,
    assignmentKey: string,
  ): Promise<AbTestAssignment | null> {
    return this.tokenRepository.loadAbTestAssignment(chatId, assignmentKey);
  }

  async storeAbTestAssignment(
    chatId: number,
    assignmentKey: string,
    assignment: AbTestAssignment,
  ): Promise<AbTestAssignment | null> {
    return this.tokenRepository.storeAbTestAssignment(
      chatId,
      assignmentKey,
      assignment,
    );
  }

  async recordAbTestDelivered(
    input: RecordAbTestDeliveredInput,
  ): Promise<number> {
    return this.mediaEventRepository.recordAbTestDelivered(input);
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
