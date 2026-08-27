import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator, Pressable, RefreshControl, ScrollView,
  StyleSheet, Text, View,
} from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import MapView, { Marker, PROVIDER_DEFAULT } from 'react-native-maps';

const FEED = 'https://raw.githubusercontent.com/manwhatopps/geo-terminal-feed/main/data.json';

const C = {
  ink: '#0C1116', panel: '#141C24', panel2: '#0F161D', line: '#22303A',
  text: '#D9E1E6', muted: '#7E8C96', accent: '#5FA8B8',
  calm: '#5B9E77', elev: '#C9A44C', high: '#C4674D', crit: '#D14B3E',
  barBg: '#1B2630', chip: '#1A242E',
};
const riskColor = { calm: C.calm, elev: C.elev, high: C.high, crit: C.crit };
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

function Scholar({ data }) {
  const lec = data.lecture;
  return (
    <View style={s.stack}>
      <Section title="Lecture" extra={lec.date}>
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
      <Text style={s.foot}>
        New lecture every Saturday — one theme from the week, taught through
        50–500 years of history, with competing frameworks in tension.
      </Text>
    </View>
  );
}

const TABS = [
  { key: 'board', label: 'BOARD', C: Board },
  { key: 'map', label: 'MAP', C: ConflictMap },
  { key: 'brief', label: 'BRIEF', C: Brief },
  { key: 'lab', label: 'LAB', C: Lab },
  { key: 'scholar', label: 'SCHOLAR', C: Scholar },
];

export default function App() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [tab, setTab] = useState('board');
  const [refreshing, setRefreshing] = useState(false);

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
});
