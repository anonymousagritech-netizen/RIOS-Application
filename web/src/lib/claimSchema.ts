/**
 * Claim FNOL field registry (metadata for the Dynamic Form Engine).
 *
 * These are the first-notification-of-loss essentials that real reinsurance
 * systems (SAP FS-RI, Sapiens ReinsuranceMaster, Guidewire) capture on every
 * claim regardless of class: cause/peril coding, catastrophe attribution, place
 * of loss, reserving class and the litigation / recovery outlook. They render
 * alongside the class-specific LOB groups (lobSchema.ts), which supply the
 * peril-appropriate risk fields for the treaty's line of business.
 *
 * Adaptivity comes from `when(ctx)` predicates reading the form's own values,
 * which the modal injects into the FormContext: the catastrophe name only shows
 * once the loss is flagged as a catastrophe, and the litigation follow-ups only
 * show once litigation is confirmed. Values persist into the claim's `details` bag.
 */
import type { FieldGroup } from './formEngine';

export const CLAIM_FNOL_GROUPS: FieldGroup[] = [
  {
    id: 'fnol',
    title: 'Loss circumstances',
    description: 'First-notification essentials captured for every loss.',
    fields: [
      {
        key: 'perilCode',
        label: 'Peril / cause code',
        type: 'select',
        required: true,
        options: ['Fire', 'Windstorm', 'Flood', 'Earthquake', 'Hail', 'Collision', 'Theft', 'Liability', 'Business interruption', 'Other'],
        hint: 'Primary cause of loss for occurrence coding.',
      },
      { key: 'placeOfLoss', label: 'Place of loss', placeholder: 'e.g. Miami, FL, USA', maxLength: 120 },
      {
        key: 'catastrophe',
        label: 'Catastrophe loss?',
        type: 'select',
        options: ['No', 'Yes'],
        hint: 'Flag if the loss belongs to a catastrophe event.',
      },
      {
        key: 'catName',
        label: 'Catastrophe name',
        placeholder: 'e.g. Hurricane Milton',
        // Cross-field: only relevant once the loss is flagged as a catastrophe,
        // and mandatory once it is, so the event can be attributed.
        when: (ctx) => ctx.catastrophe === 'Yes',
        validate: (v, ctx) => (ctx.catastrophe === 'Yes' && !v ? 'Catastrophe name is required for a catastrophe loss' : undefined),
      },
      {
        key: 'reservingClass',
        label: 'Reserving class',
        type: 'select',
        options: ['Attritional', 'Large', 'Catastrophe', 'Latent'],
        hint: 'Drives the reserving segment the case falls into.',
      },
    ],
  },
  {
    id: 'fnol-legal',
    title: 'Litigation & recovery outlook',
    description: 'Legal exposure and recovery potential on the claim.',
    fields: [
      { key: 'litigation', label: 'Litigation involved?', type: 'select', options: ['No', 'Yes'] },
      {
        key: 'litigationForum',
        label: 'Litigation forum / jurisdiction',
        placeholder: 'e.g. Florida State Court',
        // Cross-field: litigation follow-ups appear only once litigation = Yes,
        // and the forum must then be named to route the case correctly.
        when: (ctx) => ctx.litigation === 'Yes',
        validate: (v, ctx) => (ctx.litigation === 'Yes' && !v ? 'Litigation forum is required when litigation is involved' : undefined),
      },
      {
        key: 'legalDefenceReserve',
        label: 'Estimated legal defence cost',
        type: 'number',
        min: 0,
        placeholder: 'e.g. 50000',
        when: (ctx) => ctx.litigation === 'Yes',
      },
      {
        key: 'subrogation',
        label: 'Subrogation potential',
        type: 'select',
        options: ['None', 'Possible', 'Likely', 'In progress'],
        hint: 'Prospect of recovering from a liable third party.',
      },
    ],
  },
];
