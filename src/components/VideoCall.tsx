import React, { useEffect, useRef, useState, useCallback } from 'react';
import axios from 'axios';
import { Socket } from 'socket.io-client';
import SoundManager from '../utils/SoundManager';
import { useI18n } from '../i18n';
import { formatNickname } from '../utils/NicknameFormatter';

interface VideoCallProps {
  socket: Socket | null;
  activeChatId: number;
  myId: number;
  contactName: string;
  callerName: string; // Nom de celui qui appelle
  isReceivingCall: boolean;
  incomingSignal?: unknown;
  audioOnly?: boolean;
  onEndCall: () => void;
}

type CallStatus = 'calling' | 'remoteRinging' | 'ringing' | 'connecting' | 'connected' | 'reconnecting' | 'ended';

const DEFAULT_ICE: RTCConfiguration = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

// Encodage base64 JSON (compatible avec le relais serveur et les autres clients)
const encodeSignal = (obj: unknown) => window.btoa(unescape(encodeURIComponent(JSON.stringify(obj))));
const decodeSignal = (str: string) => JSON.parse(decodeURIComponent(escape(window.atob(str))));

const RING_TIMEOUT_MS = 45000;   // appelant : pas de réponse
const RECONNECT_AFTER_MS = 4000; // ICE "disconnected" -> tentative de reprise
const RECOVERY_GIVE_UP_MS = 15000;
const MAX_ICE_RESTARTS = 3;

const VideoCall: React.FC<VideoCallProps> = ({ socket, activeChatId, myId, contactName, callerName, isReceivingCall, incomingSignal, audioOnly, onEndCall }) => {
  const { t } = useI18n();
  const [callStatus, setCallStatus] = useState<CallStatus>(isReceivingCall ? 'ringing' : 'calling');
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const peerConnectionRef = useRef<RTCPeerConnection | null>(null);
  const rtcConfigRef = useRef<RTCConfiguration>(DEFAULT_ICE);
  const iceCandidatesQueue = useRef<RTCIceCandidateInit[]>([]);
  const hasInitialized = useRef(false);
  const endedRef = useRef(false);
  const restartCountRef = useRef(0);
  const ringTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const recoveryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const statusRef = useRef<CallStatus>(callStatus);

  useEffect(() => { statusRef.current = callStatus; }, [callStatus]);

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
    if (localVideoRef.current) localVideoRef.current.srcObject = null;
    if (remoteVideoRef.current) remoteVideoRef.current.srcObject = null;
  }, []);

  // Termine l'appel : message optionnel (clé i18n) puis fermeture de l'overlay.
  const finish = useCallback((noticeText?: string) => {
    if (endedRef.current) return;
    endedRef.current = true;
    if (socket) socket.emit('end_call', { target: activeChatId, caller: myId });
    if (localStream) localStream.getTracks().forEach((track) => track.stop());
    setLocalStream(null);
    teardown();
    setCallStatus('ended');
    if (noticeText) {
      setNotice(noticeText);
      setTimeout(() => onEndCall(), 1800);
    } else {
      onEndCall();
    }
  }, [socket, activeChatId, myId, localStream, teardown, onEndCall]);

  const handleEndCall = useCallback(() => finish(), [finish]);

  const emitSignal = useCallback((signal: unknown) => {
    if (!socket) return;
    socket.emit('webrtc_signal', { target: activeChatId, caller: myId, signal: encodeSignal(signal) });
  }, [socket, activeChatId, myId]);

  // Plafonne le débit (réseaux faibles) : audio ~32 kb/s, vidéo ~1,2 Mb/s dégradation équilibrée.
  const applySenderCaps = useCallback(async (pc: RTCPeerConnection) => {
    for (const sender of pc.getSenders()) {
      if (!sender.track) continue;
      try {
        const params = sender.getParameters();
        if (!params.encodings || params.encodings.length === 0) params.encodings = [{}];
        if (sender.track.kind === 'audio') {
          params.encodings[0].maxBitrate = 32000;
        } else {
          params.encodings[0].maxBitrate = 1200000;
          (params as RTCRtpSendParameters & { degradationPreference?: string }).degradationPreference = 'balanced';
        }
        await sender.setParameters(params);
      } catch { /* certains navigateurs refusent avant négociation — on réessaiera */ }
    }
  }, []);

  const tryRestartIce = useCallback(() => {
    const pc = peerConnectionRef.current;
    if (!pc || endedRef.current) return;
    if (restartCountRef.current >= MAX_ICE_RESTARTS) {
      finish(t.videoCall.failed);
      return;
    }
    restartCountRef.current += 1;
    setCallStatus('reconnecting');
    try { pc.restartIce(); } catch { /* ignore */ }
    if (recoveryTimerRef.current) clearTimeout(recoveryTimerRef.current);
    recoveryTimerRef.current = setTimeout(() => {
      const st = peerConnectionRef.current?.connectionState;
      if (st !== 'connected') finish(t.videoCall.failed);
    }, RECOVERY_GIVE_UP_MS);
  }, [finish, t]);

  const fetchRtcConfig = useCallback(async (): Promise<RTCConfiguration> => {
    try {
      const res = await axios.get('/api/rtc-config');
      const data = res.data || {};
      if (Array.isArray(data.iceServers) && data.iceServers.length > 0) {
        return { iceServers: data.iceServers, iceTransportPolicy: data.iceTransportPolicy || 'all' };
      }
    } catch { /* repli sur STUN par défaut */ }
    return DEFAULT_ICE;
  }, []);

  const initCall = useCallback(async () => {
    if (hasInitialized.current) return;
    hasInitialized.current = true;

    try {
      if (!navigator.mediaDevices || !window.isSecureContext) {
        alert(t.videoCall.unsecureContext);
        finish();
        return;
      }

      rtcConfigRef.current = await fetchRtcConfig();

      const constraints: MediaStreamConstraints = {
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: audioOnly ? false : { width: { ideal: 640 }, height: { ideal: 360 }, frameRate: { ideal: 24, max: 30 } },
      };

      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia(constraints);
      } catch (err) {
        const name = err instanceof DOMException ? err.name : '';
        if (name === 'NotAllowedError') alert(t.videoCall.permissionDenied);
        else if (name === 'NotFoundError') alert(t.videoCall.noDevice);
        else if (name === 'NotReadableError') alert(t.videoCall.deviceBusy);
        else alert(t.videoCall.mediaError);
        finish();
        return;
      }

      setLocalStream(stream);
      if (localVideoRef.current) localVideoRef.current.srcObject = stream;

      const pc = new RTCPeerConnection(rtcConfigRef.current);
      peerConnectionRef.current = pc;

      pc.onicecandidate = (event) => {
        if (event.candidate) emitSignal({ type: 'ice-candidate', candidate: event.candidate });
      };

      pc.ontrack = (event) => {
        if (remoteVideoRef.current && event.streams[0]) {
          remoteVideoRef.current.srcObject = event.streams[0];
          remoteVideoRef.current.muted = false;
          remoteVideoRef.current.volume = 1.0;
          remoteVideoRef.current.play().catch(() => { /* autoplay bloqué */ });
          restartCountRef.current = 0;
          setCallStatus('connected');
        }
      };

      const onConnState = () => {
        const pc2 = peerConnectionRef.current;
        if (!pc2) return;
        const st = pc2.connectionState;
        if (st === 'connected') {
          restartCountRef.current = 0;
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

      stream.getTracks().forEach((track) => pc.addTrack(track, stream));

      if (isReceivingCall && incomingSignal) {
        await pc.setRemoteDescription(new RTCSessionDescription(incomingSignal as RTCSessionDescriptionInit));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        emitSignal(pc.localDescription);
        await applySenderCaps(pc);
        // Candidats ICE reçus avant la réponse
        for (const candidate of iceCandidatesQueue.current) {
          await pc.addIceCandidate(new RTCIceCandidate(candidate)).catch(() => { /* ignore */ });
        }
        iceCandidatesQueue.current = [];
        setCallStatus('connecting');
      } else {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        if (socket) {
          socket.emit('call_request', {
            target: activeChatId,
            caller: myId,
            callerName,
            signal: encodeSignal(pc.localDescription),
            audioOnly,
          });
        }
        await applySenderCaps(pc);
        // Timeout « pas de réponse »
        ringTimerRef.current = setTimeout(() => {
          if (statusRef.current !== 'connected') finish(t.videoCall.noAnswer);
        }, RING_TIMEOUT_MS);
      }
    } catch (err) {
      console.error('[WebRTC] initCall:', err);
      alert(t.videoCall.genericError);
      finish();
    }
  }, [audioOnly, activeChatId, myId, isReceivingCall, incomingSignal, socket, callerName, emitSignal, applySenderCaps, fetchRtcConfig, finish, tryRestartIce, t]);

  // Sonnerie d'appel entrant
  useEffect(() => {
    let interval: ReturnType<typeof setInterval> | null = null;
    if (callStatus === 'ringing') {
      SoundManager.play('phone');
      interval = setInterval(() => SoundManager.play('phone'), 3500);
    }
    return () => { if (interval) clearInterval(interval); };
  }, [callStatus]);

  useEffect(() => {
    if (!isReceivingCall && callStatus === 'calling' && !hasInitialized.current) {
      initCall();
    }
  }, [isReceivingCall, callStatus, initCall]);

  const handleAcceptCall = () => {
    setCallStatus('connecting');
    if (socket) socket.emit('call_accept', { target: activeChatId });
    initCall();
  };

  const handleRejectCall = () => {
    if (socket) socket.emit('call_reject', { target: activeChatId });
    finish();
  };

  // Signaux & évènements d'appel
  useEffect(() => {
    if (!socket) return;

    const handleSignal = async (data: { caller: number; signal: string }) => {
      if (data.caller !== activeChatId) return;
      try {
        const signal = decodeSignal(data.signal);
        if (signal.type === 'answer') {
          if (peerConnectionRef.current && !peerConnectionRef.current.currentRemoteDescription) {
            await peerConnectionRef.current.setRemoteDescription(new RTCSessionDescription(signal));
            await applySenderCaps(peerConnectionRef.current);
          }
        } else if (signal.type === 'ice-candidate' && signal.candidate) {
          if (peerConnectionRef.current && peerConnectionRef.current.remoteDescription) {
            await peerConnectionRef.current.addIceCandidate(new RTCIceCandidate(signal.candidate)).catch(() => { /* ignore */ });
          } else {
            iceCandidatesQueue.current.push(signal.candidate);
          }
        }
      } catch (e) {
        console.error('[WebRTC] Erreur traitement signal:', e);
      }
    };

    const onRinging = (d: { target: number }) => { if (d.target === activeChatId && !isReceivingCall) setCallStatus('remoteRinging'); };
    const onAccepted = (d: { by: number }) => { if (d.by === activeChatId) setCallStatus('connecting'); };
    const onRejected = (d: { by: number }) => { if (d.by === activeChatId) finish(t.videoCall.rejected); };
    const onBusy = (d: { target: number }) => { if (d.target === activeChatId) finish(t.videoCall.busy); };
    const onUnavailable = (d: { target: number }) => { if (d.target === activeChatId) finish(t.videoCall.unavailable); };
    const onEnded = (d: { caller: number }) => { if (d.caller === activeChatId) finish(); };
    const onSocketReconnect = () => {
      if (peerConnectionRef.current && statusRef.current === 'connected') tryRestartIce();
    };

    socket.on('webrtc_signal', handleSignal);
    socket.on('call_ringing', onRinging);
    socket.on('call_accepted', onAccepted);
    socket.on('call_rejected', onRejected);
    socket.on('call_busy', onBusy);
    socket.on('call_unavailable', onUnavailable);
    socket.on('call_ended', onEnded);
    socket.on('connect', onSocketReconnect);

    return () => {
      socket.off('webrtc_signal', handleSignal);
      socket.off('call_ringing', onRinging);
      socket.off('call_accepted', onAccepted);
      socket.off('call_rejected', onRejected);
      socket.off('call_busy', onBusy);
      socket.off('call_unavailable', onUnavailable);
      socket.off('call_ended', onEnded);
      socket.off('connect', onSocketReconnect);
    };
  }, [socket, activeChatId, isReceivingCall, applySenderCaps, finish, tryRestartIce, t]);

  // Nettoyage au démontage
  useEffect(() => {
    return () => {
      endedRef.current = true;
      hasInitialized.current = false;
      clearTimers();
      if (peerConnectionRef.current) {
        try { peerConnectionRef.current.close(); } catch { /* ignore */ }
        peerConnectionRef.current = null;
      }
    };
  }, []);

  const overlayText = () => {
    if (notice) return notice;
    switch (callStatus) {
      case 'calling': return formatNickname(t.videoCall.calling.replace('{name}', contactName));
      case 'remoteRinging': return formatNickname(t.videoCall.remoteRinging.replace('{name}', contactName));
      case 'connecting': return t.videoCall.connecting;
      case 'reconnecting': return t.videoCall.reconnecting;
      case 'ended': return t.videoCall.ended;
      default: return '';
    }
  };

  const showOverlay = callStatus !== 'connected' || audioOnly;

  return (
    <div className="wlm-video-modal" style={styles.overlay}>
      <div className="wlm-video-box" style={styles.modal}>
        <div className="win-modal-header" style={styles.header}>
          <span>{formatNickname(t.videoCall.conversationWith.replace('{type}', audioOnly ? t.videoCall.audio : t.videoCall.video).replace('{name}', contactName))}</span>
          <button className="win-close-btn" onClick={handleEndCall}>✕</button>
        </div>

        <div style={styles.videoContainer}>
          <video ref={remoteVideoRef} autoPlay playsInline style={{ ...styles.remoteVideo, ...(audioOnly ? styles.remoteAudioOnly : null) }} />
          <video ref={localVideoRef} autoPlay playsInline muted style={{ ...styles.localVideo, display: audioOnly ? 'none' : 'block' }} />

          {showOverlay && (
            <div style={styles.statusOverlay}>
              {audioOnly && callStatus === 'connected' ? (
                t.videoCall.audioInProgress
              ) : callStatus === 'ringing' ? (
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
              ) : (
                overlayText()
              )}
            </div>
          )}
        </div>

        <div style={styles.footer}>
          {callStatus !== 'ringing' && (
            <button onClick={handleEndCall} style={styles.hangupBtn} aria-label={t.videoCall.hangup}>
              <svg width="30" height="30" viewBox="0 0 24 24" fill="currentColor" style={{ transform: 'rotate(135deg)' }}><path d="M6.62 10.79c1.44 2.83 3.76 5.14 6.59 6.59l2.2-2.2c.27-.27.67-.36 1.02-.24 1.12.37 2.33.57 3.57.57.55 0 1 .45 1 1V20c0 .55-.45 1-1 1-9.39 0-17-7.61-17-17 0-.55.45-1 1-1h3.5c.55 0 1 .45 1 1 0 1.25.2 2.45.57 3.57.11.35.03.74-.25 1.02l-2.2 2.2z"/></svg>
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

const styles = {
  overlay: { position: 'fixed' as const, top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 4000 },
  modal: { backgroundColor: 'white', border: '1px solid #99b4d1', borderRadius: '5px', width: '600px', overflow: 'hidden', boxShadow: '0 10px 30px rgba(0,0,0,0.3)', display: 'flex', flexDirection: 'column' as const },
  header: { padding: '8px 15px', background: 'linear-gradient(to bottom, #fcfdfe, #e1eff7)', borderBottom: '1px solid #b8d9eb', fontWeight: 'bold', fontSize: '13px', color: '#004b8d' },
  videoContainer: { position: 'relative' as const, width: '100%', height: '400px', backgroundColor: 'black' },
  remoteVideo: { width: '100%', height: '100%', objectFit: 'contain' as const },
  // Audio seul : élément présent (lecture audio garantie) mais invisible.
  remoteAudioOnly: { position: 'absolute' as const, bottom: 0, right: 0, width: '1px', height: '1px', opacity: 0 },
  localVideo: { position: 'absolute' as const, bottom: '15px', right: '15px', width: '120px', height: '90px', objectFit: 'cover' as const, border: '2px solid white', borderRadius: '4px', boxShadow: '0 2px 10px rgba(0,0,0,0.5)', zIndex: 2 },
  statusOverlay: { position: 'absolute' as const, top: '50%', left: '50%', transform: 'translate(-50%, -50%)', color: 'white', fontSize: '18px', fontWeight: 'bold', textShadow: '0 2px 5px black', zIndex: 1 },
  footer: { padding: '10px 15px', backgroundColor: '#f0f0f0', borderTop: '1px solid #ccc', display: 'flex', justifyContent: 'center' },
  acceptBtn: { background: '#25D366', color: 'white', border: 'none', borderRadius: '50%', width: '60px', height: '60px', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' },
  hangupBtn: { background: '#FF3B30', color: 'white', border: 'none', borderRadius: '50%', width: '60px', height: '60px', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }
};

export default VideoCall;
