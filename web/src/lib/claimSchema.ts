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
        options: ['Fire', 'Windstorm', 'Flood', 'Earthquake', 'Hail', 'Collision', 'Theft', 'Liability', 'Business interruption', 'Other'],
        hint: 'Primary cause of loss for occurrence coding.',
      },
      { key: 'placeOfLoss', label: 'Place of loss', placeholder: 'e.g. Miami, FL, USA' },
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
        // Cross-field: only relevant once the loss is flagged as a catastrophe.
        when: (ctx) => ctx.catastrophe === 'Yes',
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
        // Cross-field: litigation follow-ups appear only once litigation = Yes.
        when: (ctx) => ctx.litigation === 'Yes',
      },
      {
        key: 'legalDefenceReserve',
        label: 'Estimated legal defence cost',
        type: 'number',
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
