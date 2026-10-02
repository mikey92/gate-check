import {defineArrayMember, defineField, defineType} from 'sanity'

// One captured copy of a page that states a battery rule.
// Sources are kept separate from rules so that two pages can disagree and both stay on record.
export const source = defineType({
  name: 'source',
  title: 'Source',
  type: 'document',
  fields: [
    defineField({name: 'title', type: 'string', validation: (rule) => rule.required()}),
    defineField({name: 'url', type: 'url', validation: (rule) => rule.required()}),
    defineField({
      name: 'kind',
      description: 'Official pages outrank news coverage, which outranks aggregators and blogs.',
      type: 'string',
      options: {
        list: [
          {title: 'Official page of the authority', value: 'official'},
          {title: 'News report', value: 'news'},
          {title: 'Aggregator or blog', value: 'aggregator'},
        ],
        layout: 'radio',
      },
      validation: (rule) => rule.required(),
    }),
    defineField({name: 'publisher', type: 'string'}),
    defineField({
      name: 'language',
      type: 'string',
      options: {list: [{title: 'English', value: 'en'}, {title: 'Korean', value: 'ko'}, {title: 'Chinese', value: 'zh'}, {title: 'Japanese', value: 'ja'}]},
      initialValue: 'en',
    }),
    defineField({
      name: 'capturedAt',
      description: 'When this copy was read. Listings change; the date tells you how stale a claim may be.',
      type: 'datetime',
      validation: (rule) => rule.required(),
    }),
    defineField({
      name: 'lastUpdated',
      description: 'The update date the page itself shows, as written.',
      type: 'string',
    }),
    defineField({name: 'authority', type: 'reference', to: [{type: 'authority'}], validation: (rule) => rule.required()}),
    defineField({
      name: 'body',
      description: 'The relevant text of the page as captured, quoted rather than paraphrased.',
      type: 'array',
      of: [defineArrayMember({type: 'block'})],
    }),
  ],
  preview: {
    select: {title: 'title', kind: 'kind', language: 'language', capturedAt: 'capturedAt'},
    prepare: ({title, kind, language, capturedAt}) => ({
      title,
      subtitle: [kind, language, capturedAt?.slice(0, 10)].filter(Boolean).join(' · '),
    }),
  },
})
