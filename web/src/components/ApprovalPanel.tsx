/**
 * ApprovalPanel - a reusable maker/checker + authority surface.
 *
 * This panel does NOT introduce a new approval workflow. It surfaces the
 * governance that ALREADY exists on the server for the given entity, driving the
 * real, audited endpoints. There is no generic per-entity approval table, so the
 * panel branches on `entityType` and drives whatever governance is genuinely
 * implemented for that entity:
 *
 *  - entityType="claim"  -> Cash-call maker/checker (server/modules/claimsAdvanced.ts).
 *      GET  /api/claims/cash-calls/queue                 (open calls; filtered to this claim)
 *      POST /api/claims/:id/cash-call/:callId/approve    (segregation of duties: the
 *           requester cannot approve their own call - server returns 403, surfaced here)
 *      POST /api/claims/:id/cash-call/:callId/pay        (only an approved call can be paid)
 *      Permission gate: claims:write.
 *
 *  - entityType="treaty" -> Binding authority gate (server/modules/treaties.ts).
 *      Treaties have no separate approve/reject referral; binding IS the material
 *      governance gate - it books the deposit premium and runs accumulation control
 *      (which can hard-block, requiring an admin override). The approval action is
 *      therefore the guarded transition to BOUND.
 *      POST /api/treaties/:id/transition { to: "BOUND" }
 *      Permission gate: treaty:bind (authority-based segregation, not identity-based).
 *
 * Underwriting-submission referrals are a fuller maker/checker matrix, but they live
 * on submissions (see UnderwritingApprovalsPage) - not on the treaty/claim entities
 * this panel is embedded on, so they are intentionally out of scope here.
 *
 * Hooks are kept local (inline useQuery/useMutation against api()); this component
 * does not touch web/src/lib/queries.ts. ConfirmDialog gates every mutation and a
 * Toast reports the result (including a cleanly surfaced 403).
 */

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ShieldCheck, Info, Gavel, CircleDollarSign, ThumbsUp } from 'lucide-react';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useToast } from './Toast';
import { Card, CardHeader } from './Card';
import { Badge, StatusPill } from './Badge';
import { Button } from './Button';
import { ConfirmDialog } from './Modal';
import { EmptyState } from './Table';
import { legalTransitions } from '../lib/status';
import { formatMoney, titleCase } from '../lib/format';
import styles from './ApprovalPanel.module.css';

type ApprovalPanelProps =
  | { entityType: 'treaty'; entityId: string; status: string; statusColors?: Record<string, string> }
  | { entityType: 'claim'; entityId: string };

export function ApprovalPanel(props: ApprovalPanelProps) {
  if (props.entityType === 'treaty') {
    return <TreatyApproval entityId={props.entityId} status={props.status} statusColors={props.statusColors} />;
  }
  return <ClaimApproval entityId={props.entityId} />;
}

// --- Treaty: binding authority gate ----------------------------------------

const BOUND_OR_LATER = ['BOUND', 'ACTIVE', 'EXPIRING', 'RUNOFF', 'COMMUTED', 'CLOSED', 'RENEWED', 'LAPSED'];

function TreatyApproval({ entityId, status, statusColors }: { entityId: string; status: string; statusColors?: Record<string, string> }) {
  const { hasPermission } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const [confirm, setConfirm] = useState(false);

  const canBind = hasPermission('treaty:bind');
  const bindable = legalTransitions(status).includes('BOUND');
  const alreadyBound = BOUND_OR_LATER.includes(status.toUpperCase());

  const bind = useMutation({
    mutationFn: () =>
      api<{ id: string; status: string; financialEvents?: unknown[]; warnings?: unknown[] }>(
        `/api/treaties/${entityId}/transition`,
        { body: { to: 'BOUND' } },
      ),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ['treaty', entityId] });
      qc.invalidateQueries({ queryKey: ['treaties'] });
      qc.invalidateQueries({ queryKey: ['financial-events', entityId] });
      qc.invalidateQueries({ queryKey: ['statement', entityId] });
      const booked = res.financialEvents?.length ?? 0;
      toast.success(booked ? `Bound - ${booked} financial event(s) booked` : 'Treaty bound');
      setConfirm(false);
    },
    onError: (e) => {
      toast.error(e instanceof ApiError ? e.message : 'Binding failed');
      setConfirm(false);
    },
  });

  return (
    <Card>
      <CardHeader
        title="Approval & authority"
        subtitle="Binding is the material governance gate for this treaty."
        actions={<StatusPill status={status} metaColors={statusColors} />}
      />
      <div className={styles.stack}>
        <div className={styles.context}>
          <div className={styles.contextItem}>
            <span className={styles.contextLabel}>Approval gate</span>
            <span className={styles.contextValue}>Bind to BOUND</span>
          </div>
          <div className={styles.contextItem}>
            <span className={styles.contextLabel}>Required authority</span>
            <span className={styles.contextValue}><Badge color="blue">treaty:bind</Badge></span>
          </div>
          <div className={styles.contextItem}>
            <span className={styles.contextLabel}>Your authority</span>
            <span className={styles.contextValue}>{canBind ? 'Approver (can bind)' : 'View only'}</span>
          </div>
        </div>

        <div className={styles.note}>
          <Info size={14} className={styles.noteIcon} />
          <span>
            Binding books the deposit premium and runs accumulation control. A hard breach blocks the
            bind unless an <code>admin:manage</code> holder overrides it (audited). Authority here is
            permission-based (<code>treaty:bind</code>), not identity-based maker/checker.
          </span>
        </div>

        <div className={styles.actionRow}>
          {alreadyBound ? (
            <span className={styles.contextValue}>This treaty is already bound - the deposit premium has been booked.</span>
          ) : !bindable ? (
            <span className={styles.contextValue}>Not yet ready to bind. Advance the placement lifecycle first.</span>
          ) : !canBind ? (
            <span className={styles.contextValue}>You do not hold <code>treaty:bind</code>, so you cannot approve binding.</span>
          ) : (
            <>
              <span className={styles.spacer} />
              <Button variant="primary" icon={<Gavel size={15} />} loading={bind.isPending} onClick={() => setConfirm(true)}>
                Approve binding
              </Button>
            </>
          )}
        </div>
      </div>

      <ConfirmDialog
        open={confirm}
        onClose={() => setConfirm(false)}
        onConfirm={() => bind.mutate()}
        loading={bind.isPending}
        title="Approve binding?"
        confirmLabel="Bind treaty"
        message="Binding transitions the treaty to BOUND, books the deposit premium as a financial event and runs accumulation control. This is a material accounting action."
      />
    </Card>
  );
}

// --- Claim: cash-call maker/checker -----------------------------------------

interface CashCall {
  id: string;
  claimId: string;
  claimReference: string | null;
  contractId: string | null;
  amountMinor: number;
  currency: string;
  status: string;
  priority: string;
  requestedDate: string | null;
  approvedAt: string | null;
}

const PRIORITY_COLOR: Record<string, 'red' | 'orange' | 'slate'> = {
  SIMULTANEOUS_SETTLEMENT: 'red', URGENT: 'orange', NORMAL: 'slate',
};
const CALL_STATUS_COLOR: Record<string, 'amber' | 'green' | 'teal'> = {
  requested: 'amber', approved: 'green', paid: 'teal',
};

function ClaimApproval({ entityId }: { entityId: string }) {
  const { hasPermission } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const [confirm, setConfirm] = useState<{ call: CashCall; action: 'approve' | 'pay' } | null>(null);

  const canWrite = hasPermission('claims:write');
  const q = useQuery({
    queryKey: ['cash-calls', 'queue'],
    queryFn: () => api<{ queue: CashCall[] }>('/api/claims/cash-calls/queue'),
  });
  const calls = (q.data?.queue ?? []).filter((c) => c.claimId === entityId);

  const decide = useMutation({
    mutationFn: ({ call, action }: { call: CashCall; action: 'approve' | 'pay' }) =>
      api(`/api/claims/${entityId}/cash-call/${call.id}/${action}`, { method: 'POST' }),
    onSuccess: (_r, v) => {
      qc.invalidateQueries({ queryKey: ['cash-calls', 'queue'] });
      qc.invalidateQueries({ queryKey: ['claim', entityId] });
      toast.success(v.action === 'approve' ? 'Cash call approved' : 'Cash call paid');
      setConfirm(null);
    },
    onError: (e) => {
      toast.error(e instanceof ApiError ? e.message : 'Action failed');
      setConfirm(null);
    },
  });

  return (
    <Card>
      <CardHeader
        title="Approval & authority"
        subtitle="Cash-call maker/checker - an advance on the loss must be approved before payment."
        actions={<Badge color="blue"><ShieldCheck size={12} /> Segregation of duties</Badge>}
      />
      <div className={styles.stack}>
        <div className={styles.note}>
          <Info size={14} className={styles.noteIcon} />
          <span>
            Maker/checker: the person who requested a cash call cannot approve their own - the server
            enforces this (segregation of duties) and rejects the attempt. Approving and paying both
            require the <code>claims:write</code> permission.
          </span>
        </div>

        {q.isLoading ? (
          <span className={styles.contextValue}>Loading cash calls...</span>
        ) : calls.length === 0 ? (
          <EmptyState
            icon={<CircleDollarSign size={16} />}
            title="No open cash calls"
            message="Raise a cash call from the claim (Add movement / Pay) to advance funds on this loss. Requested calls appear here for approval."
          />
        ) : (
          <div className={styles.callList}>
            {calls.map((c) => (
              <div key={c.id} className={styles.callRow}>
                <div className={styles.callMain}>
                  <span className={styles.amount}>{formatMoney(c.amountMinor, c.currency)}</span>
                  <span className={styles.callRef}>
                    Requested {c.requestedDate ?? '-'} · <Badge color={PRIORITY_COLOR[c.priority] ?? 'slate'}>{titleCase(c.priority)}</Badge>
                  </span>
                </div>
                <Badge color={CALL_STATUS_COLOR[c.status] ?? 'gray'}>{titleCase(c.status)}</Badge>
                {canWrite && (
                  <div className={styles.actions}>
                    {c.status === 'requested' && (
                      <Button size="sm" variant="primary" icon={<ThumbsUp size={13} />} loading={decide.isPending} onClick={() => setConfirm({ call: c, action: 'approve' })}>
                        Approve
                      </Button>
                    )}
                    {c.status === 'approved' && (
                      <Button size="sm" variant="secondary" icon={<CircleDollarSign size={13} />} loading={decide.isPending} onClick={() => setConfirm({ call: c, action: 'pay' })}>
                        Release payment
                      </Button>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      <ConfirmDialog
        open={!!confirm}
        onClose={() => setConfirm(null)}
        onConfirm={() => confirm && decide.mutate(confirm)}
        loading={decide.isPending}
        title={confirm?.action === 'pay' ? 'Release cash-call payment?' : 'Approve cash call?'}
        confirmLabel={confirm?.action === 'pay' ? 'Release payment' : 'Approve'}
        message={
          confirm?.action === 'pay'
            ? 'This releases payment on an approved cash call. Material claims-payment action.'
            : 'Approving a cash call clears it for payment. The requester cannot approve their own call; if you raised it the server will reject this.'
        }
      />
    </Card>
  );
}
