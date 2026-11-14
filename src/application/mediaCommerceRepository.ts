import { loadAccountLanguage } from '../modules/accounts/mediaAccountLanguage.js';
import { authorizeDailyPhoto } from '../modules/access/dailyPhoto.js';
import { recordAbTestDelivered } from '../modules/experiments/deliveredEvent.js';
import { loadAbTestAssignment, storeAbTestAssignment } from '../modules/experiments/experimentRepository.js';
import { activateSubscription, activateSceneAccess, loadSceneAccessStatus, loadFreeCredits, redeemFreeFastSceneSkip, redeemFreeSceneUnlock, redeemFreePhotoUnlock } from '../modules/access/accessRepository.js';
import { sql } from '../db.js';
import type { AbTestAssignment } from '../modules/experiments/abTesting.js';
import type { InteractionTokenRow, LoadedCallbackToken, LoadedInvoiceToken, MediaContext, MediaFinalizeResult, FreeActionRedeemResult, FreeCredits, MediaOfferStats, PaidInvoiceToken, StoredInvoiceToken } from '../mediaCommerceTypes.js';
import { MediaCatalogRepository } from '../modules/media/catalogRepository.js';
import { MediaEventRepository } from '../modules/media/mediaEventRepository.js';
import { MediaPaymentRepository } from '../modules/commerce/paymentRepository.js';
import type { ActivateSubscriptionInput, ActivateSceneAccessInput, FinalizeFreePhotoUnlockInput, LoadMediaContextInput, LoadOfferStatsInput, MediaCatalogPhoto, MarkInvoicePaidInput, QueryClient, RecordAbTestDeliveredInput, RecordSbpProviderEventInput, SceneAccessStatus, SceneAccessStatusInput, SbpCheckoutCreationClaim, StorePanelInput, StorePhotoEventInput, StorePrecheckoutResultInput, UpsertInvoiceTokenBatchInput, UpsertInvoiceTokenInput } from '../mediaCommerceRepository/shared.js';
import { MediaInteractionTokenRepository } from '../modules/commerce/tokenRepository.js';

export class MediaCommerceRepository {
  private readonly query: QueryClient;

  private readonly catalogRepository: MediaCatalogRepository;

  private readonly tokenRepository: MediaInteractionTokenRepository;

  private readonly paymentRepository: MediaPaymentRepository;

  private readonly mediaEventRepository: MediaEventRepository;

  readonly authorizeDailyPhoto: (chatId: number, scene: string, token: string, uuid: string, messageId: number) => Promise<{ mode: "subscription" | "nav" | "scene_pass" | "free" | null; dispatchBy: string | undefined }>;

  readonly loadAccountLanguage: (chatId: number | null, sourceUserId: number | null) => Promise<string>;

  constructor(query: QueryClient = sql) {
    this.query = query;
    this.loadAccountLanguage = loadAccountLanguage.bind(null, query);
    this.authorizeDailyPhoto = authorizeDailyPhoto.bind(null, query);
    this.catalogRepository = new MediaCatalogRepository(query);
    this.tokenRepository = new MediaInteractionTokenRepository(query);
    this.paymentRepository = new MediaPaymentRepository(query);
    this.mediaEventRepository = new MediaEventRepository(query);
  }

  async loadOfferStats(input: LoadOfferStatsInput): Promise<MediaOfferStats> {
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

  async loadCallbackTokens(
    tokens: string[],
    chatId: number | null,
  ): Promise<LoadedCallbackToken[]> {
    return this.tokenRepository.loadCallbackTokens(tokens, chatId);
  }

  async loadMediaContext(input: LoadMediaContextInput): Promise<MediaContext> {
    return this.catalogRepository.loadMediaContext(input);
  }

  async loadPhotoByUuid(uuid: string): Promise<MediaCatalogPhoto | null> {
    return this.catalogRepository.loadPhotoByUuid(uuid);
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
    return activateSubscription(this.query, input);
  }

  async activateSceneAccess(
    input: ActivateSceneAccessInput,
  ): Promise<number> {
    return activateSceneAccess(this.query, input);
  }

  async loadSceneAccessStatus(
    input: SceneAccessStatusInput,
  ): Promise<SceneAccessStatus | null> {
    return loadSceneAccessStatus(this.query, input);
  }

  async loadFreeCredits(chatId: number): Promise<FreeCredits | null> {
    return loadFreeCredits(this.query, chatId);
  }

  async redeemFreeFastSceneSkip(
    token: string | null,
    chatId: number | null,
  ): Promise<FreeActionRedeemResult | null> {
    return redeemFreeFastSceneSkip(this.query, token, chatId);
  }

  async redeemFreeSceneUnlock(
    token: string | null,
    chatId: number | null,
  ): Promise<FreeActionRedeemResult | null> {
    return redeemFreeSceneUnlock(this.query, token, chatId);
  }

  async redeemFreePhotoUnlock(
    token: string | null,
    chatId: number | null,
  ): Promise<FreeActionRedeemResult | null> {
    return redeemFreePhotoUnlock(this.query, token, chatId);
  }

  async storePhotoEvent(input: StorePhotoEventInput): Promise<MediaFinalizeResult> {
    return this.mediaEventRepository.storePhotoEvent(input);
  }

  async finalizeFreePhotoUnlock(
    input: FinalizeFreePhotoUnlockInput,
  ): Promise<MediaFinalizeResult> {
    return this.mediaEventRepository.finalizeFreePhotoUnlock(input);
  }

  async storeInvoiceLinks(
    items: Array<{
      token: string;
      chat_id: number;
      invoice_link?: string | null;
      checkout_url?: string | null;
      external_payment_id?: string | null;
      expires_at?: string | null;
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

  async markSbpCheckoutCreationUncertain(token: string, chatId: number): Promise<number> {
    return this.tokenRepository.markSbpCheckoutCreationUncertain(token, chatId);
  }

  async markSbpInvoiceCanceled(externalPaymentId: string): Promise<number> {
    return this.paymentRepository.markSbpInvoiceCanceled(externalPaymentId);
  }

  async markSbpInvoiceExpired(token: string, chatId: number): Promise<number> {
    return this.paymentRepository.markSbpInvoiceExpired(token, chatId);
  }

  async recordSbpStatusConflict(
    externalPaymentId: string,
    providerStatus: string,
  ): Promise<number> {
    return this.paymentRepository.recordSbpStatusConflict(externalPaymentId, providerStatus);
  }

  async recordSbpProviderEvent(input: RecordSbpProviderEventInput): Promise<number> {
    return this.paymentRepository.recordSbpProviderEvent(input);
  }

  async loadStoredInvoiceTokens(tokens: string[]): Promise<StoredInvoiceToken[]> {
    return this.tokenRepository.loadStoredInvoiceTokens(tokens);
  }

  async loadActiveSubscriptionOfferId(chatId: number): Promise<string | null> {
    return this.tokenRepository.loadActiveSubscriptionOfferId(chatId);
  }

  async loadAbTestAssignment(
    chatId: number,
    assignmentKey: string,
  ): Promise<AbTestAssignment | null> {
    return loadAbTestAssignment(this.query, chatId, assignmentKey);
  }

  async storeAbTestAssignment(
    chatId: number,
    assignmentKey: string,
    assignment: AbTestAssignment,
  ): Promise<AbTestAssignment | null> {
    return storeAbTestAssignment(this.query, 
      chatId,
      assignmentKey,
      assignment,
    );
  }

  async recordAbTestDelivered(
    input: RecordAbTestDeliveredInput,
  ): Promise<number> {
    return recordAbTestDelivered(this.query, input);
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

  async clearActiveSubscriptionOffer(
    chatId: number,
    offerId: string | null,
  ): Promise<number> {
    return this.tokenRepository.clearActiveSubscriptionOffer(chatId, offerId);
  }
}
