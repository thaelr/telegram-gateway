import { config } from '../config.js';
import { MediaCommerceDecisionService } from '../mediaCommerceDecisionService.js';
import { MediaCommerceRepository } from '../mediaCommerceRepository.js';
import { NowPaymentsProvider } from '../payments/nowpayments.js';
import { PaymentProviderRegistry, SbpProvider, StarsProvider } from '../payments/providers.js';
import { SbpPaymentAdapter } from '../payments/sbp.js';
import { TelegramStarsPaymentAdapter } from '../payments/stars.js';
import { WebCommerceService } from './commerce.js';
import { WebCommerceRepository } from './commerceRepository.js';
import type { WebRepositoryContract } from './types.js';

export function createWebCommerce(accounts:WebRepositoryContract){
 const providers=new PaymentProviderRegistry([new StarsProvider(new TelegramStarsPaymentAdapter())]);
 if(config.SBP_ENABLED)providers.register(new SbpProvider(new SbpPaymentAdapter()));
 if(config.NOWPAYMENTS_ENABLED)providers.register(new NowPaymentsProvider({apiKey:config.NOWPAYMENTS_API_KEY!,ipnSecret:config.NOWPAYMENTS_IPN_SECRET!,callbackUrl:config.NOWPAYMENTS_IPN_URL!,successUrl:config.NOWPAYMENTS_SUCCESS_URL!,cancelUrl:config.NOWPAYMENTS_CANCEL_URL!,apiBaseUrl:config.NOWPAYMENTS_API_BASE_URL,timeoutMs:config.NOWPAYMENTS_TIMEOUT_MS}));
 return new WebCommerceService(new WebCommerceRepository(),providers,new MediaCommerceDecisionService(new MediaCommerceRepository()),accounts);
}
