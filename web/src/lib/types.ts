/** Web-side response envelope types layered on top of @rios/shared DTOs. */
import type {
  AuthUser, CodeValueDTO, PartyDTO, ContractDTO, FinancialEventDTO,
  StatementLineDTO, ClaimDTO, AssistantAction,
} from '@rios/shared';

/** A single entry in the recent-activity feed, sourced from audit_log. */
export interface ActivityEntry {
  id: string;
  /** Raw action code from audit_log (e.g. "CREATE", "BIND", "POST_GL"). */
  type: string;
  /** Table / entity category (e.g. "contract", "claim", "statement"). */
  entityType: string;
  /** The affected record's UUID (null for tenant-level actions). */
  entityId: string | null;
  /** Display label of the user who performed the action (may be null for system actions). */
  actor: string | null;
  /** ISO-8601 timestamp of when the action occurred. */
  at: string;
}


export interface DashboardSummary {
  kpis: {
    treaties: number;
    activeTreaties: number;
    parties: number;
    openClaims: number;
    gwpMinor: number;
    outstandingMinor: number;
    currency: string;
    /** Count of statement_of_account rows with status = 'OPEN'. */
    pendingStatementsCount: number;
    /** Incurred losses / GWP × 100, rounded to one decimal place. 0 when GWP is zero. */
    claimsRatioPercent: number;
  };
  recentTreaties: { reference: string; name: string; status: string; currency: string }[];
  treatiesByStatus: { status: string; n: number }[];
  /** Last 10 audit_log entries across all entity types. */
  recentActivity: ActivityEntry[];
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

/** Full treaty detail as returned by GET /api/treaties/:id — includes joined party names. */
export type TreatyDetail = ContractDTO & {
  /** Short name of the cedent party, joined server-side. */
  cedentName?: string | null;
  /** Short name of the broker party, joined server-side. */
  brokerName?: string | null;
};

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

// ---------------------------------------------------------------------------
// Accounting GL types (P2-05)
// ---------------------------------------------------------------------------

export interface JournalEntry {
  journalReference: string | null;
  postedAt: string;
  currency: string;
  treatyReference: string | null;
  eventType: string | null;
  debitAccount: string | null;
  creditAccount: string | null;
  amountMinor: number;
}

export interface JournalsResponse {
  entries: JournalEntry[];
  hasMore: boolean;
  page: number;
}

export interface TrialBalanceRow {
  accountCode: string;
  accountName: string;
  debitMinor: number;
  creditMinor: number;
  netMinor: number;
}

export interface TrialBalanceResponse {
  rows: TrialBalanceRow[];
  from: string;
  to: string;
}

export interface UnpostedEvent {
  id: string;
  contractId: string;
  contractReference: string | null;
  contractName: string;
  eventType: string;
  direction: string;
  amountMinor: number;
  currency: string;
  bookedAt: string;
  narrative: string | null;
}

export interface UnpostedResponse {
  events: UnpostedEvent[];
  count: number;
}
