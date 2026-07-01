/**
 * @rios/domain - pure reinsurance domain calculations.
 *
 * No I/O, no framework, no clock, no database. Everything here is deterministic
 * and unit-tested so financial correctness (brief §4.4) is provable in isolation.
 */

export * from './money.js';
export * from './proportional.js';
export * from './nonproportional.js';
export * from './accounting.js';
export * from './fx.js';
export * from './pricing.js';
export * from './ifrs17.js';
export * from './solvency2.js';
export * from './payroll.js';
export * from './workflow.js';
export * from './rules.js';
export * from './analytics.js';
export * from './catastrophe.js';
export * from './treasury.js';
export * from './tax.js';
export * from './riskcapital.js';
export * from './forecast.js';
export * from './retention.js';
export * from './masking.js';
export * from './scheduler.js';
export * from './delegation.js';
export * from './performance.js';
export * from './product.js';
export * from './capacity.js';
export * from './integration.js';
export * from './i18n.js';
export * from './ocr.js';
export * from './prediction.js';
// New reinsurance math. Several symbols (profitCommission, exposureRate,
// burningCost, rateOnLine, minimumAndDepositPremium, reinstatementPremium) are
// already provided by proportional/nonproportional/pricing; we re-export only
// the genuinely-new functions here to avoid duplicate-export ambiguity.
export {
  flatCedingCommission, slidingScaleCommission, overridingCommission, brokerage,
  type SlidingScaleInput, type SlidingScaleResult,
} from './commission.js';
export {
  burningCostRate, interpolateExposureCurve, ilf, premiumAtLimit, premiumFromRol,
  catLoadFromModel,
  type ExposureCurvePoint, type ExposureRateInput, type ExposureRateResult,
  type IlfCurvePoint, type CatLoadInput, type CatLoadResult,
} from './rating.js';
export {
  perRiskRecovery, perOccurrenceRecovery, aggregateXlRecovery, stopLossRecovery,
  layerReinstatementCapacity,
  type PerRiskRecoveryInput, type PerOccurrenceRecoveryInput,
  type AggregateXlRecoveryInput, type AggregateXlRecoveryResult,
  type StopLossRecoveryInput, type StopLossRecoveryResult,
  type Reinstatement, type ReinstatementChargeDetail, type LayerReinstatementCapacityInput,
} from './xlStructures.js';
export * from './simulation.js';
export * from './geofence.js';
export * from './parametric.js';
export * from './attendanceStatus.js';
export * from './underwriting.js';
export * from './pricingScenarios.js';
export * from './catModel.js';
export * from './underwritingModels.js';
export * from './underwritingApproval.js';
export * from './underwritingAdvisor.js';
export * from './underwritingDocuments.js';
export * from './underwritingRenewal.js';
export * from './counterparty.js';
export * from './capacityMgmt.js';
export * from './exposureMgmt.js';
