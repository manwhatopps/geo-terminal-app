import { StatusBar } from 'expo-status-bar';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator, AppState, Keyboard, Linking, Pressable, RefreshControl, ScrollView,
  Share, StyleSheet, Text, TextInput, View,
} from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Svg, { Circle, Line, Path as SvgPath, Rect, Text as SvgText } from 'react-native-svg';

const FEED = 'https://raw.githubusercontent.com/manwhatopps/geo-terminal-feed/main/data.json';
// 2026-09-14 WORLD tab: primary-source country data (geobrief/world_data.py) and the situation-room
// history graph (geobrief/history_engine.py export). Lazy-loaded the first time the tab opens.
const WORLD_URL = 'https://raw.githubusercontent.com/manwhatopps/geo-terminal-feed/main/world.json';
const HISTORY_URL = 'https://raw.githubusercontent.com/manwhatopps/geo-terminal-feed/main/history.json';
const WORLD_CACHE_KEY = 'geo-world-cache-v1';
// 2026-09-14 THE WIRE: the feed carries `stories` — every card from every run of the last 72h,
// archived by publish_feed.mjs — and stories.json holds 30 days behind a "load older" tap.
// wireOf() makes that archive the front page: `brief` becomes the wire and `easy.brief` its
// parallel plain-English column, so every reader of data.brief (front page, search, saved,
// article prev/next, home) works unchanged on the full run of stories instead of one run's cards.
const STORIES_URL = 'https://raw.githubusercontent.com/manwhatopps/geo-terminal-feed/main/stories.json';
function wireOf(j) {
  if (j && Array.isArray(j.stories) && j.stories.length) {
    j.brief = j.stories;
    j.easy = { ...(j.easy || {}), brief: j.stories.map((st) => st.easy || '') };
  }
  return j;
}
function mergeWire(cur, older) {
  if (!cur || !Array.isArray(older)) return cur;
  const seen = new Set((cur.brief || []).map(storyId));
  const add = older.filter((st) => st && !seen.has(storyId(st)));
  if (!add.length) return cur;
  const brief = (cur.brief || []).concat(add);
  return { ...cur, brief, easy: { ...(cur.easy || {}), brief: brief.map((st, i) => st.easy || ((cur.easy || {}).brief || [])[i] || '') } };
}
const HISTORY_CACHE_KEY = 'geo-history-cache-v1';
const ACK_KEY = 'geo-disclaimer-ack-v1';
const MODE_KEY = 'geo-mode';
const FEED_CACHE_KEY = 'geo-feed-cache-v1'; // last good feed: the app opens on it, then refreshes
const STALE_MS = 10 * 60 * 1000;             // re-pull on foreground if the last pull is older than this
const LEGAL = {
  terms: 'https://manwhatopps.github.io/geo-terminal-feed/terms.html',
  privacy: 'https://manwhatopps.github.io/geo-terminal-feed/privacy.html',
  disclaimer: 'https://manwhatopps.github.io/geo-terminal-feed/disclaimer.html',
};

// SIGINT terminal — phosphor green on near-black, amber for warnings, typewriter headlines.
// (Mirrors dashboard.html's dark :root; the old navy "Situation Room" palette is retired.)
// Near-black field with an earth accent (terracotta since 2026-09-14; gold before): intelligence-agency look,
// dark cards, terracotta as THE accent. Severity stays amber->orange->red.
// Two palettes, one key set. LIGHT is the default: dark-on-light (positive polarity) reads faster and more
// accurately for normal vision at every size (Piepenbrock et al.; NN/g), and the effect grows as type gets
// smaller. Newsprint, not white: a warm off-white ground, near-black ink, gold darkened until it clears 4.5:1
// on white. DARK is the original black+gold agency look, kept behind a toggle for night reading.
const THEMES = {
  light: {
    ink: '#F6F4EE', panel: '#FFFFFF', panel2: '#F0EDE5', line: '#DDD8CC',
    text: '#17171A', muted: '#63626B', accent: '#1F6F8B', accentDim: '#7FB8C9',   // 2026-09-15: deep teal, the Ocean icon's colour (4.6:1 on the off-white)
    calm: '#2E7D5B', elev: '#B07316', high: '#C24D1E', crit: '#B42323',
    barBg: '#E9E5DB', chip: '#ECE8DE',
  },
  dark: {
    ink: '#09090B', panel: '#141317', panel2: '#0E0D10', line: '#2E2A20',
    text: '#EDE7D8', muted: '#8D8574', accent: '#5FAFC2', accentDim: '#2E6A82',   // 2026-09-15: teal, the Ocean split-globe's own colour (terracotta 09-14, gold before)
    calm: '#4C9A70', elev: '#D99A2B', high: '#E1662E', crit: '#D93B3B',
    barBg: '#0E0D10', chip: '#221F18',
  },
};
// ── ACCENT COLOURWAYS (2026-09-16, user: "I like the blue colour for the article titles. We should also
// give a couple different options for colour"). The accent is the kicker, the section headings, the
// probability bars and every link - so it has to stay clear of the four colours that already MEAN
// something (calm green, elev amber, high orange, crit red). These four hues do: teal, blue, violet and
// a near-neutral graphite for readers who want the semantic colours to do all the talking. Each carries
// its own light and dark pair, because a hue legible on near-black is rarely legible on off-white.
const ACCENTS = {
  ocean:    { label: 'OCEAN',    dark: ['#5FAFC2', '#2E6A82'], light: ['#1F6F8B', '#7FB8C9'] },
  cobalt:   { label: 'COBALT',   dark: ['#6AA6E8', '#2B5D96'], light: ['#1E5FA8', '#86B4E4'] },
  iris:     { label: 'IRIS',     dark: ['#A88BE0', '#5B4A8C'], light: ['#5B3FA8', '#A899D8'] },
  graphite: { label: 'GRAPHITE', dark: ['#B9B2A3', '#6A655C'], light: ['#4A4740', '#9C978C'] },
};
const ACCENT_KEY = 'geo-accent';
let ACCENT = 'ocean';
const THEME_KEY = 'geo-theme';
let THEME = 'dark';   // 2026-09-13: the user wants the original black+gold; light stays behind the toggle
let C = { ...THEMES[THEME], accent: ACCENTS[ACCENT][THEME][0], accentDim: ACCENTS[ACCENT][THEME][1] };
let riskColor = { calm: C.calm, elev: C.elev, high: C.high, crit: C.crit };
// Every component reads C and s at render time, so a theme change is: swap the palette, rebuild the
// stylesheet, re-render from the root. (buildStyles is defined with the styles at the bottom of the file.)
function applyTheme(name, accent) {
  THEME = THEMES[name] ? name : 'light';
  if (accent && ACCENTS[accent]) ACCENT = accent;
  const pair = (ACCENTS[ACCENT] || ACCENTS.ocean)[THEME] || ACCENTS.ocean.dark;
  C = { ...THEMES[THEME], accent: pair[0], accentDim: pair[1] };
  riskColor = { calm: C.calm, elev: C.elev, high: C.high, crit: C.crit };
  s = buildStyles();
  GRADE_META = mkGradeMeta();
  VERDICT_META = mkVerdictMeta();
}

// ── THE WEB — region is the connective key across board / stories / calls / decode ──
// (mirrors dashboard.html's REGION_RX; brief cards carry `region` explicitly, everything
// else gets its theater inferred from text until the analyst authors it)
const REGION_RX = {
  Iran: /iran|hormuz|tehran|kharg|irgc|persian gulf|esfahan|isfahan|natanz|bushehr/i,
  Israel: /israel|west bank|gaza|idf|jerusalem/i,
  Ukraine: /ukrain|kyiv|zaporizh|dnipro|donbas|kharkiv|crimea|pokrovsk|kupiansk|avdiivka/i,
  Russia: /russia|moscow|kremlin|putin/i,
  China: /china|taiwan|beijing|pla\b|taipei|south china sea/i,
  US: /\bus\b|united states|washington|white house|pentagon|congress|treasury/i,
  'Middle East': /saudi|yemen|houthi|iraq|syria|lebanon|hezbollah|gulf|oman|muscat|kuwait|qatar|uae/i,
  Europe: /europe|\beu\b|nato|germany|france|\buk\b|britain|poland|iceland/i,
  Africa: /africa|niger|sahel|sudan|mali|congo|ethiopia|niamey/i,
  Asia: /asia|korea|japan|india|pakistan|nepal|myanmar|kashmir|himalaya/i,
  'Latin America': /venezuela|brazil|mexico|argentina|colombia|caracas|latin/i,
};
function inferRegion(text) {
  for (const r of Object.keys(REGION_RX)) if (REGION_RX[r].test(text || '')) return r;
  return null;
}
function evRegion(e) { return e.region || inferRegion(e.label + ' ' + (e.note || '')); }
function regionForecasts(data, r) {
  const rx = REGION_RX[r];
  return rx ? (data.forecasts || []).filter((f) => rx.test(f.q || '')) : [];
}
// COMMON FILTERS — every category gets the same chip system NEWS has.
// pairs: [[value, label, count], ...] with "ALL" first.
function ChipBar({ pairs, active, onPick }) {
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.rfilter}>
      {pairs.map(([val, lab, n]) => {
        const on = val === active;
        return (
          <Pressable key={val} onPress={() => onPick(val)} style={[s.rchip, on && s.rchipOn]}>
            <Text style={[s.rchipTxt, MONO, on && { color: C.text, fontWeight: '700' }]}>
              {lab + (n != null ? ' ' + n : '')}
            </Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}
function textRegionPairs(items, textOf) {
  const counts = {};
  items.forEach((it) => { const r = inferRegion(textOf(it)); if (r) counts[r] = (counts[r] || 0) + 1; });
  return [['ALL', 'All', items.length]].concat(Object.keys(counts).sort().map((r) => [r, r, counts[r]]));
}

// Small dotted-underline link, the app's version of the dashboard's .weblink
function WebLink({ label, onPress }) {
  return (
    <Pressable onPress={onPress} style={{ marginTop: 8, marginRight: 12, alignSelf: 'flex-start' }}>
      <Text style={[MONO, { color: C.elev, fontSize: 12, letterSpacing: 0.8, borderBottomWidth: 1, borderColor: C.elev, borderStyle: 'dotted' }]}>
        {label}
      </Text>
    </Pressable>
  );
}
// Watchtower grades: how much weight an OSINT observation has earned.
function mkGradeMeta() {
  return {
    corroborated: { c: C.calm, label: 'CORROBORATED' },
    credible: { c: C.elev, label: 'CREDIBLE' },
    unverified: { c: C.muted, label: 'UNVERIFIED' },
    };
}
let GRADE_META = mkGradeMeta();

// DECODE tab verdicts. Reuses the risk palette so a verdict badge reads on the same scale as the
// threat gauge: green = the claim survives, red = it does not. Mirrors dashboard.html's VERDICT_META.
function mkVerdictMeta() {
  return {
    true: { c: C.calm, label: 'TRUE' },
    partly: { c: C.elev, label: 'PARTLY TRUE' },
    framing: { c: C.high, label: 'FRAMING' },
    false: { c: C.crit, label: 'FALSE' },
    };
}
let VERDICT_META = mkVerdictMeta();
// Three faces, copied from the readers people actually finish articles in:
//   MONO  — was Menlo on every label; now the system face with tabular numerals (Apple News). Numbers line up,
//           labels stop shouting. The name stays so the 200 call sites don't change.
//   SERIF — the headline face: heavy system sans, tight tracking (Apple News / SF Display register).
//   BODY  — Charter, the serif Medium runs its articles in (ships with iOS). Generous x-height, open forms.
const MONO = { fontVariant: ['tabular-nums'] };
const SERIF = { fontWeight: '800', letterSpacing: -0.4 };
const BODY = { fontFamily: 'Charter' };

// Feed strings carry HTML entities (web decodes via innerHTML; RN <Text> shows them literally).
function decode(s) {
  return String(s == null ? '' : s)
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    // 2026-09-15 house style (user): "1%", never "1 per cent" / "1 percent" — applied at render so
    // every card already on the wire complies, not just the ones written after the prompt change
    .replace(/(\d+(?:\.\d+)?)\s*(?:per\s?cent|percent)(?:age points?)?/gi, (m, n) => (/points?$/i.test(m) ? n + ' pts' : n + '%'));
}
// probabilities stated in prose ("X: about 80%; Y: under 1%") → rows the app can draw as bars
function probsFrom(text) {
  const t = decode(text);
  const out = [];
  const re = /([^.;:]*?)(?::\s*)?\b(under|below|about|roughly|around|over|above|at least|at most|near)?\s*(\d{1,3}(?:\.\d+)?)%/gi;
  let m;
  while ((m = re.exec(t)) !== null) {
    const p = Math.max(0, Math.min(100, parseFloat(m[3])));
    let label = m[1].replace(/^[\s,;.]+|[\s,;.]+$/g, '').replace(/^(?:the )?desk(?:'s)? (?:estimate|call|read|puts?|gives?)( that)?\s*/i, '').replace(/^(?:and|that|is|are|at)\s+/i, '');
    label = label.replace(/\s+(?:at|is|of|to|around|about|near)$/i, '');
    if (!label || label.length < 4) continue;
    if (label.length > 90) label = '…' + label.slice(-88);
    const q = (m[2] || '').toLowerCase();
    const shown = q === 'under' || q === 'below' || q === 'at most' ? '<' + m[3] + '%' : q === 'over' || q === 'above' || q === 'at least' ? '>' + m[3] + '%' : q ? '~' + m[3] + '%' : m[3] + '%';
    out.push({ label, p, shown });
  }
  return out;
}
function ProbList({ items, color }) {
  if (!items || !items.length) return null;
  const c = color || C.accent;
  return (
    <View style={{ marginTop: 8, marginBottom: 10 }}>
      {items.map((it, i) => (
        <View key={i} style={{ marginTop: i ? 10 : 0 }}>
          <View style={{ flexDirection: 'row', alignItems: 'flex-end' }}>
            <Text style={{ color: C.text, fontSize: 13.5, lineHeight: 18, flex: 1, paddingRight: 10 }}>{it.label.charAt(0).toUpperCase() + it.label.slice(1)}</Text>
            <Text style={[MONO, { color: c, fontSize: 22, fontWeight: '800', lineHeight: 24 }]}>{it.shown || it.p + '%'}</Text>
          </View>
          <View style={{ height: 7, backgroundColor: C.barBg, borderRadius: 4, marginTop: 5 }}>
            <View style={{ width: Math.max(1.5, it.p) + '%', height: 7, backgroundColor: c, borderRadius: 4 }} />
          </View>
        </View>
      ))}
    </View>
  );
}
// ── news region filter + chronological ordering ──
const REGION_KEY = 'geo-region';
// NYT dims a headline once you've opened it and keeps a Saved list. Both key off a
// stable-ish id derived from the headline text, because feed indices shuffle on every
// refresh while the words don't.
const READ_KEY = 'geo-read-v1', SAVED_KEY = 'geo-saved-v1';
function storyId(item) {
  return decode(item.head || item.h || '').slice(0, 70).toLowerCase().replace(/[^a-z0-9]+/g, '-');
}
// keep the remembered sets from growing without bound across months of feeds
function prune(map, cap) {
  const k = Object.keys(map);
  if (k.length <= cap) return map;
  const out = {};
  for (const key of k.slice(k.length - cap)) out[key] = map[key];
  return out;
}
const REGION_ORDER = ['US', 'China', 'Russia', 'Ukraine', 'Iran', 'Israel', 'Middle East', 'Europe', 'Asia', 'Africa', 'Latin America', 'Global'];
function regionsPresent(brief) {
  const set = new Set((brief || []).map((s) => s.region).filter(Boolean));
  const ordered = REGION_ORDER.filter((r) => set.has(r));
  for (const r of set) if (!ordered.includes(r)) ordered.push(r);
  return ordered;
}
function briefSorted(brief) {
  return (brief || []).map((s, i) => ({ s, i })).sort((a, b) => {
    const ta = a.s.ts ? Date.parse(a.s.ts) : -Infinity, tb = b.s.ts ? Date.parse(b.s.ts) : -Infinity;
    return tb !== ta ? tb - ta : a.i - b.i;
  });
}

// Full stamp for article cards: always date + time, plus freshness when recent.
// "AUG 30 · 04:01 · 2H AGO" — a reader should never have to guess when a read was written.
function fullStamp(ts) {
  if (!ts) return '';
  const t = Date.parse(ts); if (isNaN(t)) return '';
  const d = new Date(t);
  const date = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }).toUpperCase();
  const hm = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  const hrs = Math.round((Date.now() - t) / 3600000);
  const rel = hrs >= 0 && hrs < 24 ? ' · ' + (hrs < 1 ? 'JUST NOW' : hrs + 'H AGO') : '';
  return date + ' · ' + hm + rel;
}
// 2026-09-13, Direction C ('Just the front page'): three text tabs, search beside them. 'news' stays the key
// for Stories so goArticle keeps working; 'conspiracy' is the key for Calls.
// 2026-09-13: the original menu, minus MAP (removed 09-13) and minus ANALYSIS/Calls (the calls now live inside
// each article under GEOPOLITICAL ANALYST). 'news' is the headline list + search the user asked for.
// 2026-09-13 23:05: HOME removed at the user's call ('get rid of this mess') - the app opens on the headlines.
const TABS = [
  // 2026-09-16 (user): HOME is where the app opens - a front page, not the wire index.
  { key: 'home', label: 'HOME', g: '⌂' },
  { key: 'news', label: 'NEWS', g: '▤' },
  { key: 'boards', label: 'BOARDS', g: '☍' },
  // 2026-09-16 (user: "broaden the menu so everything doesn't feel so crammed and long ... instead of
  // everything included in everything"). STRATEGY held eleven sections in one endless scroll AND an
  // accordion that re-rendered STRATEGY inside itself. Split by the question each tab answers:
  // CALLS = what does the desk predict and is it any good. DATA = what are the underlying numbers.
  { key: 'calls', label: 'CALLS', g: '◉' },
  { key: 'data', label: 'DATA', g: '▦' },
];
// 2026-09-14 (later): the WORLD tab lasted one build. User: "I didn't want a world menu necessarily, I wanted you to
// record that logic for the bot's brain." The history/base-rate reasoning now lives in each article as THE DESK'S
// CALL (`item.hist`, written by the analyst runs); the reference data sits under STRATEGY as WorldSections.

// 2026-09-16 (user, on CALLS: "make all of these headlines and dropdowns instead of displaying
// everything, it takes too long to scroll through all of this"). `fold` turns a section into a
// headline that opens on tap. Opt-in, so NEWS and HOME keep reading top to bottom the way a front
// page should; the reference tabs become an index you choose from.
// ── CONTENTS — 2026-09-17 (editor: "a mini table of contents ... a table of contents button and if
// they want to jump to a certain section they can click that button and it expands"). One quiet button;
// open, it lists the sections; a tap scrolls the root ScrollView to that section. Articles list their
// read's headers; a tab lists the Sections it renders (each Section registers itself on mount). The jump
// measures the target and the scroll frame in window space, so it works at any nesting depth, on iOS
// and on the web. ──
const ScrollCtx = createContext({ jumpTo: () => {} });
const TocCtx = createContext(null);
function Toc({ items, color }) {
  const { jumpTo } = useContext(ScrollCtx);
  const [open, setOpen] = useState(false);
  const list = (items || []).filter((x) => x && x.label);
  if (list.length < 2) return null;
  return (
    <View style={{ marginBottom: 12 }}>
      <Pressable onPress={() => setOpen((v) => !v)} hitSlop={6} style={{ alignSelf: 'flex-start' }}>
        <Text style={[MONO, { color: color || C.muted, fontSize: 10, letterSpacing: 1.4, fontWeight: '700' }]}>
          {(open ? '\u2212 ' : '\u2261 ') + 'CONTENTS \u00b7 ' + list.length}
        </Text>
      </Pressable>
      {open ? (
        <View style={{ marginTop: 8, paddingLeft: 10, borderLeftWidth: 1, borderLeftColor: C.line }}>
          {list.map((it, i) => (
            <Pressable key={i} onPress={() => { setOpen(false); jumpTo(it.get ? it.get() : null); }} hitSlop={4} style={{ paddingVertical: 4 }}>
              <Text style={[MONO, { color: color || C.accent, fontSize: 10.5, letterSpacing: 0.9 }]}>{'\u203a ' + String(it.label).toUpperCase()}</Text>
            </Pressable>
          ))}
        </View>
      ) : null}
    </View>
  );
}
// A tab's contents: every top-level Section inside registers itself; nested Sections do not.
function TocHost({ children, color }) {
  const [items, setItems] = useState([]);
  const reg = useMemo(() => ({
    add: (title, get) => setItems((cur) => (cur.some((x) => x.title === title) ? cur : cur.concat([{ title, get }]))),
    remove: (title) => setItems((cur) => cur.filter((x) => x.title !== title)),
  }), []);
  return (
    <TocCtx.Provider value={reg}>
      <View style={{ paddingHorizontal: 4 }}><Toc items={items.map((x) => ({ label: x.title, get: x.get }))} color={color} /></View>
      {children}
    </TocCtx.Provider>
  );
}

function Section({ title, extra, children, fold, open: openInit }) {
  const [open, setOpen] = useState(!fold || !!openInit);
  const reg = useContext(TocCtx);
  const box = useRef(null);
  useEffect(() => {
    if (!reg || !title) return undefined;
    reg.add(title, () => box.current);
    return () => reg.remove(title);
  }, [reg, title]);
  const head = (
    <View style={s.h2row}>
      <Text style={s.h2}>{title}</Text>
      <View style={s.h2rule} />
      {extra ? <Text style={[s.h2extra, MONO]}>{extra}</Text> : null}
      {fold ? <Text style={{ color: C.accent, fontSize: 19, marginLeft: 10, marginTop: -2 }}>{open ? '\u2212' : '+'}</Text> : null}
    </View>
  );
  return (
    <View style={s.section} ref={box}>
      {fold ? <Pressable onPress={() => setOpen((v) => !v)}>{head}</Pressable> : head}
      {open ? <TocCtx.Provider value={null}>{children}</TocCtx.Provider> : null}
    </View>
  );
}

function ProbBar({ p, prev }) {
  return (
    <View style={s.bar}>
      <View style={[s.fill, { width: `${p}%` }]} />
      {prev != null && <View style={[s.tick, { left: `${prev}%` }]} />}
    </View>
  );
}


// The WHY behind the posture is a drop-down, not a wall of text on the front door —



// ── THE FRONT PAGE MODEL (NYT) ────────────────────────────────────────────────
// A newspaper never hands you five equal slabs of text. It hands you an INDEX you
// scan — kicker, headline, one line of standfirst, a rule — and you choose what to
// open. Weight carries importance: the lead runs big, the rest step down. Body copy
// does not appear until you tap in. Everything below implements that split.

// Headline vs. standfirst. New feeds carry a short scannable `head`; older ones only
// have `h`, a full summary sentence, so we cut one at the first clause break.
function clipHead(h) {
  if (h.length <= 88) return h;
  const brk = h.search(/\s+[-–—]\s+|:\s|;\s/);
  if (brk > 24 && brk <= 110) return h.slice(0, brk).trim();
  const cut = h.lastIndexOf(' ', 84);
  return h.slice(0, cut > 40 ? cut : 84).trim() + '…';
}
function articleParts(item) {
  const full = decode(item.h || '');
  return item.head
    ? { head: decode(item.head), stand: full }
    : { head: clipHead(full), stand: '', longHead: full };
}
// First n sentences — the dek under an index headline. Written without lookbehind

function kickerOf(item) {
  const parts = [];
  if (item.region) parts.push(String(item.region).toUpperCase());
  if (item.tag) parts.push(decode(item.tag).toUpperCase());
  return parts.join(' · ');
}
function timeOnly(ts) {
  const t = Date.parse(ts); if (isNaN(t)) return '';
  const d = new Date(t);
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}
// Day dividers: the reader should never have to work out what day they're reading.
function dayKey(ts) {
  const t = Date.parse(ts); if (isNaN(t)) return 'undated';
  const d = new Date(t);
  return d.getFullYear() + '-' + d.getMonth() + '-' + d.getDate();
}
function dayLabel(ts) {
  const t = Date.parse(ts); if (isNaN(t)) return 'EARLIER';
  const d = new Date(t), now = new Date(), y = new Date(); y.setDate(y.getDate() - 1);
  const stamp = d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }).toUpperCase();
  if (dayKey(ts) === dayKey(now.toISOString())) return 'TODAY · ' + stamp;
  if (dayKey(ts) === dayKey(y.toISOString())) return 'YESTERDAY · ' + stamp;
  return stamp;
}
// The body a given reading level should see (unchanged rules, moved off the card).
// Split a 2-4 sentence block into paragraphs of ~2 sentences so the page has air in it.
function paragraphs(txt) {
  const sents = String(txt || '').match(/[^.!?]+[.!?]+["')\]]*\s*/g) || [String(txt || '')];
  const out = [];
  for (let i = 0; i < sents.length; i += 2) out.push(sents.slice(i, i + 2).join('').trim());
  return out.filter(Boolean);
}
// ── SECTIONS — the article as named, bold-headed sections. New cards carry `read` / `consp.reads`
// arrays; older cards had labels jammed inline ("RAIL: … DESK: … (a) … (b) …"), which sectionize()
// splits apart so every card on the wire reads the same way. (2026-09-15, user: "broken down in
// sections better… make these sections noticeable, bold them.")
const LEGACY_LABELS = {
  'RAIL': 'THE HISTORICAL RAIL', 'DESK': 'WHO DECIDES', 'BASE RATE': 'BASE RATE',
  'COMPETING EXPLANATIONS': 'COMPETING EXPLANATIONS', 'WHAT WOULD CHANGE IT': "WHAT WOULD CHANGE THE DESK'S MIND",
  'WHAT TO WATCH': 'WHAT TO WATCH', 'INDICATORS': 'WHAT TO WATCH', 'SOURCE CLASS': 'SOURCE CLASS',
  'FALSIFIER': "WHAT WOULD CHANGE THE DESK'S MIND", 'FOR': 'EVIDENCE FOR', 'AGAINST': 'EVIDENCE AGAINST',
};
const LETTER_LABELS = { a: 'THE CLAIM', b: 'MECHANISM', c: 'WHO GAINS, WHO PAYS', d: 'EVIDENCE FOR', e: 'EVIDENCE AGAINST', f: 'HISTORICAL ANALOGUES', g: "THE DESK'S VERDICT" };
function sectionize(txt) {
  const t = decode(String(txt || '')).replace(/\s+/g, ' ').trim()
    .replace(/^Source class:/i, 'SOURCE CLASS:').replace(/\bFalsifier:/g, 'FALSIFIER:')
    .replace(/\((\d)\)\s/g, '$1. ');   // legacy "(1) (2)" lists -> "1. 2." so Sections numbers them
  if (!t) return [];
  // split points: "LABEL:" in caps (2-4 words) at a sentence start, or "(a)".."(g)" markers.
  // No lookbehind (Hermes): the sentence-end prefix is captured and kept with the preceding text.
  const re = /(^|[.!?;]\s+)(?:([A-Z][A-Z' ]{2,40}?)(?:, at full strength)?:\s+|\(([a-g])\)\s+)/g;
  const parts = []; let last = 0; let m;
  while ((m = re.exec(t)) !== null) {
    const cut = m.index + m[1].length;
    if (cut > last) parts.push({ h: parts.length ? undefined : null, p: t.slice(last, cut).trim() });
    const label = m[2] ? (LEGACY_LABELS[m[2].trim()] || m[2].trim()) : LETTER_LABELS[m[3]];
    parts.push({ h: label, p: '' }); last = re.lastIndex;
  }
  if (last < t.length) parts.push({ h: parts.length ? undefined : null, p: t.slice(last).trim() });
  // fold text into the preceding header
  const out = [];
  for (const x of parts) {
    if (x.h) out.push({ h: x.h, p: x.p });
    else if (out.length && x.p) out[out.length - 1].p = (out[out.length - 1].p + ' ' + x.p).trim();
    else if (x.p) out.push({ h: null, p: x.p });
  }
  return out.filter((x) => x.p);
}
function Sections({ items, size, color, refs }) {
  if (!items || !items.length) return null;
  const fs = size || 17, lh = Math.round(fs * 1.62);
  return (
    <View>
      {items.map((sec, i) => {
        const lines = String(sec.p || '').split(/\s(?=\d\.\s)/).map((x) => x.trim()).filter(Boolean);
        const numbered = lines.length > 1 && lines.every((x) => /^\d\.\s/.test(x));
        // a verdict or a call that names probabilities gets them drawn as bars above the prose
        const probs = Array.isArray(sec.verdicts) && sec.verdicts.length
          ? sec.verdicts.map((v) => ({ label: v.claim || v.label || '', p: Number(v.p) || 0, shown: (Number(v.p) || 0) + '%' }))
          : (/VERDICT|HAPPENS NEXT|BASE RATE|PROBABILIT|THE CALL/i.test(sec.h || '') ? probsFrom(sec.p) : []);
        return (
          <View key={i} style={{ marginTop: i ? 18 : 4 }} ref={refs ? (el) => { refs.current[i] = el; } : undefined}>
            {sec.h ? <Text style={[MONO, { color: color || C.accent, fontSize: 11.5, letterSpacing: 1.6, fontWeight: '800', marginBottom: 6 }]}>{String(sec.h).toUpperCase()}</Text> : null}
            <ProbList items={probs} color={color} />
            {numbered ? lines.map((ln, j) => (
              <Text key={j} style={[s.ctxP, T(fs, lh), j > 0 && { marginTop: 8 }]}><Text style={{ color: color || C.accent, fontWeight: '800' }}>{ln.slice(0, 2)}</Text>{decode(ln.slice(2))}</Text>
            )) : paragraphs(decode(sec.p)).map((para, j) => (
              <Text key={j} style={[s.ctxP, T(fs, lh), j > 0 && { marginTop: 10 }]}>{para}</Text>
            ))}
          </View>
        );
      })}
    </View>
  );
}
function readTime(body, context) {
  const words = String(body || '').split(/\s+/).length + String(context || '').split(/\s+/).length;
  return Math.max(1, Math.round(words / 200)) + ' MIN READ';
}

function bodyFor(item, simpleText, easy, deep) {
  return easy && simpleText ? simpleText
    : deep && item.context ? item.t + '\n\n' + item.context
      : item.t;
}

function DayRule({ label }) {
  return (
    <View style={s.dayrule}>
      <Text style={[s.daytxt, MONO]}>{label}</Text>
      <View style={s.dayline} />
    </View>
  );
}



// ── THE CONTEXT PANEL — the decode that used to live inline on every card. ──
// ── THE CONSPIRACY — what the boards are saying about THIS story. ─────────────
// Sits beside the decode as the article's second door. The feed already monitors
// belief: the news pass fetches /pol/'s catalog and searches X/reddit, and writes
// what it finds into `chatter` ({claim, spread, read}). Until now that only lived
// on the ANALYSIS tab, unattached to the story it was about. Two ways in, so it
// works on today's feed and gets sharper on tomorrow's:
//   item.consp  — the analyst attaching the theory to this specific card (new)
//   data.chatter — anything circulating in the same theater (matched here)
// The bar is LOWER here than anywhere else in the app on purpose: this is a record
// of what people believe, not of what is true, and the panel says so first.
// 4 letters, not 5: the words that actually discriminate between stories are short proper
// nouns — Iran, Gaza, Iraq, NATO, oil. A five-letter floor throws away exactly the signal.
const STOP = new Set(['about','after','again','against','also','around','because','been','before','being','between','both','could','does','during','each','every','from','have','into','just','like','more','most','only','other','over','said','same','should','since','some','such','than','that','their','them','then','there','these','they','this','those','through','under','until','very','were','what','when','where','which','while','will','with','would','your']);
function tokens(str) {
  const out = new Set();
  for (const w of String(str || '').toLowerCase().match(/[a-z]{4,}/g) ?? []) if (!STOP.has(w)) out.add(w);
  return out;
}
// How much a circulating narrative actually has to do with THIS story. Same theater is
// necessary but nowhere near sufficient — a surveillance-camera theory is not about a
// Venezuela oil deal just because both got filed under Latin America. Count the real
// words they share and make the narrative clear the bar before it goes under an article.
function chatterScore(item, c) {
  const a = tokens(decode(item.head || '') + ' ' + decode(item.h || '') + ' ' + decode(item.tag || ''));
  const b = tokens(c.claim + ' ' + (c.spread || '') + ' ' + (c.read || ''));
  let n = 0;
  for (const w of a) if (b.has(w)) n++;
  return n;
}
// 2026-09-16 (user: "it gives me the conspiracy for the article but then keeps going on about conspiracy
// for other articles that aren't relevant"). The 09-14 fix kept a "same theater + two shared words" tier,
// and two shared words is far too weak a test on stories that already share a region, a country name and a
// leader's name - so every Iran story carried every Iran claim. Under an ARTICLE the door now shows ONLY
// what the desk pinned to THIS card. Everything else circulating has its own tab: BOARDS.
// A watchtower observation belongs under a story only if it is ABOUT that story: same theater AND at
// least three real words in common (2026-09-16 - region alone put a whole theater's sightings on one card).
function storySpec(speculation, item) {
  return (speculation || []).filter((sp) => {
    const r = sp.region || inferRegion(sp.obs + ' ' + (sp.read || ''));
    if (r !== item.region) return false;
    return chatterScore(item, { claim: sp.obs || '', spread: sp.src || '', read: sp.read || '' }) >= 3;
  });
}

function chatterFor(item) {
  return item.consp
    ? (Array.isArray(item.consp) ? item.consp : [item.consp]).map((c) => ({ ...c, tier: 'own' }))
    : [];
}

// ── THE COUNTER — one checkable fact against the claim, before any of the reasoning. ───────────
// 2026-09-16 (editor): "We should add contrarian responses on the board. For example you played one
// that said Shanghai says oil is $130 a barrel and in the thread they predict GDP to drop 10%. But
// the counter was that the strait isn't actually closed like news headlines read."
//
// He is describing the most useful thing the desk owns and was burying. The counter-evidence WAS
// being written - the Shanghai read already said WTI printed $107 on 15 September, so $135 implies a
// 20% premium nobody has reported - but it sat in sentence four of a paragraph, under a label that
// said THE DESK'S READ. A claim gets a headline; the fact that deflates it got prose. Now it gets its
// own line, above the reasoning, where a reader who taps nothing still sees it.
//
// Two things make this different from fact-checking. It cuts at WHOEVER IS OVERSTATING - the board
// when the board is inflating, the wire when the headline is ("the strait isn't actually closed like
// news headlines read" is a counter to the NEWS, not to the poster) - and it is allowed to come back
// empty: when the check finds nothing against a claim, the desk says so and names what would settle
// it, because a panel that always finds the claim wrong is running a narrative in the other direction.
function Counter({ c }) {
  if (!c) return null;
  const holds = /^\s*(HOLDS|NOTHING)/i.test(String(c));
  const col = holds ? C.calm : C.accent;
  return (
    <View style={{ marginTop: 12, borderLeftWidth: 3, borderLeftColor: col, paddingLeft: 12 }}>
      <Text style={[MONO, { color: col, fontSize: 10, letterSpacing: 1.5, fontWeight: '800' }]}>
        {holds ? 'AND IT SURVIVES THE CHECK' : 'BUT THE NUMBERS SAY'}
      </Text>
      <Text style={[s.p, { fontSize: 15.5, lineHeight: 24, marginTop: 6, marginBottom: 0 }]}>{decode(String(c))}</Text>
    </View>
  );
}

function ConspiracyPanel({ items, forceOpen }) {
  const [open, setOpen] = useState(!!forceOpen);
  if (!items || !items.length) return forceOpen ? <Text style={[s.foot, { marginTop: 12 }]}>Nothing is circulating about this story yet — the boards are swept every pass.</Text> : null;
  // Tier headers, not tier gates. Everything the sweep caught is in here; the labels
  // only tell the reader how close to this story each one sits.
  const HEAD = {
    own: 'ON THIS STORY',
    theater: 'ON THIS THEATER',
    board: 'ELSEWHERE ON THE BOARDS',
  };
  let tier = null;
  return (
    <>
      {!forceOpen ? (
        <Pressable style={[s.ctxbtn, s.ctxbtnWide, { borderColor: C.high }]} onPress={() => setOpen((o) => !o)}>
          <Text style={[s.ctxbtnTxt, MONO, { color: C.high }]}>
            {(open ? '− ' : '＋ ') + 'THE CONSPIRACY'}
          </Text>
          <Text style={[MONO, { color: C.muted, fontSize: 11, marginLeft: 'auto' }]}>
            {items.length + (items.length === 1 ? ' claim circulating' : ' claims circulating')}
          </Text>
        </Pressable>
      ) : null}
      {open ? (
        <View style={[s.ctxpanel, { borderLeftColor: C.high }]}>
          <Text style={[s.conspWarn, MONO]}>
            UNVERIFIED · WHAT IS CIRCULATING, NOT WHAT IS CONFIRMED
          </Text>
          <Text style={s.conspIntro}>
            Everything the desk caught circulating on the boards and social feeds about this story,
            treated as source material: each claim is stated in its strongest form and tested on the
            evidence — mechanism, who gains, what the day's data supports, and a probability.
          </Text>
          {items.map((c, i) => {
            const label = c.tier !== tier ? HEAD[c.tier] : null;
            tier = c.tier;
            return (
              <View key={i}>
                {label ? (
                  <View style={s.conspTier}>
                    <Text style={[s.conspTierTxt, MONO]}>{label}</Text>
                    <View style={s.dayline} />
                  </View>
                ) : null}
                <View style={[s.consp, !label && i > 0 && { borderTopWidth: 1, borderTopColor: C.line, marginTop: 14, paddingTop: 14 }]}>
                  <Text style={[s.ctxlbl, MONO, { color: C.high }]}>THE CLAIM</Text>
                  <Text style={[s.ctxP, T(17, 28)]}>{decode(c.claim)}</Text>
                  {c.spread ? (
                    <>
                      <Text style={[s.ctxlbl, MONO, { marginTop: 10 }]}>WHERE IT'S SPREADING</Text>
                      <Text style={[s.ctxP, T(15, 24), { color: C.muted }]}>{decode(c.spread)}</Text>
                    </>
                  ) : null}
                  <Counter c={c.counter} />
                  {Array.isArray(c.reads) && c.reads.length ? (
                    <View style={{ marginTop: 10 }}><Sections items={c.reads.map((sec) => (/VERDICT/i.test(sec.h || '') && Array.isArray(c.verdicts) ? { ...sec, verdicts: c.verdicts } : sec))} color={C.high} /></View>
                  ) : c.read ? (
                    <>
                      <Text style={[s.ctxlbl, MONO, { marginTop: 10, color: C.accent }]}>THE DESK'S READ</Text>
                      <Sections items={sectionize(c.read)} color={C.high} />
                    </>
                  ) : null}
                  {c.u ? <WebLink label="SEE THE POST ↗" onPress={() => Linking.openURL(c.u)} /> : null}
                </View>
              </View>
            );
          })}
        </View>
      ) : null}
    </>
  );
}

// ── ARTICLE — the page you land on after tapping a headline. One story, nothing else. ──
// ── SHARE CARD — the desk's call as a picture, because the call is the argument. ────────────────
// 2026-09-16. Distribution is the binding constraint, not depth: the desk writes a dated probability
// with a case for and against twelve times a day, and none of it could leave the phone except as a
// headline and a link. A call renders as an image people argue with, which is how geopolitics travels.
// Built on react-native-svg (already a dependency) + toDataURL, so there is no screenshot library and
// no view-hierarchy capture; if the image path fails at any step the text share still goes out.
const CARD_W = 1080, CARD_H = 1080;
function wrapSvg(text, perLine, maxLines) {
  const words = String(text || '').split(/\s+/).filter(Boolean);
  const lines = []; let cur = '';
  for (const w of words) {
    if ((cur + ' ' + w).trim().length > perLine) { lines.push(cur.trim()); cur = w; if (lines.length === maxLines) break; }
    else cur = (cur + ' ' + w).trim();
  }
  if (lines.length < maxLines && cur) lines.push(cur.trim());
  if (lines.length === maxLines && words.join(' ').length > lines.join(' ').length + 1) {
    lines[maxLines - 1] = lines[maxLines - 1].replace(/[.,;:]?$/, '') + '…';
  }
  return lines;
}
function CallCard({ item, svgRef }) {
  const call = (item.hist || {}).call || {};
  const p = Math.max(0, Math.min(100, Math.round(Number(call.p) || 0)));
  const claim = wrapSvg(decode(call.event || item.head || ''), 42, 4);
  // two lines per argument, not one: a case cut off at "rewarded the commander..." is not a case
  // measured against every live call: the first point gets two lines, the second one, so the card
  // never silently drops half the case. At 2+2 it dropped an argument on twenty of thirty-five cards.
  const arg = (arr) => (arr || []).slice(0, 2).map((x, i) => wrapSvg(decode(x), 46, i === 0 ? 2 : 1));
  const pro = arg((item.hist || {}).for);
  const con = arg((item.hist || {}).against);
  const T = (x, y, t, o) => <SvgText key={String(x) + '-' + y + '-' + String(t).slice(0, 12)} x={x} y={y}
    fill={(o && o.fill) || C.text} fontSize={(o && o.size) || 30} fontWeight={(o && o.weight) || '400'}
    opacity={(o && o.op) || 1} letterSpacing={(o && o.ls) || 0}>{t}</SvgText>;
  // laid out from a cursor, so a long claim or a two-line argument can never land on the footer
  const out = []; const FOOT = CARD_H - 150;
  let y = 370;
  claim.forEach((ln, i) => { out.push(T(70, y, ln, { size: 37, weight: '600' })); y += 46; });
  y += 18;
  out.push(<Rect key="rule" x="70" y={y} width={CARD_W - 140} height="2" fill={C.line} />);
  y += 52;
  const block = (label, colour, items, glyph) => {
    if (!items.length || y > FOOT) return;
    out.push(T(70, y, label, { size: 22, weight: '800', ls: 3, fill: colour }));
    y += 40;
    items.forEach((lines) => {
      lines.forEach((ln, j) => {
        if (y > FOOT) return;
        out.push(T(70, y, (j === 0 ? glyph + ' ' : '   ') + ln, { size: 26, op: 0.92 }));
        y += 32;
      });
      y += 8;
    });
    y += 10;
  };
  block('THE CASE FOR', C.calm, pro, '+');
  block('THE CASE AGAINST', C.high, con, '\u2212');
  return (
    <Svg ref={svgRef} width={CARD_W} height={CARD_H} viewBox={`0 0 ${CARD_W} ${CARD_H}`}>
      <Rect x="0" y="0" width={CARD_W} height={CARD_H} fill={C.ink} />
      <Rect x="0" y="0" width="14" height={CARD_H} fill={C.accent} />
      {T(70, 92, 'PARALLAX', { size: 30, weight: '800', ls: 7, fill: C.text })}
      {T(70, 138, "THE DESK'S CALL", { size: 24, weight: '700', ls: 4, fill: C.accent })}
      {T(70, 320, p + '%', { size: 200, weight: '800', fill: C.accent })}
      {out}
      {T(70, CARD_H - 112, String(call.horizon || '').toUpperCase() + (call.conf ? '  \u00b7  CONFIDENCE ' + String(call.conf).toUpperCase() : ''),
        { size: 23, ls: 2, fill: C.muted })}
      {T(70, CARD_H - 62, 'Analysis and opinion, not advice. The desk publishes its misses.', { size: 22, fill: C.muted, op: 0.85 })}
    </Svg>
  );
}

// Share the card if every piece of the image path is available; otherwise share the same argument as
// text. The fallback is not a degraded feature - a call with its for/against reads fine as text.
async function shareCall(item, svgRef) {
  const call = (item.hist || {}).call || {};
  const p = Math.round(Number(call.p) || 0);
  const lines = [
    call.event ? `The desk says ${p}%: ${decode(call.event)}` : decode(item.head || ''),
    ((item.hist || {}).for || []).length ? '\nFOR\n' + ((item.hist || {}).for || []).slice(0, 2).map((x) => '+ ' + decode(x)).join('\n') : '',
    ((item.hist || {}).against || []).length ? '\nAGAINST\n' + ((item.hist || {}).against || []).slice(0, 2).map((x) => '- ' + decode(x)).join('\n') : '',
    '\nvia Parallax — analysis and opinion, not advice.',
  ].filter(Boolean).join('\n');
  try {
    // expo-file-system moved to a File/Directory API in SDK 54; the base64 write we need still lives
    // on the legacy entry, which Expo ships deliberately for exactly this. Checked against the
    // installed module rather than assumed.
    const FS = require('expo-file-system/legacy');
    const Sharing = require('expo-sharing');
    if (svgRef.current && svgRef.current.toDataURL && FS.cacheDirectory && (await Sharing.isAvailableAsync())) {
      const b64 = await new Promise((res, rej) => {
        const t = setTimeout(() => rej(new Error('timeout')), 5000);
        svgRef.current.toDataURL((d) => { clearTimeout(t); d ? res(d) : rej(new Error('no data')); });
      });
      const uri = FS.cacheDirectory + 'parallax-call.png';
      await FS.writeAsStringAsync(uri, b64, { encoding: 'base64' });
      await Sharing.shareAsync(uri, { mimeType: 'image/png', dialogTitle: "The desk's call" });
      return;
    }
  } catch (e) { /* fall through to text */ }
  Share.share({ message: lines });
}

// ── THE GEOPOLITICAL ANALYST — one panel, read in time order. ─────────────────
// 2026-09-16 (user: "it's good with all the information but way too much all over the place -
// condense and organize, maybe go in chronological order"). Before this, the button opened two
// stacked panels (HistPanel + ContextPanel) that between them threw nine unranked blocks at the
// reader: the call, for/against, the long call, the contrarian, how history moved it, precedents,
// a verdict, who-gains, the watchtower. Same material, now on a spine the reader already owns —
// PAST, PRESENT, FUTURE — with the precedents sorted oldest first inside the past.
function Movement({ n, title, sub, children }) {
  if (!children || (Array.isArray(children) && !children.filter(Boolean).length)) return null;
  return (
    <View style={{ marginTop: 20 }}>
      <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 9 }}>
        <Text style={[MONO, { color: C.accent, fontSize: 12, fontWeight: '800', letterSpacing: 1 }]}>{n}</Text>
        <Text style={[MONO, { color: C.text, fontSize: 11.5, fontWeight: '800', letterSpacing: 1.7 }]}>{title}</Text>
        <View style={{ flex: 1, height: 1, backgroundColor: C.line }} />
      </View>
      {sub ? <Text style={{ color: C.muted, fontSize: 11.5, marginTop: 3, marginBottom: 2 }}>{sub}</Text> : null}
      {children}
    </View>
  );
}

// ── YOUR CALL — the reader predicts alongside the desk. 2026-09-17 (editor: "predictions score cards ...
// give readers the option of A through D scenarios and score them based on percentage. Like Polymarket
// but no money. People flex their intelligence."). Every card carries `hist.scenarios`: three or four
// exclusive outcomes by a date, each with the desk's own probability. The reader picks one, locks a
// confidence, and only THEN sees the desk's numbers (no anchoring). When the weekly audit resolves the
// set (feed/resolutions.json), both are scored with the multi-outcome Brier score and the scorecard on
// CALLS keeps the running tally. Per device, no account, no stakes - the score is the flex. ──
const RESOLUTIONS_URL = 'https://raw.githubusercontent.com/manwhatopps/geo-terminal-feed/main/resolutions.json';
const RES_CACHE_KEY = 'geo-resolutions-cache-v1';
const PICKS_KEY = 'geo-picks-v1';
const CONFS = [55, 70, 85, 95];
function readerDist(pick, options) {
  const n = options.length, c = Math.max(0, Math.min(100, Number(pick.conf) || 0)) / 100;
  const rest = n > 1 ? (1 - c) / (n - 1) : 0;
  const d = {}; options.forEach((o) => { d[o.k] = o.k === pick.k ? c : rest; });
  return d;
}
function deskDist(options) {
  const tot = options.reduce((a, o) => a + (Number(o.p) || 0), 0) || 100;
  const d = {}; options.forEach((o) => { d[o.k] = (Number(o.p) || 0) / tot; });
  return d;
}
// multi-outcome Brier: sum over outcomes of (p - o)^2, 0 best, 2 worst; shown as a 0-100 score
const brierOf = (dist, outcome, options) => options.reduce((a, o) => a + Math.pow((dist[o.k] || 0) - (o.k === outcome ? 1 : 0), 2), 0);
const scoreOf = (b) => Math.round(100 * (1 - b / 2));
function scenariosOf(item) {
  const sc = (item.hist || {}).scenarios;
  if (!sc || !Array.isArray(sc.options) || sc.options.length < 2) return null;
  return sc;
}
function YourCall({ item, pick, onPick, resolved }) {
  const sc = scenariosOf(item);
  const [sel, setSel] = useState(null);
  const [conf, setConf] = useState(null);
  if (!sc) return null;
  const opts = sc.options;
  const byTxt = sc.by ? fmtDue(String(sc.by).slice(0, 10)).replace('BY ', '') : '';
  const lbl = [MONO, { color: C.accent, fontSize: 10, letterSpacing: 1.6, fontWeight: '800' }];
  const optRow = (o, on, showP) => (
    <View key={o.k} style={{ flexDirection: 'row', alignItems: 'flex-start', paddingVertical: 9, borderTopWidth: 1, borderTopColor: C.line }}>
      <View style={{ width: 28, height: 28, borderRadius: 14, borderWidth: 1.5, borderColor: on ? C.accent : C.line, backgroundColor: on ? C.accent : 'transparent', alignItems: 'center', justifyContent: 'center', marginRight: 10 }}>
        <Text style={[MONO, { color: on ? C.ink : C.muted, fontSize: 12, fontWeight: '800' }]}>{o.k}</Text>
      </View>
      <Text style={{ color: C.text, fontSize: 15, lineHeight: 21, flex: 1, fontWeight: on ? '700' : '400' }}>{decode(o.text)}</Text>
      {showP ? <Text style={[MONO, { color: C.accent, fontSize: 14, fontWeight: '800', marginLeft: 10, width: 44, textAlign: 'right' }]}>{Math.round(Number(o.p) || 0) + '%'}</Text> : null}
    </View>
  );
  if (pick) {
    const rd = readerDist(pick, opts), dd = deskDist(opts);
    const done = resolved && resolved.k;
    const yours = done ? scoreOf(brierOf(rd, resolved.k, opts)) : null;
    const desk = done ? scoreOf(brierOf(dd, resolved.k, opts)) : null;
    return (
      <View style={[s.storycard, { borderColor: C.accent, marginTop: 8 }]}>
        <Text style={lbl}>{done ? 'RESOLVED \u00b7 ' + String(resolved.k) : 'YOUR CALL \u00b7 LOCKED' + (byTxt ? ' \u00b7 SCORED AFTER ' + byTxt : '')}</Text>
        <View style={{ flexDirection: 'row', alignItems: 'baseline', marginTop: 8 }}>
          <Text style={[MONO, { color: C.accent, fontSize: 28, fontWeight: '800' }]}>{pick.k + ' \u00b7 ' + pick.conf + '%'}</Text>
          <Text style={{ color: C.muted, fontSize: 12.5, marginLeft: 10, flex: 1 }}>{'you' + (done ? (pick.k === resolved.k ? ' \u2014 right' : ' \u2014 wrong') : '')}</Text>
        </View>
        <Text style={[lbl, { marginTop: 12, color: C.muted }]}>THE DESK'S NUMBERS</Text>
        {opts.map((o) => optRow(o, done ? o.k === resolved.k : o.k === pick.k, true))}
        {done ? (
          <View style={{ marginTop: 12, flexDirection: 'row', gap: 22 }}>
            <View><Text style={[MONO, { color: C.muted, fontSize: 9.5, letterSpacing: 1.1 }]}>YOUR SCORE</Text><Text style={[MONO, { color: yours >= desk ? C.calm : C.high, fontSize: 24, fontWeight: '800' }]}>{yours}</Text></View>
            <View><Text style={[MONO, { color: C.muted, fontSize: 9.5, letterSpacing: 1.1 }]}>THE DESK</Text><Text style={[MONO, { color: C.text, fontSize: 24, fontWeight: '800' }]}>{desk}</Text></View>
            {resolved.note ? <Text style={{ color: C.muted, fontSize: 12.5, lineHeight: 18, flex: 1 }}>{decode(resolved.note)}</Text> : null}
          </View>
        ) : (
          <Text style={{ color: C.muted, fontSize: 12.5, lineHeight: 18, marginTop: 10 }}>{'Scored against the desk when it resolves' + (sc.rule ? ' \u2014 ' + decode(sc.rule) : '') + '. Your call stays on this phone.'}</Text>
        )}
        {!done ? <Pressable onPress={() => onPick && onPick(null)} hitSlop={6} style={{ marginTop: 8 }}><Text style={[MONO, { color: C.muted, fontSize: 9.5, letterSpacing: 1.1 }]}>CHANGE YOUR CALL</Text></Pressable> : null}
      </View>
    );
  }
  return (
    <View style={[s.storycard, { borderColor: C.accent, marginTop: 8 }]}>
      <Text style={lbl}>{'YOUR CALL' + (byTxt ? ' \u00b7 WHAT HAPPENS BY ' + byTxt : '')}</Text>
      <Text style={{ color: C.muted, fontSize: 12.5, lineHeight: 18, marginTop: 5 }}>
        Pick the outcome, then how sure you are. The desk's own numbers show once you lock in, and you are scored against it when this resolves.
      </Text>
      <View style={{ marginTop: 8 }}>{opts.map((o) => (
        <Pressable key={o.k} onPress={() => setSel(o.k)}>{optRow(o, sel === o.k, false)}</Pressable>
      ))}</View>
      {sel ? (
        <View style={{ marginTop: 12 }}>
          <Text style={[MONO, { color: C.muted, fontSize: 9.5, letterSpacing: 1.1 }]}>HOW SURE</Text>
          <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
            {CONFS.map((c) => (
              <Pressable key={c} onPress={() => setConf(c)} style={[s.rchip, conf === c && s.rchipOn, { marginRight: 0 }]}>
                <Text style={[s.rchipTxt, MONO, conf === c && { color: C.text, fontWeight: '700' }]}>{c + '%'}</Text>
              </Pressable>
            ))}
          </View>
        </View>
      ) : null}
      {sel && conf ? (
        <Pressable onPress={() => onPick && onPick({ k: sel, conf, ts: new Date().toISOString().slice(0, 10), by: sc.by || null,
            head: articleParts(item).head, options: opts.map((o) => ({ k: o.k, text: o.text, p: o.p })) })}
          style={[s.artbtn, { marginTop: 14, borderColor: C.accent, alignItems: 'center' }]}>
          <Text style={[s.artbtnT, MONO, { color: C.accent }]}>{'LOCK IN ' + sel + ' AT ' + conf + '%'}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}
function resolutionFor(res, id) {
  return ((res && res.items) || []).find((r) => r.id === id) || null;
}
// The scorecard on CALLS: every call the reader has made, scored against the desk where resolved.
function Scorecard({ picks, cards, res, goArticle, quizzes, hist }) {
  const ids = Object.keys(picks || {});
  const qk = Object.keys(quizzes || {});
  const know = qk.length ? Math.round(100 * qk.reduce((a, k) => a + quizzes[k].score, 0) / Math.max(1, qk.reduce((a, k) => a + quizzes[k].total, 0))) : null;
  const roomTitle = (k) => (((hist || {}).situations || {})[k] || {}).title || k.replace(/_/g, ' ');
  const knowledge = qk.length ? (
    <View style={{ paddingHorizontal: 16, paddingBottom: 10 }}>
      <Text style={[MONO, { color: C.muted, fontSize: 9, letterSpacing: 1.1 }]}>KNOWLEDGE \u00b7 THE ROOMS YOU HAVE TESTED</Text>
      {qk.map((k) => (
        <Text key={k} style={{ color: C.text, fontSize: 13.5, lineHeight: 20, marginTop: 4 }}>
          <Text style={[MONO, { color: quizzes[k].score >= quizzes[k].total * 0.7 ? C.calm : C.high, fontWeight: '800' }]}>{quizzes[k].score + '/' + quizzes[k].total + '  '}</Text>{roomTitle(k)}
        </Text>
      ))}
    </View>
  ) : null;
  if (!ids.length && !qk.length) {
    return (
      <Section title="Your scorecard" extra="no calls yet">
        <Text style={[s.foot, { paddingHorizontal: 16, paddingBottom: 14, fontSize: 13.5, lineHeight: 19.5 }]}>
          Open any story, find YOUR CALL under ANALYST, pick a scenario and lock a confidence: the desk scores
          you against itself when it resolves. Or open a situation room on DATA and take its test. No account,
          no money: the score lives on this phone.
        </Text>
      </Section>
    );
  }
  const idx = {}; (cards || []).forEach((c, i) => { idx[storyId(c)] = i; });
  const rows = ids.map((id) => {
    const pk = picks[id]; const r = resolutionFor(res, id);
    const opts = pk.options || [];
    const done = r && r.k && r.k !== 'VOID' && opts.length;
    return { id, pk, r, done, yours: done ? scoreOf(brierOf(readerDist(pk, opts), r.k, opts)) : null,
      desk: done ? scoreOf(brierOf(deskDist(opts), r.k, opts)) : null, days: pk.by ? Math.round((Date.parse(pk.by + 'T12:00:00Z') - Date.now()) / 86400000) : null };
  });
  const scored = rows.filter((x) => x.done);
  const mean = (k) => (scored.length ? Math.round(scored.reduce((a, x) => a + x[k], 0) / scored.length) : null);
  const stat = (label, v, color) => (
    <View style={{ flex: 1 }}>
      <Text style={[MONO, { color: C.muted, fontSize: 9, letterSpacing: 1.1 }]}>{label}</Text>
      <Text style={[MONO, { color: color || C.text, fontSize: 22, fontWeight: '800', marginTop: 2 }]}>{v == null ? '\u2014' : v}</Text>
    </View>
  );
  const y = mean('yours'), d = mean('desk');
  return (
    <Section title="Your scorecard" extra={ids.length + (ids.length === 1 ? ' call' : ' calls') + (qk.length ? ' \u00b7 ' + qk.length + (qk.length === 1 ? ' room' : ' rooms') : '')}>
      <View style={{ flexDirection: 'row', paddingHorizontal: 16, paddingBottom: 12 }}>
        {stat('CALLS', ids.length)}{stat('SCORED', scored.length)}{stat('JUDGEMENT', y, y != null && d != null ? (y >= d ? C.calm : C.high) : C.text)}{stat('THE DESK', d)}{stat('KNOWLEDGE', know == null ? null : know + '%')}
      </View>
      {knowledge}
      {rows.sort((a, b) => (a.done === b.done ? (a.days == null ? 1 : b.days == null ? -1 : a.days - b.days) : a.done ? -1 : 1)).map((x) => (
        <Pressable key={x.id} onPress={() => idx[x.id] != null && goArticle && goArticle(idx[x.id])} style={{ paddingHorizontal: 16, paddingVertical: 11, borderTopWidth: 1, borderTopColor: C.line }}>
          <Text style={[MONO, { fontSize: 9.5, letterSpacing: 1.1, fontWeight: '700' }]}>
            <Text style={{ color: x.done ? (x.pk.k === x.r.k ? C.calm : C.high) : C.accent }}>{x.done ? (x.pk.k === x.r.k ? 'RIGHT' : 'WRONG') + ' \u00b7 ' + x.yours + ' vs desk ' + x.desk : 'OPEN \u00b7 YOU ' + x.pk.k + ' ' + x.pk.conf + '%'}</Text>
            <Text style={{ color: C.muted }}>{x.pk.by ? '  \u00b7  ' + (x.done ? 'RESOLVED ' + String(x.r.resolved || x.r.by || '').slice(5, 10) : fmtDue(x.pk.by) + ' \u00b7 ' + inDays(x.days).toUpperCase()) : ''}</Text>
          </Text>
          <Text style={{ color: C.text, fontSize: 14.5, lineHeight: 20, marginTop: 5, fontWeight: '600' }}>{decode(x.pk.head || x.id)}</Text>
          <Text style={{ color: C.muted, fontSize: 12.5, lineHeight: 18, marginTop: 3 }}>{(x.pk.options || []).filter((o) => o.k === x.pk.k).map((o) => 'You: ' + decode(o.text)).join('') + (x.done ? '  \u2014  Outcome: ' + ((x.pk.options || []).find((o) => o.k === x.r.k) || {}).text : '')}</Text>
        </Pressable>
      ))}
      <Text style={[s.foot, { paddingHorizontal: 16, paddingVertical: 12 }]}>
        Score: 100 means certain and right, 50 is a shrug, 0 is certain and wrong (a Brier score, the standard
        for forecasters, shown as points). The desk is scored the same way on the same outcomes.
      </Text>
    </Section>
  );
}

function AnalystPanel({ item, specMatches, pick, onPick, resolved }) {
  const hist = item.hist || {};
  const dec = item.dec || {};
  const call = hist.call || {};
  const p = Math.max(0, Math.min(100, Number(call.p) || 0));
  const br = hist.base_rate;
  const brLine = br ? (br.low_n
    ? `Comparable cases: ${br.n} — too few to put a percentage on`
    : `Comparable cases: ${br.n} · ` + Object.entries(br.dist || {}).sort((a, b) => b[1] - a[1])
        .map(([k, v]) => k.replace(/_/g, ' ') + ' ' + Math.round(v) + '%').join(' · ')) : null;
  // oldest first: the desk's memory reads forward into the present, not backward from it
  const pres = (hist.precedents || []).slice().sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')));
  const sub = { color: C.muted, fontSize: 13, lineHeight: 19, marginTop: 6 };
  const lbl = [s.ctxlbl, MONO, { marginTop: 16 }];
  const body = { color: C.text, fontSize: 15.5, lineHeight: 24, marginTop: 6, fontFamily: 'Charter' };

  const past = [
    pres.length ? (
      <View key="pre">
        {pres.map((x, i) => (
          <View key={i} style={{ paddingVertical: 10, borderTopWidth: i ? 1 : 0, borderTopColor: C.line }}>
            <Text style={[MONO, { fontSize: 10, letterSpacing: 1.3, fontWeight: '700' }]}>
              <Text style={{ color: C.accent }}>{String(x.date || '').slice(0, 7)}</Text>
              {x.use != null ? (
                <Text style={{ color: x.use >= 60 ? C.calm : x.use >= 40 ? C.elev : C.muted }}>
                  {'   WEIGHT ' + x.use + (x.use < 40 ? ' \u00b7 CITED, NOT COUNTED' : '')}
                </Text>
              ) : null}
            </Text>
            <Text style={[s.p, { fontSize: 15.5, lineHeight: 24, marginTop: 5, marginBottom: 0 }]}>{decode(x.line || '')}</Text>
          </View>
        ))}
      </View>
    ) : null,
    brLine ? <Text key="br" style={[MONO, { color: C.muted, fontSize: 11, marginTop: 8 }]}>{brLine}</Text> : null,
  ].filter(Boolean);

  const present = [
    dec.verdict ? (
      <View key="v" style={[s.verdict, { borderColor: (VERDICT_META[dec.verdict] || VERDICT_META.partly).c, marginTop: 8 }]}>
        <Text style={[MONO, { color: C.muted, fontSize: 10, letterSpacing: 1.6 }]}>THE CLAIM IS</Text>
        <Text style={[MONO, { color: (VERDICT_META[dec.verdict] || VERDICT_META.partly).c, fontSize: 18, fontWeight: '800', letterSpacing: 2, marginTop: 2 }]}>
          {(VERDICT_META[dec.verdict] || VERDICT_META.partly).label.toUpperCase()}
        </Text>
      </View>
    ) : null,
    call.update ? (
      <View key="u"><Text style={lbl}>HOW THE HISTORY MOVED THIS</Text>
        <Text style={body}>{decode(call.update)}</Text></View>
    ) : null,
    (dec.angles || []).length ? (
      <View key="a"><Text style={lbl}>WHO GAINS, WHO PAYS</Text>
        {dec.angles.map((a, i) => (
          <Text key={i} style={body}><Text style={{ color: C.accent }}>› </Text>
            <Text style={{ fontWeight: '700' }}>{decode(a.party)}</Text>{' — ' + decode(a.effect)}</Text>
        ))}</View>
    ) : null,
    (specMatches || []).length ? (
      <View key="w">{specMatches.map((sp, i) => (
        <View key={i}>
          <Text style={[s.ctxlbl, MONO, { marginTop: 12, color: (GRADE_META[sp.grade] || GRADE_META.unverified).c }]}>
            {'WATCHTOWER · ' + (GRADE_META[sp.grade] || GRADE_META.unverified).label}
          </Text>
          <Text style={body}>{decode(sp.obs) + ' — ' + decode(sp.src || '')}</Text>
        </View>
      ))}</View>
    ) : null,
  ].filter(Boolean);

  const future = [
    scenariosOf(item) ? <YourCall key="sc" item={item} pick={pick} onPick={onPick} resolved={resolved} /> : null,
    call.event ? (
      <View key="c" style={{ marginTop: 8 }}>
        <View style={{ flexDirection: 'row', alignItems: 'flex-start' }}>
          <Text style={[MONO, { color: C.accent, fontSize: 30, fontWeight: '800', width: 84, lineHeight: 34 }]}>{p + '%'}</Text>
          <Text style={{ color: C.text, fontSize: 15.5, lineHeight: 21, flex: 1, fontWeight: '600' }}>{decode(call.event)}</Text>
        </View>
        <View style={{ marginTop: 6 }}><ProbBar p={p} /></View>
        {call.horizon || call.conf ? (
          <Text style={[MONO, { color: C.muted, fontSize: 10, letterSpacing: 1.2, marginTop: 4 }]}>
            {[call.horizon ? String(call.horizon).toUpperCase() : null, call.conf ? 'CONFIDENCE ' + String(call.conf).toUpperCase() : null].filter(Boolean).join(' · ')}
          </Text>
        ) : null}
        <ForAgainst pro={hist.for} con={hist.against} />
      </View>
    ) : null,
    hist.long && hist.long.event ? (
      <View key="l" style={{ marginTop: 14 }}>
        <Text style={[s.ctxlbl, MONO]}>{'FURTHER OUT' + (hist.long.horizon ? ' · ' + String(hist.long.horizon).toUpperCase() : '')}</Text>
        <ProbList items={[{ label: decode(hist.long.event), p: Math.max(0, Math.min(100, Number(hist.long.p) || 0)) }]} />
      </View>
    ) : null,
    hist.contrarian && hist.contrarian.claim ? (
      <View key="x" style={{ marginTop: 10, borderLeftWidth: 3, borderLeftColor: C.high, paddingLeft: 9 }}>
        <Text style={[s.ctxlbl, MONO, { color: C.high }]}>
          {'THE OTHER SIDE OF THE TRADE' + (hist.contrarian.who ? ' · ' + hist.contrarian.who : '')}
        </Text>
        <ProbList color={C.high} items={[{ label: decode(hist.contrarian.claim), p: Math.max(0, Math.min(100, Number(hist.contrarian.p_desk) || 0)), shown: (Number(hist.contrarian.p_desk) || 0) + '%' }]} />
        <Text style={[MONO, { color: C.muted, fontSize: 9.5, marginTop: -4 }]}>
          {"THE DESK'S NUMBER ON THEIR CLAIM" + (hist.contrarian.their_record && hist.contrarian.their_record !== 'no scored record' ? ' · THEIR RECORD: ' + decode(hist.contrarian.their_record) : '')}
        </Text>
        {hist.contrarian.why ? <Text style={body}>{decode(hist.contrarian.why)}</Text> : null}
      </View>
    ) : null,
    dec.kill ? (
      <View key="k"><Text style={lbl}>WHAT WOULD CHANGE THIS READ</Text>
        <Text style={body}>{decode(dec.kill)}</Text></View>
    ) : null,
  ].filter(Boolean);

  if (!past.length && !present.length && !future.length) {
    return <Text style={[s.foot, { marginBottom: 18 }]}>The desk has not filed its analysis on this story yet — the next run will carry the read, the call, and the history behind it.</Text>;
  }
  return (
    <View style={[s.storycard, { borderColor: C.accent, marginTop: 10, paddingTop: 16 }]}>
      <Text style={[s.ctxlbl, MONO, { color: C.accent }]}>THE GEOPOLITICAL ANALYST</Text>
      <Text style={sub}>The desk's own reading of this story, in the order it happened: the record behind it, where it stands now, and what it thinks comes next.</Text>
      <Movement n="I" title="WHAT CAME BEFORE" sub="the precedents the desk is reading from, oldest first">{past}</Movement>
      <Movement n="II" title="WHERE IT STANDS NOW" sub="what the history does to today's picture">{present}</Movement>
      <Movement n="III" title="WHAT HAPPENS NEXT" sub="the desk's call, and the case against it">{future}</Movement>
    </View>
  );
}

function ArticlePage({ item, simpleText, easy, deep, onBack, onBoard, calls,
                       specMatches, chatter, prev, next, onOpen, isSaved, onSave,
                       tsize, onSize, theme, onTheme, level, onLevel, pick, onPick, resolved }) {
  const { head, stand, longHead } = articleParts(item);
  const secRefs = useRef([]);
  const [simple, setSimple] = useState(false);       // the one reading control: simplify THIS article
  const body = bodyFor(item, simpleText, simple, false);
  const [pane, setPane] = useState(null);
  const cardRef = useRef(null);   // the off-screen SVG the share card rasterises from           // 'analyst' | 'consp' | null
  const conspItems = chatterFor(item);
  // NYT's article furniture: back to the section, save it, send it to someone.
  const share = () => {
    const url = (item.srcs || []).find((sc) => sc.u);
    Share.share({ message: decode(head) + (url ? '\n\n' + url.u : '') + '\n\nvia Parallax' })
      .catch(() => {});
  };
  return (
    <View style={s.stack}>
      <View style={s.artbar}>
        <Pressable onPress={onBack} hitSlop={8}><Text style={s.backtxt}>‹ All headlines</Text></Pressable>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 16, marginLeft: 'auto' }}>
          {/* 2026-09-15: the SIMPLIFY toggle is gone - one depth, the deep one (user's call) */}
          <Pressable onPress={onSave} hitSlop={8}>
            <Text style={[MONO, { color: isSaved ? C.accent : C.muted, fontSize: 11, letterSpacing: 1.2 }]}>
              {(isSaved ? '★ SAVED' : '☆ SAVE')}
            </Text>
          </Pressable>
          <Pressable onPress={share} hitSlop={8}>
            <Text style={[MONO, { color: C.muted, fontSize: 11, letterSpacing: 1.2 }]}>↗ SHARE</Text>
          </Pressable>
        </View>
      </View>
      <View style={s.article}>
        <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 14 }}>
          <Text style={[s.kick, MONO, { flex: 0, marginRight: 10 }]}>{kickerOf(item)}</Text>
          <Text style={[s.readtime, MONO]}>{readTime(body, item.context)}</Text>
        </View>
        <Text style={[stand ? s.artH : s.artHLong, SERIF, T(stand ? 30 : 25, stand ? 37 : 32)]}>{stand ? head : longHead}</Text>
        {stand ? <Text style={[s.artStand, T(17.5, 26)]}>{stand}</Text> : null}
        <View style={s.artrule} />
        <Text style={[s.stime, MONO, { marginBottom: 14 }]}>{fullStamp(item.ts)}</Text>
        {!simple && Array.isArray(item.read) ? <Toc items={item.read.map((sec, i) => ({ label: sec.h, get: () => secRefs.current[i] }))} /> : null}
        {/* Three doors at the TOP of every story, before the read: the 30-second version, the desk's
            own analysis and call, and what the boards are saying. The pane opens under the buttons.
            2026-09-16: SUMMARY added at the editor's request - it needs no new pipeline work, because
            every card already carries `t` (the desk's 2-4 sentence lede) and `context` (one plain
            paragraph, no labels). Reading time is measured from the full read, not the summary. */}
        <View style={{ flexDirection: 'row', gap: 8, marginBottom: 18 }}>
          <Pressable onPress={() => setPane(pane === 'sum' ? null : 'sum')} style={[s.artbtn, { borderColor: C.calm }, pane === 'sum' && s.artbtnOn]}>
            <Text style={[s.artbtnT, MONO, { color: C.calm }]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7}>≡ SUMMARY</Text>
            <Text style={s.artbtnS}>the story in 30 seconds</Text>
          </Pressable>
          <Pressable onPress={() => setPane(pane === 'analyst' ? null : 'analyst')} style={[s.artbtn, pane === 'analyst' && s.artbtnOn]}>
            <Text style={[s.artbtnT, MONO]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7}>◉ ANALYST</Text>
            <Text style={s.artbtnS}>{scenariosOf(item) ? 'the desk\'s call \u2014 and yours' : 'the desk\'s read and its call'}</Text>
          </Pressable>
          <Pressable onPress={() => setPane(pane === 'consp' ? null : 'consp')} style={[s.artbtn, { borderColor: C.high }, pane === 'consp' && s.artbtnOn]}>
            <Text style={[s.artbtnT, MONO, { color: C.high }]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7}>☍ CONSPIRACY</Text>
            <Text style={s.artbtnS}>{conspItems.length ? conspItems.length + (conspItems.length === 1 ? ' claim circulating' : ' claims circulating') : 'nothing circulating yet'}</Text>
          </Pressable>
        </View>
        {pane === 'sum' ? (
          <View style={[s.storycard, { borderColor: C.calm, marginBottom: 18 }]}>
            <Text style={[s.ctxlbl, MONO, { color: C.calm }]}>THE STORY IN SHORT</Text>
            {item.h ? <Text style={[s.p, { marginTop: 8 }]}>{decode(item.h)}</Text> : null}
            {item.t ? <Text style={[s.p, { marginTop: 10 }]}>{decode(item.t)}</Text> : null}
            {item.context ? (
              <>
                <Text style={[s.ctxlbl, MONO, { color: C.calm, marginTop: 16 }]}>WHY IT MATTERS, PLAINLY</Text>
                <Text style={[s.p, { marginTop: 6 }]}>{decode(item.context)}</Text>
              </>
            ) : null}
            {/* 2026-09-16 (editor: "this should [be] for the user who wants a summary of the analysis
                or conspiracy. Summary should have a button for all filters of a news article"). SUMMARY
                used to summarise the READ alone and then point at the analyst. It now carries a short
                version of every door on the story - the desk's call with the strongest argument each
                way, and what the boards are saying - each with the button that opens the full thing.
                A reader in a hurry gets the whole story here; a reader who wants one part taps it. */}
            {item.hist && item.hist.call && item.hist.call.event ? (
              <View style={{ marginTop: 18, borderTopWidth: 1, borderTopColor: C.line, paddingTop: 14 }}>
                <Text style={[s.ctxlbl, MONO, { color: C.accent }]}>AND THE DESK'S CALL</Text>
                <View style={{ flexDirection: 'row', alignItems: 'flex-start', marginTop: 8 }}>
                  <Text style={[MONO, { color: C.accent, fontSize: 24, fontWeight: '800', width: 68, lineHeight: 27 }]}>
                    {Math.round(Number(item.hist.call.p) || 0) + '%'}
                  </Text>
                  <Text style={{ color: C.text, fontSize: 15, lineHeight: 21, flex: 1 }}>{decode(item.hist.call.event)}</Text>
                </View>
                {(item.hist.for || [])[0] ? (
                  <Text style={[s.p, { fontSize: 15, lineHeight: 23, marginTop: 10, marginBottom: 0 }]}>
                    <Text style={[MONO, { color: C.calm, fontSize: 10, letterSpacing: 1.3, fontWeight: '800' }]}>{'FOR  '}</Text>
                    {decode(String(item.hist.for[0]))}
                  </Text>
                ) : null}
                {(item.hist.against || [])[0] ? (
                  <Text style={[s.p, { fontSize: 15, lineHeight: 23, marginTop: 6, marginBottom: 0 }]}>
                    <Text style={[MONO, { color: C.crit, fontSize: 10, letterSpacing: 1.3, fontWeight: '800' }]}>{'BUT  '}</Text>
                    {decode(String(item.hist.against[0]))}
                  </Text>
                ) : null}
                <Pressable onPress={() => setPane('analyst')} style={s.sumdoor}>
                  <Text style={[s.artbtnT, MONO, { color: C.accent }]}>{'\u25c9  THE FULL ANALYSIS \u203a'}</Text>
                  <Text style={s.artbtnS}>the record behind it, where it stands, every argument both ways</Text>
                </Pressable>
              </View>
            ) : null}
            {conspItems.length ? (
              <View style={{ marginTop: 18, borderTopWidth: 1, borderTopColor: C.line, paddingTop: 14 }}>
                <Text style={[s.ctxlbl, MONO, { color: C.high }]}>AND WHAT IS CIRCULATING</Text>
                <Text style={[s.p, { fontSize: 15, lineHeight: 23, marginTop: 8, marginBottom: 0 }]}>
                  {decode(conspItems[0].head || conspItems[0].claim || '')}
                </Text>
                <Text style={[MONO, { color: C.muted, fontSize: 10, letterSpacing: 1.2, marginTop: 6 }]}>
                  {'UNVERIFIED \u00b7 ' + (conspItems[0].spread ? decode(String(conspItems[0].spread)).toUpperCase() : 'CIRCULATING')
                    + (conspItems.length > 1 ? '  \u00b7  ' + (conspItems.length - 1) + ' MORE' : '')}
                </Text>
                <Pressable onPress={() => setPane('consp')} style={[s.sumdoor, { borderColor: C.high }]}>
                  <Text style={[s.artbtnT, MONO, { color: C.high }]}>{'\u260d  THE FULL CONSPIRACY READ \u203a'}</Text>
                  <Text style={s.artbtnS}>each claim, the mechanism it needs, and what the desk makes of it</Text>
                </Pressable>
              </View>
            ) : null}
            {!item.h && !item.t && !item.context ? (
              <Text style={[s.foot, { marginTop: 10 }]}>No summary was filed for this story — the full read is below.</Text>
            ) : null}
          </View>
        ) : null}
        {pane === 'analyst' ? (
          <View style={{ marginBottom: 18 }}>
            <AnalystPanel item={item} specMatches={specMatches} pick={pick} onPick={onPick} resolved={resolved} />
            {item.hist && item.hist.call && item.hist.call.event ? (
              <>
                <Pressable onPress={() => shareCall(item, cardRef)} style={s.sharebtn}>
                  <Text style={[s.artbtnT, MONO, { color: C.accent }]}>↗  SHARE THIS CALL</Text>
                  <Text style={s.artbtnS}>the number, and the case for and against it</Text>
                </Pressable>
                <View style={{ position: 'absolute', left: -9999, top: 0 }} pointerEvents="none">
                  <CallCard item={item} svgRef={cardRef} />
                </View>
              </>
            ) : null}
          </View>
        ) : null}
        {pane === 'consp' ? <View style={{ marginBottom: 18 }}><ConspiracyPanel items={conspItems} forceOpen /></View> : null}
        {pane ? <View style={[s.artrule, { marginTop: 0 }]} /> : null}
        {!simple && Array.isArray(item.read) && item.read.length ? (
          <>
            <Text style={[s.storyP, T(18, 30), { marginBottom: 6 }]}>{decode(item.t || '')}</Text>
            <Sections items={item.read} size={18} refs={secRefs} />
          </>
        ) : (
          <>
            <Text style={[s.ctxlbl, MONO, { color: C.accent }]}>{simple ? 'IN PLAIN ENGLISH' : 'THE READ'}</Text>
            {paragraphs(decode(body)).map((para, i) => (
              <Text key={i} style={[s.storyP, T(simple ? 19 : 18, simple ? 32 : 30), i > 0 && { marginTop: 14 }]}>{para}</Text>
            ))}
          </>
        )}
        {item.srcs && item.srcs.length ? (
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', marginTop: 18, gap: 8 }}>
            <Text style={[MONO, { color: C.muted, fontSize: 10.5, letterSpacing: 1, marginRight: 2 }]}>SOURCES</Text>
            {item.srcs.map((sc, i) => (
              <Pressable key={i} onPress={() => sc.u && Linking.openURL(sc.u)} style={s.srcchip}>
                <Text style={[MONO, { color: C.accent, fontSize: 12 }]}>{decode(sc.n || 'link') + ' ↗'}</Text>
              </Pressable>
            ))}
          </View>
        ) : null}
      </View>
      {/* keep reading — the paper hands you the next story rather than a dead end */}
      {next || prev ? (
        <Section title="Keep reading">
          {[prev, next].filter(Boolean).map((n, i) => (
            <Pressable key={i} onPress={() => onOpen(n.i)} style={s.nextrow}>
              <View style={{ flex: 1 }}>
                <Text style={[s.kick, MONO]} numberOfLines={1}>{kickerOf(n.s)}</Text>
                <Text style={[s.nextH, SERIF]} numberOfLines={2}>{articleParts(n.s).head}</Text>
              </View>
              <Text style={{ color: C.accent, fontSize: 16, marginLeft: 10 }}>›</Text>
            </Pressable>
          ))}
        </Section>
      ) : null}
    </View>
  );
}


// ── FILTERS live behind a dropdown, not a banner — tap ⌕ to reveal the chips ──
function FilterDrop({ pairs, active, onPick }) {
  const [open, setOpen] = useState(active !== 'ALL');
  const activeLab = active !== 'ALL' ? ' · ' + String(active).toUpperCase() : '';
  return (
    <View>
      <Pressable style={s.ctxbtn} onPress={() => setOpen((o) => !o)}>
        <Text style={[s.ctxbtnTxt, MONO]}>{(open ? '− ' : '＋ ') + '⌕ FILTER' + activeLab}</Text>
      </Pressable>
      {open ? <ChipBar pairs={pairs} active={active} onPick={onPick} /> : null}
    </View>
  );
}



// ── THE BOARD — the situation-room wall map. Tap a point, get the read. Learning is invited

// ── QUIZ — optional daily 5-question self-test on the brief; collapsed so it never intrudes ──
function QuizQuestion({ q, index, onAnswered }) {
  const [picked, setPicked] = useState(null);
  const done = picked !== null;
  return (
    <View style={s.storycard}>
      <Text style={[s.storyH3, SERIF, { fontSize: 17 }]}>{(index + 1) + '. ' + decode(q.q)}</Text>
      {(q.options || []).map((opt, oi) => {
        const isRight = oi === q.answer;
        const isPicked = oi === picked;
        const border = done ? (isRight ? C.calm : isPicked ? C.crit : C.line) : C.line;
        const color = done ? (isRight ? C.calm : isPicked ? C.crit : C.muted) : C.text;
        return (
          <Pressable
            key={oi}
            disabled={done}
            onPress={() => { setPicked(oi); onAnswered(oi === q.answer); }}
            style={[s.rchip, { alignSelf: 'stretch', marginBottom: 6, borderColor: border }]}
          >
            <Text style={{ color, fontSize: 14.5, lineHeight: 21 }}>{decode(opt)}</Text>
          </Pressable>
        );
      })}
      {done && q.why ? (
        <View style={s.ctxpanel}>
          <Text style={s.ctxP}>{decode(q.why)}</Text>
        </View>
      ) : null}
    </View>
  );
}

function QuizSection({ quiz, bare, onDone }) {
  // `bare` drops the card chrome and the extra tap: used under today's lesson on HOME, where the
  // reader has already said "take the quiz" and should not have to say it twice (2026-09-16).
  const [open, setOpen] = useState(!!bare);
  const [score, setScore] = useState(0);
  const [answered, setAnswered] = useState(0);
  if (!quiz || !quiz.length) return null;
  const onAnswered = (right) => { setAnswered((a) => a + 1); if (right) setScore((v) => v + 1); };
  const doneAll = answered === quiz.length;
  useEffect(() => { if (doneAll && onDone) onDone(score, quiz.length); }, [doneAll]);
  const body = (
    <>
      {!bare ? (
        <Pressable style={s.ctxbtn} onPress={() => setOpen((o) => !o)}>
          <Text style={[s.ctxbtnTxt, MONO]}>{(open ? '− ' : '＋ ') + "TAKE TODAY'S QUIZ"}</Text>
        </Pressable>
      ) : null}
      {open ? (
        <>
          {quiz.map((q, i) => <QuizQuestion key={i} q={q} index={i} onAnswered={onAnswered} />)}
          {doneAll ? (
            <Text style={[s.ctxlbl, MONO]}>
              {'SCORE: ' + score + ' / ' + quiz.length +
                (score === quiz.length ? ' — CLEAN SWEEP' : score >= 3 ? ' — SOLID READ' : " — REREAD TODAY'S BRIEF")}
            </Text>
          ) : null}
        </>
      ) : null}
    </>
  );
  return bare ? body : <Section title="Test yourself" extra={quiz.length + ' questions'} fold>{body}</Section>;
}

// ── DECODE — a claim, interrogated: announced vs binding, and who gains vs who pays ──


// ── MONEY PRINTER RED BOARD — Tier-0 prints vs stated thresholds (mirrors dashboard plumbing tab).
// `board` is script-owned (data_feeds.py redboard apply): colour, lines, crisis channels A-D. ──
const boardColor = () => ({ RED: C.crit, YELLOW: C.elev, GREEN: C.calm });   // read at render so the theme can change
function RedBoard({ board, compact, onPress }) {
  const [chan, setChan] = useState(null);
  const [lineOpen, setLineOpen] = useState(null);
  if (!board || !board.color) return null;
  const col = boardColor()[board.color] || C.muted;
  const hit = (board.lines || []).filter((l) => l.hit).length;
  const tripped = (board.channels || []).filter((c) => c.status === 'TRIPPED');
  const since = (board.since ? board.color.toLowerCase() + ' since ' + board.since : '')
    + (board.days ? ' · ' + board.days + ' business day' + (board.days === 1 ? '' : 's') : '');
  if (compact) {
    return (
      <Pressable onPress={onPress}
        style={{ backgroundColor: C.panel, borderWidth: 1, borderColor: C.line, borderLeftWidth: 4, borderLeftColor: col, borderRadius: 8, padding: 13, flexDirection: 'row', alignItems: 'center' }}>
        <View style={{ flex: 1 }}>
          <Text style={[MONO, { color: C.accent, fontSize: 11, letterSpacing: 1.5 }]}>MONEY PRINTER RED BOARD</Text>
          <Text style={{ color: C.muted, fontSize: 11, marginTop: 3 }}>
            {hit + ' of ' + (board.lines || []).length + ' lines crossed · ' + (tripped.length ? tripped.length + ' CHANNEL TRIPPED' : 'no channel tripped') + (board.asof ? ' · as of ' + board.asof : '')}
          </Text>
        </View>
        <View style={{ borderWidth: 1, borderColor: col, borderRadius: 5, paddingVertical: 6, paddingHorizontal: 12 }}>
          <Text style={[MONO, { color: col, fontWeight: '700', fontSize: 12, letterSpacing: 1 }]}>{board.color}</Text>
        </View>
      </Pressable>
    );
  }
  return (
    <Section title="Money printer red board" extra={board.color}>
      <View style={{ backgroundColor: C.panel, borderWidth: 1, borderColor: C.line, borderLeftWidth: 4, borderLeftColor: col, borderRadius: 8, padding: 12 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 8 }}>
          <View style={{ borderWidth: 1, borderColor: col, borderRadius: 5, paddingVertical: 4, paddingHorizontal: 10, marginRight: 10 }}>
            <Text style={[MONO, { color: col, fontWeight: '700', fontSize: 13, letterSpacing: 1.5 }]}>{board.color}</Text>
          </View>
          <Text style={[MONO, { color: C.muted, fontSize: 9.5, flex: 1 }]}>{since.toUpperCase()}</Text>
        </View>
        {/* 2026-09-16 (user: "add a graph or simplify"). Each line is a threshold and a reading, so it
            draws as one: the bar fills to where the number sits, the notch is the line it has to cross.
            A crossed line is visible at a glance instead of read. */}
        {(board.lines || []).map((l, i) => {
          const lw = lineWhy(l.k);
          const isOn = lineOpen === i;
          const num = parseFloat(String(l.v).replace(/[^0-9.\-]/g, ''));
          const tm = String(l.k).match(/([0-9]+(?:\.[0-9]+)?)\s*%?\s*$/);
          const thr = tm ? parseFloat(tm[1]) : NaN;
          const span = Number.isFinite(num) && Number.isFinite(thr) && thr > 0 && num >= 0 ? Math.max(num, thr) * 1.25 : 0;
          return (
            <View key={'l' + i} style={{ paddingVertical: 7, borderTopWidth: 1, borderTopColor: C.line }}>
              <Pressable onPress={() => lw && setLineOpen(isOn ? null : i)} style={{ flexDirection: 'row', alignItems: 'baseline' }}>
                <Text style={[MONO, { color: l.hit ? C.crit : C.muted, fontSize: 11, width: 18 }]}>{l.hit ? '✕' : '·'}</Text>
                <Text style={[MONO, { color: l.hit ? C.text : C.muted, fontSize: 11.5, flex: 1 }]} numberOfLines={1}>{decode(l.k)}</Text>
                <Text style={[MONO, { color: l.hit ? C.crit : C.text, fontSize: 12.5, fontWeight: '700' }]}>{l.v}</Text>
                {lw ? (
                  <Text style={[MONO, { color: C.accent, fontSize: 8.5, letterSpacing: 0.8, marginLeft: 8 }]}>
                    {isOn ? 'CLOSE' : 'EXPLAIN'}
                  </Text>
                ) : null}
              </Pressable>
              {(l.hist || []).length >= 8 ? (
                <View style={{ marginTop: 8, marginLeft: 18 }}>
                  <Sparkline hist={l.hist} line={Number.isFinite(l.line) ? l.line : thr} hit={l.hit} />
                  <Text style={[MONO, { color: C.muted, fontSize: 8.5, letterSpacing: 0.6, marginTop: 2 }]}>
                    {'LAST ' + l.hist.length + ' SESSIONS · DASHED LINE IS ' + (Number.isFinite(l.line) ? l.line : thr)}
                  </Text>
                </View>
              ) : span ? (
                <View style={{ height: 6, backgroundColor: C.barBg, borderRadius: 3, marginTop: 6, marginLeft: 18, overflow: 'hidden' }}>
                  <View style={{ width: Math.max(2, Math.min(100, (num / span) * 100)) + '%', height: '100%', backgroundColor: l.hit ? C.crit : C.calm }} />
                  <View style={{ position: 'absolute', left: Math.min(98, (thr / span) * 100) + '%', top: 0, width: 2, height: 6, backgroundColor: C.text, opacity: 0.9 }} />
                </View>
              ) : null}
              {isOn && lw ? (
                <View style={{ marginTop: 9, marginLeft: 18, borderLeftWidth: 2, borderLeftColor: C.accentDim, paddingLeft: 10 }}>
                  <Text style={[MONO, { color: C.text, fontSize: 10.5, letterSpacing: 1, fontWeight: '700' }]}>{lw.title.toUpperCase()}</Text>
                  <Text style={[s.p, { fontSize: 14.5, lineHeight: 22, marginTop: 5 }]}>{lw.body}</Text>
                </View>
              ) : null}
            </View>
          );
        })}
        <Text style={[MONO, { color: C.muted, fontSize: 9.5, letterSpacing: 0.8, marginTop: 10, marginBottom: 4 }]}>CRISIS CHANNELS · WHERE A SQUEEZE WOULD EXIT</Text>
        {(board.channels || []).map((c, i) => {
          const cc = c.status === 'TRIPPED' ? C.crit : c.status === 'not tripped' ? C.calm : C.elev;
          return (
            <View key={'c' + i} style={{ paddingVertical: 5, borderTopWidth: 1, borderTopColor: C.line }}>
              <Pressable onPress={() => CHANNEL_WHY[c.id] && setChan(chan === c.id ? null : c.id)}
                style={{ flexDirection: 'row', alignItems: 'center' }}>
                <Text style={[MONO, { color: C.accent, fontSize: 11, width: 18 }]}>{c.id}</Text>
                <Text style={[MONO, { color: C.text, fontSize: 11.5, flex: 1 }]}>{decode(c.name)}</Text>
                <Text style={[MONO, { color: cc, fontSize: 9.5, letterSpacing: 0.8 }]}>
                  {/* 2026-09-16 (user: "I'm not sure what not tripped means or just news"). Say it in words. */}
                  {/TRIPPED/i.test(c.status) && !/NOT/i.test(c.status) ? 'FIRING'
                    : /NOT/i.test(c.status) ? 'QUIET'
                    : /NEWS/i.test(c.status) ? 'NO DATA · WATCH THE WIRE' : String(c.status).toUpperCase()}
                </Text>
                {CHANNEL_WHY[c.id] ? (
                  <Text style={[MONO, { color: C.accent, fontSize: 8.5, letterSpacing: 0.8, marginLeft: 8 }]}>
                    {chan === c.id ? 'CLOSE' : 'EXPLAIN'}
                  </Text>
                ) : null}
              </Pressable>
              {chan === c.id && CHANNEL_WHY[c.id] ? (
                <View style={{ marginTop: 8, marginLeft: 18, borderLeftWidth: 2, borderLeftColor: C.accentDim, paddingLeft: 10, paddingBottom: 4 }}>
                  <Text style={[MONO, { color: C.text, fontSize: 10.5, letterSpacing: 1, fontWeight: '700' }]}>{CHANNEL_WHY[c.id][0].toUpperCase()}</Text>
                  <Text style={[s.p, { fontSize: 14.5, lineHeight: 22, marginTop: 5 }]}>{CHANNEL_WHY[c.id][1]}</Text>
                </View>
              ) : null}
              {c.detail ? <Text style={{ color: C.muted, fontSize: 11, marginLeft: 18, marginTop: 2 }}>{decode(c.detail)}</Text> : null}
            </View>
          );
        })}
        <Text style={[s.foot, { marginTop: 8 }]}>
          {'Rule: ' + decode(board.rule || 'RED 3+ lines, YELLOW 1-2, GREEN 0') + '. Non-events score: ' + (board.nonevents || 0) + ' red-board day' + (board.nonevents === 1 ? '' : 's') + ' with no channel tripped, counted against the crisis read.'}
        </Text>
      </View>
    </Section>
  );
}

// ── LIVE WATCHLIST — the prints the economic read is built on (plumbing.series) ──
const trendC = () => ({ up: C.high, dn: C.calm, flat: C.muted });
// Crisis-channel and threshold explainers. Same principle as WHY on the money prints (2026-09-16,
// user: "I also want an explain what this means button for the crisis channels ... the jargon is so
// hard to comprehend"). A tripwire nobody understands is decoration.
const CHANNEL_WHY = {
  A: ['Forced selling of government debt',
      'If big holders have to raise cash fast, the first thing they sell is short-dated government debt, because it is the easiest thing to sell. Watching whether that is happening tells you if someone large is in trouble before they announce it.'],
  B: ['Money leaving smaller banks',
      'Depositors move money to bigger banks when they get nervous. A steady drain from small banks is the early shape of a banking scare - it showed up weeks before the failures in 2023.'],
  C: ['A currency breaking outside the rich world',
      'When the dollar is expensive and money is tight, the weakest currency goes first - and a government that loses control of its currency usually reaches for capital controls, import bans or an IMF programme, all of which are political events.'],
  D: ['Automated selling feeding on itself',
      'Much of the market is run by systems that sell when prices fall and borrowing costs rise. When funding costs jump, those systems sell together, which pushes prices down further. It is the mechanism that turns a bad day into a crash.'],
};
const LINE_WHY = [
  [/10y|10[- ]?year/i, 'The 10-year yield above its line',
   'The benchmark borrowing rate for the whole world. Above this level, mortgages, company debt and government interest bills all reprice upward at once - the desk treats it as the point where expensive money starts doing visible damage.'],
  [/30y|30[- ]?year/i, 'The 30-year yield above its line',
   'The long end is the market judging whether a government can keep paying over decades. Central banks can hold short rates down; they cannot hold this one down for long. When it leads the move, the market is pricing doubt rather than growth.'],
  [/brent|oil|crude/i, 'Oil above its line',
   'Above this level oil stops being a market story and becomes an inflation story: it feeds transport, fertiliser and plastics, so it reaches food and household bills within months and forces central banks to choose between growth and prices.'],
  [/sofr|effr/i, 'The funding-rate gap',
   'What banks actually pay to borrow overnight against what the central bank says they should pay. When the gap widens, someone is paying up for cash - it is the plumbing equivalent of a fever, and it moves before anything visible breaks.'],
];
function lineWhy(k) {
  const t = String(k || '');
  for (const [rx, title, body] of LINE_WHY) if (rx.test(t)) return { title, body };
  return null;
}

// ── SPARKLINE — the path a number took, with the line it had to cross. ─────────────────────────
// 2026-09-16 (user: "the graphs are bad, I want an actual trend line graph not just a bar for the
// treasury measures"). A bar says where a number sits; it cannot say whether it got there slowly or
// this week, which for a yield is the whole story. data_feeds.py now ships ~40 business days per
// board line with the live tape as the last point, so this draws the real path against the threshold.
function Sparkline({ hist, line, hit, w = 300, h = 40 }) {
  if (!Array.isArray(hist) || hist.length < 8) return null;
  const vals = hist.filter((v) => typeof v === 'number' && Number.isFinite(v));
  if (vals.length < 8) return null;
  const lo = Math.min(...vals, Number.isFinite(line) ? line : Infinity);
  const hi = Math.max(...vals, Number.isFinite(line) ? line : -Infinity);
  const span = hi - lo || 1;
  const pad = span * 0.12;
  const y = (v) => h - 3 - ((v - lo + pad / 2) / (span + pad)) * (h - 6);
  const x = (i) => (i / (vals.length - 1)) * w;
  const d = vals.map((v, i) => (i ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(v).toFixed(1)).join(' ');
  const col = hit ? C.crit : C.calm;
  const ly = Number.isFinite(line) ? y(line) : null;
  return (
    <Svg width="100%" height={h} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none">
      {ly != null ? <Line x1="0" y1={ly} x2={w} y2={ly} stroke={C.text} strokeWidth="1" strokeDasharray="4 4" opacity="0.5" /> : null}
      <SvgPath d={d} stroke={col} strokeWidth="2" fill="none" strokeLinejoin="round" strokeLinecap="round" />
      <Circle cx={x(vals.length - 1)} cy={y(vals[vals.length - 1])} r="3.2" fill={col} />
    </Svg>
  );
}

// ── WHY A NUMBER MATTERS — the standing explanation behind each market print. ───────────────────
// 2026-09-16 (user: "add a context button on why each stock price is significant. For example
// explaining the 30 year yield or treasury"). The desk already writes a LIVE note on every series -
// what moved today. What was missing is the durable half: what this number IS and why a reader who
// has never traded should care. That does not change day to day, so it ships with the app instead of
// costing a run. Matched on the series name, most specific pattern first.
const WHY = [
  [/30[- ]?y(ear)?\b|30y/i, 'The 30-year Treasury yield',
   'What the US government pays to borrow for thirty years. It is the market\u2019s long-run verdict on inflation and on whether Washington can keep paying its bills - the one rate a central bank cannot simply set. It also sets the floor under mortgages and pension maths, so when it climbs the cost of housing and the value of every long-dated promise move with it.'],
  [/10[- ]?y(ear)?\b|10y/i, 'The 10-year Treasury yield',
   'The world\u2019s benchmark interest rate. Almost every other asset is priced off it, and a rising 10-year makes borrowing dearer everywhere at once - for companies, for mortgages, and for governments rolling over debt. It is the number to watch when a war, a deficit or an oil shock starts to cost real money.'],
  [/\b2[- ]?y(ear)?\b|2y/i, 'The 2-year Treasury yield',
   'The market\u2019s bet on where the central bank sets rates over the next two years. It moves on policy expectations rather than on long-run inflation, so the gap between it and the 10-year is the cleanest read on whether investors expect a slowdown.'],
  [/brent|crude|wti/i, 'The oil price',
   'The single fastest channel between a distant war and a household bill. Brent is the global benchmark; most of the world\u2019s crude prices off it. Because oil moves transport, fertiliser and plastics, an oil shock becomes a food and inflation shock within months - which is why an oil price is a political number, not only a financial one.'],
  [/diesel|petrol|gasoline|pump/i, 'The pump price',
   'Where an oil shock becomes politics. Diesel in particular moves freight, farming and construction, so it feeds into the price of nearly everything with a lag of weeks. It is also the most visible price in any economy, posted on signs, which makes it the one voters punish governments for.'],
  [/hormuz|transits|strait|bab el|suez|canal/i, 'Chokepoint traffic',
   'A count of how much actually moves through a passage that the world\u2019s energy trade cannot easily route around. Rhetoric about closing a strait is cheap; the transit count is the fact. When it falls, insurance, freight and crude prices follow - and the desk treats the count, not the threat, as the evidence.'],
  [/yanbu|pipeline|export cover|loadings/i, 'Export capacity',
   'Whether the oil can physically leave. A producer can hold vast reserves and still be cut off if a pipeline, terminal or loading berth is down, so export cover is what decides the price - not the size of the reserve. Watch storage: tanks cover an outage for a few days, and then exports stop.'],
  [/cpi|inflation|ppi|core/i, 'The inflation print',
   'The official measure of how fast prices are rising. It decides whether a central bank raises or cuts, which in turn moves every interest rate above. Look past the headline to the core and to the monthly change - the annual figure can fall while prices accelerate, because it is measured against last year.'],
  [/usd\/jpy|yen|euro|eur\/usd|dxy|dollar/i, 'The currency cross',
   'What one country\u2019s money buys of another\u2019s. A strong dollar makes commodities dearer for everyone who does not earn dollars and squeezes anyone holding dollar debt, which is most of the developing world. Sharp moves are often the first sign a government is losing control of its own rates.'],
  [/gold|bullion/i, 'The gold price',
   'What money costs when people stop trusting promises. Gold pays no interest, so holding it is a bet that currencies, bonds or governments are less safe than a metal. Central banks buying it in size is usually a statement about the dollar rather than about gold.'],
  [/sofr|fed funds|policy rate|discount/i, 'The policy rate',
   'The rate the central bank actually controls, and the anchor for short-term borrowing across the banking system. When market rates pull away from it, that gap is stress - it means someone is paying more than the official price to get funded.'],
  [/vix|volatility/i, 'The volatility index',
   'What it costs to insure against a fall in share prices, and so a direct reading of how frightened the market is. It spikes before it explains itself, which makes it useful as an alarm and useless as an argument.'],
  [/freight|tanker|charter|shipping|insurance|war risk/i, 'Freight and war-risk rates',
   'What it costs to move the cargo and to insure it through a dangerous stretch of water. These move before crude does, because a shipowner has to price the risk of the voyage before the cargo is sold - which makes them one of the earliest honest signals that a conflict is affecting trade.'],
  [/wheat|grain|corn|food|fertil/i, 'The food price',
   'The most politically dangerous number in this list. Bread prices have preceded more uprisings than any ideology, and grain markets are thin enough that one exporter\u2019s decision can move the world price. Watch export bans, not harvests.'],
  [/gas|ttf|lng/i, 'The gas price',
   'Heating, electricity and industry in one number, and unlike oil it is regional - gas cannot easily be shipped around a shortage without terminals to receive it. That is why a European gas price can triple while an American one does not move.'],
];
function whyOf(k) {
  const t = String(k || '');
  for (const [rx, title, body] of WHY) if (rx.test(t)) return { title, body };
  return null;
}

function LiveWatchlist({ items }) {
  const [open, setOpen] = useState(null);
  if (!items || !items.length) return null;
  return (
    <Section title="The money" extra={items.length + ' live prints'} fold open>
      {items.map((x, i) => {
        const why = whyOf(x.k);
        const isOpen = open === i;
        return (
          <View key={i} style={{ paddingVertical: 9, borderBottomWidth: 1, borderBottomColor: C.line }}>
            {/* 2026-09-16 (user: "fix the numbers to make it look better for the percentage ... just fold
                all of these into a headline"). The change used to run off the right edge because value and
                change shared one baseline row. Name on the left, value and change stacked on the right,
                each with room; the note and the explainer only appear when the row is opened. */}
            <Pressable onPress={() => setOpen(isOpen ? null : i)} style={{ flexDirection: 'row', alignItems: 'flex-start' }}>
              <Text style={[MONO, { color: C.text, fontSize: 12.5, flex: 1, paddingRight: 10 }]} numberOfLines={2}>{decode(x.k)}</Text>
              <View style={{ alignItems: 'flex-end', maxWidth: '46%' }}>
                <Text style={[MONO, { color: C.accent, fontSize: 16, fontWeight: '700' }]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7}>{x.v}</Text>
                {x.c ? (
                  <Text style={[MONO, { color: trendC()[x.t] || C.muted, fontSize: 10, textAlign: 'right', marginTop: 2 }]} numberOfLines={2}>
                    {(x.t === 'up' ? '\u25b2 ' : x.t === 'dn' ? '\u25bc ' : '') + x.c}
                  </Text>
                ) : null}
              </View>
              <Text style={{ color: C.accent, fontSize: 15, marginLeft: 8, marginTop: 1 }}>{isOpen ? '\u2212' : '\u203a'}</Text>
            </Pressable>
            {isOpen && x.note ? (
              <View style={{ marginTop: 10 }}>
                <Text style={[MONO, { color: C.elev, fontSize: 9.5, letterSpacing: 1.1, fontWeight: '700' }]}>WHAT MOVED IT TODAY</Text>
                <Text style={{ color: C.text, fontSize: 13.5, lineHeight: 20, marginTop: 5 }}>{decode(x.note)}</Text>
              </View>
            ) : null}
            {isOpen && why ? (
              <View style={{ marginTop: 12, borderLeftWidth: 2, borderLeftColor: C.accentDim, paddingLeft: 11, paddingBottom: 4 }}>
                <Text style={[MONO, { color: C.accent, fontSize: 9.5, letterSpacing: 1.1, fontWeight: '700' }]}>WHAT THIS NUMBER IS</Text>
                <Text style={[MONO, { color: C.text, fontSize: 11, letterSpacing: 1, fontWeight: '700', marginTop: 5 }]}>{why.title.toUpperCase()}</Text>
                <Text style={[s.p, { fontSize: 15, lineHeight: 23, marginTop: 6 }]}>{why.body}</Text>
              </View>
            ) : null}
          </View>
        );
      })}
      <Text style={[s.foot, { paddingHorizontal: 0, marginTop: 10 }]}>
        Tap any print for the desk's read on today's move, and for what the number is and why it moves
        the world.
      </Text>
    </Section>
  );
}


// ── THE WATCHTOWER — OSINT-tracker observations with no official story yet. Attributed,
// graded, falsifiable; the fact is that the observation was MADE, never the event itself. ──
function Watchtower({ items }) {
  if (!items || !items.length) return null;
  return (
    <Section title="The watchtower" extra={items.length + ' sightings'}>
      {items.map((sp, i) => {
        const gm = GRADE_META[sp.grade] || GRADE_META.unverified;
        return (
          <View key={i} style={s.storycard}>
            <View style={s.cardmeta}>
              <Text style={[s.ktag, MONO, { marginBottom: 0, color: gm.c, borderColor: gm.c }]}>{gm.label}</Text>
              {fullStamp(sp.ts) ? <Text style={[s.stime, MONO]}>{fullStamp(sp.ts)}</Text> : null}
            </View>
            <Text style={[s.storyH3, SERIF, { fontSize: 16 }]}>{decode(sp.obs)}</Text>
            <Pressable disabled={!sp.u} onPress={() => sp.u && Linking.openURL(sp.u)}>
              <Text style={[MONO, { color: sp.u ? C.accent : C.muted, fontSize: 10, marginBottom: 6, textDecorationLine: sp.u ? 'underline' : 'none' }]}>{'SOURCE: ' + decode(sp.src || '—').toUpperCase()}</Text>
            </Pressable>
            <Text style={s.storyP}>{decode(sp.read)}</Text>
            {sp.falsifier ? (
              <Text style={[s.li, { marginTop: 4 }]}>
                <Text style={{ color: C.accent }}>› </Text>
                <Text style={[MONO, { fontSize: 10, color: C.muted }]}>{'CONFIRMS OR KILLS IT: '}</Text>
                {decode(sp.falsifier)}
              </Text>
            ) : null}
          </View>
        );
      })}
      <Text style={s.foot}>Observations by outside trackers, reported as claims — not asserted fact. Graded by corroboration.</Text>
    </Section>
  );
}



// ── NEWS — a front page, not a stack of slabs. ──────────────────────────────
// Two states share the tab: the INDEX (scan) and an ARTICLE (read). Order stays
// strictly newest-first inside day sections, so the chronology is never violated;
// hierarchy comes from position, not from re-ranking.
// ── THE FRONT PAGE — where the app opens. ────────────────────────────────────
// 2026-09-16 (user: "we should have a home page instead of just opening straight to articles").
// A front page is not a fourth list: it is the answer to "what do I need to know right now", and
// every block on it is a door into the tab that owns the detail. Order is the newsroom's own —
// the state of the board, the story of the day, the desk's sharpest call, what it is watching,
// what the boards are claiming, and the lesson underneath it all.
// 2026-09-17 (editor: "way too long on the home page"): a watch item is the observable, one line or
// two; the desk's number and the kill line behind it open on a tap.
function WatchItem({ text }) {
  const [open, setOpen] = useState(false);
  const t = decode(text);
  const cut = t.search(/\s*\((?:desk|the desk)[:\s]/i);
  const head = cut > 0 ? t.slice(0, cut) : t;
  const tail = cut > 0 ? t.slice(cut).trim().replace(/^\(|\)\.?$/g, '') : '';
  return (
    <Pressable onPress={() => tail && setOpen((v) => !v)} style={{ marginTop: 6 }}>
      <Text style={{ color: C.text, fontSize: 13.5, lineHeight: 20 }} numberOfLines={open ? undefined : 2}>
        <Text style={{ color: C.accent }}>› </Text>{head}{tail && !open ? <Text style={[MONO, { color: C.accent, fontSize: 10 }]}>{'  THE DESK ›'}</Text> : null}
      </Text>
      {open && tail ? <Text style={{ color: C.muted, fontSize: 13, lineHeight: 19, marginTop: 4, paddingLeft: 12 }}>{tail}</Text> : null}
    </Pressable>
  );
}
function FrontPage({ data, goTab, goArticle, read, hist }) {
  const [lessonOpen, setLessonOpen] = useState(false);
  const [quizOpen, setQuizOpen] = useState(false);
  const cards = data.brief || [];
  const lead = cards[0];
  const rc = riskColor[(data.risk || {}).color] || C.elev;
  // the sharpest call on the board: the one furthest from a coin flip, so the reader sees conviction
  const called = cards
    .map((c, i) => ({ c, i, call: (c.hist || {}).call }))
    .filter((x) => x.call && x.call.event && x.call.p != null)
    .sort((a, b) => Math.abs(Number(b.call.p) - 50) - Math.abs(Number(a.call.p) - 50))[0];
  const boards = cards.filter((c) => c.consp && c.consp.head).slice(0, 3);
  const tile = (key, glyph, label, n, sub) => (
    <Pressable key={key} onPress={() => goTab(key)} style={s.fpTile}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <Text style={{ color: C.accent, fontSize: 17 }}>{glyph}</Text>
        <Text style={[MONO, { color: C.accent, fontSize: 19, fontWeight: '800' }]}>{n}</Text>
      </View>
      <Text style={[MONO, { color: C.text, fontSize: 11, letterSpacing: 1.2, marginTop: 7 }]}>{label + ' ›'}</Text>
      <Text style={{ color: C.muted, fontSize: 10.5, marginTop: 2 }}>{sub}</Text>
    </Pressable>
  );
  return (
    <View style={s.stack}>
      {/* 2026-09-16 (user: "get rid of the high alert banner ... I don't want that banner in the
          middle of the screen"). The board's state now lives in the masthead dot and in the wire itself. */}
      {/* 2026-09-16 (user: "move this to the top of the homepage instead of the bottom, flip the
          order of the home page"). The four doors open HOME: the reader chooses a room first and
          reads second. Below them the page runs in the reverse of what it was - the lesson and the
          boards first, the wire last - because the wire has its own tab and this is the front page. */}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between' }}>
        {tile('news', '▤', 'NEWS', cards.length, 'stories on the wire')}
        {tile('data', '◫', 'SITUATION ROOMS', Object.keys((hist && hist.situations) || {}).length, 'the history behind each war')}
        {tile('boards', '☍', 'BOARDS', cards.filter((c) => c.consp).length, 'claims examined')}
        {tile('calls', '◉', 'CALLS', (data.forecasts || []).length, 'open, publicly scored')}
        {tile('data', '▦', 'DATA', (data.actors || []).length, 'players tracked')}
      </View>


      {/* 2026-09-16 (user: "when I click the link to read the education article and take the quiz it
          takes me to the calls menu and just gives me a huge droplist. Clicking that link should just
          expand the article and give an option to take a short quiz. That's it."). It used to hand the
          reader to another tab and make them find the quiz. Now the lesson opens where it is, and the
          quiz opens under it. Nobody leaves the front page. */}
      {data.lesson ? (
        <View style={s.fpLesson}>
          <Text style={[MONO, { color: C.accent, fontSize: 10, letterSpacing: 1.8 }]}>TODAY'S LESSON</Text>
          <Text style={[s.p, { fontSize: 15, lineHeight: 24, marginTop: 7 }]} numberOfLines={lessonOpen ? undefined : 6}>
            {decode(data.lesson)}
          </Text>
          <View style={{ flexDirection: 'row', gap: 18, marginTop: 11, alignItems: 'center' }}>
            <Pressable onPress={() => setLessonOpen((v) => !v)} hitSlop={6}>
              <Text style={[s.readmore, MONO]}>{lessonOpen ? 'SHOW LESS ‹' : 'READ THE FULL LESSON ›'}</Text>
            </Pressable>
            {(data.quiz || []).length ? (
              <Pressable onPress={() => setQuizOpen((v) => !v)} hitSlop={6}>
                <Text style={[s.readmore, MONO, { color: quizOpen ? C.muted : C.accent }]}>
                  {quizOpen ? 'HIDE THE QUIZ' : 'TAKE THE QUIZ · ' + (data.quiz || []).length + ' Q'}
                </Text>
              </Pressable>
            ) : null}
          </View>
          {quizOpen ? <View style={{ marginTop: 14 }}><QuizSection quiz={data.quiz} bare /></View> : null}
        </View>
      ) : null}

      {/* what the boards are claiming, and that the desk grades them */}
      {boards.length ? (
        <Pressable onPress={() => goTab('boards')} style={s.fpBoards}>
          <View style={{ flexDirection: 'row', alignItems: 'baseline' }}>
            <Text style={[MONO, { color: C.high, fontSize: 10.5, letterSpacing: 1.6, fontWeight: '800' }]}>FROM THE BOARDS</Text>
            <Text style={[MONO, { color: C.muted, fontSize: 9.5, letterSpacing: 1, marginLeft: 'auto' }]}>GRADED, NOT REPEATED</Text>
          </View>
          {boards.map((c, i) => (
            <Text key={i} style={{ color: C.text, fontSize: 13.5, lineHeight: 19, marginTop: 8 }} numberOfLines={2}>
              <Text style={{ color: C.high }}>› </Text>{decode(c.consp.head)}
            </Text>
          ))}
          <Text style={[s.readmore, MONO, { marginTop: 11 }]}>OPEN THE BOARDS ›</Text>
        </Pressable>
      ) : null}

      {/* what to watch — the desk's own tripwires for the days ahead */}
      {(data.watch || []).length ? (
        <View>
          <Text style={[MONO, { color: C.muted, fontSize: 10, letterSpacing: 2, marginBottom: 7 }]}>WHAT THE DESK IS WATCHING</Text>
          {(data.watch || []).slice(0, 4).map((w, i) => <WatchItem key={i} text={w} />)}
        </View>
      ) : null}

      {/* the desk's sharpest call, straight off the front page */}
      {called ? (
        <Pressable onPress={() => goArticle(called.i)} style={[s.fpCall, { borderColor: C.accent }]}>
          <Text style={[s.ctxlbl, MONO, { color: C.accent }]}>
            {"THE DESK'S SHARPEST CALL" + (called.call.horizon ? ' · ' + String(called.call.horizon).toUpperCase() : '')}
          </Text>
          <View style={{ flexDirection: 'row', alignItems: 'flex-start', marginTop: 7 }}>
            <Text style={[MONO, { color: C.accent, fontSize: 28, fontWeight: '800', width: 76, lineHeight: 31 }]}>
              {Math.round(Number(called.call.p)) + '%'}
            </Text>
            <Text style={{ color: C.text, fontSize: 14.5, lineHeight: 20, flex: 1, fontWeight: '600' }} numberOfLines={4}>{decode(called.call.event)}</Text>
          </View>
          <View style={{ marginTop: 8 }}><ProbBar p={Math.max(0, Math.min(100, Number(called.call.p) || 0))} /></View>
          <Text style={[s.readmore, MONO, { marginTop: 10 }]}>SEE THE CASE FOR AND AGAINST ›</Text>
        </Pressable>
      ) : null}

      {/* the story of the day */}
      {lead ? (
        <View>
          <Text style={[MONO, { color: C.muted, fontSize: 10, letterSpacing: 2, marginBottom: 9 }]}>THE STORY OF THE DAY</Text>
          <Pressable onPress={() => goArticle(0)}>
            <Text style={[s.kick, MONO]} numberOfLines={1}>{kickerOf(lead)}</Text>
            <Text style={[s.leadH, SERIF, { marginTop: 7 }, read && read[storyId(lead)] && s.readH]} numberOfLines={4}>{articleParts(lead).head}</Text>
            <Text style={s.leadDek} numberOfLines={3}>{decode(lead.h || '')}</Text>
            <Text style={[s.readmore, MONO, { marginTop: 11 }]}>READ THE FULL BRIEF ›</Text>
          </Pressable>
        </View>
      ) : null}

      {/* 2026-09-16 (user: "a more organized better home screen"): the next stories sit under the lead,
          so HOME is a front page you can actually read rather than one headline and a set of doors. */}
      {cards.length > 1 ? (
        <View>
          {cards.slice(1, 5).map((c, i) => {
            const n = cards.indexOf(c);
            return (
              <Pressable key={n} onPress={() => goArticle(n)} style={[s.idxrow, i === 0 && { borderTopWidth: 0, paddingTop: 0 }]}>
                <View style={s.idxmeta}>
                  <Text style={[s.kick, MONO]} numberOfLines={1}>{kickerOf(c)}</Text>
                  <Text style={[s.idxtime, MONO]}>{timeOnly(c.ts)}</Text>
                </View>
                <Text style={[s.idxH, SERIF, read && read[storyId(c)] && s.readH]} numberOfLines={3}>{articleParts(c).head}</Text>
              </Pressable>
            );
          })}
          <Pressable onPress={() => goTab('news')} style={{ paddingTop: 4 }}>
            <Text style={[s.readmore, MONO]}>{'ALL ' + cards.length + ' STORIES ON THE WIRE ›'}</Text>
          </Pressable>
        </View>
      ) : null}

      <Text style={s.foot}>Analysis and opinion, for information only — not advice.</Text>
    </View>
  );
}

// one taxonomy for every menu: a story, a board claim and a call are all classified the same way,

const topicOfStory = (st) => domainOf(decode(st.head || '') + ' ' + decode(st.tag || ''),
  decode(st.t || '') + ' ' + decode(st.context || ''));
const topicOfClaim = (c) => domainOf(decode(c.head || '') + ' ' + decode(c.claim || ''), decode(c.read || ''));

// ── FILTERS YOU CAN COMBINE. ───────────────────────────────────────────────────────────────────
// 2026-09-16 (user: "we should do multiple filters on all menus. Like for example say I only want to
// read articles about ai and finance and the conspiracy that they are soft loading on the public...
// because they are bracing for a bubble pop"). One filter at a time could not express that, and it is
// a completely ordinary way to read: a reader has two or three interests, not one. So every list now
// takes a SET.
//
// The semantics are the ones people already expect from every shop and every job board: OR inside a
// group (AI or MONEY shows both), AND between groups (that subject AND that region). Nothing selected
// in a group means the group is not filtering at all, which is why ALL is a state rather than a chip
// you have to remember to deselect.
const selHas = (sel, g, v) => !!(sel[g] || []).includes(v);
function selToggle(sel, g, v) {
  const cur = sel[g] || [];
  return { ...sel, [g]: cur.includes(v) ? cur.filter((x) => x !== v) : cur.concat([v]) };
}
const selCount = (sel) => Object.keys(sel).reduce((n, g) => n + (sel[g] || []).length, 0);
function selMatch(sel, groups, item) {
  for (const g of groups) {
    const picked = sel[g.key] || [];
    if (!picked.length) continue;                       // this group is not filtering
    const v = g.valueOf(item);
    const vals = Array.isArray(v) ? v : [v];
    if (!vals.some((x) => picked.includes(x))) return false;   // AND between groups
  }
  return true;
}
function MultiFilter({ groups, sel, onChange, total, shown }) {
  const n = selCount(sel);
  return (
    <View style={{ paddingBottom: 6 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingTop: 12, gap: 10 }}>
        <Text style={[MONO, { color: C.muted, fontSize: 9.5, letterSpacing: 1.3, fontWeight: '700', flex: 1 }]}>
          {n ? 'SHOWING ' + shown + ' OF ' + total : 'FILTER \u00b7 PICK AS MANY AS YOU LIKE'}
        </Text>
        {n ? (
          <Pressable onPress={() => onChange({})} hitSlop={8}>
            <Text style={[MONO, { color: C.accent, fontSize: 9.5, letterSpacing: 1.2, fontWeight: '800' }]}>CLEAR ALL</Text>
          </Pressable>
        ) : null}
      </View>
      {groups.map((g) => (
        (g.chips || []).length ? (
          <View key={g.key}>
            <Text style={[MONO, { color: C.muted, fontSize: 9, letterSpacing: 1.4, paddingHorizontal: 16, paddingTop: 10 }]}>{g.label}</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={[s.rfilter, { paddingHorizontal: 12 }]}>
              {g.chips.map(([v, count]) => {
                const on = selHas(sel, g.key, v);
                return (
                  <Pressable key={String(v)} onPress={() => onChange(selToggle(sel, g.key, v))} style={[s.rchip, on && s.rchipOn]}>
                    <Text style={[s.rchipTxt, MONO, on && { color: C.text, fontWeight: '700' }]}>
                      {(on ? '\u2713 ' : '') + String(v) + (count != null ? '  ' + count : '')}
                    </Text>
                  </Pressable>
                );
              })}
            </ScrollView>
          </View>
        ) : null
      ))}
    </View>
  );
}
// the chips for a group, counted over the items actually present
function chipsOf(items, valueOf) {
  const c = new Map();
  (items || []).forEach((it) => {
    const v = valueOf(it);
    (Array.isArray(v) ? v : [v]).filter(Boolean).forEach((x) => c.set(x, (c.get(x) || 0) + 1));
  });
  return [...c.entries()].sort((a, b) => b[1] - a[1]);
}

function NewsTab({ data, easy, deep, goTab, goBoard, article, setArticle, scrollTop,
                   read, saved, markRead, toggleSave, tsize, onSize, theme, onTheme, level, onLevel,
                   older, loadOlder, picks, setPickFor, res }) {
  const simple = (easy && data.easy && data.easy.brief) || [];
  const [region, setRegion] = useState('ALL');
  const [sel, setSelRaw] = useState({});
  useEffect(() => { AsyncStorage.getItem(REGION_KEY).then((v) => {
    try { if (v && v.startsWith('{')) setSelRaw(JSON.parse(v)); } catch (e) {}
  }).catch(() => {}); }, []);
  const setSel = (next) => { setSelRaw(next); setArticle(null); AsyncStorage.setItem(REGION_KEY, JSON.stringify(next)).catch(() => {}); };
  const choose = (r) => { setRegion(r); setArticle(null); AsyncStorage.setItem(REGION_KEY, r).catch(() => {}); };

  const regions = regionsPresent(data.brief);
  const nsaved = (data.brief || []).filter((st) => saved[storyId(st)]).length;
  const valid = region === 'ALL' || region === 'SAVED' || regions.includes(region);
  const active = valid ? region : 'ALL';
  const counts = {}; for (const st of (data.brief || [])) if (st.region) counts[st.region] = (counts[st.region] || 0) + 1;
  // "Saved" is a section front of its own, exactly where NYT puts it — in the filter bar.
  // 2026-09-16: one filter at a time could not say "AI and finance", so NEWS takes a set. Subject and
  // region are separate groups - OR inside each, AND between them - and Saved is a group of one.
  const allRows = briefSorted(data.brief);
  const GROUPS = [
    { key: 'topic', label: 'SUBJECT', valueOf: ({ s: st }) => topicOfStory(st),
      chips: chipsOf(allRows, ({ s: st }) => topicOfStory(st)) },
    { key: 'region', label: 'WHERE', valueOf: ({ s: st }) => st.region,
      chips: chipsOf(allRows, ({ s: st }) => st.region) },
  ].concat(nsaved ? [{ key: 'saved', label: 'YOURS', valueOf: ({ s: st }) => (saved[storyId(st)] ? '\u2605 Saved' : null),
      chips: [['\u2605 Saved', nsaved]] }] : []);
  const rows = allRows.filter((r) => selMatch(sel, GROUPS, r));

  const open = (i) => {
    const hit = (data.brief || [])[i];
    if (hit) markRead(storyId(hit));
    setArticle(i);
    if (scrollTop) scrollTop();
  };
  const back = () => { setArticle(null); if (scrollTop) scrollTop(); };

  // ARTICLE STATE — one story, plus the stories either side of it in the run.
  const at = article == null ? -1 : rows.findIndex(({ i }) => i === article);
  if (at >= 0) {
    const { s: item, i } = rows[at];
    const evIdx = (data.events || []).findIndex((ev) => evRegion(ev) === item.region);
    const id = storyId(item);
    return (
      <ArticlePage
        item={item} simpleText={simple[i]} easy={easy} deep={deep} onBack={back} onOpen={open}
        onBoard={evIdx >= 0 && goBoard ? () => goBoard(evIdx) : null}
        calls={regionForecasts(data, item.region)}
        specMatches={storySpec(data.speculation, item)}
        chatter={data.chatter}
        isSaved={!!saved[id]} pick={(picks || {})[id]} onPick={(v) => setPickFor && setPickFor(id, v)} resolved={resolutionFor(res, id)} onSave={() => toggleSave(id)}
        tsize={tsize} onSize={onSize} theme={theme} onTheme={onTheme} level={level} onLevel={onLevel}
        prev={at > 0 ? rows[at - 1] : null}
        next={at < rows.length - 1 ? rows[at + 1] : null}
      />
    );
  }

  // INDEX STATE — the front page (Direction C): headlines only, serif, newest first, a rule between days.
  // 2026-09-16: the filter bar is back and it takes a SET - the reader who only wants AI and money
  // picks both. It was computed here and never rendered, which is why NEWS listed everything.
  let seen = null;
  return (
    <View>
      <MultiFilter groups={GROUPS} sel={sel} onChange={setSel} total={allRows.length} shown={rows.length} />
      {rows.length ? rows.map(({ s: st, i }) => {
        const k = dayKey(st.ts);
        const rule = k !== seen ? <DayRule key={'d' + k} label={dayLabel(st.ts)} /> : null;
        seen = k;
        const id = storyId(st);
        return (
          <View key={i}>
            {rule}
            <HeadlineRow item={st} onOpen={() => open(i)} isRead={!!read[id]} isSaved={!!saved[id]} />
          </View>
        );
      }) : <Text style={s.foot}>{selCount(sel) ? 'Nothing matches those filters. Tap CLEAR ALL to see everything.' : 'No headlines right now.'}</Text>}
      {loadOlder && older !== 'done' ? (
        <Pressable onPress={older === 'loading' ? null : loadOlder} style={{ paddingVertical: 14, alignItems: 'center' }}>
          <Text style={[MONO, { color: older === 'error' ? C.high : C.accent, fontSize: 11, letterSpacing: 1 }]}>
            {older === 'loading' ? 'LOADING THE ARCHIVE…' : older === 'error' ? 'ARCHIVE UNAVAILABLE · TAP TO RETRY' : '› LOAD OLDER STORIES · 30 DAYS'}
          </Text>
        </Pressable>
      ) : null}
      {data.watch && data.watch.length ? (
        <View style={{ marginTop: 24 }}>
          <Section title="What to watch next">
            {data.watch.map((w, i) => (
              <Text key={i} style={s.li}><Text style={{ color: C.accent }}>› </Text>{decode(w)}</Text>
            ))}
          </Section>
        </View>
      ) : null}
    </View>
  );
}

// ── HEADLINE ROW — the whole front page is made of these. ──
function HeadlineRow({ item, onOpen, isRead, isSaved }) {
  const { head, longHead } = articleParts(item);
  return (
    <Pressable onPress={onOpen} style={s.hrow}>
      <Text style={[s.hrowH, T(24, 29), isRead && s.readH]}>{head || longHead}</Text>
      <Text style={s.hrowMeta}>{String(item.region || kickerOf(item) || '').toUpperCase() + (isSaved ? '  ·  SAVED' : '')}</Text>
    </Pressable>
  );
}

// ── SEARCH — one field, results grouped the way the tabs are. ──
// ── SEARCH — every word, everywhere in the piece, ranked, with the line it matched. ────────────
// 2026-09-16 (user: "make sure the search bar for every menu can search correctly when someone uses
// key words or phrases on articles they want to read"). The old search took the WHOLE query as one
// substring and looked at four fields, so "ai chips" found nothing unless those exact eight
// characters sat side by side in a headline, and a term that appeared in the body of an article -
// which is where almost every term appears - was invisible. Three fixes:
//   EVERY WORD MUST MATCH, ANYWHERE (AND across terms, not one blind substring), so word order and
//     the words in between stop mattering;
//   "IN QUOTES" STILL MEANS EXACTLY THAT, for the reader who wants the phrase;
//   AND IT SEARCHES THE WHOLE PIECE - headline, standfirst, tag, region, every section of the read,
//     the desk's call and the case for and against it, the board claim with its counter, the
//     speculation and its conditional read - all entity-decoded first, because the feed carries
//     &#39; and a reader types an apostrophe.
// Results are ranked (a headline hit beats a body hit) and each row shows the sentence it matched,
// so the reader can see WHY it came back.
function parseQuery(raw) {
  const terms = [];
  const phrases = String(raw || '').toLowerCase().match(/"[^"]+"/g) || [];
  let rest = String(raw || '').toLowerCase();
  phrases.forEach((p) => { rest = rest.replace(p, ' '); terms.push({ t: p.slice(1, -1).trim(), phrase: true }); });
  rest.split(/[^a-z0-9$%.\u2019'-]+/).filter((w) => w.length >= 2).forEach((w) => terms.push({ t: w, phrase: false }));
  return terms.filter((x) => x.t);
}
// the searchable text of anything the app holds, decoded
function hayOf(o) {
  const parts = [];
  const push = (v) => { if (v) parts.push(decode(String(v))); };
  push(o.head); push(o.h); push(o.t); push(o.tag); push(o.region); push(o.context); push(o.claim);
  push(o.spread); push(o.counter); push(o.read); push(o.obs); push(o.if_true); push(o.q); push(o.name);
  (o.read && Array.isArray(o.read) ? o.read : []).forEach((sec) => { push(sec.h); push(sec.p); });
  (o.reads || []).forEach((sec) => { push(sec.h); push(sec.p); });
  const h = o.hist || {};
  if (h.call) { push(h.call.event); push(h.call.update); }
  (h.for || []).forEach(push); (h.against || []).forEach(push);
  (h.precedents || []).forEach((p) => push(p.line));
  (o.consp ? (Array.isArray(o.consp) ? o.consp : [o.consp]) : []).forEach((c) => { push(c.head); push(c.claim); push(c.counter); });
  return parts.join('  \u00b7  ');
}
// A bare word matches at a WORD BOUNDARY, not as a substring: searching "ai" must not return every
// story containing Ukraine, claim, said or air - which it did, all 74 of them, on the first test run.
// The boundary is at the START of the word so "sanction" still finds "sanctions" - but a SHORT term
// gets both ends, because \bai also prefix-matches aid, air and aircraft, and "ai" came back with 59
// of 74 stories on the second test run. Three characters or fewer must match the whole word.
const rxCache = new Map();
function termRx(t) {
  let r = rxCache.get(t);
  if (!r) {
    const esc = t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    r = new RegExp('\\b' + esc + (t.length <= 3 ? '\\b' : ''), 'i');
    rxCache.set(t, r);
  }
  return r;
}
const inText = (term, txt) => (term.phrase ? txt.toLowerCase().includes(term.t) : termRx(term.t).test(txt));
const callHay = (b) => {
  const h = b.hist || {}, c = h.call || {};
  return [c.event, c.update, b.head, b.region, ...(h.for || []), ...(h.against || [])]
    .filter(Boolean).map((x) => decode(String(x))).join('  ·  ');
};
function scoreHit(terms, title, hay) {
  const T = String(title || ''), H = String(hay || '');
  let score = 0;
  for (const term of terms) {
    if (!inText(term, H)) return 0;               // AND: every term must appear somewhere
    score += inText(term, T) ? 3 : 1;             // a headline hit is worth more than a body hit
  }
  return score;
}
// the sentence the first term landed in, so the row shows why it matched
function snippetOf(terms, hay) {
  const H = String(hay || '');
  const m = terms[0].phrase ? { index: H.toLowerCase().indexOf(terms[0].t) } : termRx(terms[0].t).exec(H);
  const i = m ? m.index : -1;
  if (i < 0) return '';
  const from = Math.max(0, H.lastIndexOf(' ', Math.max(0, i - 60)));
  return (from > 0 ? '\u2026' : '') + H.slice(from, Math.min(H.length, i + 120)).trim() + '\u2026';
}
// one result row, hoisted out of SearchScreen: an inner component is a new type on every keystroke,
// which throws away the list's reconciliation, and it reads as an undefined component to the audit
function SearchRow({ title, meta, snip, onPress, tint }) {
  return (
    <Pressable onPress={onPress} style={s.hrow}>
      <Text style={[s.hrowH, { fontSize: 19, lineHeight: 24 }]}>{title}</Text>
      {snip ? <Text style={{ color: C.muted, fontSize: 13, lineHeight: 19, marginTop: 5 }} numberOfLines={2}>{snip}</Text> : null}
      {meta ? <Text style={[s.hrowMeta, tint ? { color: tint } : null]}>{meta}</Text> : null}
    </Pressable>
  );
}
function SearchScreen({ data, query, setQuery, goArticle, goTab }) {
  const terms = parseQuery(query);
  const enough = terms.length > 0 && query.trim().length >= 2;
  const rank = (items, title) => (enough ? items
    .map((x) => ({ x, sc: scoreHit(terms, title(x.o || x), x.hay || hayOf(x.o || x)) }))
    .filter((r) => r.sc > 0)
    .sort((a, b) => b.sc - a.sc) : []);

  const stories = rank((data.brief || []).map((b, i) => ({ o: b, i })), (b) => articleParts(b).head + ' ' + (b.tag || ''));
  const boardItems = (data.chatter || []).map((c) => ({ o: c }))
    .concat((data.brief || []).flatMap((b, i) => (b.consp ? (Array.isArray(b.consp) ? b.consp : [b.consp]) : [])
      .map((c) => ({ o: { ...c, region: b.region } }))));
  const boards = rank(boardItems, (c) => c.head || c.claim || '');
  const callItems = (data.brief || []).map((b, i) => ({ o: b, i }))
    .filter(({ o }) => (o.hist || {}).call && o.hist.call.event);
  // a call is its own object: score it on the call's own words, or every card match returns a call too
  const calls = rank(callItems.map((x) => ({ ...x, hay: callHay(x.o) })), (b) => decode((b.hist.call || {}).event || ''));
  const specs = rank((data.speculation || []).map((sp) => ({ o: sp })), (sp) => sp.head || sp.obs || '');
  const total = stories.length + boards.length + calls.length + specs.length;

  return (
    <View>
      <View style={s.searchbox}>
        <TextInput value={query} onChangeText={setQuery} autoFocus
          placeholder={'Search everything \u2014 try: ai chips, or "strait of hormuz"'} placeholderTextColor={C.muted}
          style={[s.searchin, { color: C.text }]} returnKeyType="search" autoCorrect={false} autoCapitalize="none" />
        {query ? <Pressable onPress={() => setQuery('')} hitSlop={8}><Text style={{ color: C.accent, fontWeight: '600' }}>Clear</Text></Pressable> : null}
      </View>
      {!enough ? (
        <Text style={[s.foot, { marginTop: 18 }]}>
          Type at least two letters. Every word has to appear somewhere in the piece — headline, body,
          the desk's call, the boards — so "ai chips" finds stories carrying both. Put a phrase in
          quotes to match it exactly.
        </Text>
      ) : (
        <Text style={[MONO, { color: C.muted, fontSize: 9.5, letterSpacing: 1.2, paddingHorizontal: 6, paddingTop: 14 }]}>
          {total + (total === 1 ? ' RESULT FOR ' : ' RESULTS FOR ') + terms.map((t) => (t.phrase ? '"' + t.t + '"' : t.t)).join(' + ').toUpperCase()}
        </Text>
      )}
      {stories.length ? <Text style={s.searchH}>{'STORIES \u00b7 ' + stories.length}</Text> : null}
      {stories.map(({ x }, n) => (
        <SearchRow key={'s' + n} title={articleParts(x.o).head} meta={String(x.o.region || '').toUpperCase()}
          snip={snippetOf(terms, hayOf(x.o))} onPress={() => goArticle(x.i)} />
      ))}
      {calls.length ? <Text style={s.searchH}>{'CALLS \u00b7 ' + calls.length}</Text> : null}
      {calls.map(({ x }, n) => (
        <SearchRow key={'c' + n} title={decode((x.o.hist.call || {}).event || '')}
          meta={String(x.o.region || '').toUpperCase() + (x.o.hist.call.horizon ? '  \u00b7  ' + String(x.o.hist.call.horizon).toUpperCase() : '')}
          onPress={() => goArticle(x.i)} />
      ))}
      {boards.length ? <Text style={[s.searchH, { color: C.high }]}>{'BOARDS \u00b7 ' + boards.length}</Text> : null}
      {boards.map(({ x }, n) => (
        <SearchRow key={'b' + n} title={decode(x.o.head || x.o.claim || '')} tint={C.high}
          meta={'UNVERIFIED' + (x.o.region ? '  \u00b7  ' + String(x.o.region).toUpperCase() : '')}
          snip={snippetOf(terms, hayOf(x.o))} onPress={() => goTab('boards')} />
      ))}
      {specs.length ? <Text style={[s.searchH, { color: C.elev }]}>{'SPECULATION \u00b7 ' + specs.length}</Text> : null}
      {specs.map(({ x }, n) => (
        <SearchRow key={'p' + n} title={decode(x.o.head || String(x.o.obs || '').slice(0, 110))} tint={C.elev}
          meta={String(x.o.grade || 'unverified').toUpperCase()} onPress={() => goTab('boards')} />
      ))}
      {enough && !total ? (
        <Text style={[s.foot, { marginTop: 18 }]}>
          Nothing carries all of those words. Try fewer of them, or drop the quotes.
        </Text>
      ) : null}
    </View>
  );
}

function CalibrationTrack({ track, forecasts }) {
  if (!track) return null;
  const scored = track.resolved > 0;
  const items = (track.items && track.items.length)
    ? track.items
    : (forecasts || []).slice(0, 14).map(() => ({ pending: true }));
  return (
    <Section title="Our track record" extra={scored ? track.resolved + ' scored' : 'scoring opens Oct'} fold>
      <View style={s.cal}>
        <View style={s.calbig}>
          <Text style={[s.calnum, MONO]}>{scored && track.brier != null ? track.brier.toFixed(3) : '—'}</Text>
          <Text style={[s.callab, MONO]}>{scored ? 'BRIER SCORE' : 'NO SCORE YET'}</Text>
        </View>
        <Text style={s.calsay}>{decode(track.note)}</Text>
        <View style={s.calstrip}>
          {items.map((it, i) => (
            <View key={i} style={[s.caldot, it.pending ? s.caldotPend
              : (it.outcome === 'YES') === (it.p >= 50) ? s.caldotHit : s.caldotMiss]} />
          ))}
        </View>
      </View>
    </Section>
  );
}

// ── THE BOARDS — what 4chan, Reddit and X are saying, in one place. Deliberately low bar: the app
// labels it unverified and reports belief, not fact. Story-pinned theories link back to their article. ──
// ── BOARDS — a front page of claims, laid out exactly like NEWS: short headlines, a rule between days,
// tap to open. (2026-09-15, user: "the board article headlines are way too long, I want it to look like
// the news tab.") New cards carry a newspaper `head`; older ones are clipped to their first clause. ──
function boardHead(c) {
  if (c.head) return decode(c.head);
  let t = decode(c.claim || '').replace(/^(posters on|users on|accounts on|anons on)\s+[^ ]+\s+(argue|claim|say|suggest|allege)\s+(that\s+)?/i, '').replace(/^that\s+/i, '').trim();
  t = t.charAt(0).toUpperCase() + t.slice(1);
  const brk = t.search(/\s+[-–—]\s+|:\s|;\s|,\s(?:and|but|which|while|because)\s/);
  const first = brk > 24 && brk <= 90 ? t.slice(0, brk) : t;
  if (first.length <= 80) return first.replace(/[.,;:]+$/, '');
  const cut = first.lastIndexOf(' ', 76);
  return first.slice(0, cut > 36 ? cut : 76).replace(/[.,;:]+$/, '') + '…';
}
function BoardArticle({ c, onBack, onStory }) {
  const secRefs = useRef([]);
  const reads = Array.isArray(c.reads) && c.reads.length
    ? c.reads.map((sec) => (/VERDICT/i.test(sec.h || '') && Array.isArray(c.verdicts) ? { ...sec, verdicts: c.verdicts } : sec))
    : sectionize(c.read);
  return (
    <View style={s.stack}>
      <View style={s.article}>
        <View style={s.artbar}><Pressable onPress={onBack} hitSlop={8}><Text style={s.backtxt}>‹ The boards</Text></Pressable></View>
        <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 14 }}>
          <Text style={[s.ktag, { color: c.story ? C.accent : C.high, flex: 0, marginRight: 10 }]}>{(c.story ? 'ON A STORY · ' : 'CIRCULATING · ') + String(c.region || '').toUpperCase()}</Text>
          <Text style={[s.readtime, MONO]}>{readTime(reads.map((x) => x.p).join(' '), c.claim)}</Text>
        </View>
        <Text style={[s.artH, SERIF, T(30, 37)]}>{boardHead(c)}</Text>
        <Text style={[s.artStand, T(17.5, 26)]}>{decode(c.claim)}</Text>
        <View style={s.artrule} />
        <Text style={[s.conspWarn]}>UNVERIFIED · WHAT IS CIRCULATING, NOT WHAT IS CONFIRMED</Text>
        {fullStamp(c.ts) ? <Text style={[s.stime, MONO, { marginBottom: 12 }]}>{fullStamp(c.ts)}</Text> : null}
        <Toc items={reads.map((sec, i) => ({ label: sec.h, get: () => secRefs.current[i] }))} color={C.high} />
        {c.spread ? (
          <>
            <Text style={[s.ctxlbl, MONO]}>WHERE IT'S SPREADING</Text>
            <Text style={[s.ctxP, T(16, 25), { color: C.muted, marginBottom: 12 }]}>{decode(c.spread)}</Text>
          </>
        ) : null}
        <Counter c={c.counter} />
        {reads.length ? (
          <>
            <Text style={[s.ctxlbl, MONO, { color: C.high }]}>THE DESK'S READ</Text>
            <Sections items={reads} color={C.high} refs={secRefs} />
          </>
        ) : null}
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', marginTop: 16 }}>
          {c.story && onStory ? <WebLink label={'THE STORY: ' + articleParts(c.story).head.toUpperCase().slice(0, 40) + '… ›'} onPress={() => onStory(c.storyIdx)} /> : null}
          {c.u ? <WebLink label="SEE THE POST ↗" onPress={() => Linking.openURL(c.u)} /> : null}
        </View>
      </View>
    </View>
  );
}
// ── WHAT THE WORLD IS TALKING ABOUT — GDELT news volume per theatre. ───────────────────────────
// 2026-09-16 audit. `attention` was written every pass and rendered nowhere: it was surfaced only
// inside the situation-room map, which was stripped, and an orphaned key is desk output nobody can
// read. Reading it before deleting it turned up two bugs behind it (a partial day that was never
// dropped, and a concurrent fetch that GDELT answered with 429 every single time, so the numbers had
// been FROZEN while a log line blamed the upstream). Both fixed; it earns a surface on BOARDS,
// because how loudly the world is covering a theatre is narrative data, which is what this tab is.
// Every reading carries its own date and a stale one is not drawn - a coverage ratio from last week
// is not a fact about today.
function Attention({ att }) {
  const rows = Object.keys(att || {})
    .map((k) => ({ n: k, ...(att[k] || {}) }))
    .filter((x) => x.d && typeof x.r === 'number' && Array.isArray(x.s) && x.s.length >= 8
      && (Date.now() - Date.parse(x.d + 'T12:00:00Z')) < 3 * 86400000)
    .sort((a, b) => b.r - a.r);
  if (rows.length < 3) return null;
  const word = (r) => (r >= 1.5 ? 'far louder than usual' : r >= 1.15 ? 'louder than usual'
    : r <= 0.6 ? 'far quieter than usual' : r <= 0.85 ? 'quieter than usual' : 'about as usual');
  return (
    <Section title="What the world is talking about" extra={rows[0].d || ''}>
      <Text style={{ color: C.muted, fontSize: 13, lineHeight: 19, paddingHorizontal: 16, paddingBottom: 6 }}>
        How much of the world's news is going to each theatre today, against its own fourteen-day average.
        Coverage is not importance — a theatre going quiet is sometimes the story.
      </Text>
      {rows.map((x, i) => (
        <View key={i} style={{ borderTopWidth: 1, borderTopColor: C.line, paddingHorizontal: 16, paddingVertical: 11 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <Text style={{ color: C.text, fontSize: 14.5, flex: 1 }}>{decode(x.n)}</Text>
            <View style={{ width: 96 }}><Sparkline hist={x.s} w={96} h={22} /></View>
            <Text style={[MONO, { color: x.r >= 1.15 ? C.high : x.r <= 0.85 ? C.calm : C.muted,
              fontSize: 13.5, fontWeight: '800', width: 52, textAlign: 'right' }]}>{x.r + '\u00d7'}</Text>
          </View>
          <Text style={{ color: C.muted, fontSize: 12.5, marginTop: 3 }}>{word(x.r)}</Text>
        </View>
      ))}
      <Text style={[MONO, { color: C.muted, fontSize: 9, letterSpacing: 0.8, paddingHorizontal: 16, paddingVertical: 10 }]}>
        GDELT ARTICLE VOLUME, 14-DAY WINDOW
      </Text>
    </Section>
  );
}

function BoardsTab({ data, goArticle }) {
  const [sel, setSel] = useState({});
  const [spec, setSpec] = useState(null);
  const [open, setOpen] = useState(null);
  const pinned = (data.brief || []).flatMap((b, i) =>
    (b.consp ? (Array.isArray(b.consp) ? b.consp : [b.consp]) : []).map((c) => ({ ...c, story: b, storyIdx: i, region: b.region, ts: c.ts || b.ts })));
  const loose = (data.chatter || []).map((c) => ({ ...c, region: c.region || inferRegion(c.claim + ' ' + (c.read || '')) }));
  const all = pinned.concat(loose).map((c, k) => ({ ...c, k }));
  // subject and region are separate groups: OR inside each, AND between them
  const BGROUPS = [
    { key: 'topic', label: 'SUBJECT', valueOf: topicOfClaim, chips: chipsOf(all, topicOfClaim) },
    { key: 'region', label: 'WHERE', valueOf: (c) => c.region, chips: chipsOf(all, (c) => c.region) },
  ];
  const items = all.filter((c) => selMatch(sel, BGROUPS, c))
    .sort((a, b) => (Date.parse(b.ts || '') || 0) - (Date.parse(a.ts || '') || 0));
  const specs = (data.speculation || []).filter((sp) => selMatch(sel, BGROUPS,
    { ...sp, claim: sp.obs, head: sp.head, read: sp.read,
      region: sp.region || inferRegion(sp.obs + ' ' + (sp.read || '')) }));
  const cur = open != null ? all.find((c) => c.k === open) : null;
  if (cur) return <BoardArticle c={cur} onBack={() => setOpen(null)} onStory={goArticle} />;
  let seen = null;
  return (
    <View style={s.stack}>
      <MultiFilter groups={BGROUPS} sel={sel} onChange={setSel} total={all.length} shown={items.length} />
      <Text style={[s.conspWarn, { paddingHorizontal: 4 }]}>{items.length + ' CIRCULATING · UNVERIFIED · WHAT PEOPLE BELIEVE, NOT WHAT IS CONFIRMED'}</Text>
      {/* 2026-09-16 (user: "count every rumour from these accounts - maybe put a speculation category
          for the boards"). `speculation` was computed here and never rendered outside an article: it is
          the desk's record of what trackers and tracked accounts are claiming, each with a grade and the
          thing that would settle it. Rumours belong on a board that says it is a board. */}
      {specs.length ? (
        <Section title="Speculation" extra={specs.length + ' sightings'} fold>
          <Text style={[s.foot, { paddingHorizontal: 16, paddingTop: 0, paddingBottom: 8 }]}>
            Claims from trackers and the accounts the desk follows - not confirmed, graded on how much
            weight they can carry, each with the observation that would settle it.
          </Text>
          {specs.map((sp, i) => {
            const g = GRADE_META[sp.grade] || GRADE_META.unverified;
            const isOn = spec === i;
            return (
              <View key={i} style={{ borderTopWidth: 1, borderTopColor: C.line, paddingHorizontal: 16, paddingVertical: 12 }}>
                <Pressable onPress={() => setSpec(isOn ? null : i)}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                    <Text style={[MONO, { color: g.c, fontSize: 9, letterSpacing: 1, fontWeight: '700' }]}>{g.label}</Text>
                    <Text style={[MONO, { color: C.muted, fontSize: 9, marginLeft: 'auto' }]}>{String(sp.ts || '').slice(5, 10)}</Text>
                    <Text style={{ color: C.accent, fontSize: 15 }}>{isOn ? '−' : '›'}</Text>
                  </View>
                  <Text style={{ color: C.text, fontSize: 15, lineHeight: 21, fontWeight: '600', marginTop: 6 }} numberOfLines={isOn ? undefined : 2}>
                    {decode(sp.head || sp.obs || '')}
                  </Text>
                </Pressable>
                {isOn ? (
                  <View style={{ marginTop: 9 }}>
                    {/* 2026-09-16: when a sighting carries no `head` the headline falls back to `obs`, so
                        printing `obs` again underneath repeated the whole paragraph verbatim. Only show
                        the observation when it is not already the headline. */}
                    {/* 2026-09-17 (editor: every written piece reads the same): the same labelled sections,
                        in the same order, as a board page - what was seen, the desk's read, the conditional, the test */}
                    {sp.obs && sp.head ? (
                      <>
                        <Text style={[MONO, { color: C.high, fontSize: 9, letterSpacing: 1.1, fontWeight: '700' }]}>WHAT WAS SEEN</Text>
                        <Text style={{ color: C.muted, fontSize: 13.5, lineHeight: 20, marginTop: 4 }}>{decode(sp.obs)}</Text>
                      </>
                    ) : null}
                    {sp.read ? (
                      <>
                        <Text style={[MONO, { color: C.high, fontSize: 9, letterSpacing: 1.1, fontWeight: '700', marginTop: 10 }]}>THE DESK'S READ</Text>
                        <Text style={{ color: C.text, fontSize: 13.5, lineHeight: 20, marginTop: 4 }}>{decode(sp.read)}</Text>
                      </>
                    ) : null}
                    {sp.if_true ? (
                      <View style={{ marginTop: 10, borderLeftWidth: 2, borderLeftColor: C.elev, paddingLeft: 11 }}>
                        <Text style={[MONO, { color: C.elev, fontSize: 9, letterSpacing: 1.1, fontWeight: '700' }]}>IF THIS IS TRUE</Text>
                        <Text style={{ color: C.text, fontSize: 14, lineHeight: 21, marginTop: 5 }}>{decode(sp.if_true)}</Text>
                      </View>
                    ) : null}
                    {sp.falsifier ? (
                      <>
                        <Text style={[MONO, { color: C.accent, fontSize: 9, letterSpacing: 1.1, fontWeight: '700', marginTop: 10 }]}>WHAT WOULD SETTLE IT</Text>
                        <Text style={{ color: C.muted, fontSize: 13, lineHeight: 19, marginTop: 4 }}>{decode(sp.falsifier)}</Text>
                      </>
                    ) : null}
                    {sp.u ? <WebLink label="SEE THE SOURCE ↗" onPress={() => Linking.openURL(sp.u)} /> : null}
                  </View>
                ) : null}
              </View>
            );
          })}
        </Section>
      ) : null}
      {items.map((c) => {
        const k = dayKey(c.ts);
        const rule = c.ts && k !== seen ? <DayRule key={'d' + k} label={dayLabel(c.ts)} /> : null;
        if (c.ts) seen = k;
        return (
          <View key={c.k}>
            {rule}
            <Pressable onPress={() => setOpen(c.k)} style={s.hrow}>
              <Text style={[s.hrowH, T(24, 29)]}>{boardHead(c)}</Text>
              {/* the counter rides the INDEX too: a reader scrolling the boards should meet the fact
                  that deflates a claim at the same moment as the claim, not one tap later */}
              {c.counter ? (
                <Text style={{ color: C.text, fontSize: 14, lineHeight: 20, marginTop: 6 }} numberOfLines={2}>
                  <Text style={[MONO, { color: C.accent, fontSize: 9.5, letterSpacing: 1.2, fontWeight: '800' }]}>{'BUT  '}</Text>
                  {decode(String(c.counter))}
                </Text>
              ) : null}
              <Text style={[s.hrowMeta, !c.story && { color: C.high }]}>{(c.story ? 'ON A STORY · ' : '') + String(c.region || 'CIRCULATING').toUpperCase()}</Text>
            </Pressable>
          </View>
        );
      })}
      {!items.length ? <Text style={s.foot}>Nothing circulating in this filter right now.</Text> : null}
      <Attention att={data.attention} />
      <Watchtower items={specs} />
    </View>
  );
}


// The desk files by region, but a reader thinks in wars: Iran, Israel and the wider Middle East are
// one situation, as are Russia and Ukraine. Merge only where the fighting is genuinely joined - this
// is the grouping behind the country chips on CALLS.
const THEATRE_OF = { Iran: 'Iran and the Middle East', Israel: 'Iran and the Middle East',
  'Middle East': 'Iran and the Middle East', Russia: 'Russia and Ukraine', Ukraine: 'Russia and Ukraine' };
// ── THE CHAIRS — every principal the desk reasoned from today. ─────────────────────────────────
// 2026-09-16 (user: "for calls we need to do more than just percentage of prediction. This makes it
// look like a Polymarket rip off ... this is where the geopolitical strategy and analyst brain comes
// into play. This is the section where you put yourself into all these different leaders' shoes").
// He is right, and the material already existed: the desk writes IN THEIR SHOES on EVERY card - what
// a principal needs, fears, cannot afford, how they read the other side and their best move - and it
// was reachable only by opening a story and tapping through. A number without the reasoning is a
// betting line. The reasoning IS the product, so it opens the tab.
function chairsFrom(cards) {
  const by = new Map();
  (cards || []).forEach((c, idx) => {
    const sec = (c.read || []).find((x) => x.h === 'IN THEIR SHOES');
    if (!sec || !sec.p) return;
    String(sec.p).trim().split(/\s(?=\d\.\s)/).forEach((part) => {
      const m = part.match(/^\d\.\s*([^:.]{2,42})[:.]\s*(.+)$/s);
      if (!m) return;
      const name = m[1].trim(), body = m[2].trim();
      if (body.length < 60) return;                       // a stub, not a position
      const key = name.toLowerCase().replace(/^(the|president|prime minister)\s+/, '');
      const row = by.get(key) || { name, region: c.region, positions: [] };
      row.positions.push({ body, head: c.head, idx, ts: c.ts });
      if (name.length < row.name.length) row.name = name;  // the shortest form reads best
      by.set(key, row);
    });
  });
  return [...by.values()].sort((a, b) => b.positions.length - a.positions.length);
}
// ── THE CALENDAR — the dated decision points the desk's calls turn on (votes, rulings, auctions,
// summits, each with the forecast it decides). 2026-09-16: it opened CALLS and was the third accordion
// a reader had to get past to reach a prediction ("get rid of calendar or put that in data"), so the
// full list now sits in DATA with the other reference tables, and the ONE date that settles a given
// call is printed under that call in the forward book, where it is actually being used. ──
function Calendar({ clocks }) {
  const [open, setOpen] = useState(null);
  if (!Array.isArray(clocks) || !clocks.length) return null;
  const today = new Date().toISOString().slice(0, 10);
  const rows = clocks.slice().sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')));
  const when = (d) => {
    if (!d) return '';
    const n = Math.round((Date.parse(d + 'T12:00:00Z') - Date.parse(today + 'T12:00:00Z')) / 86400000);
    return n < 0 ? 'passed' : n === 0 ? 'today' : n === 1 ? 'tomorrow' : 'in ' + n + ' days';
  };
  return (
    <Section title="The calendar" extra={rows.length + ' dated'} fold>
      {rows.map((c, i) => {
        const soon = String(c.date || '') <= today;
        return (
          <Pressable key={i} onPress={() => c.why && setOpen(open === i ? null : i)}
            style={[s.clockRow, i === 0 && { borderTopWidth: 0 }]}>
            <View style={{ width: 86 }}>
              <Text style={[MONO, { color: soon ? C.high : C.accent, fontSize: 12, fontWeight: '800' }]}>
                {String(c.date || '').slice(5)}
              </Text>
              <Text style={[MONO, { color: C.muted, fontSize: 9.5, marginTop: 2 }]}>{when(c.date)}</Text>
            </View>
            <View style={{ flex: 1 }}>
              <Text style={[MONO, { color: C.text, fontSize: 11.5, letterSpacing: 1.1, fontWeight: '700' }]}>
                {String(c.label || '').toUpperCase()}
              </Text>
              {c.why && open === i ? <Text style={{ color: C.muted, fontSize: 13.5, lineHeight: 19, marginTop: 6 }}>{decode(c.why)}</Text> : null}
            </View>
            {c.why ? <Text style={{ color: C.accent, fontSize: 17, marginLeft: 8 }}>{open === i ? '\u2212' : '\u203a'}</Text> : null}
          </Pressable>
        );
      })}
    </Section>
  );
}

// ── CALLS — the forward book, read like a page instead of a filing cabinet. ─────────────────────
// 2026-09-16 (user: "we have to do something about calls. Way too much going on ... it's useless
// having a user go through 150+ headers folded just to look at something. Look at how New York Times
// or other news articles compress this into a simple scrolling and reading ... I just think it's
// important and should be in chronological order or based on countries"). The material was right and
// the packaging was wrong: four accordions, two of them holding more accordions, and something like
// 150 rows that all had to be tapped open before a single prediction could be read. So the tab is now
// ONE scroll. The sharpest call is written out at the top like a lede. Every other call is a dated
// paragraph in CHRONOLOGICAL order - soonest first - with the case for it and the case against it
// VISIBLE, not folded. Countries are a filter, not a folder. The calendar moved to DATA, and the one
// dated decision that actually settles a call is printed under that call. Nothing on this page needs
// a tap to be read; a tap only ever takes you to the story behind it.
const MONTH_NAMES = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august',
  'september', 'october', 'november', 'december'];
const MON3 = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const monIdx = (w) => MONTH_NAMES.findIndex((n) => n.startsWith(String(w).toLowerCase().slice(0, 3)));
const isoDate = (y, m, d) => y + '-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0');

// The desk writes its deadline into the call itself ("... by 16 December 2026"). That date is the
// whole point of a falsifiable call, so it belongs in the margin where a reader can sort by it -
// and out of the sentence, which reads better without it. Day-count horizon is the fallback.
function dueOf(card, call) {
  const ev = String((call && call.event) || '');
  const pats = [[/\b(?:by|before|on or before|no later than|not later than)\s+(\d{1,2})\s+([A-Za-z]{3,9})\s+(\d{4})/i, 'dmy'],
                [/\b(?:by|before|on or before|no later than|not later than)\s+([A-Za-z]{3,9})\s+(\d{1,2}),?\s+(\d{4})/i, 'mdy'],
                [/\b(?:by|before|on or before|no later than|not later than)\s+(\d{4})-(\d{2})-(\d{2})/, 'ymd'],
                [/\b(\d{1,2})\s+([A-Za-z]{3,9})\s+(\d{4})/, 'dmy'],
                [/\b([A-Za-z]{3,9})\s+(\d{1,2}),\s+(\d{4})/, 'mdy'],
                [/\b(\d{4})-(\d{2})-(\d{2})\b/, 'ymd']];
  for (const [re, kind] of pats) {
    const m = ev.match(re);
    if (!m) continue;
    if (kind === 'ymd') return isoDate(m[1], +m[2], +m[3]);
    const mi = kind === 'dmy' ? monIdx(m[2]) : monIdx(m[1]);
    if (mi < 0) continue;
    return isoDate(m[3], mi + 1, kind === 'dmy' ? +m[1] : +m[2]);
  }
  const days = horizonDays(call && call.horizon);
  const base = Date.parse(String((card && card.ts) || '').slice(0, 10) + 'T12:00:00Z');
  return days && !Number.isNaN(base) ? new Date(base + days * 86400000).toISOString().slice(0, 10) : null;
}
// "3d", "6w", "6m", "2y", "90 days", "18 months" -> days. 2026-09-17: "6m" was read as six DAYS, which put
// every long-range call in the fortnight bucket.
function horizonDays(h) {
  const m = String(h || '').trim().match(/^(\d+)\s*(d|w|m|y|day|week|month|year)/i);
  if (!m) return null;
  const n = +m[1], u = m[2][0].toLowerCase();
  return n * (u === 'y' ? 365 : u === 'm' ? 30 : u === 'w' ? 7 : 1);
}
const DUE_TAIL = /[,;]?\s*\b(?:by|before|on or before|no later than|not later than)\s+(?:\d{1,2}\s+[A-Za-z]{3,9}\s+\d{4}|[A-Za-z]{3,9}\s+\d{1,2},?\s+\d{4}|\d{4}-\d{2}-\d{2})\s*\.?\s*$/i;
const fmtDue = (d) => (d ? 'BY ' + String(+d.slice(8, 10)) + ' ' + (MON3[+d.slice(5, 7) - 1] || '') : 'UNDATED');
const inDays = (n) => (n == null ? '' : n < 0 ? 'overdue' : n === 0 ? 'today' : n === 1 ? 'tomorrow' : 'in ' + n + ' days');

// ── WHAT THE CALL IS ABOUT. ─────────────────────────────────────────────────────────────────────
// 2026-09-16 (user: "categorize these more broadly for the filter. I like the chronological aspect
// but if people want to filter it should be large filters at first. Like money markets, countries,
// financial, war if that makes sense, but use that as only filters"). Nine theatres was a filing
// system, not a filter. Six subjects a reader already thinks in, and the theatre still prints on
// every row so the country is never lost. Matched on the CALL itself first and only then on its
// story: the headline drags a call into the wrong bucket (an ICC examination filed under WAR because
// the story around it was a war story).
const DOMAINS = [
  ['COURTS', /\b(court|indict|tribunal|prosecut|ruling|charges|arrest|icc\b|lawsuit|sentenc|convict|subpoena|contempt|warrant|grand jury|judge|extradit)/i],
  ['WAR', /\b(strike|struck|missile|drone|shelling|offensive|troops?|forces|combat|casualt|killed|wounded|ceasefire|truce|air ?defen[cs]e|interceptor|airstrike|bomb|artillery|front ?line|incursion|naval|warship|mobilis|mobiliz|war\b|fighting|militar|attack|seiz|blockad|raid|sabotage|assassinat|hostage|cyber|liberat|captur|recaptur|f-\d\d|arms (sale|transfer|package|deal)|weapons?|munitions?|fighter jets?|submarine|nuclear (test|weapon|warhead))/i],
  ['TECH', /\b(a\.?i\.?\b|artificial intelligence|machine learning|\bllm\b|model weights|chips?\b|semiconductor|foundry|nvidia|tsmc|asml|data ?cent(?:er|re)|compute cluster|\bgpus?\b|quantum|robotics?\b|automation|algorithm|cloud provider|starlink|satellite internet|encryption|facial recognition|biometric|surveillance technology)/i],
  ['MONEY', /\b(price|prices|barrel|brent|yield|oil|crude|gas\b|lng|export|import|tariff|sanction|designat|embargo|bank|currency|rouble|ruble|yuan|dollar|debt|bond|market|trade|inflation|budget|fund|imf\b|world bank|revenue|shipment|cargo|loading|refiner|pipeline|freight|insurance|transit|tanker|strait|chokepoint|barrels|gdp|investment|asset freeze|fomc|federal reserve|interest rate|target range|central bank|ecb|rate (cut|hike|rise|decision)|commercial|contract|licen[cs]e|concession|joint venture)/i],
  ['CRISES', /\b(flood|earthquake|collapse|death toll|dead|missing|famine|drought|displace|refugee|evacuat|cholera|outbreak|disease|aid convoy|humanitarian|wildfire|storm|cyclone|landslide)/i],
  ['POLITICS', /\b(elect|vote|votes|voted|ballot|parliament|duma|riksdag|congress|senate|house\b|seats|coalition|cabinet|minister|impeach|resign|president|prime minister|referendum|poll|party|legislat|\bbill\b|confidence motion|appoint|swear|inaugurat|no-confidence)/i],
  ['DIPLOMACY', /\b(talks|summit|meet|meeting|agreement|treaty|accord|\bdeal\b|recogni[sz]|ambassador|normali[sz]|mediat|delegation|joint statement|communiqu|visit|readout|envoy|negotiat|memorandum|protocol|resolution|declaration|council|conclusions|endorse|border|boundary|demarcat|survey|framework)/i],
];
const DOMAIN_SUB = { WAR: 'fighting, weapons and who is arming whom', MONEY: 'prices, trade, sanctions and the money behind them',
  TECH: 'AI, chips, compute and the companies that hold them',
  POLITICS: 'elections, parliaments and who holds the chair', DIPLOMACY: 'talks, treaties, recognition and the rooms they happen in',
  COURTS: 'indictments, rulings and where the law bites', CRISES: 'disasters, tolls and the people moved by them' };
function domainOf(ev, extra) {
  for (const [name, re] of DOMAINS) if (re.test(ev)) return name;
  for (const [name, re] of DOMAINS) if (re.test(extra)) return name;
  return 'DIPLOMACY';   // statecraft is the residual: a call that is none of the above is still a move
}

// 2026-09-16 (user: "let's get rid of the number percentage next to the headline"). He is right about
// what this tab is: "calls is pretty much [the] strategy tab - we are using our logic to try and
// predict outcomes based on current geopolitical events". A percentage in 22pt beside a sentence
// makes it a market line; the desk's judgement reads in words, and the number is still there in the
// story behind it, in the tracked book and on the share card, where it sits with its reasoning (L14).
const ODDS = [[85, 'NEAR CERTAIN'], [65, 'LIKELY'], [55, 'LEANS THIS WAY'], [45, 'A COIN FLIP'],
  [35, 'LEANS AGAINST'], [15, 'UNLIKELY'], [0, 'NEARLY RULED OUT']];
const oddsWord = (p) => (ODDS.find(([n]) => p >= n) || ODDS[ODDS.length - 1])[1];

function callsFrom(cards, clocks) {
  const out = [];
  (cards || []).forEach((c, idx) => {
    const h = c.hist || {}, call = h.call;
    if (!call || !call.event || call.p == null) return;
    const due = dueOf(c, call);
    const row = (k, d) => ({ idx, id: storyId(c), hasScenarios: !!scenariosOf(c), head: c.head, region: c.region || 'Global',
      theatre: THEATRE_OF[c.region] || c.region || 'Global',
      domain: domainOf(String(k.event), String(c.head || '') + ' ' + String(c.tag || '')),
      p: Math.max(0, Math.min(100, Math.round(Number(k.p) || 0))),
      event: String(k.event).replace(DUE_TAIL, '').trim(), due: d,
      days: d ? Math.round((Date.parse(d + 'T12:00:00Z') - Date.now()) / 86400000) : null,
      pro: (h.for || [])[0], con: (h.against || [])[0],
      conf: k.conf, update: k.update, clock: null });
    out.push(row(call, due));
    // 2026-09-17 (editor: "make long term predictions"): the card's FURTHER OUT call is a call of its
    // own and belongs in the book, in its own month, not only inside the article
    const lg = h.long;
    if (lg && lg.event && lg.p != null && String(lg.event) !== String(call.event)) out.push({ ...row(lg, dueOf(c, lg)), long: true });
  });
  // one dated decision per call, matched on the call's own words - what the calendar was for
  const ks = (clocks || []).map((k) => ({ k, t: tokens(decode(k.label || '') + ' ' + decode(k.why || '')) }));
  out.forEach((x) => {
    const w = tokens(decode(x.event) + ' ' + decode(x.head || ''));
    let best = null, bn = 0;
    ks.forEach(({ k, t }) => {
      if (x.due && String(k.date || '') > x.due) return;   // it cannot settle what resolves before it
      let n = 0; for (const q of t) if (w.has(q)) n++;
      if (n > bn) { bn = n; best = k; }
    });
    if (bn >= 3) x.clock = best;
  });
  // chronological: soonest resolution first, and the sharper call first where two land the same day
  return out.sort((a, b) => (a.days == null ? 1 : b.days == null ? -1 : a.days - b.days)
    || Math.abs(b.p - 50) - Math.abs(a.p - 50));
}

// plain-English horizons, so the spine of the page answers "what happens next" without a legend
const BUCKETS = [{ lab: 'THE NEXT TWO WEEKS', sub: 'resolve inside a fortnight', max: 14 },
  { lab: 'WITHIN THE MONTH', sub: 'resolve in the next four weeks', max: 35 },
  { lab: 'WITHIN THE QUARTER', sub: 'in the ninety-day book', max: 100 },
  { lab: 'WITHIN THE YEAR', sub: 'beyond the quarter, inside twelve months', max: 370 },
  { lab: 'THE LONG BOOK', sub: 'a year out and further', max: 1e9 }];

// One call, written out. The number never appears without the position that produced it (L14), which
// is why FOR and BUT are printed here rather than hidden behind the row.
function CallRow({ x, goArticle, lede, pick, hasScenarios }) {
  const hs = lede ? 25 : 18.5;
  return (
    <View style={{ borderTopWidth: lede ? 0 : 1, borderTopColor: C.line, paddingHorizontal: 16, paddingTop: lede ? 0 : 15, paddingBottom: lede ? 0 : 17 }}>
      <Text style={[MONO, { fontSize: 9.5, letterSpacing: 1.2, fontWeight: '700' }]}>
        <Text style={{ color: C.accent }}>{oddsWord(x.p)}</Text>
        <Text style={{ color: C.muted }}>
          {'  \u00b7  ' + [fmtDue(x.due), inDays(x.days).toUpperCase(), String(x.theatre || '').toUpperCase()].filter(Boolean).join('  \u00b7  ')}
        </Text>
      </Text>
      <Pressable onPress={() => goArticle && goArticle(x.idx)}>
        <Text style={[SERIF, { color: C.text, fontSize: hs, lineHeight: Math.round(hs * 1.34), fontWeight: '600', marginTop: 7 }]}>{decode(x.event)}</Text>
      </Pressable>
      {x.pro ? (
        <Text style={[s.p, { fontSize: 15, lineHeight: 22.5, marginTop: 11, marginBottom: 0 }]}>
          <Text style={[MONO, { color: C.calm, fontSize: 10, letterSpacing: 1.1, fontWeight: '800' }]}>{'FOR  '}</Text>{decode(String(x.pro))}
        </Text>
      ) : null}
      {x.con ? (
        <Text style={[s.p, { fontSize: 15, lineHeight: 22.5, marginTop: 7, marginBottom: 0 }]}>
          <Text style={[MONO, { color: C.crit, fontSize: 10, letterSpacing: 1.1, fontWeight: '800' }]}>{'BUT  '}</Text>{decode(String(x.con))}
        </Text>
      ) : null}
      {lede && x.update ? <Text style={[s.p, { color: C.muted, fontSize: 15, lineHeight: 22.5, marginTop: 11, marginBottom: 0 }]}>{decode(x.update)}</Text> : null}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 12, marginTop: 11 }}>
        {x.conf ? <Text style={[MONO, { color: C.muted, fontSize: 9.5, letterSpacing: 1.1 }]}>{String(x.conf).toUpperCase() + ' CONFIDENCE'}</Text> : null}
        {x.clock ? (
          <Text style={[MONO, { color: C.high, fontSize: 9.5, letterSpacing: 1.1 }]}>
            {'SETTLED BY ' + String(x.clock.label || '').toUpperCase() + ' ' + String(x.clock.date || '').slice(5)}
          </Text>
        ) : null}
        {hasScenarios && !x.long ? (
          <Pressable onPress={() => goArticle && goArticle(x.idx)} hitSlop={6}>
            <Text style={[MONO, { color: pick ? C.calm : C.high, fontSize: 9.5, letterSpacing: 1.1, fontWeight: '800' }]}>{pick ? 'YOUR CALL \u00b7 ' + pick.k + ' ' + pick.conf + '%' : 'MAKE YOUR CALL \u203a'}</Text>
          </Pressable>
        ) : null}
        <Pressable onPress={() => goArticle && goArticle(x.idx)} hitSlop={6}>
          <Text style={[MONO, { color: C.accent, fontSize: 9.5, letterSpacing: 1.1, fontWeight: '800' }]}>{'THE STORY \u203a'}</Text>
        </Pressable>
      </View>
    </View>
  );
}

// The page opens the way a front page does: one thing, said properly.
function CallsLede({ x, goArticle }) {
  if (!x) return null;
  return (
    <View>
      <View style={{ paddingHorizontal: 16, paddingBottom: 12 }}>
        <Text style={[MONO, { color: C.accent, fontSize: 10, letterSpacing: 2.2, fontWeight: '800' }]}>WHAT THE DESK EXPECTS NEXT</Text>
        <Text style={{ color: C.muted, fontSize: 13, lineHeight: 19, marginTop: 7 }}>
          Every call here is falsifiable, dated, and scored when it resolves. The case for it and the
          case against it are printed with it: the number on its own would only be a betting line.
        </Text>
      </View>
      <View style={{ borderTopWidth: 2, borderTopColor: C.accent, borderBottomWidth: 1, borderBottomColor: C.line, backgroundColor: C.panel, paddingVertical: 18 }}>
        <CallRow x={x} goArticle={goArticle} lede />
      </View>
    </View>
  );
}

// Unconfirmed sightings, held true for one paragraph. The editor's own framing of what CALLS is for:
// "predicting what could happen next based off speculation and current events" (L17).
function IfTrue({ items }) {
  const rows = (items || []).filter((x) => x && (x.if_true || x.read) && (x.head || x.obs)).slice(0, 3);
  if (!rows.length) return null;
  return (
    <Section title="If this is true" extra={rows.length + ' unconfirmed'}>
      <Text style={[s.foot, { paddingHorizontal: 16, paddingTop: 0, paddingBottom: 12 }]}>
        Sightings the desk has not confirmed. It holds each one true for a paragraph and follows the
        consequences — the grammar stays conditional, and nothing here moves a call until it is proved.
      </Text>
      {rows.map((x, i) => (
        <View key={i} style={{ borderTopWidth: 1, borderTopColor: C.line, paddingHorizontal: 16, paddingVertical: 15 }}>
          <Text style={[MONO, { color: C.elev, fontSize: 9.5, letterSpacing: 1.2, fontWeight: '800' }]}>
            {[String(x.grade || 'unverified').toUpperCase(), x.ts ? String(x.ts).slice(5, 10) : null].filter(Boolean).join('  \u00b7  ')}
          </Text>
          <Text style={[SERIF, { color: C.text, fontSize: 17, lineHeight: 23, marginTop: 7, fontWeight: '600' }]}>
            {decode(x.head || String(x.obs || '').slice(0, 150))}
          </Text>
          <Text style={{ color: C.text, fontSize: 14, lineHeight: 21, marginTop: 9 }}>{decode(x.if_true || x.read)}</Text>
          {x.falsifier ? (
            <Text style={{ color: C.muted, fontSize: 12.5, lineHeight: 18.5, marginTop: 9 }}>
              <Text style={[MONO, { color: C.crit, fontSize: 9.5, letterSpacing: 1.1, fontWeight: '800' }]}>{'KILLS IT  '}</Text>{decode(x.falsifier)}
            </Text>
          ) : null}
        </View>
      ))}
    </Section>
  );
}

// The reasoning behind the numbers, still on the page - six principals with their position VISIBLE
// rather than ninety-nine rows to open. The full set stays one tap inside each story.
function Rooms({ chairs, goArticle }) {
  const [open, setOpen] = useState(0);
  const rows = (chairs || []).slice(0, 6);
  if (!rows.length) return null;
  return (
    <Section title="Whose decision it is" extra={(chairs || []).length + ' principals today'}>
      <Text style={[s.foot, { paddingHorizontal: 16, paddingTop: 0, paddingBottom: 12 }]}>
        Before it writes a number the desk sits in each principal's chair: what they need to survive
        politically, what they fear, what is closed to them at home, and the move that follows.
      </Text>
      {rows.map((r, i) => {
        const isOpen = open === i, pos = r.positions[0];
        return (
          <Pressable key={i} onPress={() => setOpen(isOpen ? -1 : i)}
            style={{ borderTopWidth: 1, borderTopColor: C.line, paddingHorizontal: 16, paddingVertical: 15 }}>
            <Text style={[s.actorName, SERIF, { fontSize: 19 }]}>{decode(r.name)}</Text>
            <Text style={[MONO, { color: C.muted, fontSize: 9.5, letterSpacing: 1.1, marginTop: 4 }]}>
              {String(r.region || '').toUpperCase() + '  \u00b7  MODELLED ON ' + r.positions.length + (r.positions.length === 1 ? ' STORY' : ' STORIES')}
            </Text>
            <Text style={[s.p, { fontSize: 15.5, lineHeight: 24, marginTop: 8 }]} numberOfLines={isOpen ? undefined : 5}>{decode(pos.body)}</Text>
            <Pressable onPress={() => goArticle && goArticle(pos.idx)} hitSlop={6} style={{ marginTop: 9 }}>
              <Text style={[MONO, { color: C.accent, fontSize: 9.5, letterSpacing: 1.1, fontWeight: '800' }]} numberOfLines={1}>
                {'ON: ' + decode(pos.head || '').toUpperCase() + '  \u203a'}
              </Text>
            </Pressable>
          </Pressable>
        );
      })}
    </Section>
  );
}

// ── CALLS — everything predictive, and nothing else: what the desk thinks happens next, whether it
// has been right, the branches it is watching, the hypotheses it has not proved, the tripwires, and a
// quiz that tests the read. (Was ConspiracyTab, unrendered since BOARDS took the claims.) ──
function CallsTab({ data, easy, deep, goArticle, read, saved, picks, res, quizzes, hist }) {
  const [region, setRegion] = useState('ALL');
  const [book, setBook] = useState(null);   // the tracked book opens one row at a time
  const [sel, setSel] = useState({});
  const [allCalls, setAllCalls] = useState(false);
  const cFilter = (txt) => region === 'ALL' || inferRegion(txt) === region;
  const hyps = (data.hypotheses || []).filter((h) => cFilter(h.name + ' ' + h.d));
  const fcs = (data.forecasts || []).filter((f) => cFilter(f.q));
  const calls = callsFrom(data.brief, data.clocks);
  const counts = new Map();
  calls.forEach((x) => counts.set(x.domain, (counts.get(x.domain) || 0) + 1));
  const subjects = DOMAINS.map(([n]) => [n, counts.get(n) || 0]).filter(([, n]) => n > 0);
  const CGROUPS = [
    { key: 'topic', label: 'SUBJECT', valueOf: (x) => x.domain, chips: subjects },
    { key: 'theatre', label: 'WHERE', valueOf: (x) => x.theatre, chips: chipsOf(calls, (x) => x.theatre) },
  ];
  const hit = calls.filter((x) => selMatch(sel, CGROUPS, x));
  // 2026-09-17 (editor): the forward book is the first thing on CALLS - no lede above it - and the
  // long-range rows are always shown; only the crowded near-term buckets fold past fourteen rows
  const near = hit.filter((x) => x.days != null && x.days <= 100), far = hit.filter((x) => !(x.days != null && x.days <= 100));
  const shown = (allCalls || selCount(sel) ? near : near.slice(0, 14)).concat(far);
  const chairs = chairsFrom(data.brief);
  const groups = [];
  BUCKETS.forEach((b, bi) => {
    const lo = bi ? BUCKETS[bi - 1].max : -1e9;
    const rows = shown.filter((x) => (x.days == null ? b.max >= 1e9 : x.days > lo && x.days <= b.max));
    if (rows.length) groups.push({ lab: b.lab, sub: b.sub, rows });
  });
  return (
    <View style={s.stack}>
      <Section title="The forward book" extra={hit.length + (hit.length === 1 ? ' call' : ' calls')}>
        <Text style={{ color: C.muted, fontSize: 13, lineHeight: 19, paddingHorizontal: 16, paddingBottom: 12 }}>
          Every call is falsifiable, dated, and scored when it resolves: soonest first, the long book
          last. The case for it and against it is printed with it, because the number alone would be a betting line.
        </Text>
        <MultiFilter groups={CGROUPS} sel={sel} onChange={(nx) => { setSel(nx); setAllCalls(false); }}
          total={calls.length} shown={hit.length} />
        {selCount(sel) === 1 && (sel.topic || []).length === 1 ? (
          <Text style={{ color: C.muted, fontSize: 12.5, lineHeight: 18, paddingHorizontal: 16, paddingBottom: 14 }}>
            {(DOMAIN_SUB[(sel.topic || [])[0]] || '') + ' \u2014 ' + hit.length + (hit.length === 1 ? ' call' : ' calls')
              + (hit[0] && hit[0].due ? ', the next resolving ' + fmtDue(hit[0].due).replace('BY ', '').toLowerCase() : '')}
          </Text>
        ) : null}
        {groups.map((g, i) => (
          <View key={i}>
            <View style={{ paddingHorizontal: 16, paddingTop: i ? 24 : 2, paddingBottom: 2 }}>
              <Text style={[MONO, { color: C.accent, fontSize: 10.5, letterSpacing: 2.2, fontWeight: '800' }]}>{g.lab}</Text>
              <Text style={{ color: C.muted, fontSize: 12, marginTop: 4 }}>{g.rows.length + ' ' + g.sub}</Text>
            </View>
            {g.rows.map((x, j) => <CallRow key={j} x={x} goArticle={goArticle} pick={(picks || {})[x.id]} hasScenarios={x.hasScenarios} />)}
          </View>
        ))}
        {!allCalls && !selCount(sel) && near.length > 14 ? (
          <Pressable onPress={() => setAllCalls(true)} style={{ paddingVertical: 15, paddingHorizontal: 16, borderTopWidth: 1, borderTopColor: C.line }}>
            <Text style={[s.readmore, MONO]}>{'THE REMAINING ' + (near.length - 14) + ' NEAR-TERM CALLS \u203a'}</Text>
          </Pressable>
        ) : null}
      </Section>
      <Scorecard picks={picks} cards={data.brief} res={res} goArticle={goArticle} quizzes={quizzes} hist={hist} />
      <IfTrue items={data.speculation} />
      <Rooms chairs={chairs} goArticle={goArticle} />
      {/* everything the desk keeps for itself - the book, the record, the lab - behind ONE door */}
      <Section title="More from the desk" extra="every call, the book, the record" fold>
        <Section title="The tracked book" extra={String(fcs.length)} fold>
          <FilterDrop pairs={textRegionPairs(data.forecasts || [], (f) => f.q || '')} active={region} onPick={setRegion} />
          {fcs.map((f, i) => {
            const d = f.prev != null ? f.p - f.prev : null;
            return (
              <Pressable key={i} onPress={() => setBook(book === i ? null : i)} style={s.pred}>
                <View style={s.predtop}>
                  <Text style={s.predq}>{decode(f.q)}</Text>
                  <Text style={[s.predp, MONO]}>{f.p}<Text style={s.predpS}>%</Text></Text>
                </View>
                <ProbBar p={f.p} prev={f.prev} />
                <View style={s.predmeta}>
                  {d ? <Text style={[s.chip, MONO, { color: d > 0 ? C.high : C.calm }]}>{(d > 0 ? '+' : '') + d}</Text> : null}
                  <Text style={s.predmetaTxt}>by {f.by}</Text>
                </View>
                {f.note && book === i ? <Text style={s.prednote}>{decode(f.note)}</Text> : null}
                {f.note && book !== i ? <Text style={[MONO, { color: C.accent, fontSize: 9.5, letterSpacing: 1, marginTop: 6 }]}>+ WHY</Text> : null}
              </Pressable>
            );
          })}
        </Section>
        {/* the weekly deep dive lost its only surface when the HOME banner came off (the editor's
            words: don't start the page with this boring article). Ten written sections belong behind a
            door, not on the front page - so it lives here. */}
        {data.lecture && (data.lecture.sections || []).length ? (
          <Section title="This week's deep dive" extra={data.lecture.date || ''} fold>
            <View style={{ paddingHorizontal: 16, paddingBottom: 16 }}>
              <Text style={[s.idxH, SERIF, { fontSize: 21, lineHeight: 27 }]}>{decode(data.lecture.title)}</Text>
              <View style={{ marginTop: 12 }}><Sections items={data.lecture.sections} /></View>
            </View>
          </Section>
        ) : null}
        <CalibrationTrack track={data.track} forecasts={data.forecasts} />
        {hyps.length ? (
          <Section title="Hidden-strategy lab" extra={hyps.length + ' live'} fold>
            {hyps.map((h, i) => (
              <View key={i} style={s.hyp}>
                <Text style={[s.hypP, MONO]}>{h.p}%</Text>
                <View style={{ flex: 1 }}>
                  <Text style={s.hypName}>{decode(h.name)}.</Text>
                  <Text style={s.hypD}>{decode(h.d)}</Text>
                </View>
              </View>
            ))}
          </Section>
        ) : null}
        <Scenarios items={data.scenarios} />
        <Watchlist tripwires={data.tripwires} />
        <QuizSection quiz={data.quiz} />
      </Section>
      <Text style={s.foot}>Probabilities are subjective estimates and will often be wrong — that's the point of keeping score. Not advice.</Text>
    </View>
  );
}

// Our own index, published with its weights and its code. Truflation's API starts at $1,999 a month
// and its weighting is not fully published; asking a reader who came here because they trust nobody to
// trust a black box would be the one thing this feature cannot afford. So: five bills that arrive every
// week, public prices underneath, the weights on the screen, and the line moving when petrol moves
// rather than a month later. It is NOT a rival to CPI and the panel says so - CPI measures everything
// including what got cheaper; this measures the part of the basket people notice.
function WeeklyBasket({ b }) {
  const [openW, setOpenW] = useState(null);
  const [method, setMethod] = useState(false);
  if (!b || b.since == null) return null;
  const gap = b.cpi_since != null ? Math.round((b.since - b.cpi_since) * 10) / 10 : null;
  return (
    <View style={{ marginTop: 14, borderWidth: 1, borderColor: C.accentDim, borderRadius: 12, padding: 14 }}>
      <Text style={[MONO, { color: C.accent, fontSize: 9.5, letterSpacing: 1.6, fontWeight: '800' }]}>
        {'THE WEEKLY BASKET \u00b7 OUR OWN INDEX'}
      </Text>
      <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 10, marginTop: 8 }}>
        <Text style={[MONO, { color: C.high, fontSize: 34, fontWeight: '800', lineHeight: 38 }]}>
          {(b.since > 0 ? '+' : '') + b.since + '%'}
        </Text>
        <Text style={{ color: C.text, fontSize: 14.5, flex: 1, lineHeight: 20 }}>
          {'what the weekly bills cost now against ' + b.base}
        </Text>
      </View>
      {Array.isArray(b.series) && b.series.length >= 8 ? (
        <View style={{ marginTop: 10 }}><Sparkline hist={b.series} w={320} h={44} /></View>
      ) : null}
      <Text style={[MONO, { color: C.muted, fontSize: 9.5, letterSpacing: 1, marginTop: 6 }]}>
        {'WEEK OF ' + String(b.asof || '') + (b.yoy != null ? '  \u00b7  ' + b.yoy + '% OVER 12 MONTHS' : '')
          + (b.from ? '  \u00b7  LINE FROM ' + String(b.from).slice(0, 7) : '')}
      </Text>
      {gap != null ? (
        <Text style={[s.p, { fontSize: 15, lineHeight: 23, marginTop: 12, marginBottom: 0 }]}>
          {'Official CPI is up ' + b.cpi_since + '% over the same window' + (b.cpi_yoy != null ? ' and ' + b.cpi_yoy + '% over 12 months' : '')
            + '. The gap is ' + Math.abs(gap) + ' points, and it is not a contradiction: CPI measures everything a '
            + 'household buys, including the things that got cheaper. This measures the five bills that arrive '
            + 'every week.'}
        </Text>
      ) : null}
      {(b.weights || []).map((w, i) => {
        const open = openW === i;
        return (
          <View key={i} style={{ borderTopWidth: 1, borderTopColor: C.line, paddingTop: 10, marginTop: 10 }}>
            <Pressable onPress={() => setOpenW(open ? null : i)} style={{ flexDirection: 'row', alignItems: 'baseline', gap: 10 }}>
              <Text style={[MONO, { color: C.muted, fontSize: 11, width: 40 }]}>{Math.round(w.w * 100) + '%'}</Text>
              <Text style={{ color: C.text, fontSize: 14.5, flex: 1 }}>{w.n}</Text>
              <Text style={[MONO, { color: C.high, fontSize: 14, fontWeight: '800' }]}>
                {(w.pct > 0 ? '+' : '') + w.pct + '%'}
              </Text>
              <Text style={{ color: C.accent, fontSize: 15 }}>{open ? '\u2212' : '+'}</Text>
            </Pressable>
            {open ? (
              <View style={{ marginTop: 7 }}>
                <Text style={{ color: C.muted, fontSize: 13, lineHeight: 19 }}>{w.what}</Text>
                {w.then != null ? (
                  <Text style={[MONO, { color: C.muted, fontSize: 11, marginTop: 5 }]}>
                    {'$' + w.then + ' \u2192 $' + w.now + '  \u00b7  ' + String(w.src).toUpperCase()
                      + (w.asof ? '  \u00b7  ' + w.asof : '')}
                  </Text>
                ) : null}
                {(w.items || []).map((it, j) => (
                  <View key={j} style={{ flexDirection: 'row', alignItems: 'baseline', gap: 8, marginTop: 6 }}>
                    <Text style={{ color: C.text, fontSize: 13.5, flex: 1 }}>{it.n}</Text>
                    <Text style={[MONO, { color: C.muted, fontSize: 11.5 }]}>{'$' + it.then + ' \u2192 $' + it.now}</Text>
                    <Text style={[MONO, { color: C.high, fontSize: 12.5, fontWeight: '700', width: 58, textAlign: 'right' }]}>
                      {(it.pct > 0 ? '+' : '') + it.pct + '%'}
                    </Text>
                  </View>
                ))}
              </View>
            ) : null}
          </View>
        );
      })}
      <Pressable onPress={() => setMethod((v) => !v)} hitSlop={6} style={{ marginTop: 12 }}>
        <Text style={[MONO, { color: C.accent, fontSize: 9.5, letterSpacing: 1.2, fontWeight: '800' }]}>
          {method ? 'HIDE HOW IT IS BUILT \u2039' : 'HOW IT IS BUILT, AND WHY THE WEIGHTS ARE OURS \u203a'}
        </Text>
      </Pressable>
      {method ? <Text style={{ color: C.muted, fontSize: 13, lineHeight: 19.5, marginTop: 7 }}>{decode(b.method)}</Text> : null}
    </View>
  );
}

// The instrument that prices an official decision before the decision is announced. Modelled on a
// macro account the desk already reads: hours before the Fed moved, he wrote that the 3-month bill was
// paying more than the top of the Fed's own range, so a rise was already bought - and the Fed raised.
// The bill matures inside the next two meetings, so its yield IS the market's forecast of them. The
// second half is the cross-market check: a move happening in five countries at once is not caused by
// this morning's headline in one of them.
function PricedIn({ p }) {
  const [how, setHow] = useState(false);
  if (!p || p.bill == null) return null;
  const col = p.spread >= 12 ? C.crit : p.spread <= -12 ? C.calm : C.muted;
  return (
    <>
      <Text style={[MONO, { color: C.accent, fontSize: 9.5, letterSpacing: 1.6, fontWeight: '800', marginTop: 20 }]}>
        WHAT THE MARKET HAD ALREADY PRICED
      </Text>
      <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 10, marginTop: 9 }}>
        <Text style={[MONO, { color: C.text, fontSize: 24, fontWeight: '800' }]}>{p.bill + '%'}</Text>
        <Text style={{ color: C.text, fontSize: 14, flex: 1, lineHeight: 20 }}>
          {'the 3-month Treasury bill, against a target range of ' + p.bottom + '\u2013' + p.top + '%'}
        </Text>
      </View>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 8 }}>
        <Text style={[MONO, { color: col, fontSize: 13, fontWeight: '800', letterSpacing: 1.1 }]}>
          {(p.spread > 0 ? '+' : '') + p.spread + 'BP  \u00b7  ' + p.verdict}
        </Text>
      </View>
      <Text style={[s.p, { fontSize: 15, lineHeight: 23, marginTop: 8, marginBottom: 0 }]}>{decode(p.says) + '.'}</Text>
      <Text style={[MONO, { color: C.muted, fontSize: 9, letterSpacing: 0.8, marginTop: 6 }]}>
        {'DTB3 ' + String(p.bill_asof || '') + ' \u00b7 DFEDTARU/DFEDTARL ' + String(p.range_asof || '')}
      </Text>
      {(p.longs || []).length ? (
        <>
          <Text style={[MONO, { color: C.muted, fontSize: 9.5, letterSpacing: 1.4, fontWeight: '800', marginTop: 16 }]}>
            AND IS IT ONLY HAPPENING HERE?
          </Text>
          {p.longs.map((x, i) => (
            <View key={i} style={{ flexDirection: 'row', alignItems: 'baseline', gap: 10, marginTop: 7 }}>
              <Text style={{ color: C.text, fontSize: 13.5, flex: 1 }}>{x.n}</Text>
              <Text style={[MONO, { color: C.muted, fontSize: 12 }]}>{x.v + '%'}</Text>
              <Text style={[MONO, { color: x.ch > 10 ? C.high : x.ch < -10 ? C.calm : C.muted, fontSize: 12.5, fontWeight: '700', width: 66, textAlign: 'right' }]}>
                {(x.ch > 0 ? '+' : '') + x.ch + 'bp'}
              </Text>
            </View>
          ))}
          {p.where ? <Text style={[s.p, { fontSize: 15, lineHeight: 23, marginTop: 10, marginBottom: 0 }]}>{decode(p.where)}</Text> : null}
        </>
      ) : null}
      <Pressable onPress={() => setHow((v) => !v)} hitSlop={6} style={{ marginTop: 12 }}>
        <Text style={[MONO, { color: C.accent, fontSize: 9.5, letterSpacing: 1.2, fontWeight: '800' }]}>
          {how ? 'HIDE HOW THIS WORKS \u2039' : 'HOW THIS WORKS \u203a'}
        </Text>
      </Pressable>
      {how ? (
        <Text style={EXPLAIN_P}>
          {decode(p.method) + ' The signal fires BEFORE the announcement and goes quiet after it: once the '
            + 'committee moves, the range catches up with the bill and the gap closes, which is the reading '
            + 'meaning "nothing more is priced yet", not "nothing is happening".'}
        </Text>
      ) : null}
    </>
  );
}

// ── THE RECEIPTS — what the official number says, and what everything else says. ────────────────
// 2026-09-16 (editor): "What if people feel like they are being lied to about what inflation is,
// because prices are still high and savings are diminished... this news app is supposed to go through
// what the government tells us and use facts and stat points from multiple sources to call them out...
// That's what's going to separate us from every other news app."
//
// The separation is the RECEIPTS, not the accusation. Three different questions share the word
// inflation and the confusion between them is most of the feeling of being lied to:
//   the RATE (how fast prices are rising now) - which can fall while
//   the LEVEL (what things cost against a few years ago) keeps climbing, and
//   YOUR basket, which is food, rent, power and fuel, not the average of everything.
// So the panel puts all three on one screen with a source id on every figure, and the gap between
// the official measure and the independent ones is printed in WHICHEVER DIRECTION IT FALLS. On the
// day this shipped the independent measures were running BELOW the headline - and the panel says so,
// because a desk that only ever reports "the real number is higher" is running a narrative, and the
// first month that breaks is the month nobody believes anything else on the page.
// 2026-09-17 (editor, on THE RECEIPTS: "too small of font ... avoid these long paragraphs by default,
// make it a click to read like the other buttons"): the standing explanation of a print sits behind a
// door styled like the article doors, and opens at reading size, not footnote size.
function Explainer({ label, sub, children, color, boxRef }) {
  const [open, setOpen] = useState(false);
  return (
    <View style={{ marginTop: 14 }} ref={boxRef}>
      <Pressable onPress={() => setOpen((o) => !o)} style={[s.artbtn, { borderColor: color || C.accentDim }, open && s.artbtnOn]}>
        <Text style={[s.artbtnT, MONO, { color: color || C.accent }]} numberOfLines={1}>{(open ? '− ' : '≡ ') + label}</Text>
        {sub ? <Text style={s.artbtnS}>{sub}</Text> : null}
      </Pressable>
      {open ? <View style={{ marginTop: 12 }}>{children}</View> : null}
    </View>
  );
}
const EXPLAIN_P = { color: C.text, fontSize: 15.5, lineHeight: 24, marginTop: 10 };

function Receipts({ inf }) {
  const [openWhat, setOpenWhat] = useState(null);
  if (!inf || !inf.official || !inf.official.length) return null;
  const head = inf.official[0];
  const lbl = (t, c) => (
    <Text style={[MONO, { color: c || C.accent, fontSize: 9.5, letterSpacing: 1.6, fontWeight: '800', marginTop: 18 }]}>{t}</Text>
  );
  const srcline = (t) => <Text style={[MONO, { color: C.muted, fontSize: 9, letterSpacing: 0.8, marginTop: 3 }]}>{t}</Text>;
  return (
    <Section title="The receipts" extra={inf.asof || ''}>
      <View style={{ paddingHorizontal: 16, paddingBottom: 18 }}>
        <Text style={{ color: C.muted, fontSize: 13, lineHeight: 19 }}>
          The official inflation number, checked against measures the government does not produce and
          against what things actually cost. Every figure below is a published series with its source
          printed beside it — the desk adds no estimates of its own here.
        </Text>

        {inf.basket_index ? <WeeklyBasket b={inf.basket_index} /> : null}

        {lbl('WHAT THE GOVERNMENT SAYS')}
        {inf.official.map((o, i) => (
          <View key={i} style={{ marginTop: 10 }}>
            <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 10 }}>
              <Text style={[MONO, { color: C.text, fontSize: 22, fontWeight: '800' }]}>{o.v != null ? o.v + '%' : '—'}</Text>
              <Text style={{ color: C.text, fontSize: 14.5, flex: 1 }}>{o.name + ', over 12 months'}</Text>
            </View>
            <Text style={{ color: C.muted, fontSize: 13, lineHeight: 19, marginTop: 2 }}>{o.what}</Text>
            {srcline('BLS SERIES ' + o.src + ' \u00b7 ' + (o.asof || ''))}
          </View>
        ))}

        {lbl('WHAT MEASURES IT DOES NOT PRODUCE SAY')}
        {inf.independent.map((x, i) => (
          <Pressable key={i} onPress={() => setOpenWhat(openWhat === i ? null : i)} style={{ marginTop: 11 }}>
            <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 10 }}>
              <Text style={[MONO, { color: C.accent, fontSize: 18, fontWeight: '800', width: 58 }]}>{x.v != null ? x.v + '%' : '—'}</Text>
              <Text style={{ color: C.text, fontSize: 14.5, flex: 1 }}>{x.name}</Text>
              <Text style={{ color: C.accent, fontSize: 15 }}>{openWhat === i ? '\u2212' : '+'}</Text>
            </View>
            {openWhat === i ? <Text style={{ color: C.muted, fontSize: 13.5, lineHeight: 20, marginTop: 5 }}>{x.what}</Text> : null}
            {srcline((x.who ? x.who.toUpperCase() + ' \u00b7 ' : '') + String(x.src).toUpperCase())}
          </Pressable>
        ))}
        {inf.gap ? (
          <View style={{ marginTop: 14, borderLeftWidth: 3, borderLeftColor: inf.gap.dir === 'above' ? C.crit : inf.gap.dir === 'below' ? C.calm : C.muted, paddingLeft: 12 }}>
            <Text style={[MONO, { color: C.muted, fontSize: 9.5, letterSpacing: 1.4, fontWeight: '800' }]}>THE GAP</Text>
            <Text style={[s.p, { fontSize: 15, lineHeight: 23, marginTop: 5, marginBottom: 0 }]}>{decode(inf.gap.line)}</Text>
          </View>
        ) : null}

        {inf.wages ? (
          <>
            {lbl('PAY, PRICES AND WHAT IS LEFT')}
            <Text style={[s.p, { fontSize: 15, lineHeight: 23, marginTop: 6, marginBottom: 0 }]}>
              {'Since ' + inf.base + ' average hourly pay is up ' + inf.wages.pay + '% and prices are up '
                + inf.wages.prices + '%, so the average wage is '
                + (inf.wages.real >= 0 ? inf.wages.real + ' points AHEAD of' : Math.abs(inf.wages.real) + ' points BEHIND')
                + ' the average price — $' + inf.wages.then + ' an hour then, $' + inf.wages.now + ' now.'}
            </Text>
            {inf.wages.saving != null ? (
              <Text style={[s.p, { fontSize: 15, lineHeight: 23, marginTop: 8, marginBottom: 0 }]}>
                {'Households are saving ' + inf.wages.saving + '% of what they take home, against '
                  + inf.wages.saving_then + '% in ' + inf.base + '. That is the part the averages hide: pay '
                  + 'kept up with the basket on average while the things bought every week ran far ahead of it, '
                  + 'and the difference came out of savings.'}
              </Text>
            ) : null}
            {srcline(String(inf.wages.src).toUpperCase() + ' \u00b7 SAVING RATE PSAVERT \u00b7 ' + (inf.wages.asof || ''))}
          </>
        ) : null}

        {inf.priced ? <PricedIn p={inf.priced} /> : null}

        {inf.shelter ? (
          <>
            {lbl('RENT, THE MOST-DISPUTED PART OF THE INDEX')}
            {Object.keys(inf.shelter).map((k, i) => (
              <View key={i} style={{ flexDirection: 'row', alignItems: 'baseline', gap: 10, marginTop: 8 }}>
                <Text style={[MONO, { color: C.accent, fontSize: 15, fontWeight: '800', width: 58 }]}>
                  {inf.shelter[k].v != null ? inf.shelter[k].v + '%' : '—'}
                </Text>
                <Text style={{ color: C.text, fontSize: 14, flex: 1 }}>{k}
                  <Text style={[MONO, { color: C.muted, fontSize: 9.5 }]}>{'  ' + String(inf.shelter[k].src).toUpperCase()}</Text>
                </Text>
              </View>
            ))}
          </>
        ) : null}

        <Explainer label="HOW THESE ARE MEASURED" sub="the sources, the rent gap, the Big Mac, the caveats">
          {inf.shelter ? (
            <Text style={EXPLAIN_P}>
              The CPI measures what every tenant pays, most of whom did not move this year; the market
              figure is what a landlord asks on a new lease. They should differ — the question is only
              whether the CPI's version turns late, and by how much.
            </Text>
          ) : null}
          {inf.bigmac ? (
            <Text style={EXPLAIN_P}>
              {'One more basket nobody official controls: a Big Mac went from $' + inf.bigmac.then + ' to $'
                + inf.bigmac.now + ', ' + (inf.bigmac.pct > 0 ? '+' : '') + inf.bigmac.pct + '% since ' + inf.base
                + ' (' + inf.bigmac.src + ').'}
            </Text>
          ) : null}
          {(inf.notes || []).map((n, i) => (
            <Text key={i} style={EXPLAIN_P}>{decode(n)}</Text>
          ))}
        </Explainer>
      </View>
    </Section>
  );
}

// ── THE CHOKEPOINTS — the measurement behind half the geopolitics on this app. ─────────────────
// 2026-09-16. The desk files calls that turn on whether a strait is open, and until now it settled
// them with somebody's post about somebody's radar. IMF PortWatch publishes daily AIS transit counts
// for 28 chokepoints via the UN Global Platform, keyless, about three days behind. Each one is scored
// against ITS OWN ninety-day normal, because Malacca runs two hundred ships a day and the Bering
// Strait runs two - a raw count is not a signal, a deviation from a strait's own habit is.
const CHOKE_COL = { SHUT: 'crit', CHOKED: 'crit', THINNED: 'high', BUSIER: 'elev', OPEN: 'muted' };
function Chokepoints({ cp }) {
  const [open, setOpen] = useState(null);
  const [all, setAll] = useState(false);
  const [note, setNote] = useState(false);
  if (!cp || !(cp.points || []).length) return null;
  const rows = all ? cp.points : cp.points.slice(0, 9);
  const moved = (cp.points || []).filter((x) => x.status !== 'OPEN' && x.status !== 'NO DATA');
  return (
    <Section title="The chokepoints" extra={cp.asof || ''}>
      <Text style={{ color: C.muted, fontSize: 13, lineHeight: 19, paddingHorizontal: 16, paddingBottom: 4 }}>
        {'How many ships actually went through, every day, measured against each strait\u2019s own ninety-day '
          + 'normal. ' + (moved.length
            ? moved.length + (moved.length === 1 ? ' is' : ' are') + ' away from normal right now.'
            : 'Everything is running about as it usually does.')}
      </Text>
      {rows.map((x, i) => {
        const col = C[CHOKE_COL[x.status] || 'muted'];
        const isOpen = open === i;
        return (
          <View key={i} style={{ borderTopWidth: 1, borderTopColor: C.line }}>
            <Pressable onPress={() => setOpen(isOpen ? null : i)} style={{ paddingHorizontal: 16, paddingVertical: 12 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                <Text style={[MONO, { color: col, fontSize: 10, letterSpacing: 1.3, fontWeight: '800', width: 72 }]}>{x.status}</Text>
                <Text style={{ color: C.text, fontSize: 14.5, flex: 1 }}>{decode(x.n)}</Text>
                <Text style={[MONO, { color: C.muted, fontSize: 12 }]}>{x.week + '/day'}</Text>
                <Text style={[MONO, { color: col, fontSize: 13, fontWeight: '800', width: 54, textAlign: 'right' }]}>
                  {x.pct == null ? '—' : (x.pct > 0 ? '+' : '') + x.pct + '%'}
                </Text>
              </View>
            </Pressable>
            {isOpen ? (
              <View style={{ paddingHorizontal: 16, paddingBottom: 14 }}>
                {Array.isArray(x.series) && x.series.length >= 8 ? <Sparkline hist={x.series} w={320} h={40} /> : null}
                <Text style={[s.p, { fontSize: 15, lineHeight: 23, marginTop: 8, marginBottom: 0 }]}>
                  {x.week + ' ships a day this week against ' + x.base + ' normal \u2014 ' + x.what + '.'}
                </Text>
                <Text style={[MONO, { color: C.muted, fontSize: 9, letterSpacing: 0.8, marginTop: 6 }]}>
                  {'LATEST DAY ' + x.now + ' SHIPS \u00b7 ' + String(x.asof || '')
                    + (x.cap ? ' \u00b7 ' + Math.round(x.cap / 1000) + 'K TONNES OF CAPACITY' : '')}
                </Text>
              </View>
            ) : null}
          </View>
        );
      })}
      {cp.points.length > rows.length || all ? (
        <Pressable onPress={() => setAll((v) => !v)} style={{ paddingVertical: 13, paddingHorizontal: 16, borderTopWidth: 1, borderTopColor: C.line }}>
          <Text style={[s.readmore, MONO]}>{all ? 'THE NINE THAT MATTER MOST \u2039' : 'ALL ' + cp.points.length + ' CHOKEPOINTS \u203a'}</Text>
        </Pressable>
      ) : null}
      <View style={{ paddingHorizontal: 16, paddingVertical: 12, borderTopWidth: 1, borderTopColor: C.line }}>
        <Pressable onPress={() => setNote((v) => !v)} hitSlop={6}>
          <Text style={[MONO, { color: C.accent, fontSize: 9.5, letterSpacing: 1.2, fontWeight: '800' }]}>
            {note ? 'HIDE WHAT THIS CAN AND CANNOT SHOW \u2039' : 'WHAT THIS CAN AND CANNOT SHOW \u203a'}
          </Text>
        </Pressable>
        {note ? <Text style={{ color: C.muted, fontSize: 13, lineHeight: 19.5, marginTop: 7 }}>{decode(cp.note)}</Text> : null}
        <Text style={[MONO, { color: C.muted, fontSize: 9, letterSpacing: 0.8, marginTop: 8 }]}>{String(cp.src || '').toUpperCase()}</Text>
      </View>
    </Section>
  );
}

// ── COUNTRY DOSSIERS — flag chips, tap to open the dossier (mockup's country page, inline) ──
function Dossiers({ items }) {
  const [sel, setSel] = useState(null);
  if (!items || !items.length) return null;
  const d = sel != null ? items[sel] : null;
  const tc = d ? (riskColor[(d.threat || {}).level] || C.elev) : null;
  const G = [['government', 'GOVERNMENT'], ['leader', 'LEADER'], ['population', 'POPULATION'], ['gdp', 'GDP'], ['military', 'MILITARY'], ['influence', 'INFLUENCE']];
  return (
    <Section title="Country dossiers" extra={items.length + ' tracked'}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.rfilter}>
        {items.map((it, i) => (
          <Pressable key={i} onPress={() => setSel(sel === i ? null : i)} style={[s.rchip, sel === i && s.rchipOn]}>
            <Text style={[s.rchipTxt, MONO, sel === i && { color: C.text, fontWeight: '700' }]}>{(it.flag || '') + ' ' + it.name}</Text>
          </Pressable>
        ))}
      </ScrollView>
      {d ? (
        <View style={s.storycard}>
          <Text style={[s.storyH3, SERIF]}>{(d.flag || '') + ' ' + decode(d.name)}</Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', marginTop: 4 }}>
            {G.map(([k, lab]) => (d.glance || {})[k] ? (
              <View key={k} style={{ width: '50%', paddingVertical: 5, paddingRight: 8 }}>
                <Text style={[MONO, { color: C.muted, fontSize: 8.5, letterSpacing: 1 }]}>{lab}</Text>
                <Text style={{ color: C.text, fontSize: 12.5, marginTop: 1 }}>{decode(d.glance[k])}</Text>
              </View>
            ) : null)}
          </View>
          <Text style={[s.ctxlbl, MONO, { marginTop: 8 }]}>INTEL SUMMARY</Text>
          <Sections items={sectionize(d.summary)} size={16} />
          {Array.isArray(d.read) && d.read.length ? <Sections items={d.read} size={16} /> : null}
          {d.threat ? (
            <>
              <Text style={[s.ctxlbl, MONO, { marginTop: 8, color: tc }]}>{'THREAT ASSESSMENT · ' + String(d.threat.level || '').toUpperCase()}</Text>
              {(d.threat.concerns || []).map((cn, i) => (
                <Text key={i} style={s.li}><Text style={{ color: tc }}>› </Text>{decode(cn)}</Text>
              ))}
            </>
          ) : null}
          {d.updated ? <Text style={[MONO, { color: C.muted, fontSize: 9, marginTop: 6 }]}>{'UPDATED ' + d.updated}</Text> : null}
        </View>
      ) : null}
    </Section>
  );
}

// ── SCENARIO EXPLORER — what-if branches on the staged-forecast discipline ──
function Scenarios({ items }) {
  const [sel, setSel] = useState(null);
  if (!items || !items.length) return null;
  return (
    <Section title="Scenario explorer" extra={items.length + ' branches'} fold>
      {items.map((sc, i) => (
        <View key={i} style={s.storycard}>
          <Pressable onPress={() => setSel(sel === i ? null : i)}>
            <Text style={[s.storyH3, SERIF, { fontSize: 16, color: C.accent }]}>{decode(sc.q)}</Text>
          </Pressable>
          {sel === i ? (
            <>
              <Text style={s.storyP}>{decode(sc.read || '')}</Text>
              {(sc.stages || []).map((st, j) => (
                <View key={j} style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 4 }}>
                  <Text style={[MONO, { color: C.accent, fontSize: 12, width: 44 }]}>{(st.p != null ? st.p + '%' : '—')}</Text>
                  <Text style={{ color: C.text, fontSize: 12.5, flex: 1 }}>{decode(st.s)}</Text>
                </View>
              ))}
              {sc.falsifier ? (
                <Text style={[s.li, { marginTop: 4 }]}>
                  <Text style={{ color: C.crit }}>› </Text>
                  <Text style={[MONO, { fontSize: 10, color: C.muted }]}>{'KILLS THE BRANCH: '}</Text>
                  {decode(sc.falsifier)}
                </Text>
              ) : null}
            </>
          ) : (
            <Text style={[MONO, { color: C.muted, fontSize: 10 }]}>TAP TO EXPLORE ›</Text>
          )}
        </View>
      ))}
      <Text style={s.foot}>Branches, not prophecies — every stage carries a probability and a falsifier; most branches fizzle early.</Text>
    </Section>
  );
}

// ── WATCHLIST — the tripwires: what is armed, what fired (mockup's alerts page) ──
function Watchlist({ tripwires }) {
  const tw = tripwires || {};
  const armed = tw.armed || [], fired = tw.fired || [];
  if (!armed.length && !fired.length) return null;
  return (
    <Section title="Watchlist" extra={armed.length + ' armed'} fold>
      {fired.map((f, i) => (
        <View key={'f' + i} style={{ flexDirection: 'row', paddingVertical: 5 }}>
          <Text style={[MONO, { color: C.crit, fontSize: 9, width: 52, letterSpacing: 1 }]}>FIRED</Text>
          <Text style={{ color: C.text, fontSize: 12.5, flex: 1 }}>{decode(f)}</Text>
        </View>
      ))}
      {armed.map((a, i) => (
        <View key={'a' + i} style={{ flexDirection: 'row', paddingVertical: 5 }}>
          <Text style={[MONO, { color: C.elev, fontSize: 9, width: 52, letterSpacing: 1 }]}>ARMED</Text>
          <Text style={{ color: C.text, fontSize: 12.5, flex: 1 }}>{decode(a)}</Text>
        </View>
      ))}
      <Text style={s.foot}>Named thresholds checked every sweep — non-fires are logged deliberately so silence is scoreable.</Text>
    </Section>
  );
}

// ── DATA — the reference layer: who the players are, what the countries measure, what is physically
// happening, and what the money is doing. No forecasts here and no essays; those have their own tabs. ──
function DataTab({ data, easy, world, hist, goArticle, room, quizzes, onQuiz }) {
  const [region, setRegion] = useState('ALL');
  const [fullRead, setFullRead] = useState(false);
  const actorText = (a) => a.n + ' ' + a.r + ' ' + (a.w || '');
  const actors = (data.actors || []).filter((a) => region === 'ALL' || inferRegion(actorText(a)) === region);
  return (
    <View style={s.stack}>
      {/* 2026-09-16 (user: "for data, don't start with listing out all the players, that's way too long
          to scroll. I like the money reports"). The money leads; the players are a reference list and
          sit at the bottom where a reader goes looking for them. */}
      <SituationRooms hist={hist} cards={data.brief} goArticle={goArticle} initial={room} quizzes={quizzes} onQuiz={onQuiz} />
      <Receipts inf={data.inflation} />
      <Chokepoints cp={data.chokepoints} />
      {data.plumbing ? <RedBoard board={data.plumbing.board} /> : null}
      {data.plumbing ? <LiveWatchlist items={data.plumbing.series} /> : null}
      {data.plumbing ? (
        <Section title="The economic read" extra={data.plumbing.stage ? 'live' : ''}>
          <View style={{ paddingHorizontal: 16, paddingBottom: 16 }}>
            {/* 2026-09-16: the read is a dense desk paragraph. Four lines of it, then the rest on
                request - the reader who wants the whole thing asks for it, and everyone else gets
                the top of it and the chart below. */}
            <Text style={s.p} numberOfLines={fullRead ? undefined : 4}>{decode(easy && data.easy ? data.easy.markets : data.plumbing.read)}</Text>
            <Pressable onPress={() => setFullRead((v) => !v)} hitSlop={6} style={{ marginTop: 8 }}>
              <Text style={[s.readmore, MONO]}>{fullRead ? 'SHOW LESS ‹' : 'READ THE FULL READ ›'}</Text>
            </Pressable>
            {data.cost && data.cost.pct != null ? (
              <Text style={[MONO, { color: C.muted, fontSize: 11.5, marginTop: 12 }]}>
                {'WHAT A 2019 DOLLAR BUYS NOW \u00b7 +' + data.cost.pct + '% SINCE THEN \u00b7 AS OF ' + (data.cost.asof || '')}
              </Text>
            ) : null}
          </View>
        </Section>
      ) : null}
      <Calendar clocks={data.clocks} />
      <Dossiers items={data.dossiers} />
      <WorldSections world={world} hist={hist} />
            {data.actors && data.actors.length ? (
        <Section title="The players" extra={actors.length + ' tracked'} fold>
          <FilterDrop pairs={textRegionPairs(data.actors, actorText)} active={region} onPick={setRegion} />
          {actors.map((a, i) => (
            <View key={i} style={s.actor}>
              <Text style={[s.actorName, SERIF]}>{decode(a.n)}</Text>
              <Text style={[s.actorRole, MONO]}>{decode(a.r).toUpperCase()}</Text>
              {a.w ? <Text style={s.actorRow}><Text style={s.actorK}>Really — </Text>{decode(a.w)}</Text> : null}
              {a.g ? <Text style={s.actorRow}><Text style={s.actorK}>Wants — </Text>{decode(a.g)}</Text> : null}
              {a.m ? <Text style={s.actorRow}><Text style={s.actorK}>Now — </Text>{decode(a.m)}</Text> : null}
              {a.l ? <Text style={s.actorRow}><Text style={s.actorK}>Lens — </Text>{decode(a.l)}</Text> : null}
            </View>
          ))}
        </Section>
      ) : null}
      <Text style={s.foot}>Every figure carries its source and vintage. Where the desk could not get a number, it says so.</Text>
    </View>
  );
}


// ── WORLD — primary-source numbers and the situation-room history graph ──────────────────────────
// Every number on this tab is a provenanced cell {v, unit, year, src, code} from a primary statistical
// source (World Bank, IMF, UN Comtrade, UNHCR, USGS, NASA, FRED). No LLM prose. A missing value renders
// as NO DATA, never as a guess. History comes from the sourced knowledge graph; confidence and source
// ids travel with every event so the reader can see what an assessment rests on.
function fmtCell(v, unit) {
  if (v == null || Number.isNaN(v)) return '—';
  const a = Math.abs(v);
  if (unit === 'USD') {
    if (a >= 1e12) return '$' + (v / 1e12).toFixed(2) + 'T';
    if (a >= 1e9) return '$' + (v / 1e9).toFixed(1) + 'B';
    if (a >= 1e6) return '$' + (v / 1e6).toFixed(1) + 'M';
    return '$' + Math.round(v).toLocaleString();
  }
  if (unit === 'people') {
    if (a >= 1e9) return (v / 1e9).toFixed(2) + 'B';
    if (a >= 1e6) return (v / 1e6).toFixed(1) + 'M';
    if (a >= 1e3) return Math.round(v / 1e3) + 'K';
    return String(Math.round(v));
  }
  if (unit === '%') return (Math.round(v * 10) / 10).toFixed(1) + '%';
  if (unit === 'index') return (v > 0 ? '+' : '') + v.toFixed(2);
  if (unit === 'USD/bbl' || unit === 'USD/MMBtu') return '$' + v.toFixed(2);
  return (Math.round(v * 100) / 100).toLocaleString();
}
const WORLD_GROUPS = [
  ['SCALE', ['population', 'gdp', 'gdp_per_capita', 'urban_pct']],
  ['ECONOMY', ['gdp_growth', 'imf_gdp_growth_proj', 'inflation', 'unemployment', 'reserves', 'external_debt', 'govt_debt', 'imf_current_account']],
  ['INDUSTRY (% GDP)', ['va_agriculture', 'va_industry', 'va_manufacturing', 'va_services']],
  ['TRADE & ENERGY', ['exports_pct_gdp', 'imports_pct_gdp', 'energy_import_dep', 'fossil_share', 'fuel_export_share', 'electricity_access']],
  ['MILITARY', ['milex', 'milex_pct_gdp', 'armed_forces']],
  ['DEMOGRAPHY', ['fertility', 'dependency_ratio', 'net_migration', 'internet_pct']],
  ['GOVERNANCE · WGI -2.5..+2.5', ['stability', 'govt_effectiveness', 'rule_of_law', 'corruption_control', 'voice_accountability']],
];
const SHORT_LABEL = {
  population: 'Population', gdp: 'GDP', gdp_per_capita: 'GDP per capita', urban_pct: 'Urban',
  gdp_growth: 'GDP growth', imf_gdp_growth_proj: 'IMF growth (proj.)', inflation: 'Inflation', unemployment: 'Unemployment',
  reserves: 'Reserves', external_debt: 'External debt', govt_debt: 'Govt debt % GDP', imf_current_account: 'Current acct % GDP',
  va_agriculture: 'Agriculture', va_industry: 'Industry', va_manufacturing: 'Manufacturing', va_services: 'Services',
  exports_pct_gdp: 'Exports % GDP', imports_pct_gdp: 'Imports % GDP', energy_import_dep: 'Net energy imports',
  fossil_share: 'Fossil share', fuel_export_share: 'Fuel in exports', electricity_access: 'Electricity access',
  milex: 'Military spend', milex_pct_gdp: 'Military % GDP', armed_forces: 'Armed forces',
  events_12m: 'Violent events, 12 mo', events_delta: 'Change', fatalities: 'Reported fatalities',
  fertility: 'Fertility', dependency_ratio: 'Dependency ratio', net_migration: 'Net migration', internet_pct: 'Internet use',
  stability: 'Political stability', govt_effectiveness: 'Govt effectiveness', rule_of_law: 'Rule of law',
  corruption_control: 'Corruption control', voice_accountability: 'Voice & accountability',
};
const confColor = (c) => (c === 'high' ? C.calm : c === 'moderate' ? C.elev : c === 'contested' ? C.crit : C.high);

function DataCell({ field, c }) {
  if (!c) return null;
  const missing = c.v == null;
  return (
    <View style={{ width: '50%', paddingVertical: 5, paddingRight: 8 }}>
      <Text style={[MONO, { color: C.muted, fontSize: 8.5, letterSpacing: 1 }]} numberOfLines={1}>{(SHORT_LABEL[field] || field).toUpperCase()}</Text>
      <Text style={[MONO, { color: missing ? C.muted : C.text, fontSize: 14, marginTop: 1, fontWeight: '700' }]}>{fmtCell(c.v, c.unit)}</Text>
      <Text style={[MONO, { color: C.muted, fontSize: 8 }]} numberOfLines={1}>
        {missing ? 'NO DATA' : c.src + ' · ' + (c.year || '') + (c.note ? ' · PROJECTION' : '')}
      </Text>
    </View>
  );
}

function CountryProfile({ iso, world, hist }) {
  const d = (world.countries || {})[iso] || {};
  const name = (world.names || {})[iso] || iso;
  const tp = (world.trade_partners || {})[iso];
  const lin = ((hist || {}).lineages || {})[iso];
  const cf = (world.conflict || {})[iso];
  return (
    <View style={s.storycard}>
      <Text style={[s.storyH3, SERIF]}>{name}</Text>
      {WORLD_GROUPS.map(([title, fields]) => {
        const present = fields.filter((f) => d[f]);
        if (!present.length) return null;
        return (
          <View key={title}>
            <Text style={[s.ctxlbl, MONO, { marginTop: 8 }]}>{title}</Text>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
              {present.map((f) => <DataCell key={f} field={f} c={d[f]} />)}
            </View>
          </View>
        );
      })}
      {tp ? (
        <>
          <Text style={[s.ctxlbl, MONO, { marginTop: 8 }]}>{'TOP EXPORT PARTNERS · ' + tp.year + ' · TOP-3 SHARE ' + (tp.concentration_top3_pct != null ? tp.concentration_top3_pct + '%' : '—')}</Text>
          {tp.partners.map((p, i) => (
            <View key={i} style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 3 }}>
              <Text style={[MONO, { color: C.text, fontSize: 12.5, flex: 1 }]} numberOfLines={1}>{p.partner}</Text>
              <View style={{ width: 90, height: 5, backgroundColor: C.barBg, borderRadius: 3, marginHorizontal: 8 }}>
                <View style={{ width: Math.min(100, (p.share_pct || 0) * 3) + '%', height: 5, backgroundColor: C.accent, borderRadius: 3 }} />
              </View>
              <Text style={[MONO, { color: C.muted, fontSize: 11, width: 46, textAlign: 'right' }]}>{p.share_pct != null ? p.share_pct.toFixed(1) + '%' : '—'}</Text>
            </View>
          ))}
          <Text style={[MONO, { color: C.muted, fontSize: 8 }]}>{tp.src.toUpperCase() + ' · TOTAL ' + fmtCell(tp.total_usd, 'USD')}</Text>
        </>
      ) : null}
      {cf ? (
        <>
          <Text style={[s.ctxlbl, MONO, { marginTop: 8 }]}>{'CONFLICT INTENSITY · ACLED · AS OF ' + String(cf.as_of || '').toUpperCase()}</Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
            <DataCell field="events_12m" c={{ v: cf.events_12m, unit: 'count', year: 'last 12 complete months', src: 'ACLED' }} />
            <DataCell field="events_delta" c={{ v: cf.events_prev_12m ? Math.round(1000 * (cf.events_12m - cf.events_prev_12m) / cf.events_prev_12m) / 10 : null, unit: '%', year: 'vs prior 12 months', src: 'ACLED' }} />
            {Object.entries(cf.fatalities_by_year || {}).slice(-2).map(([y, n]) => (
              <DataCell key={y} field="fatalities" c={{ v: n, unit: 'count', year: y, src: 'ACLED' }} />
            ))}
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'flex-end', height: 44, gap: 3, marginTop: 4 }}>
            {(cf.monthly || []).map(([m, n], i, arr) => {
              const max = Math.max(1, ...arr.map((x) => x[1]));
              return <View key={m} style={{ flex: 1, height: Math.max(2, Math.round(40 * n / max)), backgroundColor: i === arr.length - 1 ? C.accentDim : C.accent, borderRadius: 2 }} />;
            })}
          </View>
          <Text style={[MONO, { color: C.muted, fontSize: 8 }]}>{'POLITICAL VIOLENCE EVENTS BY MONTH · ' + ((cf.monthly || [])[0] || [''])[0] + ' → ' + (cf.latest_month || '') + ' (LAST BAR PARTIAL)'}</Text>
        </>
      ) : null}
      {lin && lin.chain && lin.chain.length > 1 ? (
        <>
          <Text style={[s.ctxlbl, MONO, { marginTop: 8 }]}>STATE LINEAGE · CONTINUITY IS SHOWN, NOT ASSUMED</Text>
          <Text style={[MONO, { color: C.text, fontSize: 12 }]}>{lin.chain.map((c) => c.name).join('  →  ')}</Text>
          {lin.links.map((l, i) => (
            <Text key={i} style={[s.li, { fontSize: 12 }]}><Text style={{ color: confColor(l.confidence) }}>{'› ' + String(l.confidence).toUpperCase() + ' · '}</Text>{decode(l.discontinuity || '')}</Text>
          ))}
        </>
      ) : null}
    </View>
  );
}

function BaseRateCard({ id, b }) {
  const low = b.flag === 'LOW_N';
  const keys = Object.keys(b.counts || {});
  return (
    <View style={{ marginTop: 6 }}>
      <Text style={[MONO, { color: C.text, fontSize: 12, fontWeight: '700' }]}>{id.replace(/_/g, ' ').toUpperCase() + ' · n=' + b.n + (low ? ' · LOW N' : '')}</Text>
      {keys.map((k) => {
        const pct = b.pct ? b.pct[k] : null;
        return (
          <View key={k} style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 2 }}>
            <Text style={[MONO, { color: C.muted, fontSize: 11, width: 130 }]} numberOfLines={1}>{k.replace(/_/g, ' ')}</Text>
            <View style={{ flex: 1, height: 5, backgroundColor: C.barBg, borderRadius: 3, marginHorizontal: 8 }}>
              <View style={{ width: (pct != null ? pct : (100 * b.counts[k] / b.n)) + '%', height: 5, backgroundColor: low ? C.muted : C.accent, borderRadius: 3 }} />
            </View>
            <Text style={[MONO, { color: low ? C.muted : C.text, fontSize: 11, width: 56, textAlign: 'right' }]}>{low ? b.counts[k] + ' case' + (b.counts[k] === 1 ? '' : 's') : pct + '%'}</Text>
          </View>
        );
      })}
      <Text style={[{ color: C.muted, fontSize: 11.5, marginTop: 2, fontStyle: 'italic' }]}>{low ? 'Too few cases for a percentage: a rough prior only. ' : ''}{decode(b.selection_note || '')}</Text>
    </View>
  );
}

// 2026-09-17 (editor: "the situation room is a fantastic feature, we should expand on that heavy").
// The history engine already writes seven layers per room - the app drew three of them in footnote
// type inside a fold on DATA. Now: the room is a reading page in the article's own style, every layer
// has a door (doctrines, patterns, path dependencies, each side's narrative, the ground, base rates,
// the full timeline), and the room is LIVE - the stories on the wire that belong to it, with the
// desk's call on each, open from inside it. The rooms lead DATA and have a door on HOME.
const SITUATION_WORDS = {
  iran_hormuz: ['iran', 'hormuz', 'tehran', 'irgc', 'gulf', 'strait', 'aramco', 'khamenei'],
  israel_palestine: ['israel', 'gaza', 'west bank', 'hamas', 'idf', 'palestin', 'netanyahu', 'jerusalem'],
  resistance_axis: ['hezbollah', 'houthi', 'ansar', 'yemen', 'marib', 'lebanon', 'iraqi militia', 'resistance axis', 'sanaa'],
  korean_peninsula: ['korea', 'pyongyang', 'kim jong', 'seoul', 'dmz'],
  india_pakistan: ['india', 'pakistan', 'kashmir', 'delhi', 'islamabad', 'line of control'],
  us_israel_iran_policy: ['iran', 'israel', 'white house', 'pentagon', 'centcom'],
};
function roomCards(key, cards) {
  const words = SITUATION_WORDS[key] || [String(key).replace(/_/g, ' ')];
  return briefSorted(cards).filter(({ s: c }) => {
    const t = (String(c.head || '') + ' ' + String(c.h || '') + ' ' + String(c.tag || '') + ' ' + String(c.region || '')).toLowerCase();
    return words.some((w) => t.includes(w));
  }).slice(0, 8);
}
const ROOM_H = { color: C.text, fontSize: 15.5, lineHeight: 22, fontWeight: '700' };
const ROOM_P = { color: C.text, fontSize: 15, lineHeight: 23, marginTop: 6 };
const ROOM_K = [MONO, { color: C.muted, fontSize: 9.5, letterSpacing: 1.1, marginTop: 8 }];
function SituationRoom({ sit, sources, cards, goArticle, quizResult, onQuiz }) {
  const [srcOpen, setSrcOpen] = useState(null);
  const srcLine = (ids) => (ids || []).map((id) => (sources[id] || {}).publisher || id).filter((x, i, a) => a.indexOf(x) === i).join(' · ');
  const byId = {}; (sit.timeline || []).forEach((e) => { byId[e.id] = e; });
  const name = (ref) => { const e = byId[ref]; return e ? String(e.date || '').slice(0, 4) + ' · ' + (e.line || e.name) : String(ref).replace(/^[a-z]+:/, '').replace(/_/g, ' '); };
  const actor = (id) => String(id || '').replace(/^country:/, '').replace(/_/g, ' ');
  const live = roomCards(sit.key, cards || []);
  const doors = useRef({});
  const door = (k) => (el) => { doors.current[k] = el; };
  const layers = [['THE ACTORS', (sit.actors || []).length], ['THE DOCTRINES', (sit.lessons || []).length], ['THE PATTERNS', (sit.tendencies || []).length],
    ['HOW WE GOT HERE', (sit.path_dependencies || []).length], ['THE STORIES EACH SIDE TELLS', (sit.narratives || []).length], ['THE GROUND', (sit.territories || []).length],
    ['BASE RATES', Object.keys(sit.base_rates || {}).length], ['TEST YOURSELF', (sit.quiz || []).length], ['THE FULL TIMELINE', (sit.timeline || []).length]].filter((x) => x[1]);
  const eventRow = (e, i, full) => (
    <Pressable key={e.id || i} onPress={() => setSrcOpen(srcOpen === e.id ? null : e.id)} style={{ flexDirection: 'row', paddingVertical: 7, borderBottomWidth: 1, borderBottomColor: C.line }}>
      <Text style={[MONO, { color: C.accent, fontSize: 11.5, width: 78, paddingTop: 3 }]}>{String(e.date || '').slice(0, 10)}</Text>
      <View style={{ flex: 1 }}>
        <Text style={{ color: C.text, fontSize: 14.5, lineHeight: 21 }}>{decode(e.line || e.name || '')}</Text>
        {full && e.description && srcOpen === e.id ? <Text style={[ROOM_P, { color: C.muted, fontSize: 14 }]}>{decode(e.description)}</Text> : null}
        {srcOpen === e.id ? (
          <Text style={[MONO, { color: C.muted, fontSize: 9.5, marginTop: 4 }]}>
            <Text style={{ color: confColor(e.confidence) }}>{String(e.confidence || '').toUpperCase()}</Text>{' · ' + (srcLine(e.sources) || 'UNVERIFIED')}
          </Text>
        ) : null}
      </View>
    </Pressable>
  );
  return (
    <View style={s.storycard}>
      <Text style={[s.artH, SERIF, T(26, 32)]}>{sit.title}</Text>
      <View style={s.artrule} />
      <Toc items={layers.map(([k]) => ({ label: k, get: () => doors.current[k] }))} />
      <Text style={[s.ctxlbl, MONO]}>WHY THIS HISTORY MATTERS</Text>
      {(sit.why_it_matters || []).map((e, i) => eventRow(e, i, false))}

      {live.length ? (
        <>
          <Text style={[s.ctxlbl, MONO, { marginTop: 18, color: C.high }]}>{'LIVE IN THIS ROOM · ' + live.length + (live.length === 1 ? ' STORY' : ' STORIES')}</Text>
          {live.map(({ s: c, i }, j) => {
            const call = (c.hist || {}).call;
            return (
              <Pressable key={j} onPress={() => goArticle && goArticle(i)} style={{ paddingVertical: 9, borderBottomWidth: 1, borderBottomColor: C.line }}>
                <Text style={ROOM_H}>{articleParts(c).head}</Text>
                {call && call.event ? (
                  <Text style={{ color: C.muted, fontSize: 13, lineHeight: 19, marginTop: 4 }}>
                    <Text style={[MONO, { color: C.accent, fontSize: 10, letterSpacing: 1 }]}>{oddsWord(Number(call.p) || 0).toUpperCase() + '  '}</Text>
                    {decode(call.event)}
                  </Text>
                ) : null}
              </Pressable>
            );
          })}
        </>
      ) : null}

      {(sit.actors || []).length ? (
        <Explainer boxRef={door('THE ACTORS')} label="THE ACTORS" sub={(sit.actors || []).length + ' states and movements in this room'}>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
            {(sit.actors || []).map((a, i) => (
              <View key={i} style={[s.rchip, { marginRight: 0 }]}>
                <Text style={[s.rchipTxt, MONO]}>{decode(a.name || actor(a.id))}{a.from ? '  ' + String(a.from).slice(0, 4) + (a.to ? '–' + String(a.to).slice(0, 4) : '') : ''}</Text>
              </View>
            ))}
          </View>
        </Explainer>
      ) : null}

      {(sit.lessons || []).length ? (
        <Explainer boxRef={door('THE DOCTRINES')} label="THE DOCTRINES" sub="what each capital has committed itself to, on the record">
          {(sit.lessons || []).map((l, i) => (
            <View key={i} style={{ marginTop: i ? 16 : 0 }}>
              <Text style={ROOM_K}>{[(l.actors || []).map(actor).join(', '), String(l.tier || '').replace(/_/g, ' ')].filter(Boolean).join(' · ').toUpperCase()}</Text>
              <Text style={[ROOM_H, { marginTop: 3 }]}>{decode(l.name)}</Text>
              {l.description ? <Text style={ROOM_P}>{decode(l.description)}</Text> : null}
              {(l.evidence || []).length ? <Text style={[MONO, { color: C.muted, fontSize: 10, marginTop: 5 }]}>{'EVIDENCE · ' + (l.evidence || []).map(name).join(' · ')}</Text> : null}
            </View>
          ))}
        </Explainer>
      ) : null}

      {(sit.tendencies || []).length ? (
        <Explainer boxRef={door('THE PATTERNS')} label="THE PATTERNS" sub="how each side has behaved when it mattered, and the cases against">
          {(sit.tendencies || []).map((t, i) => (
            <View key={i} style={{ marginTop: i ? 18 : 0 }}>
              <Text style={ROOM_K}>{[(t.actors || []).map(actor).join(', '), 'CONFIDENCE ' + String(t.confidence || '?')].join(' · ').toUpperCase()}</Text>
              <Text style={[ROOM_H, { marginTop: 3 }]}>{decode(t.name)}</Text>
              <ForAgainst pro={(t.supporting || []).map(name)} con={(t.contradicting || []).map((c) => (String(c).startsWith('case:') || String(c).startsWith('event:') ? name(c) : c))} caveat={t.note} />
            </View>
          ))}
        </Explainer>
      ) : null}

      {(sit.path_dependencies || []).length ? (
        <Explainer boxRef={door('HOW WE GOT HERE')} label="HOW WE GOT HERE" sub="the path dependencies - each arrow is a hypothesis">
          {(sit.path_dependencies || []).map((pd, i) => (
            <View key={i} style={{ marginTop: i ? 18 : 0 }}>
              <Text style={[ROOM_H]}>{decode(pd.name || '')}</Text>
              {(pd.chain || []).map((st, j) => (
                <Text key={j} style={[ROOM_P, { marginTop: j ? 8 : 6 }]}><Text style={[MONO, { color: C.accent, fontWeight: '800' }]}>{(j + 1) + '. '}</Text>{decode(st.step)}</Text>
              ))}
            </View>
          ))}
        </Explainer>
      ) : null}

      {(sit.narratives || []).length ? (
        <Explainer boxRef={door('THE STORIES EACH SIDE TELLS')} label="THE STORIES EACH SIDE TELLS" sub="the history each capital cites, and what it makes of it today">
          {(sit.narratives || []).map((n, i) => (
            <View key={i} style={{ marginTop: i ? 18 : 0 }}>
              <Text style={ROOM_K}>{(n.actors || []).map(actor).join(', ').toUpperCase()}</Text>
              <Text style={[ROOM_H, { marginTop: 3 }]}>{decode(n.name)}</Text>
              {n.historical_event ? <Text style={ROOM_P}><Text style={{ color: C.muted }}>{'The history it cites: '}</Text>{decode(n.historical_event)}</Text> : null}
              {n.modern_interpretation ? <Text style={ROOM_P}><Text style={{ color: C.muted }}>{'How it reads today: '}</Text>{decode(n.modern_interpretation)}</Text> : null}
            </View>
          ))}
        </Explainer>
      ) : null}

      {(sit.territories || []).length ? (
        <Explainer boxRef={door('THE GROUND')} label="THE GROUND" sub="who holds what, who claims what, and since when">
          {(sit.territories || []).map((t, i) => (
            <View key={i} style={{ marginTop: i ? 18 : 0 }}>
              <Text style={ROOM_H}>{decode(t.name)}</Text>
              {t.de_facto_control ? <Text style={ROOM_P}><Text style={{ color: C.muted }}>{'De facto control: '}</Text>{actor(t.de_facto_control)}</Text> : null}
              {(t.current_claims || []).length ? <Text style={ROOM_P}><Text style={{ color: C.muted }}>{'Claims: '}</Text>{(t.current_claims || []).map((c) => actor(c.claimant) + (c.basis ? ' (' + decode(c.basis) + ')' : '')).join('; ')}</Text> : null}
              {t.recognition ? <Text style={ROOM_P}><Text style={{ color: C.muted }}>{'Recognition: '}</Text>{decode(t.recognition)}</Text> : null}
              {(t.historical_control || []).map((h, j) => (
                <Text key={j} style={[ROOM_P, { marginTop: j ? 4 : 8, fontSize: 14 }]}>
                  <Text style={[MONO, { color: C.accent, fontSize: 11 }]}>{String(h.from || '?') + '–' + String(h.to || 'now') + '  '}</Text>
                  {actor(h.controller)}{h.note ? ' — ' + decode(h.note) : ''}
                </Text>
              ))}
            </View>
          ))}
        </Explainer>
      ) : null}

      {Object.keys(sit.base_rates || {}).length ? (
        <Explainer boxRef={door('BASE RATES')} label="BASE RATES" sub="what comparable cases did, with n">
          {Object.entries(sit.base_rates).map(([k, b]) => <BaseRateCard key={k} id={k} b={b} />)}
        </Explainer>
      ) : null}

      {(sit.quiz || []).length ? (
        <Explainer boxRef={door('TEST YOURSELF')} label="TEST YOURSELF" color={C.high}
          sub={(quizResult ? 'your last score ' + quizResult.score + ' / ' + quizResult.total + ' \u00b7 ' : '') + sit.quiz.length + ' questions from this room\'s record'}>
          <Text style={{ color: C.muted, fontSize: 13, lineHeight: 19, marginBottom: 6 }}>
            Built from the dates, doctrines, patterns and control records above. A score here goes on your
            scorecard as knowledge, beside your calls as judgement.
          </Text>
          <QuizSection quiz={sit.quiz} bare onDone={(score, total) => onQuiz && onQuiz(sit.key, score, total)} />
        </Explainer>
      ) : null}
      {(sit.timeline || []).length ? (
        <Explainer boxRef={door('THE FULL TIMELINE')} label="THE FULL TIMELINE" sub={(sit.timeline || []).length + ' dated events, tap one for its source'}>
          {(sit.timeline || []).map((e, i) => eventRow(e, i, true))}
        </Explainer>
      ) : null}
    </View>
  );
}

// The rooms lead DATA: pick a war, read its history, see what is live in it.
function SituationRooms({ hist, cards, goArticle, initial, quizzes, onQuiz }) {
  const sits = (hist && hist.situations) || {};
  const keys = Object.keys(sits);
  const [room, setRoom] = useState(initial || null);
  useEffect(() => { if (initial) setRoom(initial); }, [initial]);
  if (!keys.length) return null;
  const cur = room && sits[room] ? { ...sits[room], key: room } : null;
  return (
    <Section title="Situation rooms" extra={keys.length + ' tracked'}>
      <Text style={{ color: C.muted, fontSize: 13, lineHeight: 19, paddingHorizontal: 16, paddingBottom: 8 }}>
        One room per war: the history that explains today, the doctrines and patterns of each side,
        and the stories on the wire that belong to it. Sourced event by event.
      </Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.rfilter}>
        {keys.map((k) => (
          <Pressable key={k} onPress={() => setRoom(room === k ? null : k)} style={[s.rchip, room === k && s.rchipOn]}>
            <Text style={[s.rchipTxt, MONO, room === k && { color: C.text, fontWeight: '700' }]}>{sits[k].title}</Text>
          </Pressable>
        ))}
      </ScrollView>
      {cur ? <SituationRoom sit={cur} sources={(hist && hist.sources) || {}} cards={cards} goArticle={goArticle} quizResult={(quizzes || {})[room]} onQuiz={onQuiz} /> : (
        <View style={{ paddingHorizontal: 16, paddingBottom: 10 }}>
          {keys.map((k) => {
            const n = roomCards(k, cards || []).length;
            return (
              <Pressable key={k} onPress={() => setRoom(k)} style={{ paddingVertical: 11, borderTopWidth: 1, borderTopColor: C.line }}>
                <Text style={ROOM_H}>{sits[k].title}</Text>
                <Text style={{ color: C.muted, fontSize: 12.5, marginTop: 3 }}>{(sits[k].timeline || []).length + ' events · ' + (sits[k].actors || []).length + ' actors' + (n ? ' · ' + n + ' live ' + (n === 1 ? 'story' : 'stories') : '')}</Text>
              </Pressable>
            );
          })}
        </View>
      )}
    </Section>
  );
}


// ── ARTICLE HOST — one story, opened from ANY tab (headlines, boards, strategy, search), rendered above
// that tab so Back returns to where the reader was. Prev/next walk the whole wire, newest first. ──
function ArticleHost({ data, article, setArticle, scrollTop, easy, deep, read, saved, toggleSave, markRead,
                       tsize, onSize, theme, onTheme, level, onLevel, picks, setPickFor, res }) {
  const rows = briefSorted(data.brief);
  const at = rows.findIndex(({ i }) => i === article);
  if (at < 0) { return <Text style={s.foot}>That story is no longer on the wire.</Text>; }
  const { s: item, i } = rows[at];
  const simple = (easy && data.easy && data.easy.brief) || [];
  const id = storyId(item);
  const open = (j) => { const hit = (data.brief || [])[j]; if (hit) markRead(storyId(hit)); setArticle(j); if (scrollTop) scrollTop(); };
  const back = () => { setArticle(null); if (scrollTop) scrollTop(); };
  return (
    <ArticlePage
      item={item} simpleText={simple[i]} easy={easy} deep={deep} onBack={back} onOpen={open} onBoard={null}
      calls={regionForecasts(data, item.region)}
      specMatches={storySpec(data.speculation, item)}
      chatter={data.chatter}
      isSaved={!!saved[id]} onSave={() => toggleSave(id)}
      pick={(picks || {})[id]} onPick={(v) => setPickFor && setPickFor(id, v)} resolved={resolutionFor(res, id)}
      tsize={tsize} onSize={onSize} theme={theme} onTheme={onTheme} level={level} onLevel={onLevel}
      prev={at > 0 ? rows[at - 1] : null}
      next={at < rows.length - 1 ? rows[at + 1] : null}
    />
  );
}

// ── FOR / AGAINST — the ledger the whole product rests on: evidence on each side, side by side. ──
// 2026-09-16 (editor, reading the analyst panel on a phone: "the pros and cons I don't like the GUI,
// it's too small. Just write them out paragraph form like the other menus"). Two columns on a 390pt
// screen gave each argument about 160pt of width at 13pt type - four words a line, and the desk's
// reasoning arrived as a ransom note. The case for something is prose. One column, full width,
// reading size, each argument its own paragraph, with the side marked by a rule and a label rather
// than by geometry. This is also what lets the desk write two sentences per argument instead of one.
function ForAgainst({ pro, con, caveat }) {
  const side = (label, color, items) => (
    <View style={{ marginTop: 14, borderLeftWidth: 3, borderLeftColor: color, paddingLeft: 12 }}>
      <Text style={[MONO, { color, fontSize: 10, letterSpacing: 1.6, fontWeight: '800' }]}>{label}</Text>
      {(items || []).length ? items.map((t, i) => (
        <Text key={i} style={[s.p, { fontSize: 15.5, lineHeight: 24, marginTop: i ? 10 : 7, marginBottom: 0 }]}>{decode(String(t))}</Text>
      )) : <Text style={{ color: C.muted, fontSize: 13.5, marginTop: 7, fontStyle: 'italic' }}>nothing recorded</Text>}
    </View>
  );
  return (
    <View style={{ marginTop: 6 }}>
      {side('THE CASE FOR IT', C.calm, pro)}
      {side('THE CASE AGAINST IT', C.crit, con)}
      {caveat ? <Text style={{ color: C.muted, fontSize: 13, lineHeight: 19, fontStyle: 'italic', marginTop: 12 }}>{decode(caveat)}</Text> : null}
    </View>
  );
}

// ── THE DESK'S CALL — the analyst's own prediction on a story, with the history that set the prior. ──
// ── WORLD SECTIONS — reference data under STRATEGY: situation rooms, country numbers, physical events. ──
function WorldSections({ world, hist }) {
  const [iso, setIso] = useState(null);
  if (!world && !hist) return null;
  const isos = Object.keys((world && world.countries) || {});
  const names = (world && world.names) || {};
  const quakes = ((world && world.events) || {}).seismic || [];
  const gaps = (world && world.intelligence_gaps) || [];
  return (
    <>
      {isos.length ? (
        <Section title="Country intelligence" extra="primary sources" fold>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.rfilter}>
            {isos.map((k) => (
              <Pressable key={k} onPress={() => setIso(iso === k ? null : k)} style={[s.rchip, iso === k && s.rchipOn]}>
                <Text style={[s.rchipTxt, MONO, iso === k && { color: C.text, fontWeight: '700' }]}>{names[k] || k}</Text>
              </Pressable>
            ))}
          </ScrollView>
          {iso ? <CountryProfile iso={iso} world={world} hist={hist} /> : null}
        </Section>
      ) : null}
      {quakes.length ? (
        <Section title="Seismic, last 7 days" extra="USGS · M5.5+" fold>
          {quakes.slice(0, 5).map((q, i) => (
            <Pressable key={i} onPress={() => q.url && Linking.openURL(q.url)} style={{ flexDirection: 'row', paddingVertical: 4 }}>
              <Text style={[MONO, { color: q.mag >= 7 ? C.crit : q.mag >= 6 ? C.high : C.elev, fontSize: 12, width: 46, fontWeight: '700' }]}>{'M' + (q.mag != null ? q.mag.toFixed(1) : '?')}</Text>
              <Text style={{ color: C.text, fontSize: 12.5, flex: 1 }} numberOfLines={1}>{q.place}</Text>
              <Text style={[MONO, { color: C.muted, fontSize: 10 }]}>{String(q.time || '').slice(5, 10)}</Text>
            </Pressable>
          ))}
        </Section>
      ) : null}
      {gaps.length ? (
        <Text style={[MONO, { color: C.muted, fontSize: 9.5, lineHeight: 14, paddingHorizontal: 4, marginTop: 6 }]}>{'DECLARED GAPS · ' + gaps.map((g) => g.gap).join(' · ')}</Text>
      ) : null}
    </>
  );
}

const SIZES = [['S', 'S', 0.92], ['M', 'M', 1], ['L', 'L', 1.15]];
const TEXT_KEY = 'geo-textsize';
let TSCALE = 1;
const T = (fs, lh) => ({ fontSize: Math.round(fs * TSCALE * 10) / 10, lineHeight: lh ? Math.round(lh * TSCALE) : undefined });
function ModeToggle({ level, onChange, tsize, onSize, theme, onTheme, accent, onAccent }) {
  return (
    <View>
    {onAccent ? (
      <View style={[s.levelbar, { borderBottomWidth: 0, paddingBottom: 0 }]}>
        <Text style={[s.levelLbl, MONO]}>COLOUR</Text>
        <View style={{ flexDirection: 'row', gap: 8, marginLeft: 10 }}>
          {Object.keys(ACCENTS).map((k) => {
            const hex = ACCENTS[k][theme === 'light' ? 'light' : 'dark'][0];
            const on = accent === k;
            return (
              <Pressable key={k} onPress={() => onAccent(k)} hitSlop={6}
                style={{ alignItems: 'center', gap: 4 }}>
                <View style={{ width: 24, height: 24, borderRadius: 12, backgroundColor: hex,
                  borderWidth: on ? 2 : 1, borderColor: on ? C.text : C.line }} />
                <Text style={[MONO, { color: on ? C.text : C.muted, fontSize: 8, letterSpacing: 0.6 }]}>{ACCENTS[k].label}</Text>
              </Pressable>
            );
          })}
        </View>
      </View>
    ) : null}
    <View style={s.levelbar}>
      <Text style={[s.levelLbl, MONO]}>TEXT</Text>
      {onTheme ? (
        <Pressable onPress={() => onTheme(theme === 'light' ? 'dark' : 'light')} hitSlop={8}
          style={{ borderWidth: 1, borderColor: C.line, borderRadius: 5, paddingVertical: 5, paddingHorizontal: 9, marginLeft: 6 }}>
          <Text style={{ color: C.muted, fontSize: 13 }}>{theme === 'light' ? '☾' : '☀'}</Text>
        </Pressable>
      ) : null}
      {onSize ? (
        <View style={[s.modetog, { marginLeft: 8 }]}>
          {SIZES.map(([v, lab], i) => {
            const active = v === tsize;
            return (
              <Pressable key={v} onPress={() => onSize(v)} style={[s.modeBtn, i > 0 && s.modeBtnDiv, active && s.modeBtnActive]}>
                <Text style={[s.modeTxt, MONO, active && { color: C.text, fontWeight: '700' }, { fontSize: 10 + i * 1.5 }]}>{'A'}</Text>
              </Pressable>
            );
          })}
        </View>
      ) : null}
    </View>
    </View>
  );
}

function DisclaimerGate({ onAccept }) {
  return (
    <SafeAreaView style={s.root}>
      <StatusBar style={THEME === 'light' ? 'dark' : 'light'} />
      <ScrollView contentContainerStyle={s.gateScroll}>
        <Text style={[s.wordmark, MONO, { fontSize: 17, marginBottom: 18 }]}>PARALLA<Text style={{ color: C.accent }}>X</Text></Text>
        <Text style={[s.gateH, SERIF]}>Before you begin</Text>
        <Text style={s.gateP}>Parallax publishes geopolitical analysis and probabilistic forecasts as <Text style={{ color: C.text, fontWeight: '700' }}>opinion</Text> — not fact, and not advice.</Text>
        <Text style={s.gateP}>Forecasts are subjective estimates that will often be wrong. Statements about governments, organizations, and public figures are commentary based on public reporting, not assertions of fact.</Text>
        <Text style={s.gateP}>This app is <Text style={{ color: C.text, fontWeight: '700' }}>not</Text> financial, investment, legal, security, safety, or travel advice. Do not rely on it for any decision. Consult a qualified professional.</Text>
        <View style={s.gateLinks}>
          <Pressable onPress={() => Linking.openURL(LEGAL.disclaimer)}><Text style={s.link}>Full Disclaimer</Text></Pressable>
          <Pressable onPress={() => Linking.openURL(LEGAL.terms)}><Text style={s.link}>Terms</Text></Pressable>
          <Pressable onPress={() => Linking.openURL(LEGAL.privacy)}><Text style={s.link}>Privacy</Text></Pressable>
        </View>
        <Pressable onPress={onAccept} style={s.gateBtn}><Text style={[s.gateBtnTxt, MONO]}>I UNDERSTAND</Text></Pressable>
      </ScrollView>
    </SafeAreaView>
  );
}

function LegalFooter() {
  return (
    <View style={s.legalRow}>
      <Pressable onPress={() => Linking.openURL(LEGAL.disclaimer)}><Text style={s.legalLink}>Disclaimer</Text></Pressable>
      <Text style={s.legalDot}>·</Text>
      <Pressable onPress={() => Linking.openURL(LEGAL.terms)}><Text style={s.legalLink}>Terms</Text></Pressable>
      <Text style={s.legalDot}>·</Text>
      <Pressable onPress={() => Linking.openURL(LEGAL.privacy)}><Text style={s.legalLink}>Privacy</Text></Pressable>
    </View>
  );
}

export default function App() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [tab, setTab] = useState('home');   // the front page, not the wire
  const [searching, setSearching] = useState(false);
  const [prefs, setPrefs] = useState(false);   // reading controls, off the page by default
  const [query, setQuery] = useState('');
  const [boardSel, setBoardSel] = useState(null);   // board selection lives here so any tab can point at the map
  // Which story NEWS is showing as an article (null = the index). Lives up here so HOME
  // can hand the reader straight into a story, the way a front-page teaser does.
  const [article, setArticle] = useState(null);
  const scrollRef = useRef(null);
  const scrollBox = useRef(null);    // the frame around the ScrollView, measured in window space for CONTENTS jumps
  const scrollY = useRef(0);
  const scrollTop = () => { if (scrollRef.current) scrollRef.current.scrollTo({ y: 0, animated: false }); };
  const jumpTo = useCallback((node) => {
    const sv = scrollRef.current, box = scrollBox.current;
    if (!node || !sv || !box || !node.measureInWindow) return;
    node.measureInWindow((x, y) => {
      box.measureInWindow((bx, by) => { sv.scrollTo({ y: Math.max(0, scrollY.current + (y - by) - 10), animated: true }); });
    });
  }, []);
  const scrollCtx = useMemo(() => ({ jumpTo }), [jumpTo]);
  const goArticle = (i) => {
    const hit = data && (data.brief || [])[i];
    if (hit) markRead(storyId(hit));
    setArticle(i); scrollTop();   // 2026-09-15: stays on the current tab; ArticleHost renders above it, Back returns here
  };
  // 2026-09-17: every tap handler calls scrollTop() BEFORE the new content commits, and on iOS (new
  // architecture) the ScrollView keeps the index's offset when its children swap - a long front page
  // opened a story at the BOTTOM. So scroll again AFTER the commit, and once more on the next frame
  // when the story's height is known. Fires on article, tab and search changes alike.
  useEffect(() => {
    scrollTop();
    const t = requestAnimationFrame(scrollTop);
    return () => cancelAnimationFrame(t);
  }, [article, tab, searching]);
  // What you've opened and what you've kept. Both are per-device and never leave it.
  const [read, setRead] = useState({});
  const [saved, setSaved] = useState({});
  const markRead = useCallback((id) => setRead((r) => {
    if (r[id]) return r;
    const next = prune({ ...r, [id]: 1 }, 300);
    AsyncStorage.setItem(READ_KEY, JSON.stringify(next)).catch(() => {});
    return next;
  }), []);
  // YOUR CALL: the reader's scenario picks, per device, and the desk's resolutions from the feed
  const [picks, setPicks] = useState({});
  const [res, setRes] = useState(null);
  useEffect(() => {
    AsyncStorage.getItem(PICKS_KEY).then((v) => { try { if (v) setPicks(JSON.parse(v)); } catch (e) {} }).catch(() => {});
    AsyncStorage.getItem(RES_CACHE_KEY).then((v) => { try { if (v) setRes((cur) => cur || JSON.parse(v)); } catch (e) {} }).catch(() => {});
    fetch(RESOLUTIONS_URL, { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).then((j) => {
      if (j) { setRes(j); AsyncStorage.setItem(RES_CACHE_KEY, JSON.stringify(j)).catch(() => {}); }
    }).catch(() => {});
  }, []);
  const QUIZ_KEY = 'geo-quiz-v1';
  const [quizzes, setQuizzes] = useState({});
  useEffect(() => { AsyncStorage.getItem(QUIZ_KEY).then((v) => { try { if (v) setQuizzes(JSON.parse(v)); } catch (e) {} }).catch(() => {}); }, []);
  const onQuiz = useCallback((room, score, total) => setQuizzes((cur) => {
    const next = { ...cur, [room]: { score, total, ts: new Date().toISOString().slice(0, 10) } };
    AsyncStorage.setItem(QUIZ_KEY, JSON.stringify(next)).catch(() => {});
    return next;
  }), []);
  const setPickFor = useCallback((id, v) => setPicks((cur) => {
    const next = { ...cur };
    if (v) next[id] = v; else delete next[id];
    AsyncStorage.setItem(PICKS_KEY, JSON.stringify(prune(next, 300))).catch(() => {});
    return next;
  }), []);
  const toggleSave = useCallback((id) => setSaved((sv) => {
    const next = { ...sv };
    if (next[id]) delete next[id]; else next[id] = 1;
    AsyncStorage.setItem(SAVED_KEY, JSON.stringify(prune(next, 200))).catch(() => {});
    return next;
  }), []);
  const [refreshing, setRefreshing] = useState(false);
  const [acked, setAcked] = useState(null);
  const [level, setLevel] = useState('regular');
  const [tsize, setTsize] = useState('M');
  const [theme, setThemeState] = useState(THEME);
  const [accent, setAccentState] = useState(ACCENT);
  useEffect(() => {
    AsyncStorage.multiGet([THEME_KEY, ACCENT_KEY]).then(([t, a]) => {
      const nt = t[1] && THEMES[t[1]] ? t[1] : null, na = a[1] && ACCENTS[a[1]] ? a[1] : null;
      if (nt || na) { applyTheme(nt || THEME, na || ACCENT); if (nt) setThemeState(nt); if (na) setAccentState(na); }
    }).catch(() => {});
  }, []);
  const setAccent = useCallback((v) => { applyTheme(THEME, v); setAccentState(v); AsyncStorage.setItem(ACCENT_KEY, v).catch(() => {}); }, []);
  const setTheme = useCallback((v) => { applyTheme(v, ACCENT); setThemeState(v); AsyncStorage.setItem(THEME_KEY, v).catch(() => {}); }, []);
  useEffect(() => { AsyncStorage.getItem(TEXT_KEY).then((v) => { if (SIZES.some(([k]) => k === v)) { TSCALE = SIZES.find(([k]) => k === v)[2]; setTsize(v); } }).catch(() => {}); }, []);
  const setSize = useCallback((v) => { TSCALE = SIZES.find(([k]) => k === v)[2]; setTsize(v); AsyncStorage.setItem(TEXT_KEY, v).catch(() => {}); }, []);
  const easy = level === 'simple', deep = level === 'deep';

  useEffect(() => {
    AsyncStorage.getItem(ACK_KEY).then((v) => setAcked(v === '1')).catch(() => setAcked(false));
    AsyncStorage.multiGet([READ_KEY, SAVED_KEY]).then(([r, sv]) => {
      try { if (r[1]) setRead(JSON.parse(r[1])); } catch (e) {}
      try { if (sv[1]) setSaved(JSON.parse(sv[1])); } catch (e) {}
    }).catch(() => {});
    AsyncStorage.getItem(MODE_KEY).then((v) => {
      if (v && v !== 'regular') AsyncStorage.setItem(MODE_KEY, 'regular').catch(() => {});   // 2026-09-14: one level only
    }).catch(() => {});
  }, []);
  const accept = useCallback(() => { AsyncStorage.setItem(ACK_KEY, '1').catch(() => {}); setAcked(true); }, []);
  const setMode = useCallback((v) => { setLevel(v); AsyncStorage.setItem(MODE_KEY, v).catch(() => {}); }, []);

  const lastPull = useRef(0);
  const load = useCallback(async () => {
    try {
      const r = await fetch(`${FEED}?t=${Date.now()}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = wireOf(await r.json());
      setData(j); setErr(null); lastPull.current = Date.now();
      AsyncStorage.setItem(FEED_CACHE_KEY, JSON.stringify(j)).catch(() => {});
    } catch (e) { setErr(String(e.message || e)); }
  }, []);
  // open on the cached feed (no spinner, works offline), then pull the live one
  useEffect(() => {
    AsyncStorage.getItem(FEED_CACHE_KEY).then((v) => {
      try { if (v) setData((cur) => cur || wireOf(JSON.parse(v))); } catch (e) {}
    }).catch(() => {}).finally(load);
  }, [load]);
  // the desk refreshes the wire several times a day: re-pull when the app comes back to the foreground
  useEffect(() => {
    const sub = AppState.addEventListener('change', (st) => {
      if (st === 'active' && Date.now() - lastPull.current > STALE_MS) load();
    });
    return () => sub.remove();
  }, [load]);
  // WORLD tab data: two more files beside data.json, pulled the first time the tab opens (and on
  // pull-to-refresh while it is open). Each falls back to its last cached copy, like the main feed.
  const [world, setWorld] = useState(null);
  const [hist, setHist] = useState(null);
  const [worldErr, setWorldErr] = useState(null);
  const loadWorld = useCallback(async () => {
    const pull = async (url, key, set) => {
      try {
        const r = await fetch(`${url}?t=${Date.now()}`);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j = await r.json();
        set(j); AsyncStorage.setItem(key, JSON.stringify(j)).catch(() => {});
        return null;
      } catch (e) {
        try { const v = await AsyncStorage.getItem(key); if (v) set((cur) => cur || JSON.parse(v)); } catch (e2) {}
        return String(e.message || e);
      }
    };
    const errs = await Promise.all([pull(WORLD_URL, WORLD_CACHE_KEY, setWorld), pull(HISTORY_URL, HISTORY_CACHE_KEY, setHist)]);
    setWorldErr(errs.find(Boolean) || null);
  }, []);
  useEffect(() => { if (tab === 'data' && !world && !hist) loadWorld(); }, [tab, world, hist, loadWorld]);
  // older stories: the 30-day archive, pulled only when the reader asks for it at the foot of the wire
  const [older, setOlder] = useState('idle');   // idle | loading | done | error
  const loadOlder = useCallback(async () => {
    setOlder('loading');
    try {
      const r = await fetch(`${STORIES_URL}?t=${Date.now()}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const arr = await r.json();
      setData((cur) => mergeWire(cur, arr));
      setOlder('done');
    } catch (e) { setOlder('error'); }
  }, []);
  const onRefresh = useCallback(async () => { setRefreshing(true); await load(); if (tab === 'data') await loadWorld(); setRefreshing(false); }, [load, loadWorld, tab]);

  if (acked === null) {
    return <SafeAreaProvider><SafeAreaView style={s.root}><View style={s.center}><ActivityIndicator color={C.accent} /></View></SafeAreaView></SafeAreaProvider>;
  }
  if (!acked) return <SafeAreaProvider><DisclaimerGate onAccept={accept} /></SafeAreaProvider>;

  const rc = data ? (riskColor[data.risk.color] || C.elev) : C.elev;
  return (
    <SafeAreaProvider>
      <SafeAreaView style={s.root} edges={['top']}>
        <StatusBar style={THEME === 'light' ? 'dark' : 'light'} />
        {/* 2026-09-16 (user): the reading controls came off the page and live behind this button -
            he did not want a settings bar sitting in the middle of the home screen. The dot is the
            board's risk colour, which is where the old HIGH banner's information went. */}
        <View style={s.header}>
          <View style={{ width: 9, height: 9, borderRadius: 5, backgroundColor: rc, shadowColor: rc, shadowOpacity: 0.9, shadowRadius: 6 }} />
          <Text style={[s.wordmark, MONO]}>PARALLA<Text style={{ color: C.accent }}>X</Text></Text>
          <Text style={[s.stamp, MONO]}>{data ? data.updated : ''}</Text>
          <Pressable onPress={() => setPrefs((v) => !v)} hitSlop={10} style={s.prefsBtn}>
            <Text style={[MONO, { color: prefs ? C.accent : C.muted, fontSize: 13 }]}>{'A' + (theme === 'light' ? '\u263e' : '\u2600')}</Text>
          </Pressable>
        </View>
        {prefs ? <ModeToggle level={level} onChange={setMode} tsize={tsize} onSize={setSize} theme={theme} onTheme={setTheme} accent={accent} onAccent={setAccent} /> : null}
        {!data && !err && <View style={s.center}><ActivityIndicator color={C.accent} size="large" /></View>}
        {!data && err && (
          <View style={s.center}>
            <Text style={s.p}>Couldn't reach the feed ({err}).</Text>
            <Pressable onPress={load} style={s.retry}><Text style={[s.retryTxt, MONO]}>RETRY</Text></Pressable>
          </View>
        )}
        {data && err ? (
          <Pressable onPress={load} style={{ backgroundColor: C.panel2, borderBottomWidth: 1, borderBottomColor: C.line, paddingVertical: 4, alignItems: 'center' }}>
            <Text style={[MONO, { color: C.elev, fontSize: 9, letterSpacing: 1 }]}>{'OFFLINE · SHOWING LAST SAVED BRIEF · TAP TO RETRY'}</Text>
          </Pressable>
        ) : null}
        {data && (
          <ScrollCtx.Provider value={scrollCtx}><View ref={scrollBox} style={{ flex: 1 }}>
          <ScrollView ref={scrollRef} contentContainerStyle={s.scroll} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag"
            onScroll={(e) => { scrollY.current = e.nativeEvent.contentOffset.y; }} scrollEventThrottle={16} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={C.accent} />}>
            {article != null ? (
              <ArticleHost data={data} article={article} setArticle={setArticle} scrollTop={scrollTop} easy={easy} deep={deep}
                read={read} saved={saved} toggleSave={toggleSave} markRead={markRead} picks={picks} setPickFor={setPickFor} res={res}
                tsize={tsize} onSize={setSize} theme={theme} onTheme={setTheme} level={level} onLevel={setMode} />
            ) : searching ? (
              <SearchScreen data={data} query={query} setQuery={setQuery}
                goArticle={(i) => { Keyboard.dismiss(); setSearching(false); goArticle(i); }} goTab={(k) => { Keyboard.dismiss(); setSearching(false); setTab(k); scrollTop(); }} />
            ) : (
              <>
                {tab === 'home' && <TocHost><FrontPage data={data} goTab={(k) => { setTab(k); scrollTop(); }} goArticle={goArticle} read={read} hist={hist} /></TocHost>}
                {tab === 'news' && <NewsTab data={data} easy={easy} deep={deep} goTab={setTab} goBoard={null} article={article} setArticle={setArticle} scrollTop={scrollTop} read={read} saved={saved} markRead={markRead} toggleSave={toggleSave} tsize={tsize} onSize={setSize} theme={theme} onTheme={setTheme} level={level} onLevel={setMode} older={older} loadOlder={loadOlder} picks={picks} setPickFor={setPickFor} res={res} />}
                {tab === 'boards' && <TocHost color={C.high}><BoardsTab data={data} goArticle={goArticle} /></TocHost>}
                {tab === 'calls' && <TocHost><CallsTab data={data} easy={easy} deep={deep} goArticle={goArticle} read={read} saved={saved} picks={picks} res={res} quizzes={quizzes} hist={hist} /></TocHost>}
                {tab === 'data' && <TocHost><DataTab data={data} easy={easy} world={world} hist={hist} goArticle={goArticle} quizzes={quizzes} onQuiz={onQuiz} /></TocHost>}
              </>
            )}
            <LegalFooter />
          </ScrollView>
          </View></ScrollCtx.Provider>
        )}
        <SafeAreaView edges={['bottom']} style={s.navWrap}>
          <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingTop: 8, paddingBottom: 8 }}>
            <View style={[s.modetog, { flex: 1, borderRadius: 14 }]}>
              {TABS.map((t, i) => {
                const on = tab === t.key && !searching;
                return (
                  <Pressable key={t.key} onPress={() => { setSearching(false); setTab(t.key); setArticle(null); scrollTop(); }}
                    style={[s.modeBtn, i > 0 && s.modeBtnDiv, on && s.modeBtnActive]}>
                    <Text style={{ fontSize: 18, color: on ? C.accent : C.muted, lineHeight: 20 }}>{t.g}</Text>
                    <Text style={[s.modeTxt, { fontSize: 10, letterSpacing: 0.4, marginTop: 2 }, on && { color: C.text, fontWeight: '700' }]} numberOfLines={1}>{t.label}</Text>
                  </Pressable>
                );
              })}
            </View>
            <View style={{ width: 14 }} />
            <Pressable hitSlop={12} onPress={() => { setSearching((v) => !v); scrollTop(); }}>
              <Svg width="22" height="22" viewBox="0 0 24 24">
                <Circle cx="11" cy="11" r="7" stroke={searching ? C.accent : C.text} strokeWidth="2" fill="none" />
                <SvgPath d="M20 20l-3.5-3.5" stroke={searching ? C.accent : C.text} strokeWidth="2" strokeLinecap="round" />
              </Svg>
            </Pressable>
          </View>
        </SafeAreaView>
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

function buildStyles() {
  return StyleSheet.create({
  root: { flex: 1, backgroundColor: C.ink },
  header: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 18, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: C.line },
  wordmark: { color: C.text, fontWeight: '800', letterSpacing: 2.5, fontSize: 15 },
  stamp: { color: C.muted, fontSize: 11, letterSpacing: 0.5, marginLeft: 'auto' },
  levelbar: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 16, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: C.line, backgroundColor: C.panel },
  levelLbl: { color: C.muted, fontSize: 10, letterSpacing: 1.5 },
  modetog: { flex: 1, flexDirection: 'row', borderWidth: 1, borderColor: C.line, borderRadius: 10, overflow: 'hidden' },
  modeBtn: { flex: 1, paddingVertical: 7, alignItems: 'center' },
  modeBtnDiv: { borderLeftWidth: 1, borderLeftColor: C.line },
  modeBtnActive: { backgroundColor: C.chip },
  modeTxt: { color: C.muted, fontSize: 11, letterSpacing: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 14 },
  retry: { borderWidth: 1, borderColor: C.accent, borderRadius: 4, paddingVertical: 8, paddingHorizontal: 22 },
  retryTxt: { color: C.accent, letterSpacing: 2, fontSize: 13 },
  scroll: { paddingHorizontal: 18, paddingTop: 16, paddingBottom: 24, gap: 24 },
  stack: { gap: 24 },
  section: { backgroundColor: C.panel, borderWidth: 1, borderColor: C.line, borderRadius: 14, overflow: 'hidden' },
  h2row: { flexDirection: 'row', alignItems: 'baseline', gap: 12, paddingHorizontal: 16, paddingTop: 16, paddingBottom: 10 },
  h2: { color: C.text, fontSize: 20, fontWeight: '800', letterSpacing: -0.3 },
  h2rule: { flex: 1 },
  h2extra: { color: C.accent, fontSize: 13, fontWeight: '600' },
  // gauge
  // plain lead
  // brief / story
  // ── FRONT PAGE ──────────────────────────────────────────────────────────────
  // A newspaper's grid is made of type weight and hairlines, not boxes. The index
  // rows have no card chrome at all: a rule separates them, and size says rank.
  dayrule: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 22, marginBottom: 4 },
  daytxt: { color: C.muted, fontSize: 12, fontWeight: '700', letterSpacing: 1.2 },
  dayline: { flex: 1, height: 1, backgroundColor: C.line },
  kick: { color: C.accent, fontSize: 12, fontWeight: '700', letterSpacing: 1.2, flex: 1 },
  idxmeta: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 7 },
  idxtime: { color: C.muted, fontSize: 12 },
  // the lead is the only story on the page that gets a panel — that IS its emphasis
  leadH: { color: C.text, fontSize: 30, lineHeight: 35, fontWeight: '700' },
  leadDek: { color: C.muted, fontFamily: 'Charter', fontSize: 17, lineHeight: 25, marginTop: 12 },
  readmore: { color: C.accent, fontSize: 13, fontWeight: '700' },
  idxrow: { borderTopWidth: 1, borderTopColor: C.line, paddingTop: 20, paddingBottom: 8, paddingHorizontal: 2 },
  idxH: { color: C.text, fontSize: 22, lineHeight: 28, fontWeight: '700' },
  readH: { color: C.muted, fontWeight: '600' },
  conspWarn: { color: C.high, fontSize: 10.5, letterSpacing: 1.5, fontWeight: '700', marginBottom: 8 },
  conspTier: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 16, marginBottom: 10 },
  conspTierTxt: { color: C.high, fontSize: 10.5, letterSpacing: 1.8, fontWeight: '700' },
  conspIntro: { color: C.muted, fontFamily: 'Charter', fontSize: 15.5, lineHeight: 23, marginBottom: 16 },
  consp: {},
  artbar: { flexDirection: 'row', alignItems: 'center', paddingVertical: 2 },
  // ── ARTICLE ──
  backtxt: { color: C.accent, fontSize: 14, fontWeight: '600' },
  article: { paddingHorizontal: 6, paddingTop: 8, paddingBottom: 12 },   // flat: the page IS the panel
  readtime: { color: C.muted, fontSize: 12, fontWeight: '600', letterSpacing: 0.8 },
  artbtn: { flex: 1, minWidth: 0, borderWidth: 1.5, borderColor: C.accentDim, borderRadius: 10, paddingVertical: 10, paddingHorizontal: 6, backgroundColor: C.panel },
  artbtnOn: { backgroundColor: C.chip },
  sumdoor: { marginTop: 14, borderWidth: 1, borderColor: C.accentDim, borderRadius: 10, paddingVertical: 11, paddingHorizontal: 14 },
  sharebtn: { marginTop: 14, borderWidth: 1, borderColor: C.accentDim, borderRadius: 10, paddingVertical: 11, paddingHorizontal: 14, alignItems: 'center' },
  artbtnT: { color: C.accent, fontSize: 10.5, fontWeight: '800', letterSpacing: 0.3 },   // one word per door, one line, never broken (2026-09-17: CONSPIRACY clipped at 0.9 spacing on a 375pt phone)
  artbtnS: { color: C.muted, fontSize: 10, marginTop: 4, lineHeight: 13.5 },
  hrow: { paddingVertical: 18, paddingHorizontal: 4, borderBottomWidth: 1, borderBottomColor: C.line },
  hrowH: { fontFamily: 'Charter', fontSize: 24, lineHeight: 29, fontWeight: '600', color: C.text, letterSpacing: -0.3 },
  hrowMeta: { color: C.accent, fontSize: 12, fontWeight: '700', letterSpacing: 1.2, marginTop: 8 },
  searchbox: { flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: C.panel, borderWidth: 1.5, borderColor: C.text, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 4 },
  searchin: { flex: 1, fontSize: 17, paddingVertical: 10 },
  searchH: { color: C.muted, fontSize: 12, fontWeight: '700', letterSpacing: 1.2, marginTop: 22, marginBottom: 2 },
  srcchip: { borderWidth: 1, borderColor: C.line, backgroundColor: C.panel, borderRadius: 999, paddingVertical: 8, paddingHorizontal: 13 },
  verdict: { alignSelf: 'flex-start', borderWidth: 1.5, borderRadius: 10, paddingVertical: 8, paddingHorizontal: 14, marginBottom: 14 },
  ctxbtnWide: { alignSelf: 'stretch', flexDirection: 'row', alignItems: 'center', paddingVertical: 12, paddingHorizontal: 16 },
  artH: { color: C.text, fontSize: 32, lineHeight: 38, fontWeight: '700' },
  artHLong: { color: C.text, fontSize: 26, lineHeight: 32, fontWeight: '700' },
  artStand: { color: C.muted, fontFamily: 'Charter', fontStyle: 'italic', fontSize: 19, lineHeight: 27, marginTop: 14 },
  artrule: { height: 2, backgroundColor: C.accent, width: 56, marginTop: 18, marginBottom: 12 },   // a short accent rule, newspaper-style
  nextrow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 16, borderBottomWidth: 1, borderBottomColor: C.line },
  nextH: { color: C.text, fontSize: 18, lineHeight: 24, fontWeight: '700', marginTop: 1 },
  storycard: { position: 'relative', backgroundColor: C.panel, borderWidth: 1, borderColor: C.line, borderRadius: 5, paddingTop: 22, paddingBottom: 20, paddingLeft: 26, paddingRight: 22 },
  ktag: { fontSize: 9.5, fontWeight: '700', letterSpacing: 1.8, color: C.muted, marginBottom: 11 },
  cardmeta: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 11 },
  stime: { fontSize: 13, color: C.muted, letterSpacing: 0.6 },
  rfilter: { flexDirection: 'row', gap: 7, paddingHorizontal: 4, paddingVertical: 4 },
  rchip: { backgroundColor: C.panel, borderWidth: 1, borderColor: C.line, borderRadius: 999, paddingVertical: 8, paddingHorizontal: 14 },
  rchipOn: { backgroundColor: C.accentDim, borderColor: C.accentDim },
  rchipTxt: { fontSize: 13, fontWeight: '600', color: C.muted },
  storyH3: { fontSize: 22, lineHeight: 27, fontWeight: '700', color: C.text, marginBottom: 12 },
  storyP: { fontFamily: 'Charter', fontSize: 19, lineHeight: 30, color: C.text },
  ctxbtn: { marginTop: 16, alignSelf: 'flex-start', borderWidth: 1, borderColor: C.accentDim, borderRadius: 10, paddingVertical: 10, paddingHorizontal: 14 },
  ctxbtnTxt: { color: C.accent, fontSize: 13, fontWeight: '600', letterSpacing: 1.4 },
  ctxpanel: { marginTop: 14, padding: 18, backgroundColor: C.panel, borderWidth: 1, borderColor: C.line, borderLeftWidth: 3, borderLeftColor: C.accent, borderRadius: 12 },
  ctxlbl: { fontSize: 12, fontWeight: '700', letterSpacing: 1.2, color: C.muted, marginBottom: 10 },
  ctxP: { fontFamily: 'Charter', fontSize: 18, lineHeight: 28, color: C.text },
  li: { color: C.text, fontFamily: 'Charter', fontSize: 17, lineHeight: 25, paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: C.line },
  foot: { color: C.muted, fontSize: 12.5, lineHeight: 18, paddingHorizontal: 6 },
  // tab intro
  // calibration
  cal: { padding: 16 },
  calbig: { flexDirection: 'row', alignItems: 'baseline', gap: 12 },
  calnum: { fontSize: 34, fontWeight: '800', color: C.accent },
  callab: { fontSize: 9.5, letterSpacing: 1.4, color: C.muted },
  calsay: { fontFamily: 'Charter', fontSize: 15.5, color: C.muted, lineHeight: 23, marginTop: 10, marginBottom: 12 },
  calstrip: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  caldot: { width: 11, height: 11, borderRadius: 6 },
  caldotHit: { backgroundColor: C.calm },
  caldotMiss: { backgroundColor: C.crit },
  caldotPend: { borderWidth: 1.5, borderColor: C.accentDim },
  // hypotheses
  hyp: { flexDirection: 'row', gap: 12, paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: C.line },
  hypP: { color: C.accent, fontWeight: '700', minWidth: 48, fontSize: 17 },
  hypName: { color: C.text, fontWeight: '600', fontSize: 15.5 },
  hypD: { color: C.muted, fontFamily: 'Charter', fontSize: 15.5, marginTop: 4, lineHeight: 22 },
  // predictions
  pred: { paddingHorizontal: 16, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: C.line },
  predtop: { flexDirection: 'row', alignItems: 'baseline', gap: 10 },
  predq: { flex: 1, fontSize: 16.5, fontWeight: '600', color: C.text, lineHeight: 22 },
  predp: { fontSize: 21, fontWeight: '800', color: C.accent },
  predpS: { fontSize: 12, fontWeight: '400', color: C.muted },
  predmeta: { flexDirection: 'row', gap: 10, alignItems: 'center', marginTop: 4 },
  chip: { backgroundColor: C.chip, borderRadius: 3, paddingHorizontal: 7, paddingVertical: 1, fontSize: 11 },
  predmetaTxt: { color: C.muted, fontSize: 11 },
  prednote: { color: C.muted, fontFamily: 'Charter', fontSize: 15.5, marginTop: 8, lineHeight: 22 },
  bar: { height: 5, borderRadius: 3, backgroundColor: C.barBg, marginTop: 11, marginBottom: 8 },
  fill: { position: 'absolute', left: 0, top: 0, bottom: 0, borderRadius: 3, backgroundColor: C.accent },
  tick: { position: 'absolute', top: -3, width: 2, height: 11, backgroundColor: C.muted },
  // actors
  clockRow: { flexDirection: 'row', gap: 12, paddingHorizontal: 16, paddingVertical: 13, borderTopWidth: 1, borderTopColor: C.line },
  actor: { paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: C.line },
  actorName: { color: C.text, fontSize: 19, letterSpacing: -0.2, fontWeight: '700' },
  actorRole: { color: C.accent, fontSize: 12, fontWeight: '700', letterSpacing: 0.8, marginTop: 2, marginBottom: 6 },
  actorRow: { color: C.text, fontFamily: 'Charter', fontSize: 16, lineHeight: 23, marginVertical: 3 },
  actorK: { color: C.muted, fontWeight: '600' },
  // prose
  p: { color: C.text, fontFamily: 'Charter', fontSize: 17.5, lineHeight: 27, marginVertical: 6 },
  // gate
  gateScroll: { padding: 26, paddingTop: 60, flexGrow: 1, justifyContent: 'center' },
  gateH: { color: C.text, fontSize: 22, fontWeight: '700', marginBottom: 14 },
  gateP: { color: C.muted, fontSize: 14.5, lineHeight: 22, marginBottom: 12 },
  gateLinks: { flexDirection: 'row', gap: 16, marginTop: 8, marginBottom: 26 },
  link: { color: C.accent, fontSize: 13.5, textDecorationLine: 'underline' },
  gateBtn: { backgroundColor: C.accent, borderRadius: 6, paddingVertical: 15, alignItems: 'center' },
  gateBtnTxt: { color: C.ink, fontWeight: '800', letterSpacing: 2, fontSize: 14 },
  legalRow: { flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 8, paddingVertical: 16 },
  legalLink: { color: C.muted, fontSize: 12, textDecorationLine: 'underline' },
  legalDot: { color: C.line },
  // nav
  navWrap: { backgroundColor: C.panel, borderTopWidth: 1, borderTopColor: C.line },
  prefsBtn: { borderWidth: 1, borderColor: C.line, borderRadius: 6, paddingVertical: 4, paddingHorizontal: 9, marginLeft: 10 },
  fpCall: { borderWidth: 1, borderRadius: 10, padding: 15, backgroundColor: C.panel },
  fpBoards: { borderWidth: 1, borderColor: C.line, borderRadius: 10, padding: 15, backgroundColor: C.panel },
  fpLesson: { borderTopWidth: 1, borderTopColor: C.line, paddingTop: 14 },
  fpTile: { width: '48.5%', backgroundColor: C.panel, borderWidth: 1, borderColor: C.line, borderRadius: 8, padding: 12, marginBottom: 10 },
});
}
let s = buildStyles();
