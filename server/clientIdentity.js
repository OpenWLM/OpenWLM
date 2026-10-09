/**
 * RÉSOLUTION FIABLE DE L'IP CLIENT (E2 — Déploiement derrière Cloudflare)
 *
 * Principe de sécurité :
 * 1. On NE FAIT JAMAIS confiance à X-Forwarded-For (header contrôlable par le client).
 * 2. L'IP de socket (req.socket.remoteAddress) est la source de vérité par défaut.
 * 3. CF-Connecting-IP n'est utilisé QUE si la connexion TCP provient d'une IP
 *    Cloudflare officielle (liste de plages de confiance ci-dessous).
 * 4. Si la requête n'arrive pas depuis Cloudflare, tous les en-têtes proxy
 *    (X-Forwarded-For, CF-Connecting-IP, X-Real-IP...) sont ignorés.
 *
 * La liste des plages peut être surchargée via la variable d'environnement
 * CLOUDFLARE_IP_RANGES (liste CIDR séparée par des virgules).
 */
import net from 'net';

// Plages IP officielles Cloudflare (https://www.cloudflare.com/ips-v4 / ips-v6).
export const DEFAULT_CLOUDFLARE_RANGES = [
  '173.245.48.0/20',
  '103.21.244.0/22',
  '103.22.200.0/22',
  '103.31.4.0/22',
  '141.101.64.0/18',
  '108.162.192.0/18',
  '190.93.240.0/20',
  '188.114.96.0/20',
  '197.234.240.0/22',
  '198.41.128.0/17',
  '162.158.0.0/15',
  '104.16.0.0/13',
  '104.24.0.0/14',
  '172.64.0.0/13',
  '131.0.72.0/22',
  '2400:cb00::/32',
  '2606:4700::/32',
  '2803:f800::/32',
  '2405:b500::/32',
  '2405:8100::/32',
  '2a06:98c0::/29',
  '2c0f:f248::/32'
];

/**
 * Normalise une adresse IP :
 * - retire le préfixe IPv4-mapped IPv6 (::ffff:1.2.3.4),
 * - retire l'identifiant de zone (fe80::1%eth0),
 * - retire les crochets d'une notation [::1],
 * - renvoie null si la chaîne n'est pas une IP valide.
 */
export const normalizeIp = (raw) => {
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  let ip = raw.trim();

  const mapped = ip.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i);
  if (mapped) ip = mapped[1];

  const zoneIndex = ip.indexOf('%');
  if (zoneIndex !== -1) ip = ip.slice(0, zoneIndex);

  ip = ip.replace(/^\[/, '').replace(/\]$/, '');

  if (net.isIPv4(ip)) return ip;
  if (net.isIPv6(ip)) return ip.toLowerCase();
  return null;
};

const ipv4ToBigInt = (ip) => {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let value = 0n;
  for (const part of parts) {
    const n = Number(part);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    value = (value << 8n) | BigInt(n);
  }
  return value;
};

const ipv6ToBigInt = (ip) => {
  if (!net.isIPv6(ip)) return null;
  let addr = ip;

  // Gérer une éventuelle queue IPv4 (ex: ::ffff:1.2.3.4 ou 64:ff9b::1.2.3.4)
  const lastColon = addr.lastIndexOf(':');
  const tailPart = addr.slice(lastColon + 1);
  if (tailPart.includes('.')) {
    const v4 = ipv4ToBigInt(tailPart);
    if (v4 === null) return null;
    const high = ((v4 >> 16n) & 0xffffn).toString(16);
    const low = (v4 & 0xffffn).toString(16);
    addr = `${addr.slice(0, lastColon)}:${high}:${low}`;
  }

  const halves = addr.split('::');
  if (halves.length > 2) return null;

  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - (head.length + tail.length);
  if (missing < 0) return null;
  if (halves.length === 1 && head.length !== 8) return null;

  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill('0'), ...tail];
  if (groups.length !== 8) return null;

  let result = 0n;
  for (const group of groups) {
    const value = parseInt(group === '' ? '0' : group, 16);
    if (Number.isNaN(value) || value < 0 || value > 0xffff) return null;
    result = (result << 16n) | BigInt(value);
  }
  return result;
};

const parseCidr = (cidr) => {
  if (typeof cidr !== 'string') return null;
  const [addr, bitsRaw] = cidr.trim().split('/');
  const bits = Number(bitsRaw);
  const ip = normalizeIp(addr);
  if (!ip || !Number.isInteger(bits)) return null;

  if (net.isIPv4(ip)) {
    if (bits < 0 || bits > 32) return null;
    return { family: 4, base: ipv4ToBigInt(ip), bits: BigInt(bits) };
  }
  if (bits < 0 || bits > 128) return null;
  return { family: 6, base: ipv6ToBigInt(ip), bits: BigInt(bits) };
};

const familyWidth = (family) => (family === 4 ? 32n : 128n);

export const ipMatchesCidr = (ip, cidr) => {
  const parsed = parseCidr(cidr);
  if (!parsed || parsed.base === null) return false;
  const target = parsed.family === 4 ? ipv4ToBigInt(ip) : ipv6ToBigInt(ip);
  if (target === null) return false;
  const shift = familyWidth(parsed.family) - parsed.bits;
  return (target >> shift) === (parsed.base >> shift);
};

export class CloudflareIpMatcher {
  constructor(ranges) {
    this.ranges = Array.from(ranges || []).map(parseCidr).filter(Boolean);
  }

  contains(rawIp) {
    const ip = normalizeIp(rawIp);
    if (!ip) return false;
    return this.ranges.some((range) => {
      const target = range.family === 4 ? ipv4ToBigInt(ip) : ipv6ToBigInt(ip);
      if (target === null) return false;
      const shift = familyWidth(range.family) - range.bits;
      return (target >> shift) === (range.base >> shift);
    });
  }
}

export const loadCloudflareRanges = (envValue = process.env.CLOUDFLARE_IP_RANGES) => {
  if (typeof envValue === 'string' && envValue.trim() !== '') {
    return envValue
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean);
  }
  return DEFAULT_CLOUDFLARE_RANGES;
};

export const defaultCloudflareMatcher = new CloudflareIpMatcher(loadCloudflareRanges());

/**
 * Renvoie l'IP de socket normalisée de la connexion TCP.
 */
export const getSocketIp = (req) => {
  const raw =
    req?.socket?.remoteAddress ||
    req?.connection?.remoteAddress ||
    req?.client?.remoteAddress ||
    null;
  return normalizeIp(raw) || null;
};

/**
 * Résout l'IP client fiable de la requête.
 *
 * @param {object} req Requête Express / Socket.IO
 * @param {{matcher?: CloudflareIpMatcher}} [options]
 * @returns {string|null}
 */
export const getClientIp = (req, options = {}) => {
  const matcher = options.matcher || defaultCloudflareMatcher;
  const socketIp = getSocketIp(req);

  // Aucune IP de socket exploitable : on ne se rabat PAS sur les en-têtes.
  if (!socketIp) return null;

  // Requête directe (non Cloudflare) : les en-têtes proxy sont ignorés.
  if (!matcher.contains(socketIp)) {
    return socketIp;
  }

  const rawHeader = req?.headers?.['cf-connecting-ip'];
  const headerValue = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;
  const cloudflareClientIp = normalizeIp(headerValue);

  return cloudflareClientIp || socketIp;
};
