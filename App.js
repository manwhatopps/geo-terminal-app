import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator, Linking, Pressable, RefreshControl, ScrollView,
  StyleSheet, Text, View,
} from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';

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
const MONO = { fontFamily: 'Menlo', fontVariant: ['tabular-nums'] };
const SERIF = { fontFamily: 'Georgia' };

// Feed strings carry HTML entities (web decodes via innerHTML; RN <Text> shows them literally).
function decode(s) {
  return String(s == null ? '' : s)
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}
const TABS = [
  { key: 'news', label: 'NEWS' },
  { key: 'conspiracy', label: 'CONSPIRACY' },
  { key: 'strategy', label: 'STRATEGY' },
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

function ThreatGauge({ risk }) {
  const idx = RISK_LEVELS.indexOf(risk.color);
  const rc = riskColor[risk.color] || C.elev;
  return (
    <View style={s.gauge}>
      <View style={s.gtop}>
        <Text style={[s.glabel, MONO]}>GLOBAL THREAT POSTURE</Text>
        <Text style={[s.gstate, SERIF, { color: rc }]}>{risk.state}</Text>
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

function StoryCard({ item }) {
  const [open, setOpen] = useState(false);
  return (
    <View style={s.storycard}>
      <View style={s.spine} />
      {item.tag ? <Text style={[s.ktag, MONO]}>{decode(item.tag).toUpperCase()}</Text> : null}
      <Text style={[s.storyH3, SERIF]}>{decode(item.h)}</Text>
      <Text style={s.storyP}>{decode(item.t)}</Text>
      {item.context ? (
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
    </View>
  );
}

function NewsTab({ data, easy }) {
  const rline = easy && data.easy ? data.easy.risk : data.risk.line;
  return (
    <View style={s.stack}>
      <ThreatGauge risk={data.risk} />
      <Text style={s.gline}>{decode(rline)}</Text>
      <PlainLead text={easy && data.easy ? data.easy.bottomLine : null} />
      <View style={s.briefhead}>
        <Text style={[s.briefT, MONO]}>TODAY'S HEADLINES</Text>
        <Text style={[s.briefD, MONO]}>{data.updated}</Text>
      </View>
      {(data.brief || []).map((b, i) => <StoryCard key={i} item={b} />)}
      {data.watch && data.watch.length ? (
        <Section title="What to watch next">
          {data.watch.map((w, i) => (
            <Text key={i} style={s.li}><Text style={{ color: C.accent }}>› </Text>{decode(w)}</Text>
          ))}
        </Section>
      ) : null}
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
  return (
    <View style={s.stack}>
      <View style={s.tabintro}>
        <Text style={s.tabintroP}>What we think happens next — falsifiable predictions and hidden-strategy hypotheses. The fun part, and the honest one: every call is scored against reality, misses included.</Text>
      </View>
      <CalibrationTrack track={data.track} forecasts={data.forecasts} />
      {data.hypotheses && data.hypotheses.length ? (
        <Section title="Hidden-strategy lab" extra={data.hypotheses.length + ' live'}>
          {data.hypotheses.map((h, i) => (
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
      <Section title="Predictions on the board" extra={String((data.forecasts || []).length)}>
        {(data.forecasts || []).map((f, i) => {
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
  return (
    <View style={s.stack}>
      <View style={s.tabintro}>
        <Text style={s.tabintroP}>The strategy desk — world events read from inside each capital, not from a podium. Who actually decides, what they really want, and what it means from their own perspective.</Text>
      </View>
      {data.actors && data.actors.length ? (
        <Section title="The players" extra={data.actors.length + ' tracked'}>
          {data.actors.map((a, i) => (
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

function ModeToggle({ easy, onChange }) {
  return (
    <View style={s.modetog}>
      {['pro', 'easy'].map((m) => {
        const active = (m === 'easy') === easy;
        return (
          <Pressable key={m} onPress={() => onChange(m === 'easy')} style={[s.modeBtn, active && s.modeBtnActive]}>
            <Text style={[s.modeTxt, MONO, active && { color: C.ink, fontWeight: '700' }]}>{m === 'pro' ? 'PRO' : 'PLAIN'}</Text>
          </Pressable>
        );
      })}
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
  const [easy, setEasy] = useState(false);

  useEffect(() => {
    AsyncStorage.getItem(ACK_KEY).then((v) => setAcked(v === '1')).catch(() => setAcked(false));
    AsyncStorage.getItem(MODE_KEY).then((v) => setEasy(v === 'easy')).catch(() => {});
  }, []);
  const accept = useCallback(() => { AsyncStorage.setItem(ACK_KEY, '1').catch(() => {}); setAcked(true); }, []);
  const setMode = useCallback((v) => { setEasy(v); AsyncStorage.setItem(MODE_KEY, v ? 'easy' : 'pro').catch(() => {}); }, []);

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
          <ModeToggle easy={easy} onChange={setMode} />
          <Text style={[s.stamp, MONO]}>{data ? data.updated : ''}</Text>
        </View>
        {!data && !err && <View style={s.center}><ActivityIndicator color={C.accent} size="large" /></View>}
        {!data && err && (
          <View style={s.center}>
            <Text style={s.p}>Couldn't reach the feed ({err}).</Text>
            <Pressable onPress={load} style={s.retry}><Text style={[s.retryTxt, MONO]}>RETRY</Text></Pressable>
          </View>
        )}
        {data && (
          <ScrollView contentContainerStyle={s.scroll} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={C.accent} />}>
            {tab === 'news' && <NewsTab data={data} easy={easy} />}
            {tab === 'conspiracy' && <ConspiracyTab data={data} />}
            {tab === 'strategy' && <StrategyTab data={data} easy={easy} />}
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
  modetog: { flexDirection: 'row', borderWidth: 1, borderColor: C.line, borderRadius: 4, overflow: 'hidden', marginLeft: 10 },
  modeBtn: { paddingVertical: 4, paddingHorizontal: 9 },
  modeBtnActive: { backgroundColor: C.accent },
  modeTxt: { color: C.muted, fontSize: 9.5, letterSpacing: 1 },
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
