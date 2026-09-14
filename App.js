import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator, AppState, Linking, Pressable, RefreshControl, ScrollView,
  Share, StyleSheet, Text, TextInput, View,
} from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Svg, { Circle, Line, Path as SvgPath, Rect } from 'react-native-svg';
import { LAND_PATH } from './worldmap';

const FEED = 'https://raw.githubusercontent.com/manwhatopps/geo-terminal-feed/main/data.json';
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
// Black + gold intelligence-agency (per user's reference mockup): near-black field,
// dark cards, gold as THE accent. Severity stays amber->orange->red.
// Two palettes, one key set. LIGHT is the default: dark-on-light (positive polarity) reads faster and more
// accurately for normal vision at every size (Piepenbrock et al.; NN/g), and the effect grows as type gets
// smaller. Newsprint, not white: a warm off-white ground, near-black ink, gold darkened until it clears 4.5:1
// on white. DARK is the original black+gold agency look, kept behind a toggle for night reading.
const THEMES = {
  light: {
    ink: '#F6F4EE', panel: '#FFFFFF', panel2: '#F0EDE5', line: '#DDD8CC',
    text: '#17171A', muted: '#63626B', accent: '#8A6300', accentDim: '#C9A64A',
    calm: '#2E7D5B', elev: '#B07316', high: '#C24D1E', crit: '#B42323',
    barBg: '#E9E5DB', chip: '#ECE8DE',
  },
  dark: {
    ink: '#09090B', panel: '#141317', panel2: '#0E0D10', line: '#2E2A20',
    text: '#EDE7D8', muted: '#8D8574', accent: '#D4AF37', accentDim: '#8A7222',
    calm: '#4C9A70', elev: '#D99A2B', high: '#E1662E', crit: '#D93B3B',
    barBg: '#0E0D10', chip: '#221F18',
  },
};
const THEME_KEY = 'geo-theme';
let THEME = 'light';
let C = THEMES[THEME];
let riskColor = { calm: C.calm, elev: C.elev, high: C.high, crit: C.crit };
// Every component reads C and s at render time, so a theme change is: swap the palette, rebuild the
// stylesheet, re-render from the root. (buildStyles is defined with the styles at the bottom of the file.)
function applyTheme(name) {
  THEME = THEMES[name] ? name : 'light';
  C = THEMES[THEME];
  riskColor = { calm: C.calm, elev: C.elev, high: C.high, crit: C.crit };
  s = buildStyles();
  GRADE_META = mkGradeMeta();
  VERDICT_META = mkVerdictMeta();
}
const RISK_LEVELS = ['calm', 'elev', 'high', 'crit'];
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
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
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
function timeLabel(ts) {
  if (!ts) return '';
  const t = Date.parse(ts); if (isNaN(t)) return '';
  const d = new Date(t), now = new Date();
  const mins = Math.round((now - d) / 60000);
  if (mins >= 0 && mins < 60) return mins <= 1 ? 'just now' : mins + 'm ago';
  if (mins >= 60 && mins < 1440 && d.toDateString() === now.toDateString())
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
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
const TABS = [
  { key: 'news', label: 'Stories' },
  { key: 'boards', label: 'Boards' },
  { key: 'conspiracy', label: 'Calls' },
];

function Section({ title, extra, children }) {
  return (
    <View style={s.section}>
      <View style={s.h2row}>
        <Text style={s.h2}>{title}</Text>
        <View style={s.h2rule} />
        {extra ? <Text style={[s.h2extra, MONO]}>{extra}</Text> : null}
      </View>
      {children}
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

function PlainLead({ text }) {
  if (!text) return null;
  return (
    <View style={s.plainLead}>
      <Text style={[s.plainLbl, MONO]}>IN PLAIN ENGLISH</Text>
      <Text style={s.plainP}>{decode(text)}</Text>
    </View>
  );
}

// The WHY behind the posture is a drop-down, not a wall of text on the front door —
// the gauge answers "how bad", the reader chooses whether to ask "why".
function WhyPosture({ text, deep }) {
  const [open, setOpen] = useState(deep);
  useEffect(() => { setOpen(deep); }, [deep]);   // keep expansion in sync with the level toggle
  if (!text) return null;
  return (
    <View>
      <Pressable style={s.ctxbtn} onPress={() => setOpen((o) => !o)}>
        <Text style={[s.ctxbtnTxt, MONO]}>{(open ? '− ' : '＋ ') + 'WHY THIS POSTURE'}</Text>
      </Pressable>
      {open ? (
        <View style={s.ctxpanel}>
          <Text style={s.gline}>{decode(text)}</Text>
        </View>
      ) : null}
    </View>
  );
}

// The fun scale: same analyst-set level underneath, told the way it feels.
const KEG = { calm: 'ALL QUIET', elev: 'SPARKS', high: 'FUSE LIT', crit: 'POWDER KEG' };
const KEG_SCALE = ['CALM', 'ELEVATED', 'HIGH', 'CRITICAL'];

function ThreatGauge({ risk, events, forecasts }) {
  const idx = RISK_LEVELS.indexOf(risk.color);
  const rc = riskColor[risk.color] || C.elev;
  // receipts, not vibes: the composite is auditable against countable inputs shown WITH it
  const sev = { crit: 0, high: 0, elev: 0 };
  (events || []).forEach((e) => { if (sev[e.sev] != null) sev[e.sev]++; });
  const moved = (forecasts || []).filter((f) => f.prev != null && f.p !== f.prev).length;
  return (
    <View style={s.gauge}>
      <View style={s.gtop}>
        <Text style={[s.glabel, MONO]}>GLOBAL THREAT LEVEL</Text>
        <Text style={[s.gstate, SERIF, { color: rc }]}>{risk.state}</Text>
      </View>
      <View style={[s.gscale, { marginBottom: 6 }]}>
        <Text style={[s.gscaleTxt, MONO]}>
          <Text style={{ color: C.crit }}>{sev.crit} CRIT</Text>
          {' · '}
          <Text style={{ color: C.high }}>{sev.high} HIGH</Text>
          {' · '}
          <Text style={{ color: C.elev }}>{sev.elev} ELEV</Text>
          {' ON THE BOARD'}
        </Text>
        <Text style={[s.gscaleTxt, MONO]}>{moved + '/' + (forecasts || []).length + ' CALLS MOVED'}</Text>
      </View>
      <View style={s.meter}>
        {RISK_LEVELS.map((lv, i) => (
          <View key={lv} style={[s.zone, { backgroundColor: riskColor[lv], opacity: i === idx ? 1 : 0.28 }]} />
        ))}
        <View style={[s.needle, { left: `${((idx + 0.5) / 4) * 100}%`, marginLeft: -6 }]} />
      </View>
      <View style={s.gscale}>
        {KEG_SCALE.map((t) => (
          <Text key={t} style={[s.gscaleTxt, MONO]}>{t}</Text>
        ))}
      </View>
    </View>
  );
}

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
// so it holds on Hermes.
function firstSentences(txt, n) {
  const str = decode(txt || '').replace(/\s+/g, ' ').trim();
  const re = /[.?!]["')\]]?\s/g;
  let out = '', count = 0, m;
  while (count < n && (m = re.exec(str))) { out = str.slice(0, m.index + m[0].length).trim(); count++; }
  return out || str;
}
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

// ── LEAD — the one story above the fold. Big serif headline, three lines of dek. ──
function LeadStory({ item, simpleText, easy, deep, onOpen, isRead, isSaved }) {
  const { head, stand, longHead } = articleParts(item);
  const dek = stand || firstSentences(bodyFor(item, simpleText, easy, deep), 2);
  const nsrc = (item.srcs || []).length;
  return (
    <Pressable onPress={onOpen} style={s.lead}>
      <View style={s.idxmeta}>
        <Text style={[s.kick, MONO]} numberOfLines={1}>{kickerOf(item)}</Text>
        <Text style={[s.idxtime, MONO]}>{timeOnly(item.ts)}</Text>
      </View>
      <Text style={[s.leadH, SERIF, isRead && s.readH]} numberOfLines={4}>{longHead || head}</Text>
      <Text style={s.leadDek} numberOfLines={3}>{dek}</Text>
      <View style={s.idxfoot}>
        <Text style={[s.readmore, MONO, isRead && { color: C.muted }]}>{isRead ? 'READ AGAIN ›' : 'READ THE FULL BRIEF ›'}</Text>
        {isSaved ? <Text style={[s.idxsrc, MONO, { color: C.accent, marginLeft: 10 }]}>★ SAVED</Text> : null}
        {nsrc ? <Text style={[s.idxsrc, MONO]}>{nsrc + (nsrc === 1 ? ' SOURCE' : ' SOURCES')}</Text> : null}
      </View>
    </Pressable>
  );
}

// ── INDEX ROW — everything after the lead. Headline-first, hairline-separated. ──
// `dense` rows drop the dek entirely: further down the page you are scanning titles.
function IndexRow({ item, simpleText, easy, deep, dense, onOpen, isRead, isSaved }) {
  const { head, stand } = articleParts(item);
  const dek = stand || firstSentences(bodyFor(item, simpleText, easy, deep), 1);
  const nsrc = (item.srcs || []).length;
  return (
    <Pressable onPress={onOpen} style={s.idxrow}>
      <View style={s.idxmeta}>
        <Text style={[s.kick, MONO, isRead && { color: C.accentDim }]} numberOfLines={1}>{kickerOf(item)}</Text>
        <Text style={[s.idxtime, MONO]}>{timeOnly(item.ts)}</Text>
      </View>
      <Text style={[s.idxH, SERIF, isRead && s.readH]} numberOfLines={3}>{head}</Text>
      {!dense ? <Text style={s.idxDek} numberOfLines={2}>{dek}</Text> : null}
      {!dense ? (
        <Text style={[s.idxsrc, MONO, { marginTop: 7, marginLeft: 0 }]}>
          {(isSaved ? '★ SAVED · ' : '') + (isRead ? 'READ · ' : '') + (nsrc ? nsrc + (nsrc === 1 ? ' SOURCE · ' : ' SOURCES · ') : '') + 'OPEN ›'}
        </Text>
      ) : null}
    </Pressable>
  );
}

// ── THE CONTEXT PANEL — the decode that used to live inline on every card. ──
function ContextPanel({ item, deep, specMatches }) {
  const [open, setOpen] = useState(true);   // 2026-09-12: open by default — readers were not finding the decode
  useEffect(() => { setOpen(true); }, [deep]);
  if (!item.context) return null;
  return (
    <>
      <Pressable style={[s.ctxbtn, s.ctxbtnWide]} onPress={() => setOpen((o) => !o)}>
        <Text style={[s.ctxbtnTxt, MONO]}>{(open ? '− ' : '＋ ') + (deep ? 'THE DECODE' : 'WHY THIS IS HAPPENING')}</Text>
      </Pressable>
      {open && (
        <View style={s.ctxpanel}>
          {item.dec && item.dec.verdict ? (
            <View style={[s.verdict, { borderColor: (VERDICT_META[item.dec.verdict] || VERDICT_META.partly).c }]}>
              <Text style={[MONO, { color: C.muted, fontSize: 10, letterSpacing: 1.6 }]}>THE CLAIM IS</Text>
              <Text style={[MONO, { color: (VERDICT_META[item.dec.verdict] || VERDICT_META.partly).c, fontSize: 18, fontWeight: '800', letterSpacing: 2, marginTop: 2 }]}>
                {(VERDICT_META[item.dec.verdict] || VERDICT_META.partly).label.toUpperCase()}
              </Text>
            </View>
          ) : null}
          {!deep ? (
            <>
              <Text style={[s.ctxlbl, MONO]}>THE CONTEXT, THE HISTORY, AND WHAT WOULD CHANGE IT</Text>
              {paragraphs(decode(item.context)).map((para, i) => (
                <Text key={i} style={[s.ctxP, T(17, 28), i > 0 && { marginTop: 12 }]}>{para}</Text>
              ))}
            </>
          ) : null}
          {item.dec && item.dec.angles && item.dec.angles.length ? (
            <>
              <Text style={[s.ctxlbl, MONO, { marginTop: 8 }]}>WHO GAINS, WHO PAYS</Text>
              {item.dec.angles.map((a, i) => (
                <Text key={i} style={[s.li, T(16, 24)]}>
                  <Text style={{ color: C.accent }}>› </Text>
                  <Text style={{ fontWeight: '700' }}>{decode(a.party)}</Text>
                  {' — ' + decode(a.effect)}
                </Text>
              ))}
            </>
          ) : null}
          {item.dec && item.dec.kill ? (
            <>
              <Text style={[s.ctxlbl, MONO, { marginTop: 8 }]}>WHAT WOULD CHANGE THIS READ</Text>
              <Text style={[s.ctxP, T(17, 28)]}>{decode(item.dec.kill)}</Text>
            </>
          ) : null}
          {(specMatches || []).map((sp, i) => (
            <View key={'sp' + i} style={{ marginTop: 8 }}>
              <Text style={[s.ctxlbl, MONO, { color: (GRADE_META[sp.grade] || GRADE_META.unverified).c }]}>
                {'WATCHTOWER · ' + (GRADE_META[sp.grade] || GRADE_META.unverified).label}
              </Text>
              <Text style={s.ctxP}>{decode(sp.obs) + ' — ' + decode(sp.src || '')}</Text>
            </View>
          ))}
        </View>
      )}
    </>
  );
}

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
function chatterFor(item, chatter) {
  const own = item.consp
    ? (Array.isArray(item.consp) ? item.consp : [item.consp]).map((c) => ({ ...c, tier: 'own' }))
    : [];
  const rest = (chatter || []).map((c) => ({
    ...c, r: c.region || inferRegion(c.claim + ' ' + (c.spread || '') + ' ' + (c.read || '')),
  }));
  // Score ORDERS but never filters. Nothing circulating gets withheld from the reader —
  // the most story-relevant just surfaces first.
  const by = (x, y) => chatterScore(item, y) - chatterScore(item, x);
  const theater = rest.filter((c) => c.r === item.region).sort(by).map((c) => ({ ...c, tier: 'theater' }));
  const board = rest.filter((c) => c.r !== item.region).sort(by).map((c) => ({ ...c, tier: 'board' }));
  return own.concat(theater, board);
}

function ConspiracyPanel({ items }) {
  const [open, setOpen] = useState(false);
  if (!items || !items.length) return null;
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
      <Pressable style={[s.ctxbtn, s.ctxbtnWide, { borderColor: C.high }]} onPress={() => setOpen((o) => !o)}>
        <Text style={[s.ctxbtnTxt, MONO, { color: C.high }]}>
          {(open ? '− ' : '＋ ') + 'THE CONSPIRACY'}
        </Text>
        <Text style={[MONO, { color: C.muted, fontSize: 11, marginLeft: 'auto' }]}>
          {items.length + (items.length === 1 ? ' claim circulating' : ' claims circulating')}
        </Text>
      </Pressable>
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
                  {c.read ? (
                    <>
                      <Text style={[s.ctxlbl, MONO, { marginTop: 10, color: C.accent }]}>THE DESK'S READ</Text>
                      {paragraphs(decode(c.read)).map((para, k) => (
                        <Text key={k} style={[s.ctxP, T(17, 28), k > 0 && { marginTop: 10 }]}>{para}</Text>
                      ))}
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
function ArticlePage({ item, simpleText, easy, deep, onBack, onBoard, callsCount, onCalls,
                       specMatches, chatter, prev, next, onOpen, isSaved, onSave,
                       tsize, onSize, theme, onTheme, level, onLevel }) {
  const { head, stand, longHead } = articleParts(item);
  const body = bodyFor(item, simpleText, easy, deep);
  // NYT's article furniture: back to the section, save it, send it to someone.
  const share = () => {
    const url = (item.srcs || []).find((sc) => sc.u);
    Share.share({ message: decode(head) + (url ? '\n\n' + url.u : '') + '\n\nvia GEO/TERMINAL' })
      .catch(() => {});
  };
  return (
    <View style={s.stack}>
      <View style={s.artbar}>
        <Pressable onPress={onBack} hitSlop={8}><Text style={s.backtxt}>‹ All headlines</Text></Pressable>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 16, marginLeft: 'auto' }}>
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
      {/* reading controls live with the reading, not on the front page */}
      <View style={{ flexDirection: 'row', gap: 18, alignItems: 'center', paddingHorizontal: 4 }}>
        {onLevel ? <Pressable hitSlop={8} onPress={() => onLevel(level === 'simple' ? 'regular' : level === 'regular' ? 'deep' : 'simple')}><Text style={s.rctl}>{'Level · ' + (level || 'regular')}</Text></Pressable> : null}
        {onSize ? <Pressable hitSlop={8} onPress={() => onSize(tsize === 'S' ? 'M' : tsize === 'M' ? 'L' : 'S')}><Text style={s.rctl}>{'Text · ' + (tsize || 'M')}</Text></Pressable> : null}
        {onTheme ? <Pressable hitSlop={8} onPress={() => onTheme(theme === 'light' ? 'dark' : 'light')}><Text style={s.rctl}>{theme === 'light' ? 'Dark' : 'Light'}</Text></Pressable> : null}
      </View>
      <View style={s.article}>
        <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 14 }}>
          <Text style={[s.kick, MONO, { flex: 0, marginRight: 10 }]}>{kickerOf(item)}</Text>
          <Text style={[s.readtime, MONO]}>{readTime(body, item.context)}</Text>
        </View>
        <Text style={[stand ? s.artH : s.artHLong, SERIF, T(stand ? 30 : 25, stand ? 37 : 32)]}>{stand ? head : longHead}</Text>
        {stand ? <Text style={[s.artStand, T(17.5, 26)]}>{stand}</Text> : null}
        <View style={s.artrule} />
        <Text style={[s.stime, MONO, { marginBottom: 18 }]}>{fullStamp(item.ts)}</Text>
        <Text style={[s.ctxlbl, MONO, { color: C.accent }]}>{easy ? 'IN PLAIN ENGLISH' : 'THE READ'}</Text>
        {paragraphs(decode(body)).map((para, i) => (
          <Text key={i} style={[s.storyP, T(easy ? 19 : 18, easy ? 32 : 30), i > 0 && { marginTop: 14 }]}>{para}</Text>
        ))}
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
        {!easy ? <ContextPanel item={item} deep={deep} specMatches={specMatches} /> : null}
        <ConspiracyPanel items={chatterFor(item, chatter)} />
        {!easy && (onBoard || callsCount > 0) ? (
          <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
            {onBoard ? <WebLink label="◉ ON THE BOARD ↑" onPress={onBoard} /> : null}
            {callsCount > 0 ? (
              <WebLink label={'ANALYSIS ON ' + (item.region || 'THIS').toUpperCase() + ' (' + callsCount + ') →'} onPress={onCalls} />
            ) : null}
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

// ── STAT STRIP — every category opens with numbers, never a paragraph ──
function StatStrip({ stats }) {
  return (
    <View style={{ flexDirection: 'row', gap: 8, marginBottom: 4 }}>
      {stats.map(([num, label], i) => (
        <View key={i} style={{ flex: 1, backgroundColor: C.panel, borderWidth: 1, borderColor: C.line, borderRadius: 6, paddingVertical: 8, alignItems: 'center' }}>
          <Text style={[MONO, { color: C.accent, fontSize: 16, fontWeight: '700' }]} numberOfLines={1}>{String(num)}</Text>
          <Text style={[MONO, { color: C.muted, fontSize: 8.5, letterSpacing: 0.8, marginTop: 2 }]} numberOfLines={1}>{label}</Text>
        </View>
      ))}
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

// terminal cursor after the wordmark — the little tell that the desk is live
function BlinkCursor() {
  const [on, setOn] = useState(true);
  useEffect(() => { const id = setInterval(() => setOn((v) => !v), 550); return () => clearInterval(id); }, []);
  return <Text style={{ color: C.accent, opacity: on ? 1 : 0 }}>▮</Text>;
}

const SPARK = '▁▂▃▄▅▆▇█';
function sparkline(sArr) { return (sArr || []).map((v) => SPARK[Math.max(0, Math.min(7, v))]).join(''); }

// ── CLOCKS — the calendars that price the board. Countdown chips; tap for which file the clock runs on. ──
function ClocksStrip({ clocks }) {
  const [sel, setSel] = useState(null);
  const cs = (clocks || []).filter((c) => c.date)
    .map((c) => ({ ...c, days: Math.ceil((new Date(c.date + 'T00:00') - Date.now()) / 86400000) }))
    .filter((c) => c.days >= -1);
  if (!cs.length) return null;
  const col = (d) => (d <= 7 ? C.crit : d <= 30 ? C.high : C.elev);
  return (
    <View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.rfilter}>
        {cs.map((c, i) => (
          <Pressable key={i} onPress={() => setSel(sel === i ? null : i)}
            style={[s.rchip, { borderColor: col(c.days) }]}>
            <Text style={[s.rchipTxt, MONO, { color: col(c.days) }]}>
              {c.label + ' −' + Math.max(c.days, 0) + 'd'}
            </Text>
          </Pressable>
        ))}
      </ScrollView>
      {sel != null && cs[sel] ? (
        <View style={s.ctxpanel}>
          <Text style={[s.ctxlbl, MONO, { color: col(cs[sel].days) }]}>
            {cs[sel].label + ' · ' + cs[sel].date + ' (' + cs[sel].days + ' DAYS)'}
          </Text>
          <Text style={s.ctxP}>{decode(cs[sel].why || '')}</Text>
        </View>
      ) : null}
    </View>
  );
}

// ── THE BOARD — the situation-room wall map. Tap a point, get the read. Learning is invited
// (every dot is a question), never forced (the brief below works without touching it). ──
function WorldMap({ events, sel, onSelect, onFilter, goTab, data }) {
  // LIVE HAZARD LAYER — USGS quakes M5+/48h (keyless, best-effort; the board never depends on it)
  const [quakes, setQuakes] = useState([]);
  const [selQ, setSelQ] = useState(null);
  useEffect(() => {
    const since = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
    fetch(`https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson&starttime=${since}&minmagnitude=5&orderby=magnitude&limit=25`)
      .then((r) => r.json())
      .then((gj) => setQuakes(gj.features || []))
      .catch(() => {});
  }, []);
  if (!events || !events.length) return null;
  const setSel = (i) => { setSelQ(null); onSelect(i); };
  const X = (lon) => ((lon + 180) / 360) * 1000;
  const Y = (lat) => ((90 - lat) / 180) * 500;
  const grid = [];
  for (let lon = -150; lon <= 150; lon += 30) grid.push({ x1: X(lon), y1: 0, x2: X(lon), y2: 500 });
  for (let lat = -60; lat <= 60; lat += 30) grid.push({ x1: 0, y1: Y(lat), x2: 1000, y2: Y(lat) });
  const e = sel != null ? events[sel] : null;
  const selC = e ? (riskColor[e.sev] || C.elev) : null;
  const coords = e
    ? (e.lat >= 0 ? e.lat.toFixed(2) + 'N' : (-e.lat).toFixed(2) + 'S') + ' ' +
      (e.lon >= 0 ? e.lon.toFixed(2) + 'E' : (-e.lon).toFixed(2) + 'W')
    : '';
  return (
    <View style={s.section}>
      <View style={s.h2row}>
        <Text style={s.h2}>THE BOARD</Text>
        <View style={s.h2rule} />
        <Text style={[s.h2extra, MONO]}>{events.length + ' ACTIVE'}</Text>
      </View>
      <View style={{ backgroundColor: C.panel2, borderWidth: 1, borderColor: C.line }}>
        <Svg viewBox="0 0 1000 500" width="100%" height={undefined} style={{ aspectRatio: 2 }}>
          <Rect x="0" y="0" width="1000" height="500" fill={C.panel2} />
          {grid.map((g, i) => (
            <Line key={'g' + i} x1={g.x1} y1={g.y1} x2={g.x2} y2={g.y2} stroke={C.line} strokeWidth="0.4" opacity="0.35" />
          ))}
          <SvgPath d={LAND_PATH} fill={C.chip} stroke={C.line} strokeWidth="0.6" />
          {e ? (
            <>
              <Line x1={X(e.lon)} y1="0" x2={X(e.lon)} y2="500" stroke={selC} strokeWidth="0.8" opacity="0.5" strokeDasharray="4 3" />
              <Line x1="0" y1={Y(e.lat)} x2="1000" y2={Y(e.lat)} stroke={selC} strokeWidth="0.8" opacity="0.5" strokeDasharray="4 3" />
            </>
          ) : null}
          {quakes.map((f, i) => {
            const [qlon, qlat] = f.geometry.coordinates;
            return (
              <Circle key={'q' + i} cx={X(qlon)} cy={Y(qlat)} r={2 + (f.properties.mag - 4)}
                fill="none" stroke={C.muted} strokeWidth="1" opacity="0.8"
                onPress={() => { onSelect(null); setSelQ(i); }} />
            );
          })}
          {events.map((ev, i) => {
            const c = riskColor[ev.sev] || C.elev;
            return (
              <Circle
                key={'e' + i}
                cx={X(ev.lon)} cy={Y(ev.lat)} r={sel === i ? 7 : 5}
                fill={c} stroke={C.ink} strokeWidth="0.8" opacity={sel == null || sel === i ? 1 : 0.55}
                onPress={() => setSel(i)}
              />
            );
          })}
        </Svg>
      </View>
      <View style={s.ctxpanel}>
        {selQ != null && quakes[selQ] ? (
          <>
            <Text style={[s.ctxlbl, MONO]}>
              {'◌ SEISMIC · M' + quakes[selQ].properties.mag.toFixed(1) + ' · '
                + Math.round((Date.now() - quakes[selQ].properties.time) / 3600000) + 'H AGO · USGS LIVE'}
            </Text>
            <Text style={s.ctxP}>
              {(quakes[selQ].properties.place || '—')
                + '. Sensor data, not analyst judgment — shown because disasters move politics (relief logistics, grid failures, border crossings, blame).'}
            </Text>
          </>
        ) : e ? (
          <>
            <Text style={[s.ctxlbl, MONO, { color: selC }]}>
              {'■ ' + decode(e.label).toUpperCase() + '  · ' + coords + ' · ' + (e.sev || 'elev').toUpperCase()}
            </Text>
            <Text style={s.ctxP}>{decode(e.note)}</Text>
            {(() => {
              const ar = evRegion(e);
              const att = ar && (data.attention || {})[ar];
              return att ? (
                <Text style={[MONO, { color: C.muted, fontSize: 12, marginTop: 4 }]}>
                  {sparkline(att.s) + '  WORLD ATTENTION ' + att.r + 'x 14-DAY BASELINE (GDELT)'}
                </Text>
              ) : null;
            })()}
            <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
              {(() => {
                const r = evRegion(e);
                if (!r) return null;
                const n = (data.brief || []).filter((c) => c.region === r).length;
                const calls = regionForecasts(data, r).length;
                return (
                  <>
                    {n ? <WebLink label={'READ THE COVERAGE · ' + r.toUpperCase() + ' (' + n + ') ↓'} onPress={() => onFilter(r)} /> : null}
                    {calls ? <WebLink label={'OUR CALLS ON THIS (' + calls + ') →'} onPress={() => goTab('conspiracy')} /> : null}
                  </>
                );
              })()}
            </View>
          </>
        ) : (
          <Text style={[s.ctxlbl, MONO]}>
            {'TAP A POINT FOR THE READ · '}
            <Text style={{ color: C.elev }}>● ELEV </Text>
            <Text style={{ color: C.high }}>● HIGH </Text>
            <Text style={{ color: C.crit }}>● CRIT </Text>
            <Text style={{ color: C.muted }}>◌ SEISMIC</Text>
          </Text>
        )}
      </View>
    </View>
  );
}

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

function QuizSection({ quiz }) {
  const [open, setOpen] = useState(false);
  const [score, setScore] = useState(0);
  const [answered, setAnswered] = useState(0);
  if (!quiz || !quiz.length) return null;
  const onAnswered = (right) => { setAnswered((a) => a + 1); if (right) setScore((v) => v + 1); };
  const doneAll = answered === quiz.length;
  return (
    <Section title="Test yourself" extra={quiz.length + ' questions'}>
      <Pressable style={s.ctxbtn} onPress={() => setOpen((o) => !o)}>
        <Text style={[s.ctxbtnTxt, MONO]}>{(open ? '− ' : '＋ ') + "TAKE TODAY'S QUIZ"}</Text>
      </Pressable>
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
    </Section>
  );
}

// ── DECODE — a claim, interrogated: announced vs binding, and who gains vs who pays ──
// NOTE: `decode(...)` here is the HTML-entity helper defined above, unrelated to the DECODE tab.
function DecodeCard({ item, easy, deep, coverageRegion, onCoverage }) {
  const [open, setOpen] = useState(deep);
  useEffect(() => { setOpen(deep); }, [deep]);   // keep expansion in sync with the level toggle
  const vm = VERDICT_META[item.verdict] || VERDICT_META.partly;
  const angles = item.angles || [];
  const watch = item.watch || [];
  const clock = item.clock || {};
  const buckets = [['0–90 DAYS', clock.d90], ['6–18 MONTHS', clock.m18], ['3–7 YEARS', clock.y7]].filter(([, v]) => v);

  return (
    <View style={s.storycard}>
      <View style={[s.spine, { backgroundColor: vm.c }]} />
      <View style={s.cardmeta}>
        <Text style={[s.ktag, MONO, { marginBottom: 0, color: vm.c, borderColor: vm.c }]}>{vm.label}</Text>
        {fullStamp(item.ts) ? <Text style={[s.stime, MONO]}>{fullStamp(item.ts)}</Text> : null}
      </View>
      <Text style={[s.storyH3, SERIF, easy && { fontSize: 21 }]}>{decode(item.claim)}</Text>
      {item.source ? <Text style={[s.stime, MONO, { marginBottom: 6 }]}>{decode(item.source).toUpperCase()}</Text> : null}

      {easy ? (
        <Text style={[s.storyP, { fontSize: 16.5, lineHeight: 27 }]}>{decode(item.easy || item.verdictNote)}</Text>
      ) : (
        <>
          {item.verdictNote ? <Text style={s.storyP}>{decode(item.verdictNote)}</Text> : null}
          <Pressable style={s.ctxbtn} onPress={() => setOpen((o) => !o)}>
            <Text style={[s.ctxbtnTxt, MONO]}>{(open ? '− ' : '＋ ') + 'DECODE THE CLAIM'}</Text>
          </Pressable>
          {open && (
            <View style={s.ctxpanel}>
              {item.reality ? (
                <>
                  <Text style={[s.ctxlbl, MONO]}>WHAT IS ACTUALLY TRUE TODAY</Text>
                  <Text style={s.ctxP}>{decode(item.reality)}</Text>
                </>
              ) : null}
              {item.aspiration ? (
                <>
                  <Text style={[s.ctxlbl, MONO]}>WHAT IS ASPIRATIONAL OR UNVERIFIED</Text>
                  <Text style={s.ctxP}>{decode(item.aspiration)}</Text>
                </>
              ) : null}
              {angles.length ? (
                <>
                  <Text style={[s.ctxlbl, MONO]}>WHO GAINS, WHO PAYS</Text>
                  {angles.map((a, i) => (
                    <Text key={i} style={s.li}>
                      <Text style={{ color: C.accent }}>› </Text>
                      <Text style={{ fontWeight: '700' }}>{decode(a.party)}</Text>
                      {' — ' + decode(a.effect)}
                    </Text>
                  ))}
                </>
              ) : null}
              {buckets.length ? (
                <>
                  <Text style={[s.ctxlbl, MONO]}>ON THE CLOCK</Text>
                  {buckets.map(([lab, txt], i) => (
                    <Text key={i} style={s.li}>
                      <Text style={{ color: C.accent }}>› </Text>
                      <Text style={[MONO, { fontWeight: '700' }]}>{lab}</Text>
                      {' — ' + decode(txt)}
                    </Text>
                  ))}
                </>
              ) : null}
              {watch.length ? (
                <>
                  <Text style={[s.ctxlbl, MONO]}>WHAT WOULD CONFIRM OR KILL THIS</Text>
                  {watch.map((w, i) => (
                    <Text key={i} style={s.li}><Text style={{ color: C.accent }}>› </Text>{decode(w)}</Text>
                  ))}
                </>
              ) : null}
            </View>
          )}
          {coverageRegion ? (
            <WebLink label={'SEE THE COVERAGE · ' + coverageRegion.toUpperCase() + ' →'} onPress={() => onCoverage(coverageRegion)} />
          ) : null}
        </>
      )}
    </View>
  );
}

function DecodeTab({ data, easy, deep, goTab }) {
  const items = data.decode || [];
  const [vf, setVf] = useState('ALL');
  const vcounts = {};
  items.forEach((d) => { vcounts[d.verdict] = (vcounts[d.verdict] || 0) + 1; });
  const shown = items.filter((d) => vf === 'ALL' || d.verdict === vf);
  // claim -> the news coverage of the same theater: pre-set the region filter (NewsTab reads
  // it from storage on mount - tabs remount on switch), then jump
  const seeCoverage = (r) => {
    AsyncStorage.setItem(REGION_KEY, r).catch(() => {});
    goTab('news');
  };
  return (
    <View style={s.stack}>
      <StatStrip stats={[
        [items.length, 'CLAIMS'],
        [(vcounts.framing || 0) + (vcounts.false || 0), 'FRAMING/FALSE'],
        [(vcounts.true || 0) + (vcounts.partly || 0), 'TRUE/PARTLY'],
      ]} />
      <View style={s.briefhead}>
        <Text style={[s.briefT, MONO]}>CLAIMS DECODED</Text>
        <Text style={[s.briefD, MONO]}>{data.updated}</Text>
      </View>
      {items.length ? (
        <FilterDrop
          pairs={[['ALL', 'All', items.length]].concat(
            ['true', 'partly', 'framing', 'false'].filter((v) => vcounts[v]).map((v) => [v, VERDICT_META[v].label, vcounts[v]]))}
          active={vf} onPick={setVf} />
      ) : null}
      {items.length
        ? shown.map((d, i) => {
            const dr = inferRegion((d.claim || '') + ' ' + (d.source || ''));
            const hasCoverage = dr && (data.brief || []).some((c) => c.region === dr);
            return (
              <DecodeCard key={i} item={d} easy={easy} deep={deep}
                coverageRegion={hasCoverage ? dr : null} onCoverage={seeCoverage} />
            );
          })
        : <Text style={s.foot}>No claims decoded yet — check back after the next run.</Text>}
      <QuizSection quiz={data.quiz} />
      <Text style={s.foot}>Analysis and opinion, for information only — not advice.</Text>
    </View>
  );
}

// ── HOME — the dashboard (mockup shape): threat level, the $100 test, top developments, analyst tools ──
function CostCard({ cost }) {
  if (!cost || !cost.mult) return null;
  return (
    <View style={{ backgroundColor: C.panel, borderWidth: 1, borderColor: C.line, borderRadius: 8, padding: 14 }}>
      <Text style={[s.glabel, MONO]}>THE $100 TEST</Text>
      <View style={{ flexDirection: 'row', alignItems: 'baseline', marginTop: 6 }}>
        <Text style={[SERIF, { color: C.text, fontSize: 22 }]}>$100 in 2019 </Text>
        <Text style={[SERIF, { color: C.accent, fontSize: 26 }]}>{'= $' + Math.round(100 * cost.mult) + ' now'}</Text>
      </View>
      <Text style={[MONO, { color: C.muted, fontSize: 10, marginTop: 4 }]}>
        {'PRICES +' + cost.pct + '% SINCE 2019 · CPI THROUGH ' + cost.asof + ' · FRED'}
      </Text>
    </View>
  );
}

// ── MONEY PRINTER RED BOARD — Tier-0 prints vs stated thresholds (mirrors dashboard plumbing tab).
// `board` is script-owned (data_feeds.py redboard apply): colour, lines, crisis channels A-D. ──
const boardColor = () => ({ RED: C.crit, YELLOW: C.elev, GREEN: C.calm });   // read at render so the theme can change
function RedBoard({ board, compact, onPress }) {
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
        {(board.lines || []).map((l, i) => (
          <View key={'l' + i} style={{ flexDirection: 'row', alignItems: 'baseline', paddingVertical: 4, borderTopWidth: 1, borderTopColor: C.line }}>
            <Text style={[MONO, { color: l.hit ? C.crit : C.muted, fontSize: 11, width: 18 }]}>{l.hit ? '✕' : '·'}</Text>
            <Text style={[MONO, { color: l.hit ? C.text : C.muted, fontSize: 11.5, flex: 1 }]}>{decode(l.k)}</Text>
            <Text style={[MONO, { color: l.hit ? C.crit : C.text, fontSize: 12.5, fontWeight: '700' }]}>{l.v}</Text>
            {l.src ? <Text style={[MONO, { color: C.muted, fontSize: 8.5, marginLeft: 6, width: 78, textAlign: 'right' }]}>{String(l.src).toUpperCase()}</Text> : null}
          </View>
        ))}
        <Text style={[MONO, { color: C.muted, fontSize: 9.5, letterSpacing: 0.8, marginTop: 10, marginBottom: 4 }]}>CRISIS CHANNELS · WHERE A SQUEEZE WOULD EXIT</Text>
        {(board.channels || []).map((c, i) => {
          const cc = c.status === 'TRIPPED' ? C.crit : c.status === 'not tripped' ? C.calm : C.elev;
          return (
            <View key={'c' + i} style={{ paddingVertical: 5, borderTopWidth: 1, borderTopColor: C.line }}>
              <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                <Text style={[MONO, { color: C.accent, fontSize: 11, width: 18 }]}>{c.id}</Text>
                <Text style={[MONO, { color: C.text, fontSize: 11.5, flex: 1 }]}>{decode(c.name)}</Text>
                <Text style={[MONO, { color: cc, fontSize: 9.5, letterSpacing: 0.8 }]}>{String(c.status).toUpperCase()}</Text>
              </View>
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
function LiveWatchlist({ items }) {
  if (!items || !items.length) return null;
  return (
    <Section title="Live watchlist" extra={items.length + ' prints'}>
      {items.map((x, i) => (
        <View key={i} style={{ paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: C.line }}>
          <View style={{ flexDirection: 'row', alignItems: 'baseline' }}>
            <Text style={[MONO, { color: C.text, fontSize: 12, flex: 1 }]}>{decode(x.k)}</Text>
            <Text style={[MONO, { color: C.accent, fontSize: 14, fontWeight: '700' }]}>{x.v}</Text>
            <Text style={[MONO, { color: trendC()[x.t] || C.muted, fontSize: 10.5, marginLeft: 8, minWidth: 54, textAlign: 'right' }]}>
              {(x.t === 'up' ? '▲ ' : x.t === 'dn' ? '▼ ' : '· ') + (x.c || '')}
            </Text>
          </View>
          {x.note ? <Text style={{ color: C.muted, fontSize: 11, marginTop: 2 }}>{decode(x.note)}</Text> : null}
        </View>
      ))}
    </Section>
  );
}

// ── THE CHATTER — raw narrative monitoring: what the boards are saying. Unverified BY DESIGN. ──
function Chatter({ items, onStory }) {
  if (!items || !items.length) return null;
  return (
    <Section title="The chatter" extra={items.length + ' circulating'}>
      <Text style={[s.conspWarn, { paddingHorizontal: 16 }]}>UNVERIFIED · WHAT IS CIRCULATING, NOT WHAT IS CONFIRMED</Text>
      {items.map((c, i) => (
        <View key={i} style={[s.storycard, { marginHorizontal: 12, marginBottom: 12 }]}>
          <View style={s.cardmeta}>
            <Text style={[s.ktag, { marginBottom: 0, color: c.story ? C.accent : C.high }]}>{c.story ? 'ON A STORY' : (c.region || 'CIRCULATING').toUpperCase()}</Text>
            {fullStamp(c.ts) ? <Text style={s.stime}>{fullStamp(c.ts)}</Text> : null}
          </View>
          <Text style={[s.ctxP, T(18, 27), { fontWeight: '700' }]}>{decode(c.claim)}</Text>
          {c.spread ? <Text style={[s.ctxP, T(15, 23), { color: C.muted, marginTop: 8 }]}>{decode(c.spread)}</Text> : null}
          {c.read ? (
            <>
              <Text style={[s.ctxlbl, { marginTop: 12, color: C.accent }]}>THE DESK'S READ</Text>
              {paragraphs(decode(c.read)).map((para, k) => (
                <Text key={k} style={[s.ctxP, T(17, 27), k > 0 && { marginTop: 10 }]}>{para}</Text>
              ))}
            </>
          ) : null}
          <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
            {c.story && onStory ? <WebLink label={'THE STORY: ' + articleParts(c.story).head.toUpperCase().slice(0, 40) + '… ›'} onPress={() => onStory(c.storyIdx)} /> : null}
            {c.u ? <WebLink label="SEE THE POST ↗" onPress={() => Linking.openURL(c.u)} /> : null}
          </View>
        </View>
      ))}
      <Text style={s.foot}>What anonymous boards and social feeds are circulating — monitored so you can see the narratives forming, never endorsed.</Text>
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

function HomeTab({ data, easy, deep, goTab, goArticle, read }) {
  const rline = data.risk.line;
  const tiles = [
    ['news', '▤', 'NEWS', (data.brief || []).length, 'stories on the wire'],
    ['conspiracy', '◉', 'ANALYSIS', (data.forecasts || []).length, 'live calls, publicly scored'],
    ['strategy', '♟', 'STRATEGY', (data.actors || []).length, 'decision-makers tracked'],
    ['boards', '☍', 'THE BOARDS', (data.chatter || []).length, 'claims circulating today'],
  ];
  const topDevs = briefSorted(data.brief).slice(0, 3);
  return (
    <View style={s.stack}>
      {/* from the boards — the three loudest claims of the day; tap opens BOARDS */}
      {(data.chatter || []).length ? (
        <Pressable onPress={() => goTab('boards')} style={{ backgroundColor: C.panel, borderWidth: 1, borderColor: C.line, borderRadius: 14, padding: 16 }}>
          <View style={{ flexDirection: 'row', alignItems: 'baseline', marginBottom: 8 }}>
            <Text style={[s.h2, { fontSize: 18 }]}>From the boards</Text>
            <Text style={[s.conspWarn, { marginLeft: 'auto', marginBottom: 0 }]}>UNVERIFIED</Text>
          </View>
          {(data.chatter || []).slice(0, 3).map((c, i) => (
            <Text key={i} style={[s.ctxP, T(16, 24), i > 0 && { marginTop: 8 }]} numberOfLines={2}>
              <Text style={{ color: C.high }}>› </Text>{decode(c.claim)}
            </Text>
          ))}
          <Text style={[s.readmore, { marginTop: 12 }]}>{(data.chatter || []).length + ' circulating · open the boards ›'}</Text>
        </Pressable>
      ) : null}
      {/* daily intelligence brief door (mockup: START) */}
      <Pressable onPress={() => goTab('news')}
        style={{ backgroundColor: C.panel, borderWidth: 1, borderColor: C.accentDim, borderRadius: 8, padding: 13, flexDirection: 'row', alignItems: 'center' }}>
        <View style={{ flex: 1 }}>
          <Text style={[MONO, { color: C.accent, fontSize: 11, letterSpacing: 1.5 }]}>DAILY INTELLIGENCE BRIEF</Text>
          <Text style={{ color: C.muted, fontSize: 11, marginTop: 3 }}>{(data.brief || []).length + ' developments · updated ' + (data.updated || '')}</Text>
        </View>
        <View style={{ backgroundColor: C.accent, borderRadius: 5, paddingVertical: 7, paddingHorizontal: 14 }}>
          <Text style={[MONO, { color: C.ink, fontWeight: '700', fontSize: 11 }]}>START ›</Text>
        </View>
      </Pressable>
      <ThreatGauge risk={data.risk} events={data.events} forecasts={data.forecasts} />
      <WhyPosture text={rline} deep={deep} />
      <Pressable onPress={() => Linking.openURL('https://t.me/Claudeyyybot')}
        style={{ backgroundColor: C.panel, borderWidth: 1, borderColor: C.line, borderRadius: 8, padding: 13, flexDirection: 'row', alignItems: 'center' }}>
        <Text style={{ fontSize: 18, marginRight: 10 }}>🗨</Text>
        <View style={{ flex: 1 }}>
          <Text style={[MONO, { color: C.accent, fontSize: 11, letterSpacing: 1.5 }]}>ASK THE ANALYST</Text>
          <Text style={{ color: C.muted, fontSize: 11, marginTop: 2 }}>Chat with the desk — ask anything on the board, or paste any article link for a decode</Text>
        </View>
        <Text style={{ color: C.accent, fontSize: 16 }}>›</Text>
      </Pressable>
      <CostCard cost={data.cost} />
      {data.plumbing ? <RedBoard board={data.plumbing.board} compact onPress={() => goTab('strategy')} /> : null}
      <Section title="Top developments" extra="SEE ALL ›">
        {topDevs.map(({ s: st, i: bi }, n) => (
          <Pressable key={bi} onPress={() => goArticle(bi)}
            style={{ flexDirection: 'row', alignItems: 'flex-start', paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: n < topDevs.length - 1 ? 1 : 0, borderColor: C.line }}>
            <View style={{ width: 7, height: 7, borderRadius: 4, marginRight: 10, marginTop: 6, backgroundColor: riskColor[(data.events || []).find((e) => evRegion(e) === st.region)?.sev] || C.elev }} />
            <View style={{ flex: 1 }}>
              <View style={s.idxmeta}>
                <Text style={[s.kick, MONO]} numberOfLines={1}>{kickerOf(st)}</Text>
                <Text style={[s.idxtime, MONO]}>{timeOnly(st.ts)}</Text>
              </View>
              <Text style={[s.teaseH, SERIF, read && read[storyId(st)] && s.readH]} numberOfLines={3}>{articleParts(st).head}</Text>
            </View>
          </Pressable>
        ))}
      </Section>
      <Section title="Analyst tools">
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between' }}>
          {tiles.map(([key, g, label, n, sub]) => (
            <Pressable key={key} onPress={() => goTab(key)}
              style={{ width: '48.5%', backgroundColor: C.panel, borderWidth: 1, borderColor: C.line, borderRadius: 8, padding: 13, marginBottom: 10 }}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                <Text style={{ color: C.accent, fontSize: 18 }}>{g}</Text>
                <Text style={[MONO, { color: C.accent, fontSize: 20, fontWeight: '700' }]}>{n}</Text>
              </View>
              <Text style={[MONO, { color: C.text, fontSize: 11.5, letterSpacing: 1.2, marginTop: 6 }]}>{label + ' ›'}</Text>
              <Text style={{ color: C.muted, fontSize: 10.5, marginTop: 2 }}>{sub}</Text>
            </Pressable>
          ))}
        </View>
      </Section>
      <Text style={s.foot}>Analysis and opinion, for information only — not advice.</Text>
    </View>
  );
}

// ── MAP — the board gets its own room (mockup: map is a destination, not homepage furniture) ──
function MapTab({ data, easy, goTab, boardSel, setBoardSel }) {
  const goCoverage = (r) => { AsyncStorage.setItem(REGION_KEY, r).catch(() => {}); goTab('news'); };
  return (
    <View style={s.stack}>
      <WorldMap events={data.events} sel={boardSel} onSelect={setBoardSel}
        onFilter={goCoverage} goTab={goTab} data={data} />
      <ClocksStrip clocks={data.clocks} />
      <Text style={s.foot}>Points are analyst-geocoded from the day's brief; rings are live USGS seismic. Analysis and opinion — not advice.</Text>
    </View>
  );
}

// ── NEWS — a front page, not a stack of slabs. ──────────────────────────────
// Two states share the tab: the INDEX (scan) and an ARTICLE (read). Order stays
// strictly newest-first inside day sections, so the chronology is never violated;
// hierarchy comes from position, not from re-ranking.
function NewsTab({ data, easy, deep, goTab, goBoard, article, setArticle, scrollTop,
                   read, saved, markRead, toggleSave, tsize, onSize, theme, onTheme, level, onLevel }) {
  const simple = (easy && data.easy && data.easy.brief) || [];
  const [region, setRegion] = useState('ALL');
  useEffect(() => { AsyncStorage.getItem(REGION_KEY).then((v) => { if (v) setRegion(v); }).catch(() => {}); }, []);
  const choose = (r) => { setRegion(r); setArticle(null); AsyncStorage.setItem(REGION_KEY, r).catch(() => {}); };

  const regions = regionsPresent(data.brief);
  const nsaved = (data.brief || []).filter((st) => saved[storyId(st)]).length;
  const valid = region === 'ALL' || region === 'SAVED' || regions.includes(region);
  const active = valid ? region : 'ALL';
  const counts = {}; for (const st of (data.brief || [])) if (st.region) counts[st.region] = (counts[st.region] || 0) + 1;
  // "Saved" is a section front of its own, exactly where NYT puts it — in the filter bar.
  const chips = [['ALL', 'All', (data.brief || []).length]]
    .concat(nsaved ? [['SAVED', '★ Saved', nsaved]] : [])
    .concat(regions.map((r) => [r, r, counts[r] || 0]));
  const rows = briefSorted(data.brief).filter(({ s: st }) =>
    active === 'ALL' ? true : active === 'SAVED' ? !!saved[storyId(st)] : st.region === active);

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
        callsCount={regionForecasts(data, item.region).length}
        onCalls={() => goTab('conspiracy')}
        specMatches={(data.speculation || []).filter((sp) => (sp.region || inferRegion(sp.obs + ' ' + (sp.read || ''))) === item.region)}
        chatter={data.chatter}
        isSaved={!!saved[id]} onSave={() => toggleSave(id)}
        tsize={tsize} onSize={onSize} theme={theme} onTheme={onTheme} level={level} onLevel={onLevel}
        prev={at > 0 ? rows[at - 1] : null}
        next={at < rows.length - 1 ? rows[at + 1] : null}
      />
    );
  }

  // INDEX STATE — the front page (Direction C): headlines only, serif, newest first, a rule between days.
  const all = briefSorted(data.brief);
  let seen = null;
  return (
    <View>
      {all.length ? all.map(({ s: st, i }) => {
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
      }) : <Text style={s.foot}>No headlines right now.</Text>}
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
function SearchScreen({ data, query, setQuery, goArticle, goTab }) {
  const q = query.trim().toLowerCase();
  const hit = (txt) => q.length >= 2 && String(txt || '').toLowerCase().includes(q);
  const stories = (data.brief || []).map((b, i) => ({ b, i })).filter(({ b }) => hit(b.head + ' ' + b.h + ' ' + b.t + ' ' + b.region + ' ' + b.tag));
  const boards = (data.chatter || []).filter((c) => hit(c.claim + ' ' + (c.read || '')));
  const calls = (data.forecasts || []).filter((f) => hit(f.q));
  return (
    <View>
      <View style={s.searchbox}>
        <TextInput value={query} onChangeText={setQuery} autoFocus placeholder="Search stories, places, people" placeholderTextColor={C.muted}
          style={[s.searchin, { color: C.text }]} returnKeyType="search" autoCorrect={false} />
        {query ? <Pressable onPress={() => setQuery('')} hitSlop={8}><Text style={{ color: C.accent, fontWeight: '600' }}>Clear</Text></Pressable> : null}
      </View>
      {q.length < 2 ? <Text style={[s.foot, { marginTop: 18 }]}>Type at least two letters. Results group into stories, boards and calls.</Text> : null}
      {stories.length ? <Text style={s.searchH}>STORIES</Text> : null}
      {stories.map(({ b, i }) => (
        <Pressable key={'s' + i} onPress={() => goArticle(i)} style={s.hrow}>
          <Text style={[s.hrowH, { fontSize: 19, lineHeight: 24 }]}>{articleParts(b).head}</Text>
          <Text style={s.hrowMeta}>{String(b.region || '').toUpperCase()}</Text>
        </Pressable>
      ))}
      {boards.length ? <Text style={[s.searchH, { color: C.high }]}>BOARDS</Text> : null}
      {boards.map((c, i) => (
        <Pressable key={'b' + i} onPress={() => goTab('boards')} style={s.hrow}>
          <Text style={[s.ctxP, T(16, 23)]}>{decode(c.claim)}</Text>
        </Pressable>
      ))}
      {calls.length ? <Text style={s.searchH}>CALLS</Text> : null}
      {calls.map((f, i) => (
        <Pressable key={'c' + i} onPress={() => goTab('conspiracy')} style={[s.hrow, { flexDirection: 'row', gap: 14, alignItems: 'baseline' }]}>
          <Text style={[s.predp, MONO]}>{f.p}%</Text>
          <Text style={[s.predq, { flex: 1 }]}>{decode(f.q)}</Text>
        </Pressable>
      ))}
      {q.length >= 2 && !stories.length && !boards.length && !calls.length ? <Text style={[s.foot, { marginTop: 18 }]}>Nothing matches in today's brief.</Text> : null}
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
    <Section title="Our track record" extra={scored ? track.resolved + ' scored' : 'scoring opens Oct'}>
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
function BoardsTab({ data, goArticle }) {
  const [region, setRegion] = useState('ALL');
  const pinned = (data.brief || []).flatMap((b, i) =>
    (b.consp ? (Array.isArray(b.consp) ? b.consp : [b.consp]) : []).map((c) => ({ ...c, story: b, storyIdx: i, region: b.region })));
  const loose = (data.chatter || []).map((c) => ({ ...c, region: c.region || inferRegion(c.claim + ' ' + (c.read || '')) }));
  const all = pinned.concat(loose);
  const items = all.filter((c) => region === 'ALL' || c.region === region);
  const specs = (data.speculation || []).filter((sp) => region === 'ALL' || (sp.region || inferRegion(sp.obs + ' ' + (sp.read || ''))) === region);
  const theaters = new Set(all.map((c) => c.region).filter(Boolean));
  return (
    <View style={s.stack}>
      <View style={s.tabintro}>
        <Text style={s.tabintroP}>
          Everything the desk caught circulating today on 4chan, X and Reddit — nothing withheld for being
          far-fetched. A record of what people believe, not of what is true. Nobody has checked any of it.
        </Text>
      </View>
      <FilterDrop pairs={textRegionPairs(all, (c) => c.claim + ' ' + (c.read || ''))} active={region} onPick={setRegion} />
      <Chatter items={items} onStory={goArticle} />
      <Watchtower items={specs} />
    </View>
  );
}

// ── FROM X AND REDDIT — the raw posts the desk read this pass (script-owned DATA.social). Source
// material, shown as posted, with attribution and reach; the desk's a-g reads sit below in The chatter. ──
function SocialFeed({ social }) {
  const [tab, setTab] = useState('x');
  const [more, setMore] = useState(false);
  if (!social || (!(social.x || []).length && !(social.reddit || []).length)) return null;
  const xs = social.x || [], rs = social.reddit || [];
  const list = tab === 'x' ? xs : rs;
  const shown = more ? list : list.slice(0, 8);
  const when = (iso) => { try { const d = new Date(iso); return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); } catch (e) { return ''; } };
  return (
    <Section title="From X and Reddit" extra={'as of ' + (social.asof || '').slice(5, 16)}>
      <View style={{ flexDirection: 'row', gap: 8, paddingHorizontal: 16, paddingBottom: 10 }}>
        {[['x', 'X · ' + xs.length], ['reddit', 'Reddit · ' + rs.length]].map(([k, lab]) => (
          <Pressable key={k} onPress={() => { setTab(k); setMore(false); }} style={[s.rchip, tab === k && s.rchipOn]}>
            <Text style={[s.rchipTxt, tab === k && { color: C.text }]}>{lab}</Text>
          </Pressable>
        ))}
      </View>
      <Text style={[s.conspWarn, { paddingHorizontal: 16 }]}>AS POSTED · ATTRIBUTED, NOT VERIFIED</Text>
      {shown.map((p, i) => (
        <Pressable key={i} onPress={() => p.url && Linking.openURL(p.url)} style={s.morerow}>
          <View style={{ flex: 1 }}>
            <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 8 }}>
              <Text style={[s.hrowMeta, { marginTop: 0 }]}>{tab === 'x' ? '@' + p.account : 'r/' + p.sub}</Text>
              {tab === 'x' && p.ts ? <Text style={{ color: C.muted, fontSize: 12 }}>{when(p.ts)}</Text> : null}
              {tab === 'x' ? <Text style={{ color: C.muted, fontSize: 12, marginLeft: 'auto' }}>{(p.likes || 0) + ' ♥ · ' + (p.rts || 0) + ' ↻'}</Text> : null}
            </View>
            <Text style={[s.ctxP, T(16, 24), { marginTop: 6 }]}>{decode(tab === 'x' ? p.text : p.title)}</Text>
            {tab === 'reddit' && p.body ? <Text style={[s.ctxP, T(14.5, 21), { color: C.muted, marginTop: 4 }]}>{decode(p.body)}</Text> : null}
          </View>
        </Pressable>
      ))}
      {list.length > 8 ? (
        <Pressable onPress={() => setMore((v) => !v)} style={[s.morerow, { justifyContent: 'center' }]}>
          <Text style={[s.readmore]}>{more ? 'Show fewer' : 'Show all ' + list.length + ' ›'}</Text>
        </Pressable>
      ) : null}
    </Section>
  );
}

function ConspiracyTab({ data, easy, deep, goArticle, read, saved }) {
  const [region, setRegion] = useState('ALL');
  const cFilter = (txt) => region === 'ALL' || inferRegion(txt) === region;
  const hyps = (data.hypotheses || []).filter((h) => cFilter(h.name + ' ' + h.d));
  const fcs = (data.forecasts || []).filter((f) => cFilter(f.q));
  const specs = (data.speculation || []).filter((sp) => region === 'ALL' || (sp.region || inferRegion(sp.obs + ' ' + sp.read)) === region);
  const movedN = (data.forecasts || []).filter((f) => f.prev != null && f.p !== f.prev).length;
  return (
    <View style={s.stack}>
      <Section title="Calls on the board" extra={String(fcs.length)}>
        {fcs.map((f, i) => {
          const d = f.prev != null ? f.p - f.prev : null;
          return (
            <View key={i} style={s.pred}>
              <View style={s.predtop}>
                <Text style={s.predq}>{decode(f.q)}</Text>
                <Text style={[s.predp, MONO]}>{f.p}<Text style={s.predpS}>%</Text></Text>
              </View>
              <ProbBar p={f.p} prev={f.prev} />
              <View style={s.predmeta}>
                {d ? <Text style={[s.chip, MONO, { color: d > 0 ? C.high : C.calm }]}>{(d > 0 ? '+' : '') + d}</Text> : null}
                <Text style={s.predmetaTxt}>by {f.by}</Text>
              </View>
              {f.note ? <Text style={s.prednote}>{decode(f.note)}</Text> : null}
            </View>
          );
        })}
      </Section>
      <CalibrationTrack track={data.track} forecasts={data.forecasts} />
      {hyps.length ? (
        <Section title="Hidden-strategy lab" extra={hyps.length + ' live'}>
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
      <Watchlist tripwires={data.tripwires} />
      <MoreFromTheDesk data={data} easy={easy} deep={deep} goArticle={goArticle} read={read} saved={saved} />
      <Text style={s.foot}>Probabilities are subjective estimates and will often be wrong — that's the point of keeping score. Not advice.</Text>
    </View>
  );
}

// ── MORE FROM THE DESK — everything that is not news, one tap deep instead of on the front. ──
function MoreFromTheDesk({ data, easy, deep, goArticle, read, saved }) {
  const [open, setOpen] = useState(null);
  const rows = [
    ['strategy', 'Strategy desk', 'players, dossiers, scenarios, the red board, this week\'s deep dive'],
    ['watch', 'What to watch', (data.watch || []).length + ' items'],
    ['quiz', 'Quiz', 'test the read'],
    ['analyst', 'Ask the analyst', 'chat with the desk on Telegram'],
  ];
  return (
    <Section title="More from the desk">
      {rows.map(([k, t, sub]) => (
        <View key={k}>
          <Pressable onPress={() => (k === 'analyst' ? Linking.openURL('https://t.me/Claudeyyybot') : setOpen(open === k ? null : k))} style={s.morerow}>
            <View style={{ flex: 1 }}><Text style={s.moreT}>{t}</Text><Text style={s.moreS}>{sub}</Text></View>
            <Text style={{ color: C.accent, fontSize: 20 }}>{k === 'analyst' ? '↗' : open === k ? '−' : '›'}</Text>
          </Pressable>
          {open === k && k === 'strategy' ? <View style={{ padding: 12 }}><StrategyTab data={data} easy={easy} deep={deep} goArticle={goArticle} read={read} saved={saved} compact /></View> : null}
          {open === k && k === 'watch' ? (data.watch || []).map((w, i) => <Text key={i} style={s.li}><Text style={{ color: C.accent }}>› </Text>{decode(w)}</Text>) : null}
          {open === k && k === 'quiz' ? <View style={{ padding: 12 }}><QuizSection quiz={data.quiz} /></View> : null}
        </View>
      ))}
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
          <Text style={s.storyP}>{decode(d.summary || '')}</Text>
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
    <Section title="Scenario explorer" extra={items.length + ' branches'}>
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
    <Section title="Watchlist" extra={armed.length + ' armed'}>
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

function StrategyTab({ data, easy, deep, goArticle, read, saved, compact }) {
  const lec = data.lecture;
  // The desk opens on the wire, not the roster: newest stories first, same index
  // furniture as NEWS (lead panel + hairline rows), then the players below.
  const simple = (easy && data.easy && data.easy.brief) || [];
  const latest = briefSorted(data.brief).slice(0, 5);
  const [region, setRegion] = useState('ALL');
  const actorText = (a) => a.n + ' ' + a.r + ' ' + (a.w || '');
  const actors = (data.actors || []).filter((a) => region === 'ALL' || inferRegion(actorText(a)) === region);
  return (
    <View style={s.stack}>
      {latest.length && !compact ? (
        <View>
          <View style={s.masthead}>
            <Text style={s.mastT}>Latest</Text>
            <Text style={[s.mastD, MONO]}>{(data.brief || []).length + ' STORIES · ' + (data.updated || '')}</Text>
          </View>
          {latest.map(({ s: st, i }, n) => {
            const id = storyId(st);
            const props = { item: st, simpleText: simple[i], easy, deep, onOpen: () => goArticle && goArticle(i),
                            isRead: !!(read && read[id]), isSaved: !!(saved && saved[id]) };
            return n === 0 ? <LeadStory key={i} {...props} /> : <IndexRow key={i} {...props} dense={n >= 3} />;
          })}
        </View>
      ) : null}
      <StatStrip stats={[
        [(data.actors || []).length, 'PLAYERS'],
        [data.lecture ? (data.lecture.date || 'LIVE') : '—', 'DEEP DIVE'],
        [data.plumbing ? (data.plumbing.stage || 'LIVE') : '—', 'ECON READ'],
        [data.plumbing && data.plumbing.board ? data.plumbing.board.color : '—', 'RED BOARD'],
      ]} />
      {data.actors && data.actors.length ? (
        <Section title="The players" extra={actors.length + ' tracked'}>
          <FilterDrop pairs={textRegionPairs(data.actors, actorText)} active={region} onPick={setRegion} />
          {actors.map((a, i) => (
            <View key={i} style={s.actor}>
              <Text style={[s.actorName, SERIF]}>{decode(a.n)}</Text>
              <Text style={[s.actorRole, MONO]}>{decode(a.r).toUpperCase()}</Text>
              <Text style={s.actorRow}><Text style={s.actorK}>Really — </Text>{decode(a.w)}</Text>
              <Text style={s.actorRow}><Text style={s.actorK}>Wants — </Text>{decode(a.g)}</Text>
              <Text style={s.actorRow}><Text style={s.actorK}>Now — </Text>{decode(a.m)}</Text>
              <Text style={s.actorRow}><Text style={s.actorK}>Lens — </Text>{decode(a.l)}</Text>
            </View>
          ))}
        </Section>
      ) : null}
      <Dossiers items={data.dossiers} />
      <Scenarios items={data.scenarios} />
      {lec ? (
        <Section title="This week's deep dive" extra={lec.date}>
          <View style={s.prose}>
            <Text style={[s.h3, SERIF]}>{decode(lec.title)}</Text>
            {lec.sections.map((part, i) => (
              <View key={i}>
                <Text style={[s.kicker, MONO]}>{decode(part.h).toUpperCase()}</Text>
                <Text style={s.p}>{decode(part.t)}</Text>
              </View>
            ))}
          </View>
        </Section>
      ) : null}
      {data.plumbing ? (
        <Section title="The economic read" extra={data.plumbing.stage}>
          <View style={s.prose}>
            <Text style={s.p}>{decode(easy && data.easy ? data.easy.markets : data.plumbing.read)}</Text>
          </View>
        </Section>
      ) : null}
      {data.plumbing ? <RedBoard board={data.plumbing.board} /> : null}
      {data.plumbing ? <LiveWatchlist items={data.plumbing.series} /> : null}
      <QuizSection quiz={data.quiz} />
      <Text style={s.foot}>Deep analysis and opinion, for information only. Not financial, legal, or safety advice.</Text>
    </View>
  );
}

const LEVELS = [['simple', 'SIMPLE'], ['regular', 'REGULAR'], ['deep', 'DEEP']];
// Text size is the reader's, not the designer's. Three stops; the article/prose styles multiply by it.
const SIZES = [['S', 'S', 0.92], ['M', 'M', 1], ['L', 'L', 1.15]];
const TEXT_KEY = 'geo-textsize';
let TSCALE = 1;
const T = (fs, lh) => ({ fontSize: Math.round(fs * TSCALE * 10) / 10, lineHeight: lh ? Math.round(lh * TSCALE) : undefined });
function ModeToggle({ level, onChange, tsize, onSize, theme, onTheme }) {
  return (
    <View style={s.levelbar}>
      <Text style={[s.levelLbl, MONO]}>LEVEL</Text>
      <View style={s.modetog}>
        {LEVELS.map(([v, lab], i) => {
          const active = v === level;
          return (
            <Pressable key={v} onPress={() => onChange(v)} style={[s.modeBtn, i > 0 && s.modeBtnDiv, active && s.modeBtnActive]}>
              <Text style={[s.modeTxt, MONO, active && { color: C.text, fontWeight: '700' }]}>{lab}</Text>
            </Pressable>
          );
        })}
      </View>
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
  );
}

function DisclaimerGate({ onAccept }) {
  return (
    <SafeAreaView style={s.root}>
      <StatusBar style={THEME === 'light' ? 'dark' : 'light'} />
      <ScrollView contentContainerStyle={s.gateScroll}>
        <Text style={[s.wordmark, MONO, { fontSize: 17, marginBottom: 18 }]}>GEO<Text style={{ color: C.accent }}>/</Text>TERMINAL</Text>
        <Text style={[s.gateH, SERIF]}>Before you begin</Text>
        <Text style={s.gateP}>GEO Terminal publishes geopolitical analysis and probabilistic forecasts as <Text style={{ color: C.text, fontWeight: '700' }}>opinion</Text> — not fact, and not advice.</Text>
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
  const [tab, setTab] = useState('news');
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState('');
  const [boardSel, setBoardSel] = useState(null);   // board selection lives here so any tab can point at the map
  const goBoard = (i) => { setBoardSel(i); setTab('map'); };
  // Which story NEWS is showing as an article (null = the index). Lives up here so HOME
  // can hand the reader straight into a story, the way a front-page teaser does.
  const [article, setArticle] = useState(null);
  const scrollRef = useRef(null);
  const scrollTop = () => { if (scrollRef.current) scrollRef.current.scrollTo({ y: 0, animated: false }); };
  const goArticle = (i) => {
    const hit = data && (data.brief || [])[i];
    if (hit) markRead(storyId(hit));
    setArticle(i); setTab('news'); scrollTop();
  };
  // What you've opened and what you've kept. Both are per-device and never leave it.
  const [read, setRead] = useState({});
  const [saved, setSaved] = useState({});
  const markRead = useCallback((id) => setRead((r) => {
    if (r[id]) return r;
    const next = prune({ ...r, [id]: 1 }, 300);
    AsyncStorage.setItem(READ_KEY, JSON.stringify(next)).catch(() => {});
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
  useEffect(() => { AsyncStorage.getItem(THEME_KEY).then((v) => { if (v && THEMES[v] && v !== THEME) { applyTheme(v); setThemeState(v); } }).catch(() => {}); }, []);
  const setTheme = useCallback((v) => { applyTheme(v); setThemeState(v); AsyncStorage.setItem(THEME_KEY, v).catch(() => {}); }, []);
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
      if (v === 'simple' || v === 'regular' || v === 'deep') setLevel(v);
      else if (v === 'easy') setLevel('simple'); // migrate old two-way toggle
    }).catch(() => {});
  }, []);
  const accept = useCallback(() => { AsyncStorage.setItem(ACK_KEY, '1').catch(() => {}); setAcked(true); }, []);
  const setMode = useCallback((v) => { setLevel(v); AsyncStorage.setItem(MODE_KEY, v).catch(() => {}); }, []);

  const lastPull = useRef(0);
  const load = useCallback(async () => {
    try {
      const r = await fetch(`${FEED}?t=${Date.now()}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      setData(j); setErr(null); lastPull.current = Date.now();
      AsyncStorage.setItem(FEED_CACHE_KEY, JSON.stringify(j)).catch(() => {});
    } catch (e) { setErr(String(e.message || e)); }
  }, []);
  // open on the cached feed (no spinner, works offline), then pull the live one
  useEffect(() => {
    AsyncStorage.getItem(FEED_CACHE_KEY).then((v) => {
      try { if (v) setData((cur) => cur || JSON.parse(v)); } catch (e) {}
    }).catch(() => {}).finally(load);
  }, [load]);
  // the desk refreshes the wire several times a day: re-pull when the app comes back to the foreground
  useEffect(() => {
    const sub = AppState.addEventListener('change', (st) => {
      if (st === 'active' && Date.now() - lastPull.current > STALE_MS) load();
    });
    return () => sub.remove();
  }, [load]);
  const onRefresh = useCallback(async () => { setRefreshing(true); await load(); setRefreshing(false); }, [load]);

  if (acked === null) {
    return <SafeAreaProvider><SafeAreaView style={s.root}><View style={s.center}><ActivityIndicator color={C.accent} /></View></SafeAreaView></SafeAreaProvider>;
  }
  if (!acked) return <SafeAreaProvider><DisclaimerGate onAccept={accept} /></SafeAreaProvider>;

  const rc = data ? (riskColor[data.risk.color] || C.elev) : C.elev;
  return (
    <SafeAreaProvider>
      <SafeAreaView style={s.root} edges={['top']}>
        <StatusBar style={THEME === 'light' ? 'dark' : 'light'} />
        <View style={s.header}>
          <Text style={s.wordmark}>GEO Terminal</Text>
          <Text style={s.stamp}>{new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' }).toUpperCase()}</Text>
        </View>
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
          <ScrollView ref={scrollRef} contentContainerStyle={s.scroll} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={C.accent} />}>
            {searching ? (
              <SearchScreen data={data} query={query} setQuery={setQuery}
                goArticle={(i) => { setSearching(false); goArticle(i); }} goTab={(k) => { setSearching(false); setTab(k); scrollTop(); }} />
            ) : (
              <>
                {tab === 'news' && <NewsTab data={data} easy={easy} deep={deep} goTab={setTab} goBoard={null} article={article} setArticle={setArticle} scrollTop={scrollTop} read={read} saved={saved} markRead={markRead} toggleSave={toggleSave} tsize={tsize} onSize={setSize} theme={theme} onTheme={setTheme} level={level} onLevel={setMode} />}
                {tab === 'boards' && <BoardsTab data={data} goArticle={goArticle} />}
                {tab === 'conspiracy' && <ConspiracyTab data={data} easy={easy} deep={deep} goArticle={goArticle} read={read} saved={saved} />}
              </>
            )}
            <LegalFooter />
          </ScrollView>
        )}
        <SafeAreaView edges={['bottom']} style={s.navWrap}>
          <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 24, paddingTop: 12, paddingBottom: 8 }}>
            <View style={{ flexDirection: 'row', gap: 22, alignItems: 'center', flex: 1 }}>
              {TABS.map((t) => {
                const on = tab === t.key && !searching;
                return (
                  <Pressable key={t.key} hitSlop={10} onPress={() => { setSearching(false); setTab(t.key); if (t.key === 'news') setArticle(null); scrollTop(); }}>
                    <Text style={[{ fontSize: 16, fontWeight: on ? '800' : '600', color: on ? C.text : C.muted, paddingBottom: 4 }, on && { borderBottomWidth: 2, borderBottomColor: C.text }]}>{t.label}</Text>
                  </Pressable>
                );
              })}
            </View>
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
  header: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', paddingHorizontal: 24, paddingTop: 14, paddingBottom: 14, borderBottomWidth: 2, borderBottomColor: C.text },
  statusdot: { width: 8, height: 8, borderRadius: 4, shadowOpacity: 0.9, shadowRadius: 5 },
  wordmark: { color: C.text, fontFamily: 'Charter', fontWeight: '600', letterSpacing: -0.3, fontSize: 22 },
  classbar: { backgroundColor: C.elev, color: C.ink, textAlign: 'center', fontSize: 9, letterSpacing: 3, paddingVertical: 3, fontWeight: '700' },
  stamp: { color: C.muted, fontSize: 12, fontWeight: '700', letterSpacing: 1.2 },
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
  gauge: { backgroundColor: C.panel, borderWidth: 1, borderColor: C.line, borderRadius: 6, padding: 18 },
  gtop: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 13 },
  glabel: { fontSize: 9.5, letterSpacing: 2, color: C.muted },
  gstate: { fontSize: 24, fontWeight: '700' },
  meter: { flexDirection: 'row', gap: 3, height: 9, marginBottom: 7, position: 'relative' },
  zone: { flex: 1, borderRadius: 2 },
  needle: { position: 'absolute', top: -4, width: 12, height: 17, backgroundColor: C.accent, borderRadius: 2, borderWidth: 2, borderColor: C.panel },
  gscale: { flexDirection: 'row', justifyContent: 'space-between' },
  gscaleTxt: { fontSize: 8, letterSpacing: 0.5, color: C.muted },
  gline: { color: C.text, fontFamily: 'Charter', fontSize: 17, lineHeight: 25, marginTop: -8, paddingHorizontal: 4 },
  // plain lead
  plainLead: { backgroundColor: C.panel, borderWidth: 1, borderColor: C.accentDim, borderLeftWidth: 3, borderLeftColor: C.accent, borderRadius: 6, padding: 14 },
  plainLbl: { fontSize: 10, fontWeight: '700', letterSpacing: 2, color: C.accent },
  plainP: { color: C.text, fontSize: 16.5, lineHeight: 25, marginTop: 6 },
  // brief / story
  briefhead: { flexDirection: 'row', alignItems: 'baseline', gap: 8, paddingHorizontal: 4, paddingTop: 2 },
  briefT: { fontSize: 11, fontWeight: '700', letterSpacing: 2.4, color: C.muted },
  briefD: { marginLeft: 'auto', fontSize: 10, color: C.accent, letterSpacing: 0.6 },
  // ── FRONT PAGE ──────────────────────────────────────────────────────────────
  // A newspaper's grid is made of type weight and hairlines, not boxes. The index
  // rows have no card chrome at all: a rule separates them, and size says rank.
  masthead: { flexDirection: 'row', alignItems: 'baseline', borderBottomWidth: 1, borderBottomColor: C.line, paddingBottom: 10, paddingHorizontal: 2 },
  mastT: { color: C.text, fontSize: 24, fontWeight: '800', letterSpacing: -0.4 },
  mastD: { marginLeft: 'auto', color: C.muted, fontSize: 12 },
  dayrule: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 22, marginBottom: 4 },
  daytxt: { color: C.muted, fontSize: 12, fontWeight: '700', letterSpacing: 1.2 },
  dayline: { flex: 1, height: 1, backgroundColor: C.line },
  kick: { color: C.accent, fontSize: 12, fontWeight: '700', letterSpacing: 1.2, flex: 1 },
  idxmeta: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 7 },
  idxtime: { color: C.muted, fontSize: 12 },
  // the lead is the only story on the page that gets a panel — that IS its emphasis
  lead: { backgroundColor: C.panel, borderWidth: 1, borderColor: C.line, borderRadius: 14, padding: 18 },
  leadH: { color: C.text, fontSize: 30, lineHeight: 35, fontWeight: '700' },
  leadDek: { color: C.muted, fontFamily: 'Charter', fontSize: 17, lineHeight: 25, marginTop: 12 },
  idxfoot: { flexDirection: 'row', alignItems: 'center', marginTop: 12 },
  readmore: { color: C.accent, fontSize: 13, fontWeight: '700' },
  idxsrc: { marginLeft: 'auto', color: C.muted, fontSize: 12 },
  idxrow: { borderTopWidth: 1, borderTopColor: C.line, paddingTop: 20, paddingBottom: 8, paddingHorizontal: 2 },
  idxH: { color: C.text, fontSize: 22, lineHeight: 28, fontWeight: '700' },
  idxDek: { color: C.muted, fontFamily: 'Charter', fontSize: 16, lineHeight: 23, marginTop: 8 },
  teaseH: { color: C.text, fontSize: 18, lineHeight: 24, fontWeight: '700', marginTop: 1 },
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
  rctl: { color: C.muted, fontSize: 13, fontWeight: '600' },
  hrow: { paddingVertical: 18, paddingHorizontal: 4, borderBottomWidth: 1, borderBottomColor: C.line },
  hrowH: { fontFamily: 'Charter', fontSize: 24, lineHeight: 29, fontWeight: '600', color: C.text, letterSpacing: -0.3 },
  hrowMeta: { color: C.accent, fontSize: 12, fontWeight: '700', letterSpacing: 1.2, marginTop: 8 },
  searchbox: { flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: C.panel, borderWidth: 1.5, borderColor: C.text, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 4 },
  searchin: { flex: 1, fontSize: 17, paddingVertical: 10 },
  searchH: { color: C.muted, fontSize: 12, fontWeight: '700', letterSpacing: 1.2, marginTop: 22, marginBottom: 2 },
  morerow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 14, borderTopWidth: 1, borderTopColor: C.line },
  moreT: { fontSize: 17, fontWeight: '700', color: C.text },
  moreS: { fontSize: 13, color: C.muted, marginTop: 2 },
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
  spine: { position: 'absolute', left: 12, top: 22, bottom: 20, width: 2, borderRadius: 2, backgroundColor: C.accentDim },
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
  tabintro: { paddingHorizontal: 6 },
  tabintroP: { color: C.muted, fontFamily: 'Charter', fontSize: 16.5, lineHeight: 25 },
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
  actor: { paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: C.line },
  actorName: { color: C.text, fontSize: 19, letterSpacing: -0.2, fontWeight: '700' },
  actorRole: { color: C.accent, fontSize: 12, fontWeight: '700', letterSpacing: 0.8, marginTop: 2, marginBottom: 6 },
  actorRow: { color: C.text, fontFamily: 'Charter', fontSize: 16, lineHeight: 23, marginVertical: 3 },
  actorK: { color: C.muted, fontWeight: '600' },
  // prose
  prose: { paddingHorizontal: 16, paddingBottom: 14, paddingTop: 4 },
  h3: { color: C.text, fontSize: 24, letterSpacing: -0.3, fontWeight: '700', marginTop: 12, marginBottom: 6 },
  kicker: { color: C.muted, fontSize: 12, fontWeight: '700', letterSpacing: 1.2, marginTop: 14, marginBottom: 3 },
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
  nav: { flexDirection: 'row', justifyContent: 'space-around', paddingVertical: 9, paddingHorizontal: 4 },
  navBtn: { alignItems: 'center', paddingVertical: 6, paddingHorizontal: 10 },
  navTxt: { color: C.muted, fontSize: 11, letterSpacing: 1.4 },
  navUnder: { marginTop: 5, width: 16, height: 2, borderRadius: 2, backgroundColor: C.accent },
});
}
let s = buildStyles();
