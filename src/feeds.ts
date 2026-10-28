/**
 * Minimal, tolerant RSS 2.0 / Atom reader plus the sanitizers every feed- or model-supplied string goes through
 * before it reaches a GitHub issue. Regex-based on purpose: no XML parser is installed and the feeds only need
 * item/entry blocks with a few text fields.
 */
export interface FeedItem {
  id: string;
  title: string;
  url: string;
  summary: string;
  /** ISO timestamp. */
  published: string;
  /** arXiv id without version, when the item is an arXiv paper. */
  arxivId?: string;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const decode = (s: string) =>
  s.replace(/&(?:#x([0-9a-f]+)|#(\d+)|([a-z]+));/gi, (m, hex, dec, name) => {
    const code = hex ? parseInt(hex, 16) : dec ? Number(dec) : undefined;
    if (code !== undefined) return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    return ENTITIES[String(name).toLowerCase()] ?? m;
  });

const TAG = /<\/?([a-zA-Z!][a-zA-Z0-9]*)[^>]*>/g;
// Block tags separate words; inline tags (<b>, <a>) do not.
const tagToSpace = (_m: string, name: string) => (/^(?:p|br|div|li|ul|ol|h\d|tr|td|th|table|blockquote|pre|section|article)$/i.test(name) ? ' ' : '');

/** Plain text from possibly-HTML input: tags (and script/style bodies) removed, entities decoded, whitespace collapsed. */
export function stripHtml(s: string): string {
  const noTags = s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(TAG, tagToSpace);
  // Decode once, then strip again: feeds often carry escaped HTML (&lt;p&gt;).
  const text = decode(noTags).replace(TAG, tagToSpace);
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2060\ufeff]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Plain text safe to place in an issue: HTML stripped, @mentions and #123 references defused, length capped. */
export function sanitize(s: string, max: number): string {
  const t = stripHtml(s).replace(/@(?=[A-Za-z0-9_])/g, '@\u200b').replace(/#(?=\d)/g, '#\u200b').replace(/[`]/g, "'");
  return t.length > max ? t.slice(0, max - 1).trimEnd() + '…' : t;
}

const tag = (block: string, name: string) => {
  const m = block.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}\\s*>`, 'i'));
  return m ? stripHtml(m[1]!) : '';
};

function link(block: string): string {
  const links = [...block.matchAll(/<link\b([^>]*?)\/?>(?:([^<]*)<\/link>)?/gi)].map((m) => ({ attrs: m[1]!, text: (m[2] ?? '').trim() }));
  const pick = links.find((l) => /rel=["']alternate["']/.test(l.attrs)) ?? links.find((l) => !/rel=|title=/.test(l.attrs)) ?? links[0];
  const href = pick?.attrs.match(/href=["']([^"']+)["']/)?.[1] ?? pick?.text ?? '';
  const url = decode(href.trim());
  return /^https?:\/\//i.test(url) ? url : '';
}

/** Items from an RSS or Atom document; entries without a title, link or valid date are dropped. */
export function parseFeed(xml: string): FeedItem[] {
  const out: FeedItem[] = [];
  for (const m of xml.matchAll(/<(item|entry)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi)) {
    const b = m[2]!;
    const url = link(b) || (/^https?:\/\//.test(tag(b, 'guid')) ? tag(b, 'guid') : '');
    const date = Date.parse(tag(b, 'pubDate') || tag(b, 'published') || tag(b, 'dc:date') || tag(b, 'updated'));
    const title = tag(b, 'title');
    if (!title || !url || Number.isNaN(date)) continue;
    const id = tag(b, 'guid') || tag(b, 'id') || url;
    const arxivId = id.match(/arxiv\.org\/abs\/(.+?)(?:v\d+)?$/i)?.[1];
    out.push({ id, title, url, summary: tag(b, 'summary') || tag(b, 'description') || tag(b, 'content:encoded') || tag(b, 'content'), published: new Date(date).toISOString(), ...(arxivId ? { arxivId } : {}) });
  }
  return out;
}
