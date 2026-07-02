/** Web-side response envelope types layered on top of @rios/shared DTOs. */
import type {
  AuthUser, CodeValueDTO, PartyDTO, ContractDTO, FinancialEventDTO,
  StatementLineDTO, ClaimDTO, AssistantAction,
} from '@rios/shared';

export interface DashboardSummary {
  kpis: {
    treaties: number;
    activeTreaties: number;
    parties: number;
    openClaims: number;
    gwpMinor: number;
    outstandingMinor: number;
    currency: string;
  };
  recentTreaties: { reference: string; name: string; status: string; currency: string }[];
  treatiesByStatus: { status: string; n: number }[];
}

export interface CodeListsResponse {
  lists: Record<string, CodeValueDTO[]>;
}

export interface CurrencyDTO {
  code: string;
  name: string;
  minorUnits: number;
  symbol: string;
}
export interface CurrenciesResponse { currencies: CurrencyDTO[]; }

export interface PartiesResponse { parties: PartyListItem[]; }
export interface PartyListItem extends PartyDTO {}
export interface PartyIdentifier { scheme?: string; value?: string; [k: string]: unknown; }
export interface PartyDetail extends PartyDTO {
  identifiers?: PartyIdentifier[];
}

export interface TreatyListItem {
  id: string;
  reference: string;
  name: string;
  contractKind: string;
  basis: string;
  proportionalType: string | null;
  npType: string | null;
  lineOfBusiness: string | null;
  direction: string;
  currency: string;
  periodStart: string | null;
  periodEnd: string | null;
  status: string;
  cedentPartyId: string | null;
  brokerPartyId: string | null;
  cedentName: string | null;
  brokerName: string | null;
}
export interface TreatiesResponse { treaties: TreatyListItem[]; }

export type TreatyDetail = ContractDTO & { cedentName?: string | null };

export interface TransitionResponse {
  id: string;
  status: string;
  financialEvents: FinancialEventDTO[];
}

export interface FinancialEventsResponse { events: FinancialEventDTO[]; }

export interface StatementResponse {
  currency: string;
  balanceMinor: number;
  eventCount: number;
  lines: StatementLineDTO[];
  posted: boolean;
  reconciled: boolean;
  controlMovementMinor: number;
}

export interface PostResponse {
  journalId: string;
  posted: boolean;
  reconciled: boolean;
  statementBalanceMinor: number;
  controlMovementMinor: number;
}

export interface ClaimListItem extends ClaimDTO {
  contractName?: string | null;
}
export interface ClaimsResponse { claims: ClaimListItem[]; }

export interface ClaimMovement {
  id: string;
  movementType: string;
  outstandingDeltaMinor?: number;
  paidDeltaMinor?: number;
  reason?: string | null;
  createdAt?: string;
  [k: string]: unknown;
}
export interface ClaimDetail extends ClaimListItem {
  movements?: ClaimMovement[];
}

export interface AssistantReply {
  reply: string;
  actions: AssistantAction[];
  grounding?: { entity: string; id: string; label: string }[];
}

export interface MeResponse { user: AuthUser; }

// SOA Entry types (P3-B)
export interface PremiumEntry {
  id: string;
  policyNo: string | null;
  insuredName: string | null;
  periodFrom: string | null;
  periodTo: string | null;
  sumInsuredMinor: number;
  grossPremiumMinor: number;
  riPremiumMinor: number;
  commissionMinor: number;
  netPremiumMinor: number;
  classOfBusiness: string | null;
  currency: string;
  remarks: string | null;
  createdAt: string;
}

export interface ClaimEntry {
  id: string;
  policyNo: string | null;
  insuredName: string | null;
  dateOfLoss: string | null;
  causeOfLoss: string | null;
  grossLossMinor: number;
  riLossMinor: number;
  outstandingMinor: number;
  paidMinor: number;
  classOfBusiness: string | null;
  currency: string;
  remarks: string | null;
  createdAt: string;
}

export interface SoaEntriesResponse {
  contractId: string;
  premiumEntries: PremiumEntry[];
  claimEntries: ClaimEntry[];
  summary: {
    totalGrossPremiumMinor: number;
    totalRiPremiumMinor: number;
    totalNetPremiumMinor: number;
    totalGrossLossMinor: number;
    totalRiLossMinor: number;
  };
}
