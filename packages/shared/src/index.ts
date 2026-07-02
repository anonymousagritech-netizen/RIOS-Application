/**
 * @rios/shared - API DTO contracts shared between the server and web client.
 * Keeping these in one place is the lightweight equivalent of the OpenAPI
 * contract described in brief §6 (Phase 6). The full OpenAPI doc is generated
 * from the server routes; these types are the hand-maintained source of truth
 * for the TypeScript clients.
 */

export interface AuthUser {
  id: string;
  email: string;
  displayName: string;
  tenantId: string;
  roles: string[];
  permissions: string[];
}

export interface LoginRequest {
  email: string;
  password: string;
  tenantCode?: string;
}

export interface LoginResponse {
  token: string;
  user: AuthUser;
}

/** A money value as carried over the wire: integer minor units + currency. */
export interface MoneyDTO {
  amount: number;
  currency: string;
}

export interface CodeValueDTO {
  code: string;
  label: string;
  meta: Record<string, unknown>;
  sortOrder: number;
}

export interface PartyDTO {
  id: string;
  reference: string | null;
  legalName: string;
  shortName: string | null;
  kind: string;
  country: string | null;
  roles: string[];
  status: string;
}

export interface LayerDTO {
  id: string;
  layerNo: number;
  name: string | null;
  currency: string;
  attachmentMinor: number;
  limitMinor: number;
  aadMinor: number;
  reinstatements: number | null;
  reinstatementRates: number[];
  rateOnLine: number | null;
}

export interface ParticipationDTO {
  id: string;
  layerId: string | null;
  partyId: string;
  partyName?: string;
  writtenLine: number;
  signedLine: number | null;
  orderPct: number | null;
  status: string;
}

export interface ContractDTO {
  id: string;
  reference: string | null;
  name: string;
  contractKind: string;
  basis: string;
  proportionalType: string | null;
  npType: string | null;
  lineOfBusiness: string | null;
  direction: string;
  cedentPartyId: string | null;
  brokerPartyId: string | null;
  /** Joined from the party table; present on the detail endpoint, null-able. */
  cedentName?: string | null;
  /** Joined from the party table; present on the detail endpoint, null-able. */
  brokerName?: string | null;
  currency: string;
  periodStart: string | null;
  periodEnd: string | null;
  status: string;
  wordingRef: string | null;
  layers?: LayerDTO[];
  participations?: ParticipationDTO[];
  terms?: Record<string, unknown>;
}

export interface FinancialEventDTO {
  id: string;
  contractId: string;
  eventType: string;
  direction: 'DR' | 'CR';
  amountMinor: number;
  currency: string;
  bookedAt: string;
  narrative: string | null;
}

export interface StatementLineDTO {
  type: string;
  count: number;
  totalMinor: number;
}

export interface StatementDTO {
  id?: string;
  contractId: string;
  currency: string;
  lines: StatementLineDTO[];
  balanceMinor: number;
  eventCount: number;
  reconciled?: boolean;
}

export interface ClaimDTO {
  id: string;
  reference: string | null;
  contractId: string;
  description: string | null;
  lossDate: string | null;
  notifiedDate: string;
  currency: string;
  grossLossMinor: number;
  outstandingMinor: number;
  paidMinor: number;
  recoveredMinor: number;
  status: string;
}

// ── Pagination contract (G-04) ─────────────────────────────────────────────

/**
 * Keyset pagination query parameters.
 * limit: max rows per page, default 50, capped at 200.
 * cursor: opaque page token — base64url of "createdAt,id" from the last row.
 */
export interface PaginationQuery {
  limit?: number;
  cursor?: string;
}

/**
 * Paginated response envelope.
 * nextCursor is null on the final page.
 * total is omitted from keyset responses (only present on OFFSET routes where cheap).
 */
export interface PaginatedResponse<T> {
  rows: T[];
  nextCursor: string | null;
  total?: number;
}

// ── Assistant ──────────────────────────────────────────────────────────────

/** Assistant intent + the prepared (not yet committed) action it resolves to (§12.4). */
export interface AssistantRequest {
  message: string;
}

export interface AssistantAction {
  /** Stable id used to confirm/execute a prepared action. */
  id: string;
  kind: string;
  description: string;
  /** True when the action mutates data and must be explicitly confirmed (§12.4). */
  requiresConfirmation: boolean;
  destructive: boolean;
  /** Human-readable preview of exactly what will change. */
  preview: Record<string, unknown>;
}

export interface AssistantResponse {
  reply: string;
  /** Grounded answer or navigation; never fabricated figures (§12.4). */
  actions: AssistantAction[];
  /** Records consulted to ground the answer. */
  grounding?: { entity: string; id: string; label: string }[];
}

// ── Capacity breach (P3-D) ─────────────────────────────────────────────────

/**
 * One zone's numbers in a capacity hard-limit breach (HTTP 409 CAPACITY_BREACH).
 * `zoneCode` and `addedMinor` are the canonical P3-D field names; the server
 * also returns `zone`, `additionMinor` etc. for backwards compatibility.
 */
export interface CapacityBreachZone {
  /** Zone identifier (e.g. territory code or cat zone). */
  zoneCode: string;
  /** The hard limit for this zone in integer minor units. */
  limitMinor: number;
  /** Existing bound aggregate before this contract, in integer minor units. */
  currentMinor: number;
  /** Exposure this contract would add, in integer minor units. */
  addedMinor: number;
}

/**
 * Body of the HTTP 409 response returned when binding would breach a hard
 * accumulation limit.  Discriminated by `code === 'CAPACITY_BREACH'`.
 */
export interface CapacityBreachError {
  code: 'CAPACITY_BREACH';
  zones: CapacityBreachZone[];
}
