/**
 * Utilitaire utilisant l'API Web Audio pour synthétiser des sons
 * Utilisé pour les sons qui ne sont pas basés sur des fichiers MP3 (ex: sons procéduraux).
 */

class SoundSynthesizer {
  private ctx: AudioContext | null = null;

  /**
   * Récupère ou initialise le contexte audio
   */
  private getCtx() {
    if (!this.ctx) {
      this.ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
    }
    return this.ctx;
  }

  /**
   * Synthétise un son de "capture" (utilisé par le clin d'œil Grenouille)
   */
  public playCatch() {
    const ctx = this.getCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = 'sine';
    osc.frequency.setValueAtTime(400, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(100, ctx.currentTime + 0.1);

    gain.gain.setValueAtTime(0.5, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.1);

    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.start();
    osc.stop(ctx.currentTime + 0.1);
  }

  /**
   * Synthétise un son de "rot" (bruit sourd et granuleux)
   */
  public playBurp() {
    const ctx = this.getCtx();
    const bufferSize = ctx.sampleRate * 0.4; // Durée de 0.4s
    const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    const data = buffer.getChannelData(0);

    // Génération d'un bruit blanc modulé pour simuler un rot
    for (let i = 0; i < bufferSize; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.sin(i * 0.01);
    }

    const source = ctx.createBufferSource();
    source.buffer = buffer;

    // Filtre passe-bas pour rendre le son plus sourd
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(300, ctx.currentTime);
    filter.frequency.exponentialRampToValueAtTime(50, ctx.currentTime + 0.4);

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.4, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.4);

    source.connect(filter);
    filter.connect(gain);
    gain.connect(ctx.destination);

    source.start();
  }
}

export default new SoundSynthesizer();
