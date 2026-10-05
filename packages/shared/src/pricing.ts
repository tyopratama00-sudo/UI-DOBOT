export interface PricingConfig {
  firstPrint: number;
  additionalPrint: number;
  maxQuantity: number;
  currency: string;
}

export const DEFAULT_PRICING: PricingConfig = {
  firstPrint: 65000,
  additionalPrint: 15000,
  maxQuantity: 10,
  currency: 'IDR',
};

export function clampQuantity(q: number, cfg: PricingConfig = DEFAULT_PRICING): number {
  if (!Number.isFinite(q)) return 1;
  return Math.max(1, Math.min(cfg.maxQuantity, Math.trunc(q)));
}

/** Prototype: price(q) = 65000 + (q-1) * 15000 */
export function priceFor(quantity: number, cfg: PricingConfig = DEFAULT_PRICING): number {
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > cfg.maxQuantity) {
    throw new RangeError(`Quantity must be an integer between 1 and ${cfg.maxQuantity}`);
  }
  return cfg.firstPrint + (quantity - 1) * cfg.additionalPrint;
}

/** Rupiah formatting identical to the prototype: 'Rp' + n.toLocaleString('id-ID') */
export function rp(n: number): string {
  return 'Rp' + n.toLocaleString('id-ID');
}

export function p2(n: number): string {
  return String(n).padStart(2, '0');
}
