import React, { useEffect, useRef, useState, useCallback } from 'react';
import axios from 'axios';
import { Socket } from 'socket.io-client';
import { useI18n } from '../i18n';
import { isSoundAllowed, soundVolume } from '../utils/appPrefs';
import { formatNickname } from '../utils/NicknameFormatter';
import { startCallKeepAlive, keepScreenOn } from '../utils/callKeepAlive';
import { isNativeApp, isNativeAppLocked, startNativeCall, setNativeCallVideo, setNativeKeepScreenOn } from '../utils/platform';
import { stripPlusTags } from '../utils/plusFormat';
import {
  encryptMessagePayload,
  decryptMessagePayload,
  importPublicKeyForVerifying,
  signString,
  verifyString,
  extractFingerprints,
} from '../utils/Security';
import { notify } from '../utils/dialogs';

interface VideoCallProps {
  socket: Socket | null;
  activeChatId: number;
  myId: number;
  contactName: string;
  callerName: string; // Nom de celui qui appelle
  isReceivingCall: boolean;
  incomingSignal?: unknown;
  audioOnly?: boolean;
  myKeys?: { publicKeyJwk?: JsonWebKey; privateKey?: CryptoKey; signingKey?: CryptoKey | null } | null;
  getContactPublicKey?: (contactId: number, forceRefresh?: boolean) => Promise<JsonWebKey | null>;
  /** App Android : « Répondre » déjà choisi sur l'écran d'appel natif, prendre l'appel aussitôt. */
  autoAnswer?: boolean;
  onEndCall: () => void;
}

// Payload de signalisation (chiffré E2EE avant transport)
interface SignalPayload {
  type: string;
  sdp?: string;
  candidate?: RTCIceCandidateInit;
  fpSig?: string;
  /** type 'media-state' : le pair indique s'il envoie de la vidéo (caméra ou écran) */
  video?: boolean;
}

// 'waking' : aucun appareil de l'appelé n'a confirmé la réception (veille ?) — réveil par Push en cours
type CallStatus = 'calling' | 'waking' | 'remoteRinging' | 'ringing' | 'connecting' | 'connected' | 'reconnecting' | 'ended';
type Quality = 'good' | 'fair' | 'poor';

const DEFAULT_ICE: RTCConfiguration = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

// P1 : Opus — force FEC (résilience à la perte) et DTX (silence = pas de paquets)
const mungeOpus = (sdp: string): string => sdp.replace(/a=fmtp:(\d+) ([^\r\n]*minptime=[^\r\n]*)/g, (_m, pt, params) => {
  let p = String(params).replace(/useinbandfec=0/, 'useinbandfec=1').replace(/usedtx=0/, 'usedtx=1');
  if (!/useinbandfec=/.test(p)) p += ';useinbandfec=1';
  if (!/usedtx=/.test(p)) p += ';usedtx=1';
  return `a=fmtp:${pt} ${p}`;
});

const RING_TIMEOUT_MS = 45000;
const RECONNECT_AFTER_MS = 4000;
const RECOVERY_GIVE_UP_MS = 15000;
const MAX_ICE_RESTARTS = 3;

const fmtDuration = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

const VideoCall: React.FC<VideoCallProps> = ({ socket, activeChatId, myId, contactName, callerName, isReceivingCall, incomingSignal, audioOnly, myKeys, getContactPublicKey, autoAnswer, onEndCall }) => {
  const { t } = useI18n();
  const [callStatus, setCallStatus] = useState<CallStatus>(isReceivingCall ? 'ringing' : 'calling');
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [micOn, setMicOn] = useState(true);
  const [camOn, setCamOn] = useState(!audioOnly);
  /** Démarrer caméra coupée (cf. réponse automatique, app Android verrouillée). */
  const startCamOffRef = useRef(false);
  const [duration, setDuration] = useState(0);
  const [quality, setQuality] = useState<Quality>('good');
  const [showDevices, setShowDevices] = useState(false);
  const [sharingScreen, setSharingScreen] = useState(false);
  // Vidéo reçue du pair (caméra ou partage d'écran) — un appel audio peut passer en vidéo
  const [remoteVideoOn, setRemoteVideoOn] = useState(!audioOnly);
  const [micList, setMicList] = useState<MediaDeviceInfo[]>([]);
  const [camList, setCamList] = useState<MediaDeviceInfo[]>([]);
  const [spkList, setSpkList] = useState<MediaDeviceInfo[]>([]);
  const [micId, setMicId] = useState('');
  const [camId, setCamId] = useState('');
  const [spkId, setSpkId] = useState('');

  // FENÊTRE FLOTTANTE NON BLOQUANTE (style WLM 2009 : l'appel n'est pas une boîte de
  // dialogue modale, on garde la main sur la liste de contacts et les conversations).
  const isMobileViewport = () => window.matchMedia('(max-width: 600px)').matches;
  const [minimized, setMinimized] = useState(() => isMobileViewport());
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null); // null = position par défaut (bas-droite)
  const boxRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ startX: number; startY: number; originX: number; originY: number; pointerId: number } | null>(null);

  const clampToViewport = (x: number, y: number, el: HTMLElement) => {
    const margin = 8;
    const maxX = window.innerWidth - el.offsetWidth - margin;
    const maxY = window.innerHeight - el.offsetHeight - margin;
    return { x: Math.min(Math.max(x, margin), Math.max(margin, maxX)), y: Math.min(Math.max(y, margin), Math.max(margin, maxY)) };
  };

  const onDragPointerDown = (e: React.PointerEvent) => {
    // Ignore un clic sur un bouton de l'en-tête (fermer…)
    if ((e.target as HTMLElement).closest('button')) return;
    const el = boxRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    dragRef.current = { startX: e.clientX, startY: e.clientY, originX: rect.left, originY: rect.top, pointerId: e.pointerId };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onDragPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    const el = boxRef.current;
    if (!d || !el || d.pointerId !== e.pointerId) return;
    const next = clampToViewport(d.originX + (e.clientX - d.startX), d.originY + (e.clientY - d.startY), el);
    setPos(next);
  };
  const onDragPointerUp = (e: React.PointerEvent) => {
    if (dragRef.current?.pointerId === e.pointerId) dragRef.current = null;
  };

  // Garde la fenêtre dans le viewport : au redimensionnement de la fenêtre du navigateur,
  // et après un passage réduire/déplier (la boîte change de taille et peut déborder).
  useEffect(() => {
    const reclamp = () => setPos((p) => {
      const el = boxRef.current;
      if (!el || !p) return p;
      const next = clampToViewport(p.x, p.y, el);
      // Même référence si inchangé : évite toute boucle de re-rendu.
      return (next.x === p.x && next.y === p.y) ? p : next;
    });
    window.addEventListener('resize', reclamp);
    reclamp();
    return () => window.removeEventListener('resize', reclamp);
  }, [minimized]);

  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const peerConnectionRef = useRef<RTCPeerConnection | null>(null);
  const iceCandidatesQueue = useRef<RTCIceCandidateInit[]>([]);
  const hasInitialized = useRef(false);
  const endedRef = useRef(false);
  const restartCountRef = useRef(0);
  const ringTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const recoveryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const statusRef = useRef<CallStatus>(callStatus);
  const localStreamRef = useRef<MediaStream | null>(null);
  // P1 : renégociation (perfect negotiation), partage d'écran, adaptation
  const cameraTrackRef = useRef<MediaStreamTrack | null>(null);
  const screenTrackRef = useRef<MediaStreamTrack | null>(null);
  const politeRef = useRef(isReceivingCall);
  const makingOfferRef = useRef(false);
  const ignoreOfferRef = useRef(false);
  const renegotiationReadyRef = useRef(false);
  const adaptAppliedRef = useRef<Quality>('good');
  const adaptCandidateRef = useRef<{ level: Quality; count: number }>({ level: 'good', count: 0 });
  const ringAudioRef = useRef<HTMLAudioElement | null>(null);
  // Flux distant assemblé piste par piste (une piste vidéo peut arriver en cours d'appel)
  // Son et image distants dans DEUX éléments séparés : un <video> qui contient une piste vidéo
  // sans images (canal vidéo réservé d'un appel audio) ne démarre pas la lecture sur Chrome et
  // Safari (mobile surtout) — le son restait muet jusqu'à l'arrivée d'une première image.
  const remoteAudioStreamRef = useRef<MediaStream | null>(null);
  const remoteVideoStreamRef = useRef<MediaStream | null>(null);
  const remoteAudioRef = useRef<HTMLAudioElement>(null);
  // Lecture du son bloquée par le navigateur (autoplay) : bouton « Activer le son »
  const [audioBlocked, setAudioBlocked] = useState(false);
  // Réveil de l'appelé par une notification Push (pas d'appareil ayant confirmé la réception)
  const [wakingPushed, setWakingPushed] = useState(false);
  const camOnRef = useRef(!audioOnly);
  const sharingRef = useRef(false);

  useEffect(() => { statusRef.current = callStatus; }, [callStatus]);
  useEffect(() => { localStreamRef.current = localStream; }, [localStream]);

  const clearTimers = () => {
    if (ringTimerRef.current) { clearTimeout(ringTimerRef.current); ringTimerRef.current = null; }
    if (recoveryTimerRef.current) { clearTimeout(recoveryTimerRef.current); recoveryTimerRef.current = null; }
  };

  const teardown = useCallback(() => {
    clearTimers();
    if (peerConnectionRef.current) {
      try { peerConnectionRef.current.close(); } catch { /* ignore */ }
      peerConnectionRef.current = null;
    }
    if (screenTrackRef.current) { screenTrackRef.current.stop(); screenTrackRef.current = null; }
    if (localVideoRef.current) localVideoRef.current.srcObject = null;
    if (remoteVideoRef.current) remoteVideoRef.current.srcObject = null;
    if (remoteAudioRef.current) remoteAudioRef.current.srcObject = null;
  }, []);

  const finish = useCallback((noticeText?: string) => {
    if (endedRef.current) return;
    endedRef.current = true;
    if (socket) socket.emit('end_call', { target: activeChatId, caller: myId });
    const stream = localStreamRef.current;
    if (stream) stream.getTracks().forEach((track) => track.stop());
    setLocalStream(null);
    teardown();
    setCallStatus('ended');
    if (noticeText) { setNotice(noticeText); setTimeout(() => onEndCall(), 1800); }
    else onEndCall();
  }, [socket, activeChatId, myId, teardown, onEndCall]);

  const handleEndCall = useCallback(() => finish(), [finish]);

  const myKeysRef = useRef(myKeys);
  useEffect(() => { myKeysRef.current = myKeys; }, [myKeys]);
  const getContactKeyRef = useRef(getContactPublicKey);
  useEffect(() => { getContactKeyRef.current = getContactPublicKey; }, [getContactPublicKey]);
  const contactKeyRef = useRef<JsonWebKey | null>(null);

  const resolveContactKey = useCallback(async (): Promise<JsonWebKey | null> => {
    if (contactKeyRef.current) return contactKeyRef.current;
    try {
      const k = await getContactKeyRef.current?.(activeChatId);
      if (k) contactKeyRef.current = k;
      return k ?? null;
    } catch { return null; }
  }, [activeChatId]);

  // Chiffre (E2EE) + signe l'empreinte DTLS, puis renvoie la chaîne à transmettre.
  const buildSignal = useCallback(async (signal: SignalPayload): Promise<string | null> => {
    const keys = myKeysRef.current;
    const contactPub = await resolveContactKey();
    if (!keys?.publicKeyJwk || !contactPub) {
      console.warn('[WebRTC] Signal non chiffré : clés E2EE indisponibles');
      return null;
    }
    const payload: SignalPayload = { ...signal };
    if ((payload.type === 'offer' || payload.type === 'answer') && payload.sdp && keys.signingKey) {
      try { payload.fpSig = await signString(keys.signingKey, extractFingerprints(payload.sdp)); } catch { /* ignore */ }
    }
    try {
      const e2ee = await encryptMessagePayload(payload, contactPub, keys.publicKeyJwk);
      return JSON.stringify(e2ee);
    } catch (e) { console.error('[WebRTC] Échec chiffrement signal:', e); return null; }
  }, [resolveContactKey]);

  const emitSignal = useCallback(async (signal: SignalPayload) => {
    if (!socket) return;
    const encoded = await buildSignal(signal);
    if (encoded) socket.emit('webrtc_signal', { target: activeChatId, caller: myId, signal: encoded });
  }, [socket, activeChatId, myId, buildSignal]);

  const decryptSignal = useCallback(async (raw: unknown): Promise<SignalPayload | null> => {
    const keys = myKeysRef.current;
    if (!keys?.privateKey) return null;
    try {
      const e2ee = typeof raw === 'string' ? JSON.parse(raw) : raw;
      return await decryptMessagePayload<SignalPayload>(e2ee, keys.privateKey, false);
    } catch (e) { console.error('[WebRTC] Échec déchiffrement signal:', e); return null; }
  }, []);

  // Vérifie la signature de l'empreinte DTLS (anti-MITM). STRICTE : une offre/réponse
  // sans signature, ou impossible à vérifier, est REFUSÉE. L'ancienne version acceptait
  // ces cas (« tolérant si indisponible ») : le serveur, qui connaît notre clé publique,
  // pouvait alors chiffrer pour nous une signalisation non signée portant SA propre
  // empreinte DTLS et s'interposer dans l'appel.
  const verifyFingerprint = useCallback(async (payload: SignalPayload): Promise<boolean> => {
    if (!payload.sdp || !payload.fpSig) return false;
    const contactPub = await resolveContactKey();
    if (!contactPub) return false;
    const vk = await importPublicKeyForVerifying(contactPub);
    if (!vk) return false;
    return await verifyString(vk, extractFingerprints(payload.sdp), payload.fpSig);
  }, [resolveContactKey]);

  const applySenderCaps = useCallback(async (pc: RTCPeerConnection) => {
    for (const sender of pc.getSenders()) {
      if (!sender.track) continue;
      try {
        const params = sender.getParameters();
        if (!params.encodings || params.encodings.length === 0) params.encodings = [{}];
        if (sender.track.kind === 'audio') params.encodings[0].maxBitrate = 32000;
        else {
          params.encodings[0].maxBitrate = 1200000;
          (params as RTCRtpSendParameters & { degradationPreference?: string }).degradationPreference = 'balanced';
        }
        await sender.setParameters(params);
      } catch { /* refusé avant négociation — retenté après */ }
    }
  }, []);

  // Émetteur vidéo : celui de la piste caméra (appel vidéo) ou celui du transceiver vidéo
  // réservé dès le départ dans un appel audio (piste nulle tant que rien n'est partagé).
  const getVideoSender = useCallback((): RTCRtpSender | null => {
    const pc = peerConnectionRef.current;
    if (!pc) return null;
    const tr = pc.getTransceivers().find((x) => x.receiver.track?.kind === 'video' && x.direction !== 'stopped' && x.direction !== 'inactive');
    return tr ? tr.sender : null;
  }, []);

  // Prévient le pair qu'on envoie (ou non) de la vidéo, pour qu'il affiche l'image ou l'écran audio
  const sendMediaState = useCallback(() => {
    void emitSignal({ type: 'media-state', video: camOnRef.current || sharingRef.current });
  }, [emitSignal]);

  // P1 : applique une description locale « mungée » (Opus FEC/DTX), avec repli sûr.
  const applyLocalDescription = useCallback(async (pc: RTCPeerConnection, desc: RTCSessionDescriptionInit) => {
    const sdp = desc.sdp || '';
    if (sdp) {
      try { await pc.setLocalDescription({ type: desc.type, sdp: mungeOpus(sdp) }); return; }
      catch { /* SDP modifié refusé — on retombe sur l'original */ }
    }
    await pc.setLocalDescription(desc);
  }, []);

  // P1 : adaptation dynamique du débit/résolution vidéo selon la qualité mesurée.
  const applyAdaptation = useCallback(async (level: Quality) => {
    const pc = peerConnectionRef.current;
    if (!pc) return;
    const sender = getVideoSender();
    if (!sender || !sender.track) return;
    try {
      const params = sender.getParameters();
      if (!params.encodings || params.encodings.length === 0) params.encodings = [{}];
      if (level === 'poor') { params.encodings[0].maxBitrate = 250000; params.encodings[0].scaleResolutionDownBy = 2; }
      else if (level === 'fair') { params.encodings[0].maxBitrate = 600000; params.encodings[0].scaleResolutionDownBy = 1.5; }
      else { params.encodings[0].maxBitrate = 1200000; params.encodings[0].scaleResolutionDownBy = 1; }
      await sender.setParameters(params);
    } catch { /* ignore */ }
  }, [getVideoSender]);

  // Fin du partage d'écran : retour à la caméra si elle est active, sinon plus de vidéo
  const restoreCamera = useCallback(async () => {
    const sender = getVideoSender();
    const cam = cameraTrackRef.current;
    const camLive = cam && cam.readyState === 'live' ? cam : null;
    if (sender) { try { await sender.replaceTrack(camLive); } catch { /* ignore */ } }
    if (screenTrackRef.current) { screenTrackRef.current.stop(); screenTrackRef.current = null; }
    if (localVideoRef.current) localVideoRef.current.srcObject = localStreamRef.current;
    sharingRef.current = false;
    setSharingScreen(false);
    sendMediaState();
  }, [getVideoSender, sendMediaState]);

  // Envoie une piste vidéo : par remplacement sur l'émetteur existant (sans renégociation) ;
  // à défaut (pair d'une ancienne version, sans transceiver vidéo), ajout + renégociation.
  const sendVideoTrack = useCallback(async (track: MediaStreamTrack) => {
    const pc = peerConnectionRef.current;
    if (!pc) return false;
    const sender = getVideoSender();
    if (sender) {
      await sender.replaceTrack(track);
      return true;
    }
    pc.addTrack(track, localStreamRef.current || new MediaStream([track]));
    return true;
  }, [getVideoSender]);

  // Partage d'écran (aussi possible depuis un appel audio).
  const toggleShare = useCallback(async () => {
    if (!peerConnectionRef.current) return;
    if (sharingScreen) { await restoreCamera(); return; }
    try {
      const display = await navigator.mediaDevices.getDisplayMedia({ video: true });
      const screenTrack = display.getVideoTracks()[0];
      screenTrackRef.current = screenTrack;
      await sendVideoTrack(screenTrack);
      if (localVideoRef.current) localVideoRef.current.srcObject = new MediaStream([screenTrack]);
      sharingRef.current = true;
      setSharingScreen(true);
      sendMediaState();
      screenTrack.onended = () => { restoreCamera(); }; // arrêt depuis l'UI du navigateur
    } catch { /* refusé */ }
  }, [sharingScreen, restoreCamera, sendVideoTrack, sendMediaState]);

  const tryRestartIce = useCallback(() => {
    const pc = peerConnectionRef.current;
    if (!pc || endedRef.current) return;
    if (restartCountRef.current >= MAX_ICE_RESTARTS) { finish(t.videoCall.failed); return; }
    restartCountRef.current += 1;
    setCallStatus('reconnecting');
    try { pc.restartIce(); } catch { /* ignore */ }
    if (recoveryTimerRef.current) clearTimeout(recoveryTimerRef.current);
    recoveryTimerRef.current = setTimeout(() => {
      if (peerConnectionRef.current?.connectionState !== 'connected') finish(t.videoCall.failed);
    }, RECOVERY_GIVE_UP_MS);
  }, [finish, t]);

  const fetchRtcConfig = useCallback(async (): Promise<RTCConfiguration> => {
    try {
      const res = await axios.get('/api/rtc-config');
      const data = res.data || {};
      if (Array.isArray(data.iceServers) && data.iceServers.length > 0) {
        return { iceServers: data.iceServers, iceTransportPolicy: data.iceTransportPolicy || 'all' };
      }
    } catch { /* repli STUN */ }
    return DEFAULT_ICE;
  }, []);

  const initCall = useCallback(async () => {
    if (hasInitialized.current) return;
    hasInitialized.current = true;

    try {
      if (!navigator.mediaDevices || !window.isSecureContext) {
        notify(t.videoCall.unsecureContext, { icon: '⚠️' });
        finish();
        return;
      }

      const rtcConfig = await fetchRtcConfig();

      const constraints: MediaStreamConstraints = {
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: audioOnly ? false : { width: { ideal: 640 }, height: { ideal: 360 }, frameRate: { ideal: 24, max: 30 } },
      };

      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia(constraints);
      } catch (err) {
        const name = err instanceof DOMException ? err.name : '';
        if (name === 'NotAllowedError') notify(t.videoCall.permissionDenied, { icon: '⚠️' });
        else if (name === 'NotFoundError') notify(t.videoCall.noDevice, { icon: '⚠️' });
        else if (name === 'NotReadableError') notify(t.videoCall.deviceBusy, { icon: '⚠️' });
        else notify(t.videoCall.mediaError, { icon: '⚠️' });
        finish();
        return;
      }

      // Appel vidéo pris depuis l'écran d'appel natif alors que l'app est verrouillée : caméra
      // coupée au départ (celui qui tient le téléphone n'a pas déverrouillé l'app) ; on peut
      // l'allumer ensuite avec le bouton caméra
      if (!audioOnly && startCamOffRef.current) stream.getVideoTracks().forEach((track) => { track.enabled = false; });

      setLocalStream(stream);
      if (localVideoRef.current) localVideoRef.current.srcObject = stream;
      setMicOn(stream.getAudioTracks()[0]?.enabled ?? true);
      setCamOn(audioOnly ? false : (stream.getVideoTracks()[0]?.enabled ?? true));
      camOnRef.current = audioOnly ? false : (stream.getVideoTracks()[0]?.enabled ?? true);
      cameraTrackRef.current = stream.getVideoTracks()[0] || null;

      const pc = new RTCPeerConnection(rtcConfig);
      peerConnectionRef.current = pc;

      pc.onicecandidate = (event) => { if (event.candidate) emitSignal({ type: 'ice-candidate', candidate: event.candidate }); };

      pc.ontrack = (event) => {
        // Flux distants assemblés à la main (une piste ajoutée en cours d'appel rejoint
        // l'élément déjà en lecture) : le son dans <audio>, l'image dans <video> (muet).
        if (event.track.kind === 'audio') {
          const audioEl = remoteAudioRef.current;
          if (audioEl) {
            let as = remoteAudioStreamRef.current;
            if (!as) { as = new MediaStream(); remoteAudioStreamRef.current = as; }
            if (!as.getTracks().includes(event.track)) as.addTrack(event.track);
            if (audioEl.srcObject !== as) audioEl.srcObject = as;
            audioEl.volume = 1.0;
            audioEl.play().then(() => setAudioBlocked(false)).catch(() => setAudioBlocked(true));
          }
        } else {
          const videoEl = remoteVideoRef.current;
          if (videoEl) {
            let vs = remoteVideoStreamRef.current;
            if (!vs) { vs = new MediaStream(); remoteVideoStreamRef.current = vs; }
            if (!vs.getTracks().includes(event.track)) vs.addTrack(event.track);
            if (videoEl.srcObject !== vs) videoEl.srcObject = vs;
            videoEl.muted = true;
            videoEl.play().catch(() => { /* image : relancée à l'arrivée des images */ });
          }
        }
        if (event.track.kind === 'video') {
          const track = event.track;
          const upd = () => setRemoteVideoOn(track.readyState === 'live' && !track.muted);
          track.onmute = upd;
          track.onunmute = upd;
          track.onended = upd;
          if (!audioOnly) upd();
        }
        restartCountRef.current = 0;
        setCallStatus('connected');
      };

      const onConnState = () => {
        const pc2 = peerConnectionRef.current;
        if (!pc2) return;
        const st = pc2.connectionState;
        if (st === 'connected') {
          restartCountRef.current = 0;
          renegotiationReadyRef.current = true;
          if (recoveryTimerRef.current) { clearTimeout(recoveryTimerRef.current); recoveryTimerRef.current = null; }
          setCallStatus('connected');
        } else if (st === 'disconnected') {
          if (statusRef.current === 'connected') {
            setCallStatus('reconnecting');
            if (recoveryTimerRef.current) clearTimeout(recoveryTimerRef.current);
            recoveryTimerRef.current = setTimeout(() => {
              if (peerConnectionRef.current?.connectionState !== 'connected') tryRestartIce();
            }, RECONNECT_AFTER_MS);
          }
        } else if (st === 'failed') {
          tryRestartIce();
        }
      };
      pc.onconnectionstatechange = onConnState;
      pc.oniceconnectionstatechange = onConnState;

      // P1 : renégociation (perfect negotiation) — n'agit qu'après la négociation initiale.
      pc.onnegotiationneeded = async () => {
        if (!renegotiationReadyRef.current) return;
        try {
          makingOfferRef.current = true;
          await pc.setLocalDescription();
          await emitSignal({ type: 'offer', sdp: pc.localDescription?.sdp });
        } catch { /* ignore */ } finally { makingOfferRef.current = false; }
      };

      stream.getTracks().forEach((track) => pc.addTrack(track, stream));
      // Appel audio : on réserve un canal vidéo dès l'offre, pour pouvoir activer la caméra
      // ou partager l'écran plus tard par simple remplacement de piste (sans renégociation).
      if (audioOnly && !isReceivingCall) {
        pc.addTransceiver('video', { direction: 'sendrecv', streams: [stream] });
      }

      if (isReceivingCall && incomingSignal) {
        const offer = await decryptSignal(incomingSignal);
        if (!offer?.sdp) { console.error('[WebRTC] Offre entrante illisible'); finish(t.videoCall.genericError); return; }
        if (!(await verifyFingerprint(offer))) { console.error('[WebRTC] Empreinte DTLS invalide (offre)'); finish(t.videoCall.failed); return; }
        await pc.setRemoteDescription(new RTCSessionDescription({ type: offer.type as RTCSdpType, sdp: offer.sdp }));
        // Canal vidéo proposé sans piste de notre côté (appel audio) : on le passe en
        // émission/réception pour pouvoir y brancher la caméra ou l'écran plus tard.
        pc.getTransceivers().forEach((tr) => {
          if (tr.receiver.track?.kind === 'video' && !tr.sender.track && tr.direction === 'recvonly') {
            tr.direction = 'sendrecv';
          }
        });
        const answer = await pc.createAnswer();
        await applyLocalDescription(pc, answer);
        await emitSignal({ type: 'answer', sdp: pc.localDescription?.sdp });
        await applySenderCaps(pc);
        for (const candidate of iceCandidatesQueue.current) {
          await pc.addIceCandidate(new RTCIceCandidate(candidate)).catch(() => { /* ignore */ });
        }
        iceCandidatesQueue.current = [];
        // `ontrack` a déjà pu passer l'appel à « connecté » pendant setRemoteDescription
        setCallStatus((st) => (st === 'connected' ? st : 'connecting'));
      } else {
        const offer = await pc.createOffer();
        await applyLocalDescription(pc, offer);
        const encodedOffer = await buildSignal({ type: 'offer', sdp: pc.localDescription?.sdp });
        if (!encodedOffer) {
          console.error('[WebRTC] Offre non chiffrée : appel annulé');
          finish(t.videoCall.genericError);
          return;
        }
        if (socket) {
          socket.emit('call_request', { target: activeChatId, caller: myId, callerName, signal: encodedOffer, audioOnly });
        }
        await applySenderCaps(pc);
        ringTimerRef.current = setTimeout(() => {
          if (statusRef.current !== 'connected') finish(t.videoCall.noAnswer);
        }, RING_TIMEOUT_MS);
      }
    } catch (err) {
      console.error('[WebRTC] initCall:', err);
      notify(t.videoCall.genericError, { icon: '⚠️' });
      finish();
    }
  }, [audioOnly, activeChatId, myId, isReceivingCall, incomingSignal, socket, callerName, emitSignal, decryptSignal, verifyFingerprint, buildSignal, applySenderCaps, applyLocalDescription, fetchRtcConfig, finish, tryRestartIce, t]);

  // Sonnerie d'appel entrant : élément audio EN BOUCLE (les minuteries sont
  // fortement throttlées dans un onglet en arrière-plan, pas la lecture média).
  useEffect(() => {
    if (callStatus !== 'ringing') {
      if (ringAudioRef.current) { ringAudioRef.current.pause(); ringAudioRef.current.currentTime = 0; ringAudioRef.current = null; }
      return;
    }
    // Sonnerie : réglage « Sons → Appels » (toujours active en « Occupé »)
    if (!isSoundAllowed('call')) return;
    const audio = new Audio('/assets/sounds/phone.mp3');
    audio.loop = true;
    audio.volume = soundVolume();
    ringAudioRef.current = audio;
    audio.play().catch((e) => { console.warn('[WebRTC] Sonnerie bloquée par la politique autoplay:', e); });
    return () => { audio.pause(); audio.currentTime = 0; if (ringAudioRef.current === audio) ringAudioRef.current = null; };
  }, [callStatus]);

  useEffect(() => {
    if (!isReceivingCall && callStatus === 'calling' && !hasInitialized.current) initCall();
  }, [isReceivingCall, callStatus, initCall]);

  // Android : garder la page active écran éteint pendant l'appel (cf. callKeepAlive)
  const finishRef = useRef(finish);
  useEffect(() => { finishRef.current = finish; }, [finish]);
  const callActive = callStatus === 'connecting' || callStatus === 'connected' || callStatus === 'reconnecting';
  const keepAliveTitle = t.videoCall.conversationWith
    .replace('{type}', (audioOnly ? t.videoCall.audio : t.videoCall.video).toLowerCase())
    .replace('{name}', stripPlusTags(contactName));
  // App Android : service d'appel natif à la place (cf. src/utils/platform.ts)
  const nativeApp = isNativeApp();
  const peerName = stripPlusTags(contactName);
  useEffect(() => {
    if (!callActive) return;
    if (nativeApp) return startNativeCall({ peerName, video: !audioOnly, onHangUp: () => finishRef.current() });
    return startCallKeepAlive({ title: keepAliveTitle, onHangUp: () => finishRef.current() });
  }, [callActive, keepAliveTitle, nativeApp, peerName, audioOnly]);

  // Vidéo en cours (la mienne ou celle du correspondant) : garder l'écran allumé
  const videoFlowing = callActive && (camOn || sharingScreen || remoteVideoOn);
  useEffect(() => {
    if (nativeApp) {
      // Haut-parleur et écran allumé en vidéo ; écouteur et capteur de proximité sinon.
      // Fin de la vidéo ou de l'appel : l'écran peut de nouveau s'éteindre
      if (!callActive) return;
      setNativeCallVideo(videoFlowing);
      return videoFlowing ? () => setNativeKeepScreenOn(false) : undefined;
    }
    if (!videoFlowing) return;
    return keepScreenOn();
  }, [videoFlowing, callActive, nativeApp]);

  // Minuteur d'appel
  useEffect(() => {
    if (callStatus !== 'connected') return;
    const id = setInterval(() => setDuration((d) => d + 1), 1000);
    return () => clearInterval(id);
  }, [callStatus]);

  // Indicateur de qualité (lecture seule via getStats)
  useEffect(() => {
    if (callStatus !== 'connected') return;
    let stop = false;
    const poll = async () => {
      const pc = peerConnectionRef.current;
      if (!pc) return;
      try {
        const stats = await pc.getStats();
        let rtt: number | null = null;
        let lost = 0; let recv = 0;
        stats.forEach((r: Record<string, unknown>) => {
          if (r.type === 'candidate-pair' && (r.nominated === true) && typeof r.currentRoundTripTime === 'number') rtt = r.currentRoundTripTime as number;
          if (r.type === 'inbound-rtp' && r.isRemote !== true) {
            lost += (r.packetsLost as number) || 0;
            recv += (r.packetsReceived as number) || 0;
          }
        });
        const loss = (lost + recv) > 0 ? (lost / (lost + recv)) * 100 : 0;
        let level: Quality = 'good';
        if ((rtt !== null && rtt > 0.3) || loss > 5) level = 'poor';
        else if ((rtt !== null && rtt > 0.15) || loss > 1.5) level = 'fair';
        if (stop) return;
        setQuality(level);
        // P1 : hystérésis (2 mesures consécutives) avant d'appliquer l'adaptation
        if (adaptCandidateRef.current.level === level) adaptCandidateRef.current.count += 1;
        else adaptCandidateRef.current = { level, count: 1 };
        if (adaptCandidateRef.current.count >= 2 && adaptAppliedRef.current !== level) {
          adaptAppliedRef.current = level;
          applyAdaptation(level);
        }
      } catch { /* ignore */ }
    };
    poll();
    const id = setInterval(poll, 3000);
    return () => { stop = true; clearInterval(id); };
  }, [callStatus, applyAdaptation]);

  // Périphériques (micro / caméra / haut-parleur)
  const refreshDevices = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    try {
      const list = await navigator.mediaDevices.enumerateDevices();
      setMicList(list.filter((d) => d.kind === 'audioinput'));
      setCamList(list.filter((d) => d.kind === 'videoinput'));
      setSpkList(list.filter((d) => d.kind === 'audiooutput'));
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    if (callStatus !== 'connected' && callStatus !== 'connecting') return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- chargement initial de la liste des périphériques
    refreshDevices();
    const md = navigator.mediaDevices;
    if (!md?.addEventListener) return;
    md.addEventListener('devicechange', refreshDevices);
    return () => md.removeEventListener('devicechange', refreshDevices);
  }, [callStatus, refreshDevices]);

  const toggleMic = () => {
    const track = localStreamRef.current?.getAudioTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    setMicOn(track.enabled);
  };

  const setCam = (on: boolean) => {
    camOnRef.current = on;
    setCamOn(on);
    sendMediaState();
  };

  const toggleCam = async () => {
    const track = localStreamRef.current?.getVideoTracks()[0];
    if (audioOnly) {
      // Appel démarré en audio : la caméra est ouverte à la demande et vraiment libérée à l'arrêt
      if (track && track.readyState === 'live') {
        track.stop();
        cameraTrackRef.current = null;
        const prev = localStreamRef.current;
        const ns = new MediaStream(prev ? prev.getAudioTracks() : []);
        setLocalStream(ns);
        if (!sharingRef.current) {
          const sender = getVideoSender();
          if (sender) { try { await sender.replaceTrack(null); } catch { /* ignore */ } }
          if (localVideoRef.current) localVideoRef.current.srcObject = ns;
        }
        setCam(false);
        return;
      }
      try {
        const s = await navigator.mediaDevices.getUserMedia({
          video: camId
            ? { deviceId: { exact: camId }, width: { ideal: 640 }, height: { ideal: 360 }, frameRate: { ideal: 24, max: 30 } }
            : { width: { ideal: 640 }, height: { ideal: 360 }, frameRate: { ideal: 24, max: 30 } },
        });
        const camTrack = s.getVideoTracks()[0];
        cameraTrackRef.current = camTrack;
        const prev = localStreamRef.current;
        const ns = new MediaStream([...(prev ? prev.getAudioTracks() : []), camTrack]);
        setLocalStream(ns);
        localStreamRef.current = ns;
        // Pendant un partage d'écran, l'écran reste prioritaire : la caméra prendra le relais à la fin
        if (!sharingRef.current) {
          await sendVideoTrack(camTrack);
          if (localVideoRef.current) localVideoRef.current.srcObject = ns;
        }
        setCam(true);
        refreshDevices();
      } catch (err) {
        const name = err instanceof DOMException ? err.name : '';
        if (name === 'NotAllowedError') notify(t.videoCall.permissionDenied, { icon: '⚠️' });
        else if (name === 'NotFoundError') notify(t.videoCall.noDevice, { icon: '⚠️' });
        else if (name === 'NotReadableError') notify(t.videoCall.deviceBusy, { icon: '⚠️' });
        else notify(t.videoCall.mediaError, { icon: '⚠️' });
      }
      return;
    }
    if (!track) return;
    track.enabled = !track.enabled;
    setCam(track.enabled);
  };

  const applyLocalTrack = (kind: 'audio' | 'video', newTrack: MediaStreamTrack) => {
    const prev = localStreamRef.current;
    const others = prev ? prev.getTracks().filter((tr) => tr.kind !== kind) : [];
    if (prev) prev.getTracks().filter((tr) => tr.kind === kind).forEach((tr) => tr.stop());
    const ns = new MediaStream([...others, newTrack]);
    setLocalStream(ns);
    if (kind === 'video' && localVideoRef.current) localVideoRef.current.srcObject = ns;
  };

  const switchDevice = async (kind: 'audio' | 'video', deviceId: string) => {
    const pc = peerConnectionRef.current;
    try {
      const cs: MediaStreamConstraints = kind === 'audio'
        ? { audio: { deviceId: { exact: deviceId } } }
        : { video: { deviceId: { exact: deviceId }, width: { ideal: 640 }, height: { ideal: 360 }, frameRate: { ideal: 24 } } };
      const s = await navigator.mediaDevices.getUserMedia(cs);
      const newTrack = s.getTracks()[0];
      const sender = kind === 'video'
        ? (sharingRef.current ? null : getVideoSender())
        : pc?.getSenders().find((sd) => sd.track && sd.track.kind === kind);
      if (sender) await sender.replaceTrack(newTrack);
      if (kind === 'video') cameraTrackRef.current = newTrack;
      applyLocalTrack(kind, newTrack);
      if (kind === 'audio') setMicId(deviceId); else setCamId(deviceId);
    } catch { /* ignore */ }
  };

  const switchSpeaker = async (deviceId: string) => {
    setSpkId(deviceId);
    // Le son sort de l'élément <audio> : c'est lui qui change de haut-parleur
    const el = remoteAudioRef.current as (HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> }) | null;
    if (el?.setSinkId) { try { await el.setSinkId(deviceId); } catch { /* ignore */ } }
  };

  const toggleFullscreen = () => {
    const el = containerRef.current;
    if (!el) return;
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else el.requestFullscreen?.().catch(() => {});
  };

  const togglePip = async () => {
    const v = remoteVideoRef.current as (HTMLVideoElement & { requestPictureInPicture?: () => Promise<unknown> }) | null;
    if (!v?.requestPictureInPicture) return;
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else await v.requestPictureInPicture();
    } catch { /* ignore */ }
  };

  const handleAcceptCall = () => {
    setCallStatus('connecting');
    if (socket) socket.emit('call_accept', { target: activeChatId });
    initCall();
  };

  // « Répondre » choisi sur l'écran d'appel de l'app Android : pas de second appui
  const autoAnsweredRef = useRef(false);
  useEffect(() => {
    if (!autoAnswer || autoAnsweredRef.current || !isReceivingCall || callStatus !== 'ringing') return;
    autoAnsweredRef.current = true;
    isNativeAppLocked().then((locked) => {
      startCamOffRef.current = locked;
      handleAcceptCall();
    });
  });

  // Caméra coupée au départ : le correspondant en est informé une fois l'appel établi
  const camOffSentRef = useRef(false);
  useEffect(() => {
    if (callStatus !== 'connected' || !startCamOffRef.current || camOffSentRef.current) return;
    camOffSentRef.current = true;
    sendMediaState();
  }, [callStatus, sendMediaState]);

  const handleRejectCall = () => {
    if (socket) socket.emit('call_reject', { target: activeChatId });
    finish();
  };

  // Signaux & évènements d'appel
  useEffect(() => {
    if (!socket) return;

    const handleSignal = async (data: { caller: number; signal: string }) => {
      if (data.caller !== activeChatId) return;
      const pc = peerConnectionRef.current;
      try {
        const payload = await decryptSignal(data.signal);
        if (!payload) return;
        // Anti-MITM : la signalisation (offer/answer) doit être signée par la clé E2EE du pair.
        if ((payload.type === 'offer' || payload.type === 'answer') && !(await verifyFingerprint(payload))) {
          console.error('[WebRTC] Signature d\'empreinte DTLS invalide (signal)');
          finish(t.videoCall.failed);
          return;
        }
        if (payload.type === 'answer') {
          if (pc && pc.signalingState === 'have-local-offer') {
            await pc.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp: payload.sdp }));
            // Candidats ICE du pair arrivés AVANT la réponse (chiffrement plus rapide que
            // celui de la réponse signée) : sans ce drainage, ils étaient perdus côté appelant.
            for (const candidate of iceCandidatesQueue.current) {
              await pc.addIceCandidate(new RTCIceCandidate(candidate)).catch(() => { /* ignore */ });
            }
            iceCandidatesQueue.current = [];
            await applySenderCaps(pc);
            renegotiationReadyRef.current = true;
            // Mise à jour fonctionnelle : `ontrack` a pu passer l'appel à « connecté » pendant
            // setRemoteDescription, alors que statusRef (synchronisé après rendu) l'ignore encore.
            setCallStatus((st) => (st === 'connected' ? st : 'connecting'));
          }
        } else if (payload.type === 'offer') {
          // P1 : renégociation (perfect negotiation)
          if (!pc) return;
          const collision = makingOfferRef.current || pc.signalingState !== 'stable';
          ignoreOfferRef.current = !politeRef.current && collision;
          if (ignoreOfferRef.current) return;
          await pc.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp: payload.sdp }));
          const answer = await pc.createAnswer();
          await applyLocalDescription(pc, answer);
          void emitSignal({ type: 'answer', sdp: pc.localDescription?.sdp });
        } else if (payload.type === 'media-state') {
          setRemoteVideoOn(!!payload.video);
        } else if (payload.type === 'ice-candidate' && payload.candidate) {
          if (pc && pc.remoteDescription) {
            await pc.addIceCandidate(new RTCIceCandidate(payload.candidate)).catch(() => { /* ignore */ });
          } else {
            iceCandidatesQueue.current.push(payload.candidate);
          }
        }
      } catch (e) { console.error('[WebRTC] Erreur traitement signal:', e); }
    };

    // « Ça sonne » n'arrive que lorsqu'un appareil de l'appelé a CONFIRMÉ la réception de l'appel
    const onRinging = (d: { target: number }) => { if (d.target === activeChatId && !isReceivingCall) setCallStatus((st) => (st === 'connected' || st === 'connecting' ? st : 'remoteRinging')); };
    const onWaking = (d: { target: number; pushed?: boolean }) => {
      if (d.target !== activeChatId || isReceivingCall) return;
      setWakingPushed(!!d.pushed);
      setCallStatus((st) => (st === 'calling' ? 'waking' : st));
    };
    const onAccepted = (d: { by: number }) => { if (d.by === activeChatId) setCallStatus((st) => (st === 'connected' ? st : 'connecting')); };
    const onRejected = (d: { by: number }) => { if (d.by === activeChatId) finish(t.videoCall.rejected); };
    const onBusy = (d: { target: number }) => { if (d.target === activeChatId) finish(t.videoCall.busy); };
    const onUnavailable = (d: { target: number }) => { if (d.target === activeChatId) finish(t.videoCall.unavailable); };
    const onEnded = (d: { caller: number }) => { if (d.caller === activeChatId) finish(); };
    const onSocketReconnect = () => { if (peerConnectionRef.current && statusRef.current === 'connected') tryRestartIce(); };

    socket.on('webrtc_signal', handleSignal);
    socket.on('call_ringing', onRinging);
    socket.on('call_waking', onWaking);
    socket.on('call_accepted', onAccepted);
    socket.on('call_rejected', onRejected);
    socket.on('call_busy', onBusy);
    socket.on('call_unavailable', onUnavailable);
    socket.on('call_ended', onEnded);
    socket.on('connect', onSocketReconnect);

    return () => {
      socket.off('webrtc_signal', handleSignal);
      socket.off('call_ringing', onRinging);
      socket.off('call_waking', onWaking);
      socket.off('call_accepted', onAccepted);
      socket.off('call_rejected', onRejected);
      socket.off('call_busy', onBusy);
      socket.off('call_unavailable', onUnavailable);
      socket.off('call_ended', onEnded);
      socket.off('connect', onSocketReconnect);
    };
  }, [socket, activeChatId, isReceivingCall, applySenderCaps, applyLocalDescription, emitSignal, decryptSignal, verifyFingerprint, finish, tryRestartIce, t]);

  useEffect(() => {
    return () => {
      endedRef.current = true;
      hasInitialized.current = false;
      clearTimers();
      const stream = localStreamRef.current;
      if (stream) stream.getTracks().forEach((track) => track.stop());
      if (peerConnectionRef.current) { try { peerConnectionRef.current.close(); } catch { /* ignore */ } peerConnectionRef.current = null; }
    };
  }, []);

  const overlayText = () => {
    if (notice) return notice;
    switch (callStatus) {
      case 'calling': return formatNickname(t.videoCall.calling.replace('{name}', contactName));
      case 'remoteRinging': return formatNickname(t.videoCall.remoteRinging.replace('{name}', contactName));
      case 'waking': return formatNickname((wakingPushed ? t.videoCall.waking : t.videoCall.wakingNoPush).replace('{name}', contactName));
      case 'connecting': return t.videoCall.connecting;
      case 'reconnecting': return t.videoCall.reconnecting;
      case 'ended': return t.videoCall.ended;
      default: return '';
    }
  };

  const localVideoOn = camOn || sharingScreen;
  const isVideoCall = !audioOnly || localVideoOn || remoteVideoOn;
  const canShareScreen = typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getDisplayMedia;
  const showOverlay = callStatus !== 'connected' || !remoteVideoOn;
  const qualityLabel = quality === 'good' ? t.videoCall.qualityGood : quality === 'fair' ? t.videoCall.qualityFair : t.videoCall.qualityPoor;

  // Pendant la sonnerie, une décision immédiate est attendue : on garde une boîte
  // centrée classique. Une fois l'appel engagé, la fenêtre devient flottante et
  // déplaçable, et ne bloque plus l'accès au reste de l'application (liste de
  // contacts, autres conversations) — comme sur WLM 2009.
  const isModalPhase = callStatus === 'ringing';
  // La réduction est ignorée pendant la sonnerie : sur mobile l'appel démarre réduit par
  // défaut, mais les boutons accepter/refuser (dans la scène) doivent être visibles
  // immédiatement pour répondre à l'appel entrant.
  const effMinimized = minimized && callStatus !== 'ringing';
  const boxStyle: React.CSSProperties = (!isModalPhase && pos) ? { left: pos.x, top: pos.y, right: 'auto', bottom: 'auto' } : {};

  return (
    <div className={`wlm-video-modal${isModalPhase ? ' wlm-video-modal-ringing' : ''}`}>
      <div
        ref={boxRef}
        className={`wlm-video-box wlm-call-skin${effMinimized ? ' wlm-call-minimized' : ''}`}
        style={boxStyle}
      >
        <div
          className="win-modal-header wlm-call-titlebar"
          style={styles.header}
          onPointerDown={isModalPhase ? undefined : onDragPointerDown}
          onPointerMove={isModalPhase ? undefined : onDragPointerMove}
          onPointerUp={isModalPhase ? undefined : onDragPointerUp}
        >
          <span>{formatNickname(t.videoCall.conversationWith.replace('{type}', isVideoCall ? t.videoCall.video : t.videoCall.audio).replace('{name}', contactName))}</span>
          <span className="wlm-call-titlebar-actions">
            {!isModalPhase && (
              <button
                className="win-close-btn"
                onClick={() => setMinimized((v) => !v)}
                title={effMinimized ? t.videoCall.expand : t.videoCall.minimizeWindow}
                aria-label={effMinimized ? t.videoCall.expand : t.videoCall.minimizeWindow}
              >
                {effMinimized ? '▢' : '_'}
              </button>
            )}
            <button className="win-close-btn" onClick={handleEndCall} aria-label={t.videoCall.hangup}>✕</button>
          </span>
        </div>

        {effMinimized ? (
          <div className="wlm-call-minibar" onClick={() => setMinimized(false)}>
            <span className="wlm-call-minibar-name">{formatNickname(contactName)}</span>
            {callStatus === 'connected' && <span className="wlm-call-timer">{fmtDuration(duration)}</span>}
            {callStatus !== 'connected' && <span className="wlm-call-minibar-status">{overlayText()}</span>}
            <button
              className={`wlm-call-btn small${micOn ? '' : ' off'}`}
              onClick={(e) => { e.stopPropagation(); toggleMic(); }}
              title={micOn ? t.videoCall.mute : t.videoCall.unmute}
              aria-label={micOn ? t.videoCall.mute : t.videoCall.unmute}
            >
              {micOn ? '🎤' : '🔇'}
            </button>
            <button
              className="wlm-call-btn small"
              onClick={(e) => { e.stopPropagation(); handleEndCall(); }}
              title={t.videoCall.hangup}
              aria-label={t.videoCall.hangup}
              style={styles.hangupBtnSmall}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" style={{ transform: 'rotate(135deg)' }}><path d="M6.62 10.79c1.44 2.83 3.76 5.14 6.59 6.59l2.2-2.2c.27-.27.67-.36 1.02-.24 1.12.37 2.33.57 3.57.57.55 0 1 .45 1 1V20c0 .55-.45 1-1 1-9.39 0-17-7.61-17-17 0-.55.45-1 1-1h3.5c.55 0 1 .45 1 1 0 1.25.2 2.45.57 3.57.11.35.03.74-.25 1.02l-2.2 2.2z"/></svg>
            </button>
          </div>
        ) : null}
        {/* La scène vidéo reste montée (jamais démontée) même réduite, pour ne pas
            interrompre les flux WebRTC : elle est seulement masquée via CSS. */}
        <div ref={containerRef} className="wlm-video-stage" style={effMinimized ? { display: 'none' } : undefined}>
          <video ref={remoteVideoRef} autoPlay playsInline muted className={`wlm-video-remote${remoteVideoOn ? '' : ' wlm-video-remote-audio'}`} />
          <audio ref={remoteAudioRef} autoPlay className="wlm-remote-audio" data-testid="remote-audio" />
          {audioBlocked && (
            <button
              type="button"
              className="wlm-call-unmute"
              onClick={() => { remoteAudioRef.current?.play().then(() => setAudioBlocked(false)).catch(() => { /* toujours bloqué */ }); }}
            >
              {t.videoCall.enableSound}
            </button>
          )}
          <video ref={localVideoRef} autoPlay playsInline muted className="wlm-video-local" style={{ display: (!audioOnly || localVideoOn) ? 'block' : 'none' }} />

          {showOverlay && (
            <div className="wlm-video-status">
              {callStatus === 'connected' ? (audioOnly ? t.videoCall.audioInProgress : formatNickname(t.videoCall.remoteCameraOff.replace('{name}', contactName))) : callStatus === 'ringing' ? (
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '20px' }}>
                  <div>{formatNickname(t.videoCall.ringing.replace('{name}', contactName))}</div>
                  <div style={{ display: 'flex', gap: '30px' }}>
                    <button onClick={handleAcceptCall} style={styles.acceptBtn} aria-label={t.videoCall.accept}>
                      <svg width="30" height="30" viewBox="0 0 24 24" fill="currentColor"><path d="M6.62 10.79c1.44 2.83 3.76 5.14 6.59 6.59l2.2-2.2c.27-.27.67-.36 1.02-.24 1.12.37 2.33.57 3.57.57.55 0 1 .45 1 1V20c0 .55-.45 1-1 1-9.39 0-17-7.61-17-17 0-.55.45-1 1-1h3.5c.55 0 1 .45 1 1 0 1.25.2 2.45.57 3.57.11.35.03.74-.25 1.02l-2.2 2.2z"/></svg>
                    </button>
                    <button onClick={handleRejectCall} style={styles.hangupBtn} aria-label={t.videoCall.reject}>
                      <svg width="30" height="30" viewBox="0 0 24 24" fill="currentColor" style={{ transform: 'rotate(135deg)' }}><path d="M6.62 10.79c1.44 2.83 3.76 5.14 6.59 6.59l2.2-2.2c.27-.27.67-.36 1.02-.24 1.12.37 2.33.57 3.57.57.55 0 1 .45 1 1V20c0 .55-.45 1-1 1-9.39 0-17-7.61-17-17 0-.55.45-1 1-1h3.5c.55 0 1 .45 1 1 0 1.25.2 2.45.57 3.57.11.35.03.74-.25 1.02l-2.2 2.2z"/></svg>
                    </button>
                  </div>
                </div>
              ) : overlayText()}
            </div>
          )}

          {callStatus === 'connected' && (
            <div className="wlm-call-meta">
              <span className="wlm-call-timer">{fmtDuration(duration)}</span>
              <span className={`wlm-quality wlm-quality-${quality}`} title={qualityLabel} aria-label={qualityLabel} />
            </div>
          )}
        </div>

        {callStatus !== 'ringing' && !effMinimized && (
        <div className="wlm-call-controls">
          <button className={`wlm-call-btn${micOn ? '' : ' off'}`} onClick={toggleMic} title={micOn ? t.videoCall.mute : t.videoCall.unmute} aria-label={micOn ? t.videoCall.mute : t.videoCall.unmute}>
            {micOn ? '🎤' : '🔇'}
          </button>
          {(
            <button className={`wlm-call-btn${camOn ? '' : ' off'}`} onClick={toggleCam} title={camOn ? t.videoCall.cameraOff : t.videoCall.cameraOn} aria-label={camOn ? t.videoCall.cameraOff : t.videoCall.cameraOn}>
              {camOn ? '📷' : '🚫'}
            </button>
          )}
          {canShareScreen && (
            <button className={`wlm-call-btn${sharingScreen ? ' off' : ''}`} onClick={toggleShare} title={sharingScreen ? t.videoCall.stopShare : t.videoCall.shareScreen} aria-label={sharingScreen ? t.videoCall.stopShare : t.videoCall.shareScreen}>
              {sharingScreen ? '🛑' : '🖥️'}
            </button>
          )}
          <button className="wlm-call-btn" onClick={() => { setShowDevices((v) => !v); refreshDevices(); }} title={t.videoCall.devices} aria-label={t.videoCall.devices}>⚙️</button>
          <button className="wlm-call-btn" onClick={toggleFullscreen} title={t.videoCall.fullscreen} aria-label={t.videoCall.fullscreen}>⛶</button>
          <button className="wlm-call-btn" onClick={togglePip} title={t.videoCall.pip} aria-label={t.videoCall.pip}>◱</button>
          <button onClick={handleEndCall} style={styles.hangupBtn} title={t.videoCall.hangup} aria-label={t.videoCall.hangup}>
            <svg width="28" height="28" viewBox="0 0 24 24" fill="currentColor" style={{ transform: 'rotate(135deg)' }}><path d="M6.62 10.79c1.44 2.83 3.76 5.14 6.59 6.59l2.2-2.2c.27-.27.67-.36 1.02-.24 1.12.37 2.33.57 3.57.57.55 0 1 .45 1 1V20c0 .55-.45 1-1 1-9.39 0-17-7.61-17-17 0-.55.45-1 1-1h3.5c.55 0 1 .45 1 1 0 1.25.2 2.45.57 3.57.11.35.03.74-.25 1.02l-2.2 2.2z"/></svg>
          </button>

          {showDevices && (
            <div className="wlm-devices-pop">
              <label>{t.videoCall.microphone}
                <select value={micId} onChange={(e) => switchDevice('audio', e.target.value)}>
                  <option value="">{t.videoCall.defaultDevice}</option>
                  {micList.map((d) => <option key={d.deviceId} value={d.deviceId}>{d.label || `${t.videoCall.microphone} ${d.deviceId.slice(0, 4)}`}</option>)}
                </select>
              </label>
              {(!audioOnly || camOn) && (
                <label>{t.videoCall.camera}
                  <select value={camId} onChange={(e) => switchDevice('video', e.target.value)}>
                    <option value="">{t.videoCall.defaultDevice}</option>
                    {camList.map((d) => <option key={d.deviceId} value={d.deviceId}>{d.label || `${t.videoCall.camera} ${d.deviceId.slice(0, 4)}`}</option>)}
                  </select>
                </label>
              )}
              {spkList.length > 0 && (
                <label>{t.videoCall.speaker}
                  <select value={spkId} onChange={(e) => switchSpeaker(e.target.value)}>
                    <option value="">{t.videoCall.defaultDevice}</option>
                    {spkList.map((d) => <option key={d.deviceId} value={d.deviceId}>{d.label || `${t.videoCall.speaker} ${d.deviceId.slice(0, 4)}`}</option>)}
                  </select>
                </label>
              )}
            </div>
          )}
        </div>
        )}
      </div>
    </div>
  );
};

const styles = {
  header: { padding: '8px 15px', background: 'linear-gradient(to bottom, #fcfdfe, #e1eff7)', borderBottom: '1px solid #b8d9eb', fontWeight: 'bold', fontSize: '13px', color: '#004b8d' },
  acceptBtn: { background: '#25D366', color: 'white', border: 'none', borderRadius: '50%', width: '60px', height: '60px', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' },
  hangupBtn: { background: '#FF3B30', color: 'white', border: 'none', borderRadius: '50%', width: '52px', height: '52px', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' },
  hangupBtnSmall: { background: '#FF3B30', color: 'white', border: 'none', borderRadius: '50%', width: '24px', height: '24px', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', flex: '0 0 auto' },
};

export default VideoCall;
