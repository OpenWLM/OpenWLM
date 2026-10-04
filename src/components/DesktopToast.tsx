import React, { useEffect, useState } from 'react';

export interface ToastItem {
  id: string;
  senderId: number;
  senderName: string;
  avatar?: string;
  text: string;
  actionText?: string;
  isExiting?: boolean;
}

interface DesktopToastContainerProps {
  toasts: ToastItem[];
  onOpenChat: (senderId: number) => void;
  onDismiss: (toastId: string) => void;
}

export const DesktopToastContainer: React.FC<DesktopToastContainerProps> = ({
  toasts,
  onOpenChat,
  onDismiss
}) => {
  if (!toasts || toasts.length === 0) return null;

  return (
    <div className="wlm-desktop-toast-container" aria-live="polite">
      {toasts.map(toast => (
        <DesktopToastCard
          key={toast.id}
          toast={toast}
          onOpenChat={onOpenChat}
          onDismiss={onDismiss}
        />
      ))}
    </div>
  );
};

interface DesktopToastCardProps {
  toast: ToastItem;
  onOpenChat: (senderId: number) => void;
  onDismiss: (toastId: string) => void;
}

export const DesktopToastCard: React.FC<DesktopToastCardProps> = ({
  toast,
  onOpenChat,
  onDismiss
}) => {
  const [isHovered, setIsHovered] = useState(false);

  useEffect(() => {
    if (isHovered || toast.isExiting) return;

    const timer = setTimeout(() => {
      onDismiss(toast.id);
    }, 4500);

    return () => clearTimeout(timer);
  }, [isHovered, toast.id, toast.isExiting, onDismiss]);

  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    onOpenChat(toast.senderId);
    onDismiss(toast.id);
  };

  const handleClose = (e: React.MouseEvent) => {
    e.stopPropagation();
    onDismiss(toast.id);
  };

  const avatarSrc = toast.avatar || '/assets/usertiles/chess.png';

  return (
    <div
      className={`wlm-desktop-toast ${toast.isExiting ? 'wlm-desktop-toast-exit' : 'wlm-desktop-toast-enter'}`}
      onClick={handleClick}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      role="alert"
      title="Cliquer pour ouvrir la conversation"
    >
      <div className="wlm-desktop-toast-header">
        <div className="wlm-desktop-toast-title">
          <img src="/assets/openwlm_logo.png" alt="" className="wlm-desktop-toast-logo" />
          <span>OpenWLM</span>
        </div>
        <button
          className="wlm-desktop-toast-close-btn"
          onClick={handleClose}
          aria-label="Fermer"
          title="Fermer"
        >
          ✕
        </button>
      </div>

      <div className="wlm-desktop-toast-body">
        <div className="wlm-desktop-toast-avatar-box">
          <img
            src={avatarSrc}
            alt={toast.senderName}
            onError={(e) => {
              (e.target as HTMLImageElement).src = '/assets/usertiles/chess.png';
            }}
          />
        </div>
        <div className="wlm-desktop-toast-content">
          <div className="wlm-desktop-toast-sender">{toast.senderName}</div>
          <div className="wlm-desktop-toast-action">{toast.actionText || 'a envoyé un message :'}</div>
          <div className="wlm-desktop-toast-message">{toast.text}</div>
        </div>
      </div>
    </div>
  );
};

export default DesktopToastContainer;
