/**
 * Hashtags: reading them out of AT Protocol posts, writing them into ours, and
 * choosing a community's starting set from its name.
 */

export const MAX_TAGS = 30
const MAX_TAG_LEN = 64

/** "#Genealogy" / "genealogy" -> "genealogy". Null for anything that is not a usable tag. */
export function normalizeTag(value: unknown): string | null {
  let t = String(value ?? '').normalize('NFKC').trim().replace(/^[#＃]+/, '').toLowerCase()
  t = t.replace(/[\p{P}\p{S}]+$/u, '')
  if (!t || t.length > MAX_TAG_LEN) return null
  if (/[\s#＃]/u.test(t)) return null
  if (/^\d+$/.test(t)) return null
  return t
}

const TAG_IN_TEXT = /(?:^|[\s(])[#＃]([^\s#＃]+)/gu

/** Tags written as #word in text, in order, deduplicated. */
export function tagsInText(text: string): string[] {
  const out = new Set<string>()
  for (const m of String(text ?? '').matchAll(TAG_IN_TEXT)) {
    const t = normalizeTag(m[1])
    if (t) out.add(t)
  }
  return [...out]
}

/** Tags of an app.bsky.feed.post record: `app.bsky.richtext.facet#tag` features, plus #word in the text, plus the record's own `tags`. */
export function extractTags(record: any): string[] {
  const out = new Set<string>()
  for (const facet of Array.isArray(record?.facets) ? record.facets : []) {
    for (const f of Array.isArray(facet?.features) ? facet.features : []) {
      if (f?.$type === 'app.bsky.richtext.facet#tag') {
        const t = normalizeTag(f.tag)
        if (t) out.add(t)
      }
    }
  }
  for (const t of tagsInText(typeof record?.text === 'string' ? record.text : '')) out.add(t)
  for (const raw of Array.isArray(record?.tags) ? record.tags.slice(0, 8) : []) {
    const t = normalizeTag(raw)
    if (t) out.add(t)
  }
  return [...out]
}

/** Tag facets for our own posts, with UTF-8 byte offsets as the lexicon requires. */
export function tagFacets(text: string): { index: { byteStart: number; byteEnd: number }; features: { $type: string; tag: string }[] }[] {
  const enc = new TextEncoder()
  const facets: ReturnType<typeof tagFacets> = []
  for (const m of text.matchAll(TAG_IN_TEXT)) {
    const raw = m[1]!.replace(/[\p{P}\p{S}]+$/u, '')
    const tag = normalizeTag(raw)
    if (!tag) continue
    const hashAt = m.index! + m[0].length - m[1]!.length - 1
    const byteStart = enc.encode(text.slice(0, hashAt)).length
    const byteEnd = byteStart + enc.encode(text.slice(hashAt, hashAt + 1 + raw.length)).length
    facets.push({ index: { byteStart, byteEnd }, features: [{ $type: 'app.bsky.richtext.facet#tag', tag: raw }] })
  }
  return facets
}

/** Single words that would flood a niche feed if followed alone (#family is everyone's dinner). */
const GENERIC = new Set(
  'family life love home day days good new best top rank world news social app apps web online net site my the and of for you me us club group people time live now today shop store official hub zone space info blog page link links media pit'.split(' '),
)

/** A small map from common niche words to the tags their communities actually use. */
export const SYNONYMS: Record<string, string[]> = {
  ancestry: ['ancestry', 'genealogy', 'familyhistory', 'familytree', 'familysearch'],
  genealogy: ['genealogy', 'familyhistory', 'familytree', 'ancestry'],
  familyancestry: ['genealogy', 'familyhistory', 'familytree'],
  seo: ['seo', 'searchengineoptimization', 'technicalseo', 'localseo'],
  seorank: ['seo', 'searchengineoptimization', 'serp'],
  rank: ['seo', 'serp'],
  crypto: ['crypto', 'cryptocurrency', 'bitcoin', 'ethereum', 'web3'],
  bitcoin: ['bitcoin', 'btc', 'lightning'],
  ai: ['ai', 'machinelearning', 'llm', 'artificialintelligence'],
  code: ['coding', 'programming', 'softwaredevelopment', 'devs'],
  coding: ['coding', 'programming', 'softwaredevelopment'],
  dev: ['coding', 'programming', 'webdev'],
  linux: ['linux', 'opensource', 'foss'],
  opensource: ['opensource', 'foss'],
  garden: ['gardening', 'garden', 'plants', 'growyourown'],
  gardening: ['gardening', 'plants', 'growyourown'],
  cooking: ['cooking', 'recipes', 'foodie'],
  recipes: ['recipes', 'cooking'],
  food: ['food', 'foodie', 'recipes'],
  fitness: ['fitness', 'workout', 'gym'],
  running: ['running', 'runners', 'marathon'],
  photo: ['photography', 'photooftheday'],
  photography: ['photography', 'photooftheday', 'streetphotography'],
  music: ['music', 'newmusic', 'nowplaying'],
  books: ['books', 'reading', 'booksky', 'amreading'],
  reading: ['reading', 'books', 'booksky'],
  writing: ['writing', 'writingcommunity', 'amwriting'],
  art: ['art', 'artists', 'illustration', 'digitalart'],
  gaming: ['gaming', 'videogames', 'indiegames'],
  games: ['gaming', 'videogames', 'indiegames', 'boardgames'],
  podcast: ['podcast', 'podcasts', 'podcasting'],
  podcasts: ['podcast', 'podcasts', 'podcasting'],
  tv: ['tv', 'television', 'streaming'],
  movies: ['movies', 'film', 'cinema'],
  film: ['film', 'movies', 'cinema', 'filmsky'],
  science: ['science', 'scicomm', 'sciencesky'],
  space: ['space', 'astronomy', 'nasa'],
  astronomy: ['astronomy', 'astrophotography', 'space'],
  birds: ['birds', 'birding', 'birdwatching'],
  dogs: ['dogs', 'dogsofbluesky'],
  cats: ['cats', 'catsofbluesky'],
  travel: ['travel', 'travelphotography'],
  security: ['infosec', 'cybersecurity', 'security'],
  infosec: ['infosec', 'cybersecurity'],
  privacy: ['privacy', 'dataprivacy'],
  jobs: ['jobs', 'hiring', 'remotejobs'],
  hiring: ['hiring', 'jobs'],
  startups: ['startups', 'startup', 'entrepreneurship'],
  marketing: ['marketing', 'digitalmarketing', 'contentmarketing'],
  tsbb: ['bbs', 'forums'],
  bbs: ['bbs', 'retrocomputing'],
  retro: ['retrocomputing', 'retrogaming'],
  iptv: ['iptv', 'cordcutting'],
  torrents: ['torrents', 'bittorrent'],
  selfhosted: ['selfhosted', 'homelab'],
  homelab: ['homelab', 'selfhosted'],
}

/** Words in a listing description that say nothing about the niche. */
const LISTING_STOP = new Set(
  'about above after again against private public include includes including source sources photos photo charts chart invites invite import export trees tree people person online worldwide service services company business simple without tracking through every other their there these those where which while within anyone someone something everything nothing account accounts website websites download free open based provide provides product products platform software system systems network networks community communities members member better faster easily directly instead support supports'.split(
    ' ',
  ),
)

/**
 * The tags a community starts with: its name's labels (minus words too generic to
 * follow alone), the labels joined (#familyancestry), synonyms for known niches, and
 * a few niche words from its pit.world listing. The admin can change them all.
 */
export function defaultTags(name: string, listing?: { description?: string; services?: string[]; name?: string } | null): string[] {
  const out = new Set<string>()
  const add = (t: unknown) => {
    const n = normalizeTag(t)
    if (n && out.size < MAX_TAGS) out.add(n)
  }
  const labels = name.split('.').map((l) => l.replace(/-/g, ''))
  if (labels.length > 1) add(labels.join(''))
  for (const l of labels) if (!GENERIC.has(l) && l.length >= 2) add(l)
  for (const key of [labels.join(''), ...labels]) for (const s of SYNONYMS[key] ?? []) add(s)
  if (listing) {
    const words = `${listing.description ?? ''} ${(listing.services ?? []).join(' ')}`.toLowerCase().match(/[a-z][a-z0-9]+/g) ?? []
    let extra = 0
    for (const w of new Set(words)) {
      if (extra >= 6) break
      if (SYNONYMS[w] || Object.values(SYNONYMS).some((v) => v.includes(w))) {
        if (!out.has(w)) extra++
        add(w)
        for (const s of (SYNONYMS[w] ?? []).slice(0, 2)) add(s)
      } else if (w.length >= 6 && !LISTING_STOP.has(w) && !GENERIC.has(w) && extra < 3) {
        // A long, specific word ("gedcom", "pedigree") is a plausible niche tag.
        if (!out.has(w)) extra++
        add(w)
      }
    }
  }
  return [...out]
}

/** Parse the admin's tag list (one per line, commas or spaces), normalized, deduplicated, capped. */
export function parseTagList(value: unknown): string[] {
  const out = new Set<string>()
  for (const raw of String(value ?? '').split(/[\s,]+/)) {
    const t = normalizeTag(raw)
    if (t) out.add(t)
    if (out.size >= MAX_TAGS) break
  }
  return [...out]
}
