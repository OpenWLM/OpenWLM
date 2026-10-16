import React, { useEffect, useRef, useState } from 'react';
import { useI18n } from '../i18n';

/**
 * Lecteur de clip vocal simple avec icône play/pause et barre de progression texte.
 */
export const VoiceClipPlayer: React.FC<{ src: string }> = ({ src }) => {
  const { t } = useI18n();
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const formatTime = (time: number) => {
    const mins = Math.floor(time / 60);
    const secs = Math.floor(time % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  useEffect(() => {
    return () => {
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
      setIsPlaying(false);
      setCurrentTime(0);
    }
  }, [src]);

  const togglePlay = () => {
    if (!audioRef.current) {
      audioRef.current = new Audio(src);
      audioRef.current.onended = () => {
        setIsPlaying(false);
        setCurrentTime(0);
      };
      audioRef.current.ontimeupdate = () => {
        setCurrentTime(audioRef.current?.currentTime || 0);
      };
      audioRef.current.onloadedmetadata = () => {
        setDuration(audioRef.current?.duration || 0);
      };
    }

    if (isPlaying) {
      audioRef.current.pause();
    } else {
      audioRef.current.play().catch(err => console.error("Erreur lecture audio:", err));
    }
    setIsPlaying(!isPlaying);
  };

  return (
    <div className="wlm-voice-clip-player" onClick={togglePlay} title={t.chat.voiceClipClickToListen}>
      <div className={`play-pause-icon ${isPlaying ? 'pause' : 'play'}`}></div>
      <div className="voice-clip-info">
        <span className="voice-clip-text">{isPlaying ? t.chat.voiceClipPlaying : t.chat.voiceClipPlay}</span>
        {duration > 0 && (
          <span className="voice-clip-timer">
            {formatTime(currentTime)} / {formatTime(duration)}
          </span>
        )}
      </div>
    </div>
  );
};

export default VoiceClipPlayer;
