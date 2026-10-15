// Browser-safe display primitives shared by the editor and Node renderers.
// Locale catalog loading stays in i18n.mjs on the Node side of this boundary.
import { assertFontFields, assertFontSize } from './font-size.mjs';

export function arrowGeometry(scale = 1) {
  // Leave one scaled unit past the apex; retain the earlier local clipping fix.
  return { markerWidth: 11 * scale, markerHeight: 7 * scale, refX: 9 * scale, refY: 3.5 * scale,
    points: `0 0, ${10 * scale} ${3.5 * scale}, 0 ${7 * scale}` };
}

export const SEMANTIC_SIGIL_INSET = 6;
export const SEMANTIC_SIGIL_SIZE = 11;
export const SEMANTIC_SIGIL_FOOTPRINT = SEMANTIC_SIGIL_INSET + SEMANTIC_SIGIL_SIZE;
// The viewer installs a runtime "sources" beacon on the node's top-right
// rail, just left of the brand mark. Layout must reserve the same footprint
// so labels never sit under the badge.
export const SOURCE_BADGE_FOOTPRINT = 38;

export function createCards(cards, document) {
  assertFontFields(cards);
  const container = document.createElement('div');
  container.className = 'cards';
  const element = (tag, className, content, parent, size) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (content != null) node.textContent = content;
    if (size != null) {
      node.style.fontSize = `${assertFontSize(size)}px`;
      node.style.lineHeight = '1.5';
      node.style.overflowWrap = 'anywhere';
    }
    parent.appendChild(node);
    return node;
  };
  for (const card of (Array.isArray(cards) ? cards : [])) {
    const node = element('div', 'card', null, container);
    const header = element('div', 'card-header', null, node);
    element('div', `card-dot ${card.dot ?? ''}`, null, header);
    element('h3', '', card.title, header, card.font_sizes?.title);
    const list = element('ul', '', null, node);
    card.items.forEach((item, index) => element('li', '', item, list, card.font_sizes?.items?.[index]));
  }
  return container;
}

// CJK and other wide/fullwidth glyphs render at roughly twice the advance
// width of ASCII in the monospace stacks the template uses. Keep halfwidth
// forms (notably U+FF61–U+FF9F Katakana) out of this set. The explicit ranges
// also cover vertical punctuation and supplementary East Asian scripts that
// literal glyph ranges made difficult to audit.
// Code points that take two columns of advance width: East Asian Wide and
// Fullwidth per UAX #11, tracking Unicode 17.0. That takes in the BMP symbols
// carrying emoji presentation (U+2705, U+2B50, U+26A1, U+231B, ...), which
// render at the same square advance as the supplementary-plane emoji already
// listed here, and Hangul Jamo Extended-A. Two boundary calls worth naming:
// Unicode 16.0 reclassified the trigrams (U+2630-U+2637) and the monogram /
// digram symbols (U+268A-U+268F) from Neutral to Wide, so both are in; and
// Hangul Jamo Extended-A stops at U+A97C, its last assigned jamo, because
// U+A97D-U+A97F are unassigned, and unassigned code points outside the CJK
// ranges UAX #11 names default to Neutral rather than Wide. Spelled out as
// ranges because V8 has no \p{East_Asian_Width=W} property escape.
const FULLWIDTH_RE = /[\u1100-\u115F\u231A-\u231B\u2329-\u232A\u23E9-\u23EC\u23F0\u23F3\u25FD-\u25FE\u2614-\u2615\u2630-\u2637\u2648-\u2653\u267F\u268A-\u268F\u2693\u26A1\u26AA-\u26AB\u26BD-\u26BE\u26C4-\u26C5\u26CE\u26D4\u26EA\u26F2-\u26F3\u26F5\u26FA\u26FD\u2705\u270A-\u270B\u2728\u274C\u274E\u2753-\u2755\u2757\u2795-\u2797\u27B0\u27BF\u2B1B-\u2B1C\u2B50\u2B55\u2E80-\uA4CF\uA960-\uA97C\uAC00-\uD7A3\uF900-\uFAFF\uFE10-\uFE19\uFE30-\uFE6F\uFF01-\uFF60\uFFE0-\uFFE6\u{16FE0}-\u{18DFF}\u{1AFF0}-\u{1AFFF}\u{1B000}-\u{1B2FF}\u{1F000}-\u{1FAFF}\u{20000}-\u{3FFFD}]/u;

// Variation selectors contribute no separate unit. This is a conservative
// width estimate, not a measurement of the selected glyph: its actual advance
// depends on the font and presentation (Unicode UAX #11).
// VS16 requests emoji presentation, so reserve two units for the sequence.
// VS15 retains the base's width estimate; forcing every text-presentation
// sequence to one unit undercounts wide bases, including CJK characters whose
// font ignores that selector. Neutral bases remain one unit. Some selected
// text glyphs can be narrower than this estimate; prefer extra space to overflow.
const VARIATION_SELECTOR_FIRST = 0xfe00;
const VARIATION_SELECTOR_LAST = 0xfe0f;
const VARIATION_SELECTOR_EMOJI = 0xfe0f;

// Width measurement is pure and the same labels are measured many times per
// compile, so the unit count is memoized by its input string.
const TEXT_UNITS_CACHE = new Map();
const MAX_TEXT_UNITS_CACHE_ENTRIES = 4096;
const MAX_CACHED_TEXT_LENGTH = 1024;

export function textUnits(text) {
  const cacheKey = String(text ?? '');
  const cachedUnits = TEXT_UNITS_CACHE.get(cacheKey);
  if (cachedUnits !== undefined) return cachedUnits;
  const chars = Array.from(cacheKey);
  let units = 0;
  for (let i = 0; i < chars.length; i += 1) {
    const codePoint = chars[i].codePointAt(0);
    if (codePoint >= VARIATION_SELECTOR_FIRST && codePoint <= VARIATION_SELECTOR_LAST) continue;
    const next = i + 1 < chars.length ? chars[i + 1].codePointAt(0) : -1;
    if (next === VARIATION_SELECTOR_EMOJI) units += 2;
    else units += FULLWIDTH_RE.test(chars[i]) ? 2 : 1;
  }
  // Keep repeated in-process compiles bounded, including unusually long labels.
  if (cacheKey.length <= MAX_CACHED_TEXT_LENGTH) {
    if (TEXT_UNITS_CACHE.size >= MAX_TEXT_UNITS_CACHE_ENTRIES) {
      TEXT_UNITS_CACHE.delete(TEXT_UNITS_CACHE.keys().next().value);
    }
    TEXT_UNITS_CACHE.set(cacheKey, units);
  }
  return units;
}
