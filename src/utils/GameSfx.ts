/**
 * BRUITAGES DE JEU synthétisés (Web Audio API) — aucun fichier audio, aucune licence.
 *
 * Sons courts et discrets, distincts des sons de messagerie (le son de réception d'un
 * message ne doit pas servir de bruitage de jeu). Un seul AudioContext, créé à la demande ;
 * les navigateurs le débloquent au premier geste de l'utilisateur (un clic sur le plateau).
 */

type Ctx = AudioContext;

let ctx: Ctx | null = null;
const getCtx = (): Ctx | null => {
  try {
    if (!ctx) {
      const AC = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
    }
    if (ctx.state === 'suspended') void ctx.resume();
    return ctx;
  } catch {
    return null;
  }
};

const MASTER = 0.22;

/** Note simple avec enveloppe (attaque rapide, déclin exponentiel). */
const tone = (c: Ctx, freq: number, start: number, duration: number, opts: { type?: OscillatorType; gain?: number; slideTo?: number } = {}) => {
  const osc = c.createOscillator();
  const g = c.createGain();
  osc.type = opts.type ?? 'sine';
  osc.frequency.setValueAtTime(freq, start);
  if (opts.slideTo) osc.frequency.exponentialRampToValueAtTime(opts.slideTo, start + duration);
  const peak = MASTER * (opts.gain ?? 1);
  g.gain.setValueAtTime(0.0001, start);
  g.gain.exponentialRampToValueAtTime(peak, start + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0001, start + duration);
  osc.connect(g).connect(c.destination);
  osc.start(start);
  osc.stop(start + duration + 0.02);
};

/** Bruit filtré (explosion, souffle). */
const noise = (c: Ctx, start: number, duration: number, opts: { from: number; to: number; gain?: number }) => {
  const length = Math.floor(c.sampleRate * duration);
  const buffer = c.createBuffer(1, length, c.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / length);
  const src = c.createBufferSource();
  src.buffer = buffer;
  const filter = c.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.setValueAtTime(opts.from, start);
  filter.frequency.exponentialRampToValueAtTime(opts.to, start + duration);
  const g = c.createGain();
  g.gain.setValueAtTime(MASTER * (opts.gain ?? 1), start);
  g.gain.exponentialRampToValueAtTime(0.0001, start + duration);
  src.connect(filter).connect(g).connect(c.destination);
  src.start(start);
};

const play = (fn: (c: Ctx, t: number) => void) => {
  const c = getCtx();
  if (!c) return;
  try { fn(c, c.currentTime + 0.01); } catch { /* audio indisponible */ }
};

const GameSfx = {
  /** Case révélée (chiffre) : petit clic sec. */
  reveal: () => play((c, t) => {
    tone(c, 1400, t, 0.05, { type: 'triangle', gain: 0.55 });
    noise(c, t, 0.03, { from: 4000, to: 1500, gain: 0.25 });
  }),

  /** Ouverture en cascade (zone vide) : série de clics rapides qui montent. */
  cascade: () => play((c, t) => {
    for (let k = 0; k < 6; k++) tone(c, 700 + k * 140, t + k * 0.028, 0.05, { type: 'triangle', gain: 0.4 });
  }),

  /** Mine trouvée par moi : « plop » du drapeau + carillon clair à deux notes. */
  mineFound: () => play((c, t) => {
    tone(c, 220, t, 0.09, { type: 'sine', gain: 0.9, slideTo: 440 });
    tone(c, 1046.5, t + 0.07, 0.18, { type: 'sine', gain: 0.6 });
    tone(c, 1568, t + 0.15, 0.28, { type: 'sine', gain: 0.5 });
  }),

  /** Mine trouvée par l'adversaire : même idée, plus grave et plus discrète. */
  opponentMine: () => play((c, t) => {
    tone(c, 200, t, 0.09, { type: 'sine', gain: 0.6, slideTo: 330 });
    tone(c, 659.3, t + 0.07, 0.2, { type: 'sine', gain: 0.35 });
  }),

  /** Bombe : souffle grave + grondement. */
  bomb: () => play((c, t) => {
    noise(c, t, 0.7, { from: 1800, to: 80, gain: 1.6 });
    tone(c, 110, t, 0.5, { type: 'sine', gain: 1.1, slideTo: 40 });
  }),

  /** Victoire : petit arpège montant. */
  win: () => play((c, t) => {
    [523.3, 659.3, 784, 1046.5].forEach((f, k) => tone(c, f, t + k * 0.11, k === 3 ? 0.45 : 0.16, { type: 'triangle', gain: 0.7 }));
  }),

  /** Défaite : deux notes descendantes. */
  lose: () => play((c, t) => {
    tone(c, 392, t, 0.22, { type: 'triangle', gain: 0.6 });
    tone(c, 293.7, t + 0.2, 0.4, { type: 'triangle', gain: 0.6 });
  })
};

export default GameSfx;
