/**
 * Treaty layer pricing & analytics - pure, deterministic, framework-free.
 *
 * A non-proportional treaty is built from layers (attachment / limit / rate on
 * line / reinstatements). This module prices a layer and rolls a tower of layers
 * into the numbers a treaty administrator watches: total limit, total premium,
 * the weighted rate on line, the top of the programme and the reinstated
 * capacity. Money is integer minor units. No I/O.
 */

const round2 = (v: number) => Math.round(v * 100) / 100;

/** Rate on line = premium ÷ limit, as a percentage. */
export function layerRateOnLine(premiumMinor: number, limitMinor: number): number {
  if (limitMinor <= 0) return 0;
  return round2((premiumMinor / limitMinor) * 100);
}

/** Premium implied by a rate on line applied to a limit. */
export function layerPremiumFromRol(limitMinor: number, rolPct: number): number {
  return Math.round(limitMinor * (rolPct / 100));
}

/** A first-cut expected loss on the layer from a target loss ratio on premium. */
export function layerExpectedLoss(premiumMinor: number, targetLossRatioPct: number): number {
  return Math.round(premiumMinor * (targetLossRatioPct / 100));
}

export interface LayerInput {
  attachmentMinor: number;
  limitMinor: number;
  premiumMinor?: number;      // if omitted, derived from rolPct
  rolPct?: number;            // if omitted, derived from premium
  reinstatements?: number | null; // null/undefined = unlimited
}

export interface LayerResult extends LayerInput {
  premiumMinor: number;
  rolPct: number;
  topMinor: number;           // attachment + limit (exhaustion point)
  reinstatedLimitMinor: number; // limit × (reinstatements + 1); limit if unlimited
}

/** Normalise a layer: fill in premium↔RoL and derived exhaustion/reinstated limit. */
export function priceLayer(layer: LayerInput): LayerResult {
  const limit = Math.max(0, layer.limitMinor);
  let premium = layer.premiumMinor ?? 0;
  let rol = layer.rolPct ?? 0;
  if (!premium && rol) premium = layerPremiumFromRol(limit, rol);
  else if (premium && !rol) rol = layerRateOnLine(premium, limit);
  const reinst = layer.reinstatements;
  const reinstatedLimit = reinst == null ? limit : limit * (reinst + 1);
  return {
    ...layer, limitMinor: limit, premiumMinor: premium, rolPct: rol,
    topMinor: layer.attachmentMinor + limit, reinstatedLimitMinor: reinstatedLimit,
  };
}

export interface TreatyLayerBook {
  layerCount: number;
  totalLimitMinor: number;
  totalPremiumMinor: number;
  weightedRolPct: number;         // premium-weighted... actually limit-weighted RoL
  programmeTopMinor: number;      // highest exhaustion point across layers
  reinstatedCapacityMinor: number;
  layers: LayerResult[];
}

/** Roll a tower of layers into programme-level analytics. */
export function treatyLayerBook(layers: LayerInput[]): TreatyLayerBook {
  const priced = layers.map(priceLayer).sort((a, b) => a.attachmentMinor - b.attachmentMinor);
  const totalLimit = priced.reduce((a, l) => a + l.limitMinor, 0);
  const totalPremium = priced.reduce((a, l) => a + l.premiumMinor, 0);
  const top = priced.reduce((m, l) => Math.max(m, l.topMinor), 0);
  const reinstated = priced.reduce((a, l) => a + l.reinstatedLimitMinor, 0);
  return {
    layerCount: priced.length,
    totalLimitMinor: totalLimit,
    totalPremiumMinor: totalPremium,
    weightedRolPct: totalLimit > 0 ? round2((totalPremium / totalLimit) * 100) : 0,
    programmeTopMinor: top,
    reinstatedCapacityMinor: reinstated,
    layers: priced,
  };
}
