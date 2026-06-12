import React, { useEffect, useRef, useState } from 'react';
import { Socket } from 'socket.io-client';

interface VideoCallProps {
  socket: Socket | null;
  activeChatId: number;
  myId: number;
  contactName: string;
  callerName: string; // Nom de celui qui appelle
  isReceivingCall: boolean;
  incomingSignal?: any;
  audioOnly?: boolean;
  iceCandidatesBuffer?: any[];
  onEndCall: () => void;
}

const VideoCall: React.FC<VideoCallProps> = ({ socket, activeChatId, myId, contactName, callerName, isReceivingCall, incomingSignal, audioOnly, iceCandidatesBuffer, onEndCall }) => {
  const [callStatus, setCallStatus] = useState<'calling' | 'ringing' | 'connected' | 'ended'>(isReceivingCall ? 'ringing' : 'calling');
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const peerConnectionRef = useRef<RTCPeerConnection | null>(null);
  const iceCandidatesQueue = useRef<RTCIceCandidateInit[]>([]);
  const hasInitialized = useRef(false); // Empêche le double appel

  useEffect(() => {
    // Si on initie l'appel, on lance la caméra tout de suite
    if (!isReceivingCall && callStatus === 'calling' && !hasInitialized.current) {
      initCall();
    }
  }, [isReceivingCall, callStatus]);

  const initCall = async () => {
    if (hasInitialized.current) return;
    hasInitialized.current = true;

    console.log("[WebRTC] >>> initCall lancé !");
    try {
      if (!navigator.mediaDevices || !window.isSecureContext) {
        console.error("[WebRTC] Erreur : Contexte non sécurisé ou mediaDevices manquants.");
        alert("Votre navigateur bloque l'accès à la caméra/micro car le site n'est pas sécurisé (HTTPS requis).");
        handleEndCall();
        return;
      }

      console.log("[WebRTC] Demande d'accès microphone/caméra...");
      const stream = await navigator.mediaDevices.getUserMedia({ 
        video: !audioOnly, 
        audio: true 
      });
      console.log("[WebRTC] Accès médias accordé. Tracks obtenus:", stream.getTracks().length);
      
      setLocalStream(stream);
      if (localVideoRef.current) {
        localVideoRef.current.srcObject = stream;
      }

      const configuration = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };
      console.log("[WebRTC] Création RTCPeerConnection...");
      const peerConnection = new RTCPeerConnection(configuration);
      peerConnectionRef.current = peerConnection;

      // Gestion des candidats ICE (TRÈS IMPORTANT)
      peerConnection.onicecandidate = (event) => {
        if (event.candidate && socket) {
          console.log("[WebRTC] Nouveau candidat ICE généré, envoi...");
          socket.emit('webrtc_signal', {
            target: activeChatId,
            caller: myId,
            signal: window.btoa(unescape(encodeURIComponent(JSON.stringify({ type: 'ice-candidate', candidate: event.candidate }))))
          });
        }
      };

      peerConnection.oniceconnectionstatechange = () => {
        console.log("[WebRTC] État ICE :", peerConnection.iceConnectionState);
      };

      // Réception du flux distant
      peerConnection.ontrack = (event) => {
        console.log("[WebRTC] >>> Flux distant reçu ! Tracks:", event.streams[0].getTracks().length);
        if (remoteVideoRef.current && event.streams[0]) {
          remoteVideoRef.current.srcObject = event.streams[0];
          remoteVideoRef.current.muted = false;
          remoteVideoRef.current.volume = 1.0;
          remoteVideoRef.current.play().catch(e => console.warn("[WebRTC] Autoplay bloqué:", e));
          setCallStatus('connected');
        }
      };

      // Ajouter nos pistes
      stream.getTracks().forEach(track => peerConnection.addTrack(track, stream));

      if (isReceivingCall && incomingSignal) {
        console.log("[WebRTC] Mode RÉPONDEUR : Application de l'offre...");
        await peerConnection.setRemoteDescription(new RTCSessionDescription(incomingSignal));
        
        console.log("[WebRTC] Création de l'Answer...");
        const answer = await peerConnection.createAnswer();
        await peerConnection.setLocalDescription(answer);
        
        if (socket) {
          console.log("[WebRTC] Envoi de l'Answer...");
          socket.emit('webrtc_signal', {
            target: activeChatId,
            caller: myId,
            signal: window.btoa(unescape(encodeURIComponent(JSON.stringify(peerConnection.localDescription))))
          });
        }

        // Traiter les candidats ICE en attente
        if (iceCandidatesBuffer) {
          for (const candidate of iceCandidatesBuffer) {
            await peerConnection.addIceCandidate(new RTCIceCandidate(candidate)).catch(e => console.warn(e));
          }
        }
      } else {
        console.log("[WebRTC] Mode APPELANT : Création de l'Offer...");
        const offer = await peerConnection.createOffer();
        await peerConnection.setLocalDescription(offer);
        
        if (socket) {
          console.log("[WebRTC] Envoi du call_request...");
          const sdpSignal = window.btoa(unescape(encodeURIComponent(JSON.stringify(peerConnection.localDescription))));
          socket.emit('call_request', {
            target: activeChatId,
            caller: myId,
            callerName: callerName,
            signal: sdpSignal,
            audioOnly: audioOnly
          });
        }
      }

    } catch (err: any) {
      console.error("[WebRTC] EXCEPTION :", err);
      alert(`Erreur : ${err.message || 'Inconnue'}`);
      handleEndCall();
    }
  };

  const handleAcceptCall = () => {
    setCallStatus('connected');
    initCall();
  };

  useEffect(() => {
    if (!socket) return;

    const handleSignal = async (data: any) => {
      if (data.caller !== activeChatId) return;
      try {
        let signal = data.signal;
        try { signal = JSON.parse(decodeURIComponent(escape(window.atob(data.signal)))); } catch(e) {}
        
        if (signal.type === 'answer') {
          console.log("[WebRTC] Answer reçue, application...");
          if (peerConnectionRef.current) {
            await peerConnectionRef.current.setRemoteDescription(new RTCSessionDescription(signal));
          }
        } else if (signal.type === 'ice-candidate') {
          if (peerConnectionRef.current && peerConnectionRef.current.remoteDescription) {
            await peerConnectionRef.current.addIceCandidate(new RTCIceCandidate(signal.candidate));
          } else {
            iceCandidatesQueue.current.push(signal.candidate);
          }
        }
      } catch (e) {
        console.error("[WebRTC] Erreur traitement signal:", e);
      }
    };

    socket.on('webrtc_signal', handleSignal);
    socket.on('call_ended', (data: any) => {
      if (data.caller === activeChatId) handleEndCall();
    });

    return () => {
      socket.off('webrtc_signal', handleSignal);
      socket.off('call_ended');
    };
  }, [socket, activeChatId]);

  const handleEndCall = () => {
    setCallStatus('ended');
    if (socket) socket.emit('end_call', { target: activeChatId, caller: myId });
    if (localStream) localStream.getTracks().forEach(track => track.stop());
    onEndCall();
  };

  return (
    <div className="wlm-video-modal" style={styles.overlay}>
      <div className="wlm-video-box" style={styles.modal}>
        <div className="win-modal-header" style={styles.header}>
          <span>Conversation {audioOnly ? 'Audio' : 'Vidéo'} avec {contactName}</span>
          <button className="win-close-btn" onClick={handleEndCall}>✕</button>
        </div>
        
        <div style={styles.videoContainer}>
          <video ref={remoteVideoRef} autoPlay playsInline style={{ ...styles.remoteVideo, display: audioOnly ? 'none' : 'block' }} />
          <video ref={localVideoRef} autoPlay playsInline muted style={{ ...styles.localVideo, display: audioOnly ? 'none' : 'block' }} />
          {audioOnly && <audio ref={el => { if(el && remoteVideoRef.current?.srcObject) el.srcObject = remoteVideoRef.current.srcObject; }} autoPlay />}

          {(callStatus !== 'connected' || audioOnly) && (
            <div style={styles.statusOverlay}>
              {audioOnly && callStatus === 'connected' ? 'Appel vocal en cours...' :
               callStatus === 'calling' ? `Appel vers ${contactName}...` : 
               callStatus === 'ringing' ? (
                 <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '20px' }}>
                   <div>Appel entrant de {contactName}...</div>
                   <div style={{ display: 'flex', gap: '30px' }}>
                     <button onClick={handleAcceptCall} style={{ background: '#25D366', color: 'white', border: 'none', borderRadius: '50%', width: '60px', height: '60px', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                       <svg width="30" height="30" viewBox="0 0 24 24" fill="currentColor"><path d="M6.62 10.79c1.44 2.83 3.76 5.14 6.59 6.59l2.2-2.2c.27-.27.67-.36 1.02-.24 1.12.37 2.33.57 3.57.57.55 0 1 .45 1 1V20c0 .55-.45 1-1 1-9.39 0-17-7.61-17-17 0-.55.45-1 1-1h3.5c.55 0 1 .45 1 1 0 1.25.2 2.45.57 3.57.11.35.03.74-.25 1.02l-2.2 2.2z"/></svg>
                     </button>
                     <button onClick={handleEndCall} style={{ background: '#FF3B30', color: 'white', border: 'none', borderRadius: '50%', width: '60px', height: '60px', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                       <svg width="30" height="30" viewBox="0 0 24 24" fill="currentColor" style={{ transform: 'rotate(135deg)' }}><path d="M6.62 10.79c1.44 2.83 3.76 5.14 6.59 6.59l2.2-2.2c.27-.27.67-.36 1.02-.24 1.12.37 2.33.57 3.57.57.55 0 1 .45 1 1V20c0 .55-.45 1-1 1-9.39 0-17-7.61-17-17 0-.55.45-1 1-1h3.5c.55 0 1 .45 1 1 0 1.25.2 2.45.57 3.57.11.35.03.74-.25 1.02l-2.2 2.2z"/></svg>
                     </button>
                   </div>
                 </div>
               ) : 'Appel terminé'}
            </div>
          )}
        </div>

        <div style={styles.footer}>
          {callStatus !== 'ringing' && (
            <button onClick={handleEndCall} style={{ background: '#FF3B30', color: 'white', border: 'none', borderRadius: '50%', width: '60px', height: '60px', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
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
  remoteVideo: { width: '100%', height: '100%', objectFit: 'cover' as const },
  localVideo: { position: 'absolute' as const, bottom: '15px', right: '15px', width: '120px', height: '90px', objectFit: 'cover' as const, border: '2px solid white', borderRadius: '4px', boxShadow: '0 2px 10px rgba(0,0,0,0.5)' },
  statusOverlay: { position: 'absolute' as const, top: '50%', left: '50%', transform: 'translate(-50%, -50%)', color: 'white', fontSize: '18px', fontWeight: 'bold', textShadow: '0 2px 5px black' },
  footer: { padding: '10px 15px', backgroundColor: '#f0f0f0', borderTop: '1px solid #ccc', display: 'flex', justifyContent: 'center' }
};

export default VideoCall;
