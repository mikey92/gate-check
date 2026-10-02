import {defineField, defineType} from 'sanity'

// Whoever sets or restates a rule: a regulator, an industry body, an airline, an airport, or a third-party publisher.
export const authority = defineType({
  name: 'authority',
  title: 'Authority',
  type: 'document',
  fields: [
    defineField({name: 'name', type: 'string', validation: (rule) => rule.required()}),
    defineField({name: 'slug', type: 'slug', options: {source: 'name'}, validation: (rule) => rule.required()}),
    defineField({
      name: 'kind',
      type: 'string',
      options: {
        list: [
          {title: 'Regulator', value: 'regulator'},
          {title: 'Industry body', value: 'industry'},
          {title: 'Airline', value: 'airline'},
          {title: 'Airport', value: 'airport'},
          {title: 'Third-party publisher', value: 'publisher'},
        ],
        layout: 'radio',
      },
      validation: (rule) => rule.required(),
    }),
    defineField({
      name: 'country',
      description: 'ISO 3166-1 alpha-2 code, e.g. KR or US. Empty for worldwide bodies.',
      type: 'string',
      validation: (rule) => rule.regex(/^[A-Z]{2}$/).warning('Use a two-letter country code'),
    }),
    defineField({
      name: 'codes',
      description: 'IATA airline code and other names people type, e.g. KE, Korean Air, 대한항공.',
      type: 'array',
      of: [{type: 'string'}],
      options: {layout: 'tags'},
    }),
    defineField({name: 'website', type: 'url'}),
  ],
  preview: {
    select: {title: 'name', kind: 'kind', country: 'country'},
    prepare: ({title, kind, country}) => ({title, subtitle: [kind, country].filter(Boolean).join(' · ')}),
  },
})
