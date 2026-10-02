import {defineArrayMember, defineField, defineType} from 'sanity'

const tri = (values: string[]) => ({list: values, layout: 'radio' as const})

// One authority's rule for spare lithium-ion batteries (power banks) in passenger baggage,
// broken into the numbers and switches code can evaluate, with the exact wording behind each.
export const batteryRule = defineType({
  name: 'batteryRule',
  title: 'Battery rule',
  type: 'document',
  groups: [
    {name: 'basics', title: 'Basics', default: true},
    {name: 'limits', title: 'Limits'},
    {name: 'onboard', title: 'On board'},
    {name: 'evidence', title: 'Evidence'},
  ],
  fields: [
    defineField({name: 'title', type: 'string', group: 'basics', validation: (rule) => rule.required()}),
    defineField({
      name: 'authority',
      type: 'reference',
      to: [{type: 'authority'}],
      group: 'basics',
      validation: (rule) => rule.required(),
    }),
    defineField({
      name: 'source',
      description: 'The page this rule is taken from.',
      type: 'reference',
      to: [{type: 'source'}],
      group: 'basics',
      validation: (rule) => rule.required(),
    }),
    defineField({
      name: 'scope',
      description: 'Which flights the rule binds.',
      type: 'string',
      group: 'basics',
      options: {
        list: [
          {title: "Flights operated by this airline", value: 'carrier'},
          {title: "Flights departing this authority's country", value: 'departing'},
          {title: "Domestic flights in this authority's country", value: 'domestic'},
          {title: 'Worldwide standard (ICAO)', value: 'worldwide'},
          {title: 'Advisory guidance (reported, not binding)', value: 'guidance'},
        ],
      },
      validation: (rule) => rule.required(),
    }),
    defineField({name: 'effectiveFrom', type: 'date', group: 'basics'}),
    defineField({
      name: 'status',
      type: 'string',
      group: 'basics',
      options: {
        list: [
          {title: 'Confirmed by the official source', value: 'confirmed'},
          {title: 'Sources disagree', value: 'disputed'},
          {title: 'Only a third party says so', value: 'unverified'},
        ],
        layout: 'radio',
      },
      initialValue: 'confirmed',
    }),
    defineField({
      name: 'limits',
      type: 'object',
      group: 'limits',
      fields: [
        defineField({name: 'freeMaxWh', title: 'Largest battery allowed without approval (Wh)', type: 'number'}),
        defineField({name: 'approvalMaxWh', title: 'Largest battery allowed with airline approval (Wh)', type: 'number'}),
        defineField({
          name: 'maxWh',
          title: 'Largest battery allowed (Wh), approval not stated',
          description: 'Use when the source gives a ceiling without saying whether approval is needed below it.',
          type: 'number',
        }),
        defineField({name: 'freeMaxCount', title: 'Most batteries allowed without approval', description: 'Leave empty when the source sets no number.', type: 'number'}),
        defineField({name: 'approvalMaxCount', title: 'Most batteries allowed in the approval band', type: 'number'}),
        defineField({name: 'totalMaxCount', title: 'Most power banks allowed in total', type: 'number'}),
      ],
    }),
    defineField({
      name: 'onboard',
      type: 'object',
      group: 'onboard',
      fields: [
        defineField({name: 'checkedBaggage', type: 'string', options: tri(['forbidden', 'allowed', 'unknown'])}),
        defineField({
          name: 'useInFlight',
          title: 'Using it to charge devices in flight',
          description: '"restricted" means not during taxi, take-off and landing; "discouraged" means the source says should not.',
          type: 'string',
          options: tri(['allowed', 'restricted', 'discouraged', 'forbidden', 'unknown']),
        }),
        defineField({name: 'rechargeInFlight', title: 'Recharging it from seat power', type: 'string', options: tri(['allowed', 'discouraged', 'forbidden', 'unknown'])}),
        defineField({name: 'overheadBin', type: 'string', options: tri(['allowed', 'discouraged', 'forbidden', 'unknown'])}),
        defineField({name: 'keepVisible', title: 'Must stay visible or supervised while in use', type: 'string', options: tri(['required', 'not stated'])}),
        defineField({name: 'protection', title: 'Terminal protection (tape, bag, pouch)', type: 'string', options: tri(['required', 'recommended', 'not stated'])}),
        defineField({name: 'labelRequired', title: 'Capacity must be readable on the battery', type: 'string', options: tri(['required', 'not stated'])}),
        defineField({name: 'certification', description: 'A mark the battery must carry, e.g. CCC (3C).', type: 'string'}),
      ],
    }),
    defineField({
      name: 'quotes',
      description: 'The exact wording behind each field, with the source it came from.',
      type: 'array',
      group: 'evidence',
      of: [
        defineArrayMember({
          type: 'object',
          name: 'quote',
          fields: [
            defineField({name: 'field', type: 'string'}),
            defineField({name: 'text', type: 'text', rows: 2}),
            defineField({name: 'source', type: 'reference', to: [{type: 'source'}]}),
          ],
          preview: {select: {title: 'field', subtitle: 'text'}},
        }),
      ],
    }),
    defineField({name: 'note', type: 'text', rows: 3, group: 'evidence'}),
  ],
  preview: {
    select: {title: 'title', authority: 'authority.name', status: 'status', freeMaxWh: 'limits.freeMaxWh'},
    prepare: ({title, authority, status, freeMaxWh}) => ({
      title,
      subtitle: [authority, freeMaxWh ? `${freeMaxWh} Wh` : null, status !== 'confirmed' ? status : null].filter(Boolean).join(' · '),
    }),
  },
})
