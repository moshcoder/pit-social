import { describe, expect, test } from 'bun:test'
import { defaultTags, extractTags, normalizeTag, parseTagList, tagFacets, tagsInText, MAX_TAGS } from '../src/tags.ts'

describe('tags', () => {
  test('normalize', () => {
    expect(normalizeTag('#Genealogy')).toBe('genealogy')
    expect(normalizeTag('genealogy!')).toBe('genealogy')
    expect(normalizeTag('2024')).toBeNull()
    expect(normalizeTag('two words')).toBeNull()
    expect(normalizeTag('')).toBeNull()
    expect(normalizeTag('ＧＥＤＣＯＭ')).toBe('gedcom')
  })

  test('from text', () => {
    expect(tagsInText('Found grandpa in the 1910 census! #Genealogy #FamilyHistory, #genealogy')).toEqual(['genealogy', 'familyhistory'])
    expect(tagsInText('no tags, an email a#b and C# and #1')).toEqual([])
    expect(tagsInText('(#seo) line\n#rank.')).toEqual(['seo', 'rank'])
  })

  test('from facets, text and record tags', () => {
    const record = {
      $type: 'app.bsky.feed.post',
      text: 'New post about #familytree research',
      facets: [
        { index: { byteStart: 0, byteEnd: 4 }, features: [{ $type: 'app.bsky.richtext.facet#tag', tag: 'Ancestry' }] },
        { index: { byteStart: 5, byteEnd: 9 }, features: [{ $type: 'app.bsky.richtext.facet#link', uri: 'https://x.test/#notatag' }] },
      ],
      tags: ['GEDCOM'],
    }
    expect(extractTags(record).sort()).toEqual(['ancestry', 'familytree', 'gedcom'])
    expect(extractTags({})).toEqual([])
    expect(extractTags({ text: 42, facets: 'x' })).toEqual([])
  })

  test('facets use UTF-8 byte offsets', () => {
    const text = 'héllo #genealogy wörld #Ahnen!'
    const facets = tagFacets(text)
    const bytes = new TextEncoder().encode(text)
    const slice = (f: (typeof facets)[number]) => new TextDecoder().decode(bytes.slice(f.index.byteStart, f.index.byteEnd))
    expect(facets.map(slice)).toEqual(['#genealogy', '#Ahnen'])
    expect(facets[1]!.features[0]!.tag).toBe('Ahnen')
  })

  test('defaults from the name, synonyms and listing', () => {
    const fa = defaultTags('family.ancestry')
    expect(fa).toContain('familyancestry')
    expect(fa).toContain('ancestry')
    expect(fa).toContain('genealogy')
    expect(fa).not.toContain('family') // too generic to follow alone
    const seo = defaultTags('seo.rank')
    expect(seo).toContain('seo')
    expect(seo).toContain('searchengineoptimization')
    expect(seo).not.toContain('rank')
    const withListing = defaultTags('family.ancestry', { description: 'Private family trees: GEDCOM import and export, pedigree charts, photos.' })
    expect(withListing).toContain('gedcom')
    expect(withListing).toContain('pedigree')
    expect(withListing).not.toContain('photos')
  })

  test('admin tag list is capped and normalized', () => {
    const many = Array.from({ length: 50 }, (_, i) => `#tag${i}`).join(', ')
    expect(parseTagList(many)).toHaveLength(MAX_TAGS)
    expect(parseTagList('#SEO\nseo, rank  rank')).toEqual(['seo', 'rank'])
  })
})
