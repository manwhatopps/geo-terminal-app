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

// "Analyst's Desk in a Situation Room" — nautical-chart navy, document-paper cards, cyan = instrument light.
const C = {
  ink: '#0B1220', panel: '#20263A', panel2: '#141D2E', line: '#2A3A57',
  text: '#E8EDF5', muted: '#93A2BE', accent: '#3FE0D0', accentDim: '#0E8C86',
  calm: '#5B9E7A', elev: '#E0B24A', high: '#E08A3C', crit: '#E5544E',
  barBg: '#141D2E', chip: '#26324E',
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
            <Text style={[s.rchipTxt, MONO, on && { color: C.ink, fontWeight: '700' }]}>
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
const SERIF = { fontFamily: 'Georgia' };

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
const TABS = [
  { key: 'news', label: 'NEWS' },
  { key: 'conspiracy', label: 'CONSPIRACY' },
  { key: 'strategy', label: 'STRATEGY' },
  { key: 'decode', label: 'DECODE' },
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
        <Text style={[s.glabel, MONO]}>BOARD PRESSURE</Text>
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
        {['CALM', 'ELEVATED', 'HIGH', 'CRITICAL'].map((t) => (
          <Text key={t} style={[s.gscaleTxt, MONO]}>{t}</Text>
        ))}
      </View>
    </View>
  );
}

function StoryCard({ item, simpleText, easy, deep, onBoard, callsCount, onCalls }) {
  const [open, setOpen] = useState(deep);
  const body = easy && simpleText ? simpleText : item.t;
  return (
    <View style={s.storycard}>
      <View style={s.spine} />
      <View style={s.cardmeta}>
        {item.tag ? <Text style={[s.ktag, MONO, { marginBottom: 0 }]}>{decode(item.tag).toUpperCase()}</Text> : <View />}
        {timeLabel(item.ts) ? <Text style={[s.stime, MONO]}>{timeLabel(item.ts)}</Text> : null}
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

// ── THE BOARD — the situation-room wall map. Tap a point, get the read. Learning is invited
// (every dot is a question), never forced (the brief below works without touching it). ──
function WorldMap({ events, sel, onSelect, onFilter, goTab, data }) {
  if (!events || !events.length) return null;
  const setSel = onSelect;
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
        {e ? (
          <>
            <Text style={[s.ctxlbl, MONO, { color: selC }]}>
              {'■ ' + decode(e.label).toUpperCase() + '  · ' + coords + ' · ' + (e.sev || 'elev').toUpperCase()}
            </Text>
            <Text style={s.ctxP}>{decode(e.note)}</Text>
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
          <>
            <Text style={[s.ctxlbl, MONO]}>TAP A POINT FOR THE ANALYST'S READ</Text>
            <Text style={s.ctxP}>Each dot is a live pressure point from today's brief — amber elevated, orange high, red critical. Analyst-geocoded, not a sensor feed; it moves when the brief moves.</Text>
          </>
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
        {timeLabel(item.ts) ? <Text style={[s.stime, MONO]}>{timeLabel(item.ts)}</Text> : null}
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
      <View style={s.tabintro}>
        <Text style={s.tabintroP}>
          When someone important announces something big, this tab checks it. Was it actually signed, or just said?
          How long would it really take? And who does it help — and who ends up paying?
        </Text>
      </View>
      <View style={s.briefhead}>
        <Text style={[s.briefT, MONO]}>CLAIMS DECODED</Text>
        <Text style={[s.briefD, MONO]}>{data.updated}</Text>
      </View>
      {items.length ? (
        <ChipBar
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
      <Text style={s.foot}>Analysis and opinion, for information only — not advice.</Text>
    </View>
  );
}

function NewsTab({ data, easy, deep, goTab }) {
  const rline = easy && data.easy ? data.easy.risk : data.risk.line;
  const simple = (easy && data.easy && data.easy.brief) || [];
  const [region, setRegion] = useState('ALL');
  const [boardSel, setBoardSel] = useState(null);
  useEffect(() => { AsyncStorage.getItem(REGION_KEY).then((v) => { if (v) setRegion(v); }).catch(() => {}); }, []);
  const choose = (r) => { setRegion(r); AsyncStorage.setItem(REGION_KEY, r).catch(() => {}); };

  const regions = regionsPresent(data.brief);
  const active = region === 'ALL' || regions.includes(region) ? region : 'ALL';
  const counts = {}; for (const s of (data.brief || [])) if (s.region) counts[s.region] = (counts[s.region] || 0) + 1;
  const chips = [['ALL', 'All', (data.brief || []).length]].concat(regions.map((r) => [r, r, counts[r] || 0]));
  const rows = briefSorted(data.brief).filter(({ s }) => active === 'ALL' || s.region === active);

  return (
    <View style={s.stack}>
      <ThreatGauge risk={data.risk} events={data.events} forecasts={data.forecasts} />
      <WhyPosture text={rline} deep={deep} />
      <WorldMap events={data.events} sel={boardSel} onSelect={setBoardSel} onFilter={choose} goTab={goTab} data={data} />
      <PlainLead text={easy && data.easy ? data.easy.bottomLine : null} />
      <View style={s.briefhead}>
        <Text style={[s.briefT, MONO]}>LATEST HEADLINES</Text>
        <Text style={[s.briefD, MONO]}>{data.updated}</Text>
      </View>
      {regions.length ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.rfilter}>
          {chips.map(([val, lab, n]) => {
            const on = val === active;
            return (
              <Pressable key={val} onPress={() => choose(val)} style={[s.rchip, on && s.rchipOn]}>
                <Text style={[s.rchipTxt, MONO, on && { color: C.ink, fontWeight: '700' }]}>{lab} {n}</Text>
              </Pressable>
            );
          })}
        </ScrollView>
      ) : null}
      {rows.length
        ? rows.map(({ s, i }) => {
            const evIdx = (data.events || []).findIndex((ev) => evRegion(ev) === s.region);
            const calls = regionForecasts(data, s.region).length;
            return (
              <StoryCard key={i} item={s} simpleText={simple[i]} easy={easy} deep={deep}
                onBoard={evIdx >= 0 ? () => setBoardSel(evIdx) : null}
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
  return (
    <View style={s.stack}>
      <View style={s.tabintro}>
        <Text style={s.tabintroP}>What we think happens next — falsifiable predictions and hidden-strategy hypotheses. The fun part, and the honest one: every call is scored against reality, misses included.</Text>
      </View>
      <CalibrationTrack track={data.track} forecasts={data.forecasts} />
      <ChipBar
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
      <View style={s.tabintro}>
        <Text style={s.tabintroP}>The strategy desk — world events read from inside each capital, not from a podium. Who actually decides, what they really want, and what it means from their own perspective.</Text>
      </View>
      {data.actors && data.actors.length ? (
        <Section title="The players" extra={actors.length + ' tracked'}>
          <ChipBar pairs={textRegionPairs(data.actors, actorText)} active={region} onPick={setRegion} />
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
              <Text style={[s.modeTxt, MONO, active && { color: C.ink, fontWeight: '700' }]}>{lab}</Text>
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
  const [tab, setTab] = useState('news');
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
          <Text style={[s.wordmark, MONO]}>GEO<Text style={{ color: C.accent }}>/</Text>TERMINAL</Text>
          <Text style={[s.stamp, MONO]}>{data ? data.updated : ''}</Text>
        </View>
        <ModeToggle level={level} onChange={setMode} />
        {!data && !err && <View style={s.center}><ActivityIndicator color={C.accent} size="large" /></View>}
        {!data && err && (
          <View style={s.center}>
            <Text style={s.p}>Couldn't reach the feed ({err}).</Text>
            <Pressable onPress={load} style={s.retry}><Text style={[s.retryTxt, MONO]}>RETRY</Text></Pressable>
          </View>
        )}
        {data && (
          <ScrollView contentContainerStyle={s.scroll} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={C.accent} />}>
            {tab === 'news' && <NewsTab data={data} easy={easy} deep={deep} goTab={setTab} />}
            {tab === 'conspiracy' && <ConspiracyTab data={data} />}
            {tab === 'strategy' && <StrategyTab data={data} easy={easy} />}
            {tab === 'decode' && <DecodeTab data={data} easy={easy} deep={deep} goTab={setTab} />}
            <LegalFooter />
          </ScrollView>
        )}
        <SafeAreaView edges={['bottom']} style={s.navWrap}>
          <View style={s.nav}>
            {TABS.map((t) => (
              <Pressable key={t.key} onPress={() => setTab(t.key)} style={s.navBtn}>
                <Text style={[s.navTxt, MONO, tab === t.key && { color: C.accent }]}>{t.label}</Text>
                {tab === t.key && <View style={s.navUnder} />}
              </Pressable>
            ))}
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
  wordmark: { color: C.text, fontWeight: '800', letterSpacing: 3, fontSize: 14 },
  stamp: { color: C.muted, fontSize: 10, marginLeft: 'auto', letterSpacing: 0.5 },
  levelbar: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 16, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: C.line, backgroundColor: C.panel2 },
  levelLbl: { color: C.muted, fontSize: 9, letterSpacing: 1.5 },
  modetog: { flex: 1, flexDirection: 'row', borderWidth: 1, borderColor: C.line, borderRadius: 5, overflow: 'hidden' },
  modeBtn: { flex: 1, paddingVertical: 6, alignItems: 'center' },
  modeBtnDiv: { borderLeftWidth: 1, borderLeftColor: C.line },
  modeBtnActive: { backgroundColor: C.accent },
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
  rchipOn: { backgroundColor: C.accent, borderColor: C.accent },
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
