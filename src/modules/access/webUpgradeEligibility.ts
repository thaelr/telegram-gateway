import {config} from '../../config.js';
import {calculateFullUpgrade} from '../products/plans.js';
import type {WebProductPlan} from '../../web/commerceTypes.js';
export function eligibleWebUpgrade(plan:WebProductPlan,rights:{subscription_sku?:string|null;subscription_until?:string|null;full_active?:boolean}){
  if(plan.subscription_tier!=='full'||rights.full_active||!rights.subscription_until||Date.parse(rights.subscription_until)<=Date.now())return null;
  const nominal=config.MEDIA_SUBSCRIPTION_PLANS_JSON.find(p=>p.sku===rights.subscription_sku&&p.tier!=='full');
  if(!nominal)return null;
  return {...calculateFullUpgrade(plan,nominal,config.MEDIA_UPGRADE_DISCOUNT_PERCENT),base_sku:nominal.sku};
 }
