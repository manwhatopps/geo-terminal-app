import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator, Linking, Pressable, RefreshControl, ScrollView,
  StyleSheet, Text, View,
} from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Svg, { Circle, Line, Path as SvgPath, Rect } from 'react-native-svg';
import { LAND_PATH } from './worldmap';

const FEED = 'https://raw.githubusercontent.com/manwhatopps/geo-terminal-feed/main/data.json';
const ACK_KEY = 'geo-disclaimer-ack-v1';
const MODE_KEY = 'geo-mode';
const LEGAL = {
  terms: 'https://manwhatopps.github.io/geo-terminal-feed/terms.html',
  privacy: 'https://manwhatopps.github.io/geo-terminal-feed/privacy.html',
  disclaimer: 'https://manwhatopps.github.io/geo-terminal-feed/disclaimer.html',
};

// SIGINT terminal — phosphor green on near-black, amber for warnings, typewriter headlines.
// (Mirrors dashboard.html's dark :root; the old navy "Situation Room" palette is retired.)
// Black + gold intelligence-agency (per user's reference mockup): near-black field,
// dark cards, gold as THE accent. Severity stays amber->orange->red.
const C = {
  ink: '#09090B', panel: '#141317', panel2: '#0E0D10', line: '#2E2A20',
  text: '#EDE7D8', muted: '#8D8574', accent: '#D4AF37', accentDim: '#8A7222',
  calm: '#4C9A70', elev: '#D99A2B', high: '#E1662E', crit: '#D93B3B',
  barBg: '#0E0D10', chip: '#221F18',
};
const riskColor = { calm: C.calm, elev: C.elev, high: C.high, crit: C.crit };
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
// DECODE tab verdicts. Reuses the risk palette so a verdict badge reads on the same scale as the
// threat gauge: green = the claim survives, red = it does not. Mirrors dashboard.html's VERDICT_META.
const VERDICT_META = {
  true: { c: C.calm, label: 'TRUE' },
  partly: { c: C.elev, label: 'PARTLY TRUE' },
  framing: { c: C.high, label: 'FRAMING' },
  false: { c: C.crit, label: 'FALSE' },
};
const MONO = { fontFamily: 'Menlo', fontVariant: ['tabular-nums'] };
const SERIF = { fontFamily: 'Georgia', fontWeight: '700' };  // refined dossier headlines (gold-agency register)

// Feed strings carry HTML entities (web decodes via innerHTML; RN <Text> shows them literally).
function decode(s) {
  return String(s == null ? '' : s)
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}
// ── news region filter + chronological ordering ──
const REGION_KEY = 'geo-region';
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
const TABS = [
  { key: 'home', label: 'HOME', g: '⌂' },
  { key: 'map', label: 'MAP', g: '◈' },
  { key: 'news', label: 'NEWS', g: '▤' },
  { key: 'conspiracy', label: 'CONSP.', g: '◉' },
  { key: 'strategy', label: 'STRAT.', g: '♟' },
  { key: 'decode', label: 'DECODE', g: '⌖' },
];

function Section({ title, extra, children }) {
  return (
    <View style={s.section}>
      <View style={s.h2row}>
        <Text style={s.h2}>{title.toUpperCase()}</Text>
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

function StoryCard({ item, simpleText, easy, deep, onBoard, callsCount, onCalls }) {
  const [open, setOpen] = useState(deep);
  // DEEP's whole effect is auto-expansion — useState only reads `deep` on FIRST render, so
  // without this sync, toggling REGULAR<->DEEP after mount visibly did nothing (user-reported).
  useEffect(() => { setOpen(deep); }, [deep]);
  const body = easy && simpleText ? simpleText : item.t;
  return (
    <View style={s.storycard}>
      <View style={s.spine} />
      <View style={s.cardmeta}>
        {item.tag ? <Text style={[s.ktag, MONO, { marginBottom: 0 }]}>{decode(item.tag).toUpperCase()}</Text> : <View />}
        {fullStamp(item.ts) ? <Text style={[s.stime, MONO]}>{fullStamp(item.ts)}</Text> : null}
      </View>
      <Text style={[s.storyH3, SERIF, easy && { fontSize: 21 }]}>{decode(item.h)}</Text>
      <Text style={[s.storyP, easy && { fontSize: 16.5, lineHeight: 27 }]}>{decode(body)}</Text>
      {item.context && !easy ? (
        <>
          <Pressable style={s.ctxbtn} onPress={() => setOpen((o) => !o)}>
            <Text style={[s.ctxbtnTxt, MONO]}>{(open ? '− ' : '＋ ') + 'WHY THIS IS HAPPENING'}</Text>
          </Pressable>
          {open && (
            <View style={s.ctxpanel}>
              <Text style={[s.ctxlbl, MONO]}>THE CONTEXT, THE HISTORY, AND WHAT WOULD CHANGE IT</Text>
              <Text style={s.ctxP}>{decode(item.context)}</Text>
            </View>
          )}
        </>
      ) : null}
      {!easy && (onBoard || callsCount > 0) ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
          {onBoard ? <WebLink label="◉ ON THE BOARD ↑" onPress={onBoard} /> : null}
          {callsCount > 0 ? (
            <WebLink label={'OUR CALLS ON ' + (item.region || 'THIS').toUpperCase() + ' (' + callsCount + ') →'} onPress={onCalls} />
          ) : null}
        </View>
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

function HomeTab({ data, easy, deep, goTab }) {
  const rline = data.risk.line;
  const tiles = [
    ['news', '▤', 'NEWS', (data.brief || []).length, 'stories on the wire'],
    ['conspiracy', '◉', 'CONSPIRACY', (data.forecasts || []).length, 'live calls, publicly scored'],
    ['strategy', '♟', 'STRATEGY', (data.actors || []).length, 'decision-makers tracked'],
    ['decode', '⌖', 'DECODE', (data.decode || []).length, 'claims interrogated'],
  ];
  const topDevs = briefSorted(data.brief).slice(0, 3);
  return (
    <View style={s.stack}>
      <ThreatGauge risk={data.risk} events={data.events} forecasts={data.forecasts} />
      <WhyPosture text={rline} deep={deep} />
      <CostCard cost={data.cost} />
      <Section title="Top developments" extra="SEE ALL ›">
        {topDevs.map(({ s: st }, i) => (
          <Pressable key={i} onPress={() => goTab('news')}
            style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 9, borderBottomWidth: i < topDevs.length - 1 ? 1 : 0, borderColor: C.line }}>
            <View style={{ width: 7, height: 7, borderRadius: 4, marginRight: 10, backgroundColor: riskColor[(data.events || []).find((e) => evRegion(e) === st.region)?.sev] || C.elev }} />
            <View style={{ flex: 1 }}>
              <Text style={{ color: C.text, fontSize: 13.5 }} numberOfLines={2}>{decode(st.h)}</Text>
              <Text style={[MONO, { color: C.muted, fontSize: 9, marginTop: 2 }]}>{(st.region || '').toUpperCase() + (st.tag ? ' · ' + decode(st.tag).toUpperCase() : '')}</Text>
            </View>
            <Text style={{ color: C.accent, fontSize: 16, marginLeft: 8 }}>›</Text>
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

function NewsTab({ data, easy, deep, goTab, goBoard }) {
  const simple = (easy && data.easy && data.easy.brief) || [];
  const [region, setRegion] = useState('ALL');
  useEffect(() => { AsyncStorage.getItem(REGION_KEY).then((v) => { if (v) setRegion(v); }).catch(() => {}); }, []);
  const choose = (r) => { setRegion(r); AsyncStorage.setItem(REGION_KEY, r).catch(() => {}); };

  const regions = regionsPresent(data.brief);
  const active = region === 'ALL' || regions.includes(region) ? region : 'ALL';
  const counts = {}; for (const s of (data.brief || [])) if (s.region) counts[s.region] = (counts[s.region] || 0) + 1;
  const chips = [['ALL', 'All', (data.brief || []).length]].concat(regions.map((r) => [r, r, counts[r] || 0]));
  const rows = briefSorted(data.brief).filter(({ s }) => active === 'ALL' || s.region === active);

  return (
    <View style={s.stack}>
      <StatStrip stats={[
        [(data.brief || []).length, 'STORIES'],
        [regions.length, 'THEATERS'],
        [(data.updated || '').split(' ')[1] || '—', 'UPDATED'],
      ]} />
      <PlainLead text={easy && data.easy ? data.easy.bottomLine : null} />
      <View style={s.briefhead}>
        <Text style={[s.briefT, MONO]}>LATEST HEADLINES</Text>
        <Text style={[s.briefD, MONO]}>{data.updated}</Text>
      </View>
      {regions.length ? <FilterDrop pairs={chips} active={active} onPick={choose} /> : null}
      {rows.length
        ? rows.map(({ s, i }) => {
            const evIdx = (data.events || []).findIndex((ev) => evRegion(ev) === s.region);
            const calls = regionForecasts(data, s.region).length;
            return (
              <StoryCard key={i} item={s} simpleText={simple[i]} easy={easy} deep={deep}
                onBoard={evIdx >= 0 && goBoard ? () => goBoard(evIdx) : null}
                callsCount={calls} onCalls={() => goTab('conspiracy')} />
            );
          })
        : <Text style={s.foot}>No headlines in this filter right now.</Text>}
      {data.watch && data.watch.length ? (
        <Section title="What to watch next">
          {data.watch.map((w, i) => (
            <Text key={i} style={s.li}><Text style={{ color: C.accent }}>› </Text>{decode(w)}</Text>
          ))}
        </Section>
      ) : null}
      <QuizSection quiz={data.quiz} />
      <Text style={s.foot}>Headlines refresh through the day. Analysis and opinion, for information only — not advice.</Text>
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

function ConspiracyTab({ data }) {
  const [region, setRegion] = useState('ALL');
  const cFilter = (txt) => region === 'ALL' || inferRegion(txt) === region;
  const hyps = (data.hypotheses || []).filter((h) => cFilter(h.name + ' ' + h.d));
  const fcs = (data.forecasts || []).filter((f) => cFilter(f.q));
  const movedN = (data.forecasts || []).filter((f) => f.prev != null && f.p !== f.prev).length;
  return (
    <View style={s.stack}>
      <StatStrip stats={[
        [(data.forecasts || []).length, 'LIVE CALLS'],
        [movedN, 'MOVED TODAY'],
        [(data.hypotheses || []).length, 'HYPOTHESES'],
      ]} />
      <CalibrationTrack track={data.track} forecasts={data.forecasts} />
      <FilterDrop
        pairs={textRegionPairs([...(data.hypotheses || []).map((h) => h.name + ' ' + h.d), ...(data.forecasts || []).map((f) => f.q)], (x) => x)}
        active={region} onPick={setRegion} />
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
      <Section title="Predictions on the board" extra={String(fcs.length)}>
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
      <QuizSection quiz={data.quiz} />
      <Text style={s.foot}>Probabilities are subjective estimates and will often be wrong — that's the point of keeping score. Not advice.</Text>
    </View>
  );
}

function StrategyTab({ data, easy }) {
  const lec = data.lecture;
  const [region, setRegion] = useState('ALL');
  const actorText = (a) => a.n + ' ' + a.r + ' ' + (a.w || '');
  const actors = (data.actors || []).filter((a) => region === 'ALL' || inferRegion(actorText(a)) === region);
  return (
    <View style={s.stack}>
      <StatStrip stats={[
        [(data.actors || []).length, 'PLAYERS'],
        [data.lecture ? (data.lecture.date || 'LIVE') : '—', 'DEEP DIVE'],
        [data.plumbing ? (data.plumbing.stage || 'LIVE') : '—', 'ECON READ'],
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
      <QuizSection quiz={data.quiz} />
      <Text style={s.foot}>Deep analysis and opinion, for information only. Not financial, legal, or safety advice.</Text>
    </View>
  );
}

const LEVELS = [['simple', 'SIMPLE'], ['regular', 'REGULAR'], ['deep', 'DEEP']];
function ModeToggle({ level, onChange }) {
  return (
    <View style={s.levelbar}>
      <Text style={[s.levelLbl, MONO]}>READING LEVEL</Text>
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
    </View>
  );
}

function DisclaimerGate({ onAccept }) {
  return (
    <SafeAreaView style={s.root}>
      <StatusBar style="light" />
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
  const [tab, setTab] = useState('home');
  const [boardSel, setBoardSel] = useState(null);   // board selection lives here so any tab can point at the map
  const goBoard = (i) => { setBoardSel(i); setTab('map'); };
  const [refreshing, setRefreshing] = useState(false);
  const [acked, setAcked] = useState(null);
  const [level, setLevel] = useState('regular');
  const easy = level === 'simple', deep = level === 'deep';

  useEffect(() => {
    AsyncStorage.getItem(ACK_KEY).then((v) => setAcked(v === '1')).catch(() => setAcked(false));
    AsyncStorage.getItem(MODE_KEY).then((v) => {
      if (v === 'simple' || v === 'regular' || v === 'deep') setLevel(v);
      else if (v === 'easy') setLevel('simple'); // migrate old two-way toggle
    }).catch(() => {});
  }, []);
  const accept = useCallback(() => { AsyncStorage.setItem(ACK_KEY, '1').catch(() => {}); setAcked(true); }, []);
  const setMode = useCallback((v) => { setLevel(v); AsyncStorage.setItem(MODE_KEY, v).catch(() => {}); }, []);

  const load = useCallback(async () => {
    try {
      const r = await fetch(`${FEED}?t=${Date.now()}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setData(await r.json()); setErr(null);
    } catch (e) { setErr(String(e.message || e)); }
  }, []);
  useEffect(() => { load(); }, [load]);
  const onRefresh = useCallback(async () => { setRefreshing(true); await load(); setRefreshing(false); }, [load]);

  if (acked === null) {
    return <SafeAreaProvider><SafeAreaView style={s.root}><View style={s.center}><ActivityIndicator color={C.accent} /></View></SafeAreaView></SafeAreaProvider>;
  }
  if (!acked) return <SafeAreaProvider><DisclaimerGate onAccept={accept} /></SafeAreaProvider>;

  const rc = data ? (riskColor[data.risk.color] || C.elev) : C.elev;
  return (
    <SafeAreaProvider>
      <SafeAreaView style={s.root} edges={['top']}>
        <StatusBar style="light" />
        <View style={s.header}>
          <View style={[s.statusdot, { backgroundColor: rc, shadowColor: rc }]} />
          <Text style={[s.wordmark, MONO]}>GEO<Text style={{ color: C.accent }}>/</Text>TERMINAL<BlinkCursor /></Text>
          <Text style={[s.stamp, MONO]}>{data ? data.updated : ''}</Text>
        </View>
        {tab !== 'home' && tab !== 'map' ? <ModeToggle level={level} onChange={setMode} /> : null}
        {!data && !err && <View style={s.center}><ActivityIndicator color={C.accent} size="large" /></View>}
        {!data && err && (
          <View style={s.center}>
            <Text style={s.p}>Couldn't reach the feed ({err}).</Text>
            <Pressable onPress={load} style={s.retry}><Text style={[s.retryTxt, MONO]}>RETRY</Text></Pressable>
          </View>
        )}
        {data && (
          <ScrollView contentContainerStyle={s.scroll} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={C.accent} />}>
            {tab === 'home' && <HomeTab data={data} easy={easy} deep={deep} goTab={setTab} />}
            {tab === 'map' && <MapTab data={data} easy={easy} goTab={setTab} boardSel={boardSel} setBoardSel={setBoardSel} />}
            {tab === 'news' && <NewsTab data={data} easy={easy} deep={deep} goTab={setTab} goBoard={goBoard} />}
            {tab === 'conspiracy' && <ConspiracyTab data={data} />}
            {tab === 'strategy' && <StrategyTab data={data} easy={easy} />}
            {tab === 'decode' && <DecodeTab data={data} easy={easy} deep={deep} goTab={setTab} />}
            <LegalFooter />
          </ScrollView>
        )}
        <SafeAreaView edges={['bottom']} style={s.navWrap}>
          {/* segmented pill, same organizing bubble as the READING LEVEL selector up top */}
          <View style={[s.modetog, { marginHorizontal: 12, marginVertical: 8, flex: 0 }]}>
            {TABS.map((t, i) => {
              const on = tab === t.key;
              return (
                <Pressable key={t.key} onPress={() => setTab(t.key)}
                  style={[s.modeBtn, i > 0 && s.modeBtnDiv, on && s.modeBtnActive]}>
                  <Text style={{ fontSize: 15, color: on ? C.accent : C.muted, lineHeight: 17 }}>{t.g}</Text>
                  <Text style={[s.modeTxt, MONO, { fontSize: 7, letterSpacing: 0.5 }, on && { color: C.text, fontWeight: '700' }]} numberOfLines={1}>{t.label}</Text>
                </Pressable>
              );
            })}
          </View>
        </SafeAreaView>
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.ink },
  header: { flexDirection: 'row', alignItems: 'center', gap: 9, paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: C.line },
  statusdot: { width: 8, height: 8, borderRadius: 4, shadowOpacity: 0.9, shadowRadius: 5 },
  wordmark: { color: C.text, fontWeight: '800', letterSpacing: 3, fontSize: 14, textShadowColor: C.accent, textShadowRadius: 8 },
  classbar: { backgroundColor: C.elev, color: C.ink, textAlign: 'center', fontSize: 9, letterSpacing: 3, paddingVertical: 3, fontWeight: '700' },
  stamp: { color: C.muted, fontSize: 10, marginLeft: 'auto', letterSpacing: 0.5 },
  levelbar: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 16, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: C.line, backgroundColor: C.panel2 },
  levelLbl: { color: C.muted, fontSize: 9, letterSpacing: 1.5 },
  modetog: { flex: 1, flexDirection: 'row', borderWidth: 1, borderColor: C.line, borderRadius: 5, overflow: 'hidden' },
  modeBtn: { flex: 1, paddingVertical: 6, alignItems: 'center' },
  modeBtnDiv: { borderLeftWidth: 1, borderLeftColor: C.line },
  modeBtnActive: { backgroundColor: C.chip },
  modeTxt: { color: C.muted, fontSize: 10, letterSpacing: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 14 },
  retry: { borderWidth: 1, borderColor: C.accent, borderRadius: 4, paddingVertical: 8, paddingHorizontal: 22 },
  retryTxt: { color: C.accent, letterSpacing: 2, fontSize: 13 },
  scroll: { padding: 15, gap: 18 },
  stack: { gap: 18 },
  section: { backgroundColor: C.panel, borderWidth: 1, borderColor: C.line, borderRadius: 5, overflow: 'hidden' },
  h2row: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: C.panel2, paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: C.line },
  h2: { color: C.muted, fontSize: 10, fontWeight: '700', letterSpacing: 2.2, fontFamily: 'Menlo' },
  h2rule: { flex: 1, height: 1, backgroundColor: C.line },
  h2extra: { color: C.accent, fontSize: 10, letterSpacing: 0.6 },
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
  gline: { color: C.text, fontSize: 14.5, lineHeight: 22, marginTop: -8, paddingHorizontal: 4 },
  // plain lead
  plainLead: { backgroundColor: C.panel, borderWidth: 1, borderColor: C.accentDim, borderLeftWidth: 3, borderLeftColor: C.accent, borderRadius: 6, padding: 14 },
  plainLbl: { fontSize: 10, fontWeight: '700', letterSpacing: 2, color: C.accent },
  plainP: { color: C.text, fontSize: 14.5, lineHeight: 22, marginTop: 6 },
  // brief / story
  briefhead: { flexDirection: 'row', alignItems: 'baseline', gap: 8, paddingHorizontal: 4, paddingTop: 2 },
  briefT: { fontSize: 11, fontWeight: '700', letterSpacing: 2.4, color: C.muted },
  briefD: { marginLeft: 'auto', fontSize: 10, color: C.accent, letterSpacing: 0.6 },
  storycard: { position: 'relative', backgroundColor: C.panel, borderWidth: 1, borderColor: C.line, borderRadius: 5, paddingTop: 22, paddingBottom: 20, paddingLeft: 26, paddingRight: 22 },
  spine: { position: 'absolute', left: 12, top: 22, bottom: 20, width: 2, borderRadius: 2, backgroundColor: C.accentDim },
  ktag: { fontSize: 9.5, fontWeight: '700', letterSpacing: 1.8, color: C.muted, marginBottom: 11 },
  cardmeta: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 11 },
  stime: { fontSize: 10.5, color: C.muted, letterSpacing: 0.6 },
  rfilter: { flexDirection: 'row', gap: 7, paddingHorizontal: 4, paddingVertical: 4 },
  rchip: { backgroundColor: C.panel2, borderWidth: 1, borderColor: C.line, borderRadius: 999, paddingVertical: 6, paddingHorizontal: 13 },
  rchipOn: { backgroundColor: C.accentDim, borderColor: C.accentDim },
  rchipTxt: { fontSize: 11, letterSpacing: 0.6, color: C.muted },
  storyH3: { fontSize: 22, lineHeight: 27, fontWeight: '700', color: C.text, marginBottom: 12 },
  storyP: { fontSize: 15, lineHeight: 25, color: C.text },
  ctxbtn: { marginTop: 15, alignSelf: 'flex-start', borderWidth: 1, borderColor: C.accentDim, borderRadius: 6, paddingVertical: 8, paddingHorizontal: 14 },
  ctxbtnTxt: { color: C.accent, fontSize: 10.5, fontWeight: '600', letterSpacing: 1.4 },
  ctxpanel: { marginTop: 14, padding: 15, backgroundColor: C.panel2, borderLeftWidth: 3, borderLeftColor: C.accent, borderRadius: 7 },
  ctxlbl: { fontSize: 9.5, letterSpacing: 1.6, color: C.muted, marginBottom: 8 },
  ctxP: { fontSize: 14, lineHeight: 24, color: C.text },
  li: { color: C.text, fontSize: 13.5, lineHeight: 19, paddingHorizontal: 16, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: C.line },
  foot: { color: C.muted, fontSize: 11, lineHeight: 17, paddingHorizontal: 6 },
  // tab intro
  tabintro: { paddingHorizontal: 6 },
  tabintroP: { color: C.muted, fontSize: 13.5, lineHeight: 22 },
  // calibration
  cal: { padding: 16 },
  calbig: { flexDirection: 'row', alignItems: 'baseline', gap: 12 },
  calnum: { fontSize: 34, fontWeight: '800', color: C.accent },
  callab: { fontSize: 9.5, letterSpacing: 1.4, color: C.muted },
  calsay: { fontSize: 12.5, color: C.muted, lineHeight: 19, marginTop: 10, marginBottom: 12 },
  calstrip: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  caldot: { width: 11, height: 11, borderRadius: 6 },
  caldotHit: { backgroundColor: C.calm },
  caldotMiss: { backgroundColor: C.crit },
  caldotPend: { borderWidth: 1.5, borderColor: C.accentDim },
  // hypotheses
  hyp: { flexDirection: 'row', gap: 12, paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: C.line },
  hypP: { color: C.accent, fontWeight: '700', minWidth: 44, fontSize: 15 },
  hypName: { color: C.text, fontWeight: '600', fontSize: 13.5 },
  hypD: { color: C.muted, fontSize: 12.5, marginTop: 3, lineHeight: 18 },
  // predictions
  pred: { paddingHorizontal: 16, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: C.line },
  predtop: { flexDirection: 'row', alignItems: 'baseline', gap: 10 },
  predq: { flex: 1, fontSize: 14.5, fontWeight: '600', color: C.text, lineHeight: 19 },
  predp: { fontSize: 21, fontWeight: '800', color: C.accent },
  predpS: { fontSize: 12, fontWeight: '400', color: C.muted },
  predmeta: { flexDirection: 'row', gap: 10, alignItems: 'center', marginTop: 4 },
  chip: { backgroundColor: C.chip, borderRadius: 3, paddingHorizontal: 7, paddingVertical: 1, fontSize: 11 },
  predmetaTxt: { color: C.muted, fontSize: 11 },
  prednote: { color: C.muted, fontSize: 12.5, marginTop: 7, lineHeight: 19 },
  bar: { height: 5, borderRadius: 3, backgroundColor: C.barBg, marginTop: 11, marginBottom: 8 },
  fill: { position: 'absolute', left: 0, top: 0, bottom: 0, borderRadius: 3, backgroundColor: C.accent },
  tick: { position: 'absolute', top: -3, width: 2, height: 11, backgroundColor: C.muted },
  // actors
  actor: { paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: C.line },
  actorName: { color: C.text, fontSize: 16, fontWeight: '700' },
  actorRole: { color: C.accent, fontSize: 10, letterSpacing: 0.8, marginTop: 2, marginBottom: 6 },
  actorRow: { color: C.text, fontSize: 12.5, lineHeight: 18, marginVertical: 2 },
  actorK: { color: C.muted, fontWeight: '600' },
  // prose
  prose: { paddingHorizontal: 16, paddingBottom: 14, paddingTop: 4 },
  h3: { color: C.text, fontSize: 19, fontWeight: '700', marginTop: 12, marginBottom: 6 },
  kicker: { color: C.muted, fontSize: 11, letterSpacing: 2.5, marginTop: 14, marginBottom: 3 },
  p: { color: C.text, fontSize: 14, lineHeight: 22, marginVertical: 5 },
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
  navWrap: { backgroundColor: C.panel2, borderTopWidth: 1, borderTopColor: C.line },
  nav: { flexDirection: 'row', justifyContent: 'space-around', paddingVertical: 9, paddingHorizontal: 4 },
  navBtn: { alignItems: 'center', paddingVertical: 6, paddingHorizontal: 10 },
  navTxt: { color: C.muted, fontSize: 11, letterSpacing: 1.4 },
  navUnder: { marginTop: 5, width: 16, height: 2, borderRadius: 2, backgroundColor: C.accent },
});
