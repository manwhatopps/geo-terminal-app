import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator, Linking, Pressable, RefreshControl, ScrollView,
  StyleSheet, Text, View,
} from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import MapView, { Marker, PROVIDER_DEFAULT } from 'react-native-maps';
import AsyncStorage from '@react-native-async-storage/async-storage';

const FEED = 'https://raw.githubusercontent.com/manwhatopps/geo-terminal-feed/main/data.json';
const ACK_KEY = 'geo-disclaimer-ack-v1';
const LEGAL = {
  terms: 'https://manwhatopps.github.io/geo-terminal-feed/terms.html',
  privacy: 'https://manwhatopps.github.io/geo-terminal-feed/privacy.html',
  disclaimer: 'https://manwhatopps.github.io/geo-terminal-feed/disclaimer.html',
};

const C = {
  ink: '#0C1116', panel: '#141C24', panel2: '#0F161D', line: '#22303A',
  text: '#D9E1E6', muted: '#7E8C96', accent: '#5FA8B8',
  calm: '#5B9E77', elev: '#C9A44C', high: '#C4674D', crit: '#D14B3E',
  barBg: '#1B2630', chip: '#1A242E',
};
const riskColor = { calm: C.calm, elev: C.elev, high: C.high, crit: C.crit };
const FIELD_GUIDE = [
  { n: 'Manufactured urgency', d: 'A fake deadline or scarcity to kill your deliberation.', e: '"Economic D-Day," "effective immediately" tariff framing.', t: 'The deadline benefits the persuader, not you. Ask: what actually breaks if I wait a day?' },
  { n: 'Firehose of falsehood', d: 'High-volume, contradictory claims that make verification collapse.', e: "State bot networks driving most of a wartime hashtag's traffic.", t: "Volume + speed + claims that don't even agree with each other. The goal is exhaustion, not consistency." },
  { n: 'Atrocity framing', d: "Overwhelming, often-unverified images of the enemy's cruelty to short-circuit judgment.", e: 'AI-generated "atrocity" videos racking up hundreds of millions of views.', t: 'Unsourced, undated, rage-optimized visuals. Reverse-image-search before you believe or share.' },
  { n: 'The authority costume', d: 'Borrowed credibility from a uniform, title, or "studies show."', e: 'Doctor-endorsed cigarettes; "experts say" with no expert named.', t: "The credential is displayed; the evidence isn't. Ask which study, by whom." },
  { n: 'Manufactured consensus', d: '"Everyone believes this" — via bots, bought followers, or trending metrics.', e: 'Astroturfed hashtags; identical phrasing from new accounts.', t: 'Engagement with no organic origin. Who actually started it?' },
  { n: 'In-group framing', d: 'Binding a claim to your identity so rejecting it feels like betrayal.', e: '"Real patriots know…"; identity-coded issue messaging.', t: "It's about belonging, not evidence. You feel tribal before you feel convinced." },
  { n: 'Anchoring the debate', d: 'An extreme opening number so the "compromise" lands where they wanted.', e: 'A shock demand, then a "reasonable" retreat to the real target.', t: 'The first ask is outrageous on purpose. Negotiate from your own anchor, not theirs.' },
  { n: 'Loaded labels', d: 'Renaming something to smuggle a verdict inside a neutral-sounding noun.', e: '"Liberation Day" tariffs; "collateral damage."', t: 'Strip the adjective and re-describe the plain event.' },
  { n: 'Sanewashing', d: 'Smoothing incoherent or extreme statements into reasonable-sounding paraphrase.', e: 'Rambling remarks rendered as tidy policy in the write-up.', t: 'The paraphrase is more coherent than the transcript. Go read the primary quote.' },
  { n: 'Nutpicking', d: 'Elevating a fringe crank as representative of a whole group.', e: 'A 12-follower account cited as "what they all believe."', t: 'The "representative" example is conveniently the worst one. Check its real reach.' },
  { n: 'The consistency trap', d: 'A tiny engineered "yes" that makes the big "yes" feel obligatory.', e: 'Sign the petition → donate → volunteer ladders.', t: 'Each step cites your last step as the reason. The escalation is doing the work.' },
  { n: 'The denied control', d: "An outcome with no counterfactual, so you can't judge the cause.", e: '"Since the policy, X improved" — with no baseline shown.', t: 'Ask "compared to what?" No control group, no claim.' },
];
const DARK_MAP = [
  { elementType: 'geometry', stylers: [{ color: '#0F161D' }] },
  { elementType: 'labels.text.fill', stylers: [{ color: '#7E8C96' }] },
  { elementType: 'labels.text.stroke', stylers: [{ color: '#0C1116' }] },
  { featureType: 'water', elementType: 'geometry', stylers: [{ color: '#0C1116' }] },
  { featureType: 'landscape', elementType: 'geometry', stylers: [{ color: '#141C24' }] },
  { featureType: 'administrative', elementType: 'geometry.stroke', stylers: [{ color: '#22303A' }] },
  { featureType: 'road', stylers: [{ visibility: 'off' }] },
  { featureType: 'poi', stylers: [{ visibility: 'off' }] },
  { featureType: 'transit', stylers: [{ visibility: 'off' }] },
];
const MONO = { fontFamily: 'Menlo', fontVariant: ['tabular-nums'] };

function Section({ title, extra, children }) {
  return (
    <View style={s.section}>
      <View style={s.h2row}>
        <Text style={s.h2}>{title.toUpperCase()}</Text>
        {extra ? <Text style={[s.h2extra, MONO]}>{extra}</Text> : null}
      </View>
      {children}
    </View>
  );
}

function Forecast({ f }) {
  const d = f.prev != null ? f.p - f.prev : null;
  return (
    <View style={s.fc}>
      <View style={s.fcTop}>
        <Text style={[s.fcId, MONO]}>{f.id}</Text>
        <Text style={s.fcQ}>{f.q}</Text>
        <Text style={[s.fcP, MONO]}>{f.p}<Text style={s.fcPct}>%</Text></Text>
      </View>
      <View style={s.bar}>
        <View style={[s.fill, { width: `${f.p}%` }]} />
        {f.prev != null && <View style={[s.tick, { left: `${f.prev}%`, backgroundColor: C.muted }]} />}
        {f.mkt != null && <View style={[s.tick, { left: `${f.mkt}%`, backgroundColor: C.elev }]} />}
      </View>
      <View style={s.meta}>
        {d != null && (
          <Text style={[s.chip, MONO, { color: d > 0 ? C.high : C.calm }]}>
            {d > 0 ? '+' : ''}{d} pts
          </Text>
        )}
        <Text style={[s.metaTxt, MONO]}>by {f.by}</Text>
        <Text style={s.metaTxt}>conf {f.conf}</Text>
      </View>
      {f.note ? <Text style={s.note}>{f.note}</Text> : null}
    </View>
  );
}

function Board({ data }) {
  const rc = riskColor[data.risk.color] || C.elev;
  return (
    <View style={s.stack}>
      <View style={[s.risk, { borderLeftColor: rc }]}>
        <Text style={[s.riskState, MONO, { color: rc }]}>RISK: {data.risk.state}</Text>
        <Text style={s.riskLine}>{data.risk.line}</Text>
      </View>
      {data.track && (
        <Section title="Track record">
          <View style={s.track}>
            <View style={s.brierBox}>
              {data.track.resolved > 0 ? (
                <>
                  <Text style={[s.brierBig, MONO]}>{data.track.brier != null ? data.track.brier.toFixed(3) : '—'}</Text>
                  <Text style={[s.brierLab, MONO]}>BRIER</Text>
                </>
              ) : (
                <Text style={[s.brierBig, MONO]}>0<Text style={s.brierUnit}> resolved</Text></Text>
              )}
            </View>
            <Text style={s.trackSay}>
              {data.track.resolved > 0
                ? `${data.track.resolved} forecast${data.track.resolved > 1 ? 's' : ''} resolved and scored. Lower Brier is better; 0.25 is a coin-flip. ${data.track.note || ''}`
                : data.track.note}
            </Text>
          </View>
        </Section>
      )}
      <Section title="Forecast board" extra={`${data.forecasts.length} open`}>
        {data.forecasts.map((f) => <Forecast key={f.id} f={f} />)}
        <View style={s.legend}>
          <Text style={s.legendTxt}>▮ current</Text>
          <Text style={[s.legendTxt, { color: C.muted }]}>| previous</Text>
          <Text style={[s.legendTxt, { color: C.elev }]}>| market</Text>
        </View>
      </Section>
      <Section title="Tripwires">
        {data.tripwires.fired.map((t, i) => (
          <Text key={`f${i}`} style={s.li}><Text style={{ color: C.crit }}>▲ FIRED — </Text>{t}</Text>
        ))}
        {data.tripwires.armed.map((t, i) => (
          <Text key={`a${i}`} style={s.li}><Text style={{ color: C.accent }}>◦ </Text>{t}</Text>
        ))}
      </Section>
      <Text style={s.foot}>
        Brief 07:00 · tripwire sweeps 12:00 + 18:00 · lab Wed · audit Sun · lecture Sat.
        Every number is scored against reality — including the wrong ones.
      </Text>
    </View>
  );
}

function ConflictMap({ data }) {
  const events = data.events || [];
  const [sel, setSel] = useState(null);
  return (
    <View style={s.stack}>
      <Section title="Live conflict map" extra={`${events.length} active`}>
        <View style={s.mapBox}>
          <MapView
            style={s.map}
            provider={PROVIDER_DEFAULT}
            customMapStyle={DARK_MAP}
            initialRegion={{ latitude: 30, longitude: 45, latitudeDelta: 55, longitudeDelta: 60 }}
          >
            {events.map((e, i) => (
              <Marker
                key={i}
                coordinate={{ latitude: e.lat, longitude: e.lon }}
                onPress={() => setSel(e)}
              >
                <View style={[s.pin, { backgroundColor: riskColor[e.sev] || C.elev }]} />
              </Marker>
            ))}
          </MapView>
        </View>
        {sel && (
          <View style={s.mapCallout}>
            <Text style={[s.calloutH, { color: riskColor[sel.sev] || C.elev }]}>{sel.label}</Text>
            <Text style={s.calloutT}>{sel.note}</Text>
          </View>
        )}
      </Section>
      <Section title="Active theaters">
        {events.map((e, i) => (
          <Pressable key={i} onPress={() => setSel(e)}>
            <Text style={s.li}>
              <Text style={{ color: riskColor[e.sev] || C.elev }}>● </Text>
              <Text style={{ fontWeight: '600' }}>{e.label}. </Text>{e.note}
            </Text>
          </Pressable>
        ))}
      </Section>
      <Text style={s.foot}>
        Points are analyst-geocoded from the day's brief — color is severity
        (amber elevated, orange high, red critical). Not a live sensor feed; it
        moves when the brief moves.
      </Text>
    </View>
  );
}

function Brief({ data }) {
  return (
    <View style={s.stack}>
      <Section title="Daily brief" extra={data.updated}>
        <View style={s.prose}>
          {data.brief.map((b, i) => (
            <View key={i}>
              <Text style={s.h3}>{b.h}</Text>
              <Text style={s.p}>{b.t}</Text>
            </View>
          ))}
        </View>
      </Section>
      <Section title="Watch — next 48h">
        {data.watch.map((w, i) => (
          <Text key={i} style={s.li}><Text style={{ color: C.accent }}>› </Text>{w}</Text>
        ))}
      </Section>
      {data.lesson ? (
        <Section title="Today's lesson">
          <View style={s.prose}><Text style={s.p}>{data.lesson}</Text></View>
        </Section>
      ) : null}
    </View>
  );
}

function Lab({ data }) {
  return (
    <View style={s.stack}>
      <Section title="Hypothesis lab" extra={`${data.hypotheses.length} live`}>
        {data.hypotheses.map((h, i) => (
          <View key={i} style={s.hyp}>
            <Text style={[s.hypP, MONO]}>{h.p}%</Text>
            <View style={{ flex: 1 }}>
              <Text style={s.hypName}>{h.name}.</Text>
              <Text style={s.hypD}>{h.d}</Text>
            </View>
          </View>
        ))}
      </Section>
      <Text style={s.foot}>
        Hypotheses live under the decay rule: failed predictions cut probability;
        nothing survives on narrative alone.
      </Text>
    </View>
  );
}

function Learn({ data }) {
  const lec = data.lecture;
  const actors = data.actors || [];
  return (
    <View style={s.stack}>
      {actors.length > 0 && (
        <Section title="The players" extra={`${actors.length} tracked`}>
          <Text style={[s.foot, { paddingHorizontal: 16, paddingTop: 10 }]}>
            Who's actually driving the board — and whether they decide, execute, or just voice.
            Roles verified; opaque palace dynamics flagged as such.
          </Text>
          {actors.map((a, i) => (
            <View key={i} style={s.actor}>
              <Text style={s.actorName}>{a.n}</Text>
              <Text style={[s.actorRole, MONO]}>{a.r.toUpperCase()}</Text>
              <Text style={s.actorRow}><Text style={s.actorK}>Really — </Text>{a.w}</Text>
              <Text style={s.actorRow}><Text style={s.actorK}>Wants — </Text>{a.g}</Text>
              <Text style={s.actorRow}><Text style={s.actorK}>Now — </Text>{a.m}</Text>
              <Text style={s.actorRow}><Text style={s.actorK}>Lens — </Text>{a.l}</Text>
            </View>
          ))}
        </Section>
      )}
      <Section title="This week's lecture" extra={lec.date}>
        <View style={s.prose}>
          <Text style={s.h3}>{lec.title}</Text>
          {lec.sections.map((part, i) => (
            <View key={i}>
              <Text style={[s.kicker, MONO]}>{part.h.toUpperCase()}</Text>
              <Text style={s.p}>{part.t}</Text>
            </View>
          ))}
        </View>
      </Section>
      <Section title="Spot the technique" extra={`${FIELD_GUIDE.length} tells`}>
        <Text style={[s.foot, { paddingHorizontal: 16, paddingTop: 10 }]}>
          How you're persuaded, and how to catch it. The tell is the part that protects you.
        </Text>
        {FIELD_GUIDE.map((g, i) => (
          <View key={i} style={s.fg}>
            <Text style={s.fgName}><Text style={[s.fgNum, MONO]}>{i + 1} </Text>{g.n}</Text>
            <Text style={s.fgDef}>{g.d}</Text>
            <Text style={s.fgEx}>e.g. {g.e}</Text>
            <Text style={s.fgTell}><Text style={{ fontWeight: '700' }}>Tell — </Text>{g.t}</Text>
          </View>
        ))}
      </Section>
      <Text style={s.foot}>
        New lecture every Saturday. The field guide draws on the political-psychology canon —
        and deliberately omits the debunked studies (retracted priming work, failed replications),
        because a guide to being fooled can't itself be fooled.
      </Text>
    </View>
  );
}

const TABS = [
  { key: 'board', label: 'BOARD', C: Board },
  { key: 'map', label: 'MAP', C: ConflictMap },
  { key: 'brief', label: 'BRIEF', C: Brief },
  { key: 'lab', label: 'LAB', C: Lab },
  { key: 'learn', label: 'LEARN', C: Learn },
];

function DisclaimerGate({ onAccept }) {
  return (
    <SafeAreaView style={s.root}>
      <StatusBar style="light" />
      <ScrollView contentContainerStyle={s.gateScroll}>
        <Text style={[s.wordmark, MONO, { fontSize: 17, marginBottom: 18 }]}>
          GEO<Text style={{ color: C.accent }}>/</Text>TERMINAL
        </Text>
        <Text style={s.gateH}>Before you begin</Text>
        <Text style={s.gateP}>
          GEO Terminal publishes geopolitical analysis and probabilistic forecasts as
          <Text style={{ color: C.text, fontWeight: '700' }}> opinion</Text> — not fact, and not advice.
        </Text>
        <Text style={s.gateP}>
          Forecasts are subjective estimates that will often be wrong. Statements about
          governments, organizations, and public figures are commentary based on public
          reporting, not assertions of fact.
        </Text>
        <Text style={s.gateP}>
          This app is <Text style={{ color: C.text, fontWeight: '700' }}>not</Text> financial,
          investment, legal, security, safety, or travel advice. Do not rely on it for any
          decision. Consult a qualified professional.
        </Text>
        <View style={s.gateLinks}>
          <Pressable onPress={() => Linking.openURL(LEGAL.disclaimer)}><Text style={s.link}>Full Disclaimer</Text></Pressable>
          <Pressable onPress={() => Linking.openURL(LEGAL.terms)}><Text style={s.link}>Terms</Text></Pressable>
          <Pressable onPress={() => Linking.openURL(LEGAL.privacy)}><Text style={s.link}>Privacy</Text></Pressable>
        </View>
        <Pressable onPress={onAccept} style={s.gateBtn}>
          <Text style={[s.gateBtnTxt, MONO]}>I UNDERSTAND</Text>
        </Pressable>
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
  const [tab, setTab] = useState('board');
  const [refreshing, setRefreshing] = useState(false);
  const [acked, setAcked] = useState(null);

  useEffect(() => {
    AsyncStorage.getItem(ACK_KEY).then((v) => setAcked(v === '1')).catch(() => setAcked(false));
  }, []);
  const accept = useCallback(() => {
    AsyncStorage.setItem(ACK_KEY, '1').catch(() => {});
    setAcked(true);
  }, []);

  const load = useCallback(async () => {
    try {
      const r = await fetch(`${FEED}?t=${Date.now()}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setData(await r.json());
      setErr(null);
    } catch (e) {
      setErr(String(e.message || e));
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true); await load(); setRefreshing(false);
  }, [load]);

  const Active = TABS.find((t) => t.key === tab).C;

  if (acked === null) {
    return (
      <SafeAreaProvider>
        <SafeAreaView style={s.root}><View style={s.center}><ActivityIndicator color={C.accent} /></View></SafeAreaView>
      </SafeAreaProvider>
    );
  }
  if (!acked) {
    return <SafeAreaProvider><DisclaimerGate onAccept={accept} /></SafeAreaProvider>;
  }

  return (
    <SafeAreaProvider>
      <SafeAreaView style={s.root} edges={['top']}>
        <StatusBar style="light" />
        <View style={s.header}>
          <Text style={[s.wordmark, MONO]}>GEO<Text style={{ color: C.accent }}>/</Text>TERMINAL</Text>
          <Text style={[s.stamp, MONO]}>{data ? `UPDATED ${data.updated}` : ''}</Text>
        </View>
        {!data && !err && (
          <View style={s.center}><ActivityIndicator color={C.accent} size="large" /></View>
        )}
        {!data && err && (
          <View style={s.center}>
            <Text style={s.p}>Couldn't reach the feed ({err}).</Text>
            <Pressable onPress={load} style={s.retry}><Text style={[s.retryTxt, MONO]}>RETRY</Text></Pressable>
          </View>
        )}
        {data && (
          <ScrollView
            contentContainerStyle={s.scroll}
            refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={C.accent} />}
          >
            <Active data={data} />
            <LegalFooter />
          </ScrollView>
        )}
        <SafeAreaView edges={['bottom']} style={s.navWrap}>
          <View style={s.nav}>
            {TABS.map((t) => (
              <Pressable key={t.key} onPress={() => setTab(t.key)}
                style={[s.navBtn, tab === t.key && s.navBtnActive]}>
                <Text style={[s.navTxt, MONO, tab === t.key && { color: C.accent }]}>{t.label}</Text>
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
  header: {
    flexDirection: 'row', alignItems: 'baseline', paddingHorizontal: 16,
    paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: C.line,
  },
  wordmark: { color: C.text, fontWeight: '800', letterSpacing: 3, fontSize: 15 },
  stamp: { color: C.muted, fontSize: 11, marginLeft: 'auto', letterSpacing: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 14 },
  retry: { borderWidth: 1, borderColor: C.accent, borderRadius: 4, paddingVertical: 8, paddingHorizontal: 22 },
  retryTxt: { color: C.accent, letterSpacing: 2, fontSize: 13 },
  scroll: { padding: 14, gap: 14 },
  stack: { gap: 14 },
  risk: {
    backgroundColor: C.panel, borderWidth: 1, borderColor: C.line,
    borderLeftWidth: 4, borderRadius: 6, padding: 15,
  },
  riskState: { fontWeight: '800', letterSpacing: 2.5, fontSize: 14 },
  riskLine: { color: C.text, marginTop: 7, fontSize: 14.5, lineHeight: 21 },
  section: { backgroundColor: C.panel, borderWidth: 1, borderColor: C.line, borderRadius: 6, overflow: 'hidden' },
  h2row: {
    flexDirection: 'row', alignItems: 'center', backgroundColor: C.panel2,
    paddingHorizontal: 16, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: C.line,
  },
  h2: { color: C.muted, fontSize: 11, fontWeight: '700', letterSpacing: 3 },
  h2extra: { color: C.accent, fontSize: 11, marginLeft: 'auto' },
  fc: { paddingHorizontal: 16, paddingVertical: 13, borderBottomWidth: 1, borderBottomColor: C.line },
  fcTop: { flexDirection: 'row', alignItems: 'baseline', gap: 8 },
  fcId: { color: C.muted, fontSize: 10, letterSpacing: 1 },
  fcQ: { color: C.text, fontSize: 14, fontWeight: '600', flex: 1 },
  fcP: { color: C.accent, fontSize: 23, fontWeight: '700' },
  fcPct: { color: C.muted, fontSize: 12, fontWeight: '400' },
  bar: { height: 6, borderRadius: 3, backgroundColor: C.barBg, marginTop: 10, marginBottom: 8 },
  fill: { position: 'absolute', left: 0, top: 0, bottom: 0, borderRadius: 3, backgroundColor: C.accent },
  tick: { position: 'absolute', top: -3, width: 2, height: 12 },
  meta: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, alignItems: 'center' },
  chip: { backgroundColor: C.chip, borderRadius: 3, paddingHorizontal: 7, paddingVertical: 1, fontSize: 11 },
  metaTxt: { color: C.muted, fontSize: 11 },
  note: { color: C.muted, fontSize: 12, marginTop: 5, lineHeight: 17 },
  legend: { flexDirection: 'row', gap: 14, padding: 12, paddingHorizontal: 16, backgroundColor: C.panel2 },
  legendTxt: { color: C.accent, fontSize: 10.5 },
  li: {
    color: C.text, fontSize: 13.5, lineHeight: 19, paddingHorizontal: 16,
    paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: C.line,
  },
  hyp: {
    flexDirection: 'row', gap: 12, paddingHorizontal: 16, paddingVertical: 12,
    borderBottomWidth: 1, borderBottomColor: C.line,
  },
  hypP: { color: C.accent, fontWeight: '700', minWidth: 44, fontSize: 15 },
  hypName: { color: C.text, fontWeight: '600', fontSize: 13.5 },
  hypD: { color: C.muted, fontSize: 12.5, marginTop: 3, lineHeight: 18 },
  prose: { paddingHorizontal: 16, paddingBottom: 14, paddingTop: 4 },
  h3: { color: C.text, fontSize: 14.5, fontWeight: '700', marginTop: 12, marginBottom: 4 },
  kicker: { color: C.muted, fontSize: 11, letterSpacing: 2.5, marginTop: 14, marginBottom: 3 },
  p: { color: C.text, fontSize: 14, lineHeight: 21, marginVertical: 5 },
  foot: { color: C.muted, fontSize: 11, lineHeight: 17, paddingHorizontal: 6 },
  navWrap: { backgroundColor: C.panel2, borderTopWidth: 1, borderTopColor: C.line },
  nav: { flexDirection: 'row', justifyContent: 'space-around', paddingVertical: 8, paddingHorizontal: 4 },
  navBtn: { paddingVertical: 6, paddingHorizontal: 9, borderRadius: 4 },
  navBtnActive: { backgroundColor: C.chip },
  navTxt: { color: C.muted, fontSize: 10.5, letterSpacing: 1.4 },
  mapBox: { height: 340, backgroundColor: C.panel2 },
  map: { flex: 1 },
  pin: { width: 14, height: 14, borderRadius: 7, borderWidth: 2, borderColor: C.ink },
  mapCallout: { padding: 14, borderTopWidth: 1, borderTopColor: C.line, backgroundColor: C.panel2 },
  calloutH: { fontWeight: '700', fontSize: 14, marginBottom: 3 },
  calloutT: { color: C.text, fontSize: 13.5, lineHeight: 19 },
  gateScroll: { padding: 26, paddingTop: 60, flexGrow: 1, justifyContent: 'center' },
  gateH: { color: C.text, fontSize: 20, fontWeight: '800', marginBottom: 14 },
  gateP: { color: C.muted, fontSize: 14.5, lineHeight: 22, marginBottom: 12 },
  gateLinks: { flexDirection: 'row', gap: 16, marginTop: 8, marginBottom: 26 },
  link: { color: C.accent, fontSize: 13.5, textDecorationLine: 'underline' },
  gateBtn: { backgroundColor: C.accent, borderRadius: 6, paddingVertical: 15, alignItems: 'center' },
  gateBtnTxt: { color: C.ink, fontWeight: '800', letterSpacing: 2, fontSize: 14 },
  legalRow: { flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 8, paddingVertical: 16 },
  legalLink: { color: C.muted, fontSize: 12, textDecorationLine: 'underline' },
  legalDot: { color: C.line },
  track: { flexDirection: 'row', alignItems: 'center', gap: 16, padding: 15 },
  brierBox: { alignItems: 'center', minWidth: 74 },
  brierBig: { color: C.accent, fontSize: 30, fontWeight: '800' },
  brierUnit: { color: C.muted, fontSize: 13, fontWeight: '400' },
  brierLab: { color: C.muted, fontSize: 9, letterSpacing: 2 },
  trackSay: { flex: 1, color: C.muted, fontSize: 12.5, lineHeight: 18 },
  fg: { paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: C.line },
  fgName: { color: C.text, fontSize: 14, fontWeight: '700' },
  fgNum: { color: C.accent, fontWeight: '700' },
  fgDef: { color: C.text, fontSize: 13, marginTop: 4, marginBottom: 6, lineHeight: 18 },
  fgEx: { color: C.muted, fontSize: 12, marginBottom: 3, lineHeight: 17 },
  fgTell: { color: C.calm, fontSize: 12.5, lineHeight: 18 },
  actor: { paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: C.line },
  actorName: { color: C.text, fontSize: 14, fontWeight: '700' },
  actorRole: { color: C.accent, fontSize: 10, letterSpacing: 0.8, marginTop: 2, marginBottom: 6 },
  actorRow: { color: C.text, fontSize: 12.5, lineHeight: 18, marginVertical: 2 },
  actorK: { color: C.muted, fontWeight: '600' },
});
