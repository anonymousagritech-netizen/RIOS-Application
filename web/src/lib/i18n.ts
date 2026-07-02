// Simple i18n — extend with locale files as needed
const en = {
  // Treaty / contract terms
  'treaty': 'Treaty',
  'cession': 'Cession',
  'cedent': 'Cedent',
  'retrocessionaire': 'Retrocessionaire',
  'inceptionDate': 'Inception Date',
  'expiryDate': 'Expiry Date',
  'writtenLine': 'Written Line',
  'signedLine': 'Signed Line',
  'orderLine': 'Order',
  'attachmentPoint': 'Attachment Point',
  'exhaustionPoint': 'Exhaustion Point',
  'rateOnLine': 'Rate on Line (RoL)',
  'reinstatement': 'Reinstatement',
  'grossWrittenPremium': 'Gross Written Premium (GWP)',
  'gnpi': 'Gross Net Premium Income (GNPI)',
  'technicalAccount': 'Technical Account',
  'currentAccount': 'Current Account',
  'premiumBordereau': 'Premium Bordereau',
  'claimsBordereau': 'Claims Bordereau',
  'lossRatio': 'Loss Ratio',
  'commissionRatio': 'Commission Ratio',
  'combinedRatio': 'Combined Ratio',
  'outstandingReserve': 'Outstanding Reserve',
  'recoverable': 'Recoverable',
  'lineOfBusiness': 'Line of Business (LOB)',
} as const;

type I18nKey = keyof typeof en;
type Locale = Record<I18nKey, string>;
let _locale: Locale = en;

export function t(key: I18nKey): string {
  return _locale[key] ?? key;
}

export function setLocale(locale: Locale): void {
  _locale = locale;
}

export type { Locale };
export { en as enStrings };
