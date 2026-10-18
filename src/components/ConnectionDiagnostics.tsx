import React, { useCallback, useEffect, useState } from 'react';
import axios from 'axios';
import type { Socket } from 'socket.io-client';
import { useI18n } from '../i18n';
import { getExistingPushSubscription, isPushSupported, type PushBackendStatus } from '../utils/PushNotificationManager';
import { getSystemIdleSupport } from '../utils/systemIdle';
import { callKeepAliveSupported } from '../utils/callKeepAlive';

/**
 * Options → Connexion : DIAGNOSTIC (lecture seule).
 *
 * Connexion temps réel (état, transport, temps de réponse, « Se reconnecter »), notifications
 * (permission, Push sur cet appareil, service worker), appels (relais TURN configuré, test du
 * réseau par collecte de candidats ICE, lancé à la demande) et navigateur (fonctions
 * disponibles). « Copier le rapport » produit un texte à coller pour le support : aucun
 * secret (ni identifiants TURN, ni adresse d'abonnement Push, ni adresses IP).
 */

type Level = 'ok' | 'warn' | 'bad' | 'info';
interface Row { label: string; value: string; level: Level }

type IceResult = { turnConfigured: boolean; host: boolean; srflx: boolean; relay: boolean };
type IceTest = { state: 'idle' } | { state: 'running' } | { state: 'done'; result: IceResult } | { state: 'error' };

const ICE_GATHER_TIMEOUT_MS = 6000;

/** Collecte les candidats ICE avec la configuration du serveur, sans appeler personne. */
const runIceTest = async (): Promise<IceResult> => {
  const { data } = await axios.get('/api/rtc-config');
  const iceServers: RTCIceServer[] = Array.isArray(data?.iceServers) ? data.iceServers : [];
  const turnConfigured = iceServers.some((s) => ([] as string[]).concat(s.urls).some((u) => /^turns?:/i.test(u)));
  const result: IceResult = { turnConfigured, host: false, srflx: false, relay: false };
  const pc = new RTCPeerConnection({ iceServers });
  try {
    pc.createDataChannel('diag');
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ICE_GATHER_TIMEOUT_MS);
      pc.onicecandidate = (e) => {
        if (!e.candidate) { clearTimeout(timer); resolve(); return; }
        const type = e.candidate.type ?? (/ typ (\w+)/.exec(e.candidate.candidate)?.[1] as RTCIceCandidateType | undefined);
        if (type === 'host') result.host = true;
        else if (type === 'srflx' || type === 'prflx') result.srflx = true;
        else if (type === 'relay') result.relay = true;
      };
      pc.createOffer().then((o) => pc.setLocalDescription(o)).catch(() => { clearTimeout(timer); resolve(); });
    });
  } finally {
    pc.close();
  }
  return result;
};

const swCacheVersion = async (): Promise<string | null> => {
  try {
    const keys = await caches.keys();
    return keys.find((k) => /^openwlm-v\d+$/.test(k)) ?? null;
  } catch {
    return null;
  }
};

const ConnectionDiagnostics: React.FC<{ socket: Socket | null; pushStatus: PushBackendStatus | null }> = ({ socket, pushStatus }) => {
  const { t } = useI18n();
  const c = t.settings;

  // --- Temps réel (relu chaque seconde : état, transport) ---
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, []);
  const connected = !!socket?.connected;
  const transport = socket?.io?.engine?.transport?.name ?? null;

  const [latency, setLatency] = useState<number | null>(null);
  useEffect(() => {
    if (!socket) return;
    let stopped = false;
    const ping = () => {
      if (!socket.connected) { setLatency(null); return; }
      const t0 = performance.now();
      socket.timeout(5000).emit('diag_ping', (err: Error | null) => {
        if (!stopped) setLatency(err ? null : Math.round(performance.now() - t0));
      });
    };
    ping();
    const id = setInterval(ping, 5000);
    return () => { stopped = true; clearInterval(id); };
  }, [socket]);

  const reconnect = () => {
    if (!socket) return;
    setLatency(null);
    socket.disconnect();
    socket.connect();
  };

  // --- Notifications (lues une fois à l'ouverture de l'onglet) ---
  const [pushHere, setPushHere] = useState<boolean | null>(null);
  const [swVersion, setSwVersion] = useState<string | null>(null);
  useEffect(() => {
    getExistingPushSubscription().then((s) => setPushHere(!!s)).catch(() => setPushHere(false));
    swCacheVersion().then(setSwVersion);
  }, []);
  const notifPermission: NotificationPermission | 'unsupported' = typeof Notification !== 'undefined' ? Notification.permission : 'unsupported';
  const swActive = typeof navigator !== 'undefined' && !!navigator.serviceWorker?.controller;

  // --- Appels (test à la demande : contacte les serveurs STUN/TURN) ---
  const [ice, setIce] = useState<IceTest>({ state: 'idle' });
  const testCalls = useCallback(async () => {
    setIce({ state: 'running' });
    try { setIce({ state: 'done', result: await runIceTest() }); } catch { setIce({ state: 'error' }); }
  }, []);

  // --- Lignes affichées (et rapport) ---
  const yesNo = (v: boolean) => (v ? c.connYes : c.connNo);
  const realtime: Row[] = [
    {
      label: c.connState,
      value: connected ? c.connStateConnected : socket?.active ? c.connStateReconnecting : c.connStateDisconnected,
      level: connected ? 'ok' : socket?.active ? 'warn' : 'bad'
    },
    {
      label: c.connTransport,
      value: !connected || !transport ? '—' : transport === 'websocket' ? 'WebSocket' : c.connTransportPolling,
      level: !connected || !transport ? 'info' : transport === 'websocket' ? 'ok' : 'warn'
    },
    {
      label: c.connLatency,
      value: latency === null ? '—' : `${latency} ms`,
      level: latency === null ? 'info' : latency < 300 ? 'ok' : latency < 1000 ? 'warn' : 'bad'
    }
  ];

  const notifications: Row[] = [
    {
      label: c.connNotifPermission,
      value: notifPermission === 'granted' ? c.connGranted : notifPermission === 'denied' ? c.connDenied : notifPermission === 'default' ? c.connNotAsked : c.connUnsupported,
      level: notifPermission === 'granted' ? 'ok' : notifPermission === 'denied' ? 'bad' : 'warn'
    },
    {
      label: c.connPushServer,
      value: pushStatus === null ? '…' : yesNo(pushStatus.hasVapid),
      level: pushStatus === null ? 'info' : pushStatus.hasVapid ? 'ok' : 'warn'
    },
    {
      label: c.connPushHere,
      value: !isPushSupported() ? c.connUnsupported : pushHere === null ? '…' : yesNo(pushHere),
      level: !isPushSupported() ? 'warn' : pushHere ? 'ok' : 'warn'
    },
    {
      label: c.connServiceWorker,
      value: swActive ? (swVersion ?? c.connYes) : c.connNo,
      level: swActive ? 'ok' : 'warn'
    }
  ];

  const calls: Row[] = [];
  if (ice.state === 'done') {
    const r = ice.result;
    calls.push({ label: c.connTurn, value: yesNo(r.turnConfigured), level: r.turnConfigured ? 'ok' : 'info' });
    calls.push({
      label: c.connCallsVerdict,
      value: r.relay ? c.connCallsRelay : r.srflx ? c.connCallsInternet : r.host ? c.connCallsLocalOnly : c.connCallsNone,
      level: r.relay ? 'ok' : r.srflx ? 'ok' : 'bad'
    });
  } else if (ice.state === 'error') {
    calls.push({ label: c.connCallsVerdict, value: c.connCallsError, level: 'bad' });
  }

  const supported = (v: boolean) => (v ? c.connAvailable : c.connUnavailable);
  const idleSupport = getSystemIdleSupport();
  const browser: Row[] = [
    { label: c.connVersion, value: `OpenWLM v${__APP_VERSION__}`, level: 'info' },
    { label: c.connSecure, value: yesNo(window.isSecureContext), level: window.isSecureContext ? 'ok' : 'bad' },
    { label: c.connLocalStorage, value: supported(typeof indexedDB !== 'undefined'), level: typeof indexedDB !== 'undefined' ? 'ok' : 'bad' },
    { label: c.connIdle, value: supported(idleSupport === 'available'), level: idleSupport === 'available' ? 'ok' : 'info' },
    { label: c.connWakeLock, value: supported('wakeLock' in navigator), level: 'wakeLock' in navigator ? 'ok' : 'info' },
    { label: c.connMediaSession, value: callKeepAliveSupported() ? supported('mediaSession' in navigator) : c.connAndroidOnly, level: callKeepAliveSupported() && 'mediaSession' in navigator ? 'ok' : 'info' }
  ];

  // --- Rapport texte ---
  const [copied, setCopied] = useState<'idle' | 'ok' | 'fail'>('idle');
  const copyReport = async () => {
    const section = (title: string, rows: Row[]) => [`[${title}]`, ...rows.map((r) => `${r.label} : ${r.value}`)].join('\n');
    const text = [
      `OpenWLM — ${c.connReportTitle} — ${new Date().toISOString()}`,
      `User-Agent : ${navigator.userAgent}`,
      section(c.connRealtime, realtime),
      section(c.connNotifications, notifications),
      section(c.connCalls, calls.length ? calls : [{ label: c.connCallsVerdict, value: c.connCallsNotRun, level: 'info' }]),
      section(c.connBrowser, browser)
    ].join('\n\n');
    try {
      await navigator.clipboard.writeText(text);
      setCopied('ok');
    } catch {
      setCopied('fail');
    }
  };

  const table = (rows: Row[], testId: string) => (
    <table className="conn-diag-table" data-testid={testId}>
      <tbody>
        {rows.map((r) => (
          <tr key={r.label}>
            <td className="conn-diag-label">{r.label}</td>
            <td className={`conn-diag-value conn-${r.level}`}><span className="conn-dot" aria-hidden="true" />{r.value}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );

  return (
    <div className="options-section" data-testid="options-connection">
      <div className="options-title">{t.settings.tabConnection}</div>

      <div className="options-subsection">
        <label className="options-label">{c.connRealtime}</label>
        {table(realtime, 'diag-realtime')}
        <button type="button" className="win-btn" style={{ marginTop: '6px' }} disabled={!socket} onClick={reconnect}>{c.connReconnect}</button>
      </div>

      <div className="options-subsection">
        <label className="options-label">{c.connNotifications}</label>
        {table(notifications, 'diag-notifications')}
      </div>

      <div className="options-subsection">
        <label className="options-label">{c.connCalls}</label>
        <div className="options-hint">{c.connCallsHint}</div>
        {calls.length > 0 && table(calls, 'diag-calls')}
        <button type="button" className="win-btn" style={{ marginTop: '6px' }} disabled={ice.state === 'running'} onClick={testCalls}>
          {ice.state === 'running' ? c.connCallsRunning : c.connCallsTest}
        </button>
      </div>

      <div className="options-subsection">
        <label className="options-label">{c.connBrowser}</label>
        {table(browser, 'diag-browser')}
      </div>

      <div className="options-subsection">
        <button type="button" className="win-btn" onClick={copyReport}>{c.connCopyReport}</button>
        {copied === 'ok' && <span className="options-hint" role="status" style={{ marginLeft: '8px', color: '#1b7d23' }}>{c.connCopied}</span>}
        {copied === 'fail' && <span className="options-hint" role="status" style={{ marginLeft: '8px', color: '#c02717' }}>{c.connCopyFailed}</span>}
      </div>
    </div>
  );
};

export default ConnectionDiagnostics;
