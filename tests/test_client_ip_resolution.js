import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  getClientIp,
  getSocketIp,
  normalizeIp,
  ipMatchesCidr,
  CloudflareIpMatcher,
  DEFAULT_CLOUDFLARE_RANGES
} from '../server/clientIdentity.js';

/**
 * E2 — Non-régression : résolution de l'IP client.
 * - X-Forwarded-For est TOUJOURS ignoré.
 * - CF-Connecting-IP n'est pris en compte QUE depuis une IP Cloudflare de confiance.
 * - Sinon : socket.remoteAddress.
 */

const makeReq = (remoteAddress, headers = {}) => ({
  socket: { remoteAddress },
  headers
});

const matcher = new CloudflareIpMatcher(DEFAULT_CLOUDFLARE_RANGES);

// IP utilitaires (plages de documentation / réservées)
const CLOUDFLARE_IP = '173.245.48.5';        // dans 173.245.48.0/20
const CLOUDFLARE_IPV6 = '2606:4700:1234::1'; // dans 2606:4700::/32
const CLIENT_IP = '198.51.100.23';           // TEST-NET-2
const DIRECT_IP = '203.0.113.10';            // TEST-NET-3

test('requête directe (non Cloudflare) : remoteAddress, en-têtes ignorés', () => {
  const req = makeReq(DIRECT_IP, {
    'x-forwarded-for': CLIENT_IP,
    'cf-connecting-ip': CLIENT_IP
  });
  assert.equal(getClientIp(req, { matcher }), DIRECT_IP);
});

test('faux X-Forwarded-For depuis une source non fiable -> ignoré', () => {
  const req = makeReq(DIRECT_IP, { 'x-forwarded-for': '1.2.3.4, 5.6.7.8' });
  assert.equal(getClientIp(req, { matcher }), DIRECT_IP);
});

test('faux CF-Connecting-IP depuis une source non Cloudflare -> ignoré', () => {
  const req = makeReq(DIRECT_IP, { 'cf-connecting-ip': '10.0.0.1' });
  assert.equal(getClientIp(req, { matcher }), DIRECT_IP);
});

test('requête directe sans aucun en-tête -> remoteAddress', () => {
  assert.equal(getClientIp(makeReq(DIRECT_IP), { matcher }), DIRECT_IP);
});

test('requête via Cloudflare : CF-Connecting-IP utilisé', () => {
  const req = makeReq(CLOUDFLARE_IP, {
    'cf-connecting-ip': CLIENT_IP,
    'x-forwarded-for': '9.9.9.9'
  });
  assert.equal(getClientIp(req, { matcher }), CLIENT_IP);
});

test('requête via Cloudflare sans CF-Connecting-IP -> remoteAddress Cloudflare', () => {
  const req = makeReq(CLOUDFLARE_IP, { 'x-forwarded-for': '9.9.9.9' });
  assert.equal(getClientIp(req, { matcher }), CLOUDFLARE_IP);
});

test('requête via Cloudflare avec CF-Connecting-IP invalide -> remoteAddress Cloudflare', () => {
  const req = makeReq(CLOUDFLARE_IP, { 'cf-connecting-ip': 'not-an-ip' });
  assert.equal(getClientIp(req, { matcher }), CLOUDFLARE_IP);
});

test('IPv4-mapped IPv6 depuis Cloudflare est reconnu et apex retourné', () => {
  const req = makeReq('::ffff:173.245.48.9', { 'cf-connecting-ip': '::ffff:198.51.100.23' });
  assert.equal(getClientIp(req, { matcher }), CLIENT_IP);
});

test('IPv6 Cloudflare : CF-Connecting-IP IPv6 utilisé', () => {
  const req = makeReq(CLOUDFLARE_IPV6, { 'cf-connecting-ip': '2001:db8::1' });
  assert.equal(getClientIp(req, { matcher }), '2001:db8::1');
});

test('normalizeIp : mapped, zone, crochets, invalides', () => {
  assert.equal(normalizeIp('::ffff:1.2.3.4'), '1.2.3.4');
  assert.equal(normalizeIp('fe80::1%eth0'), 'fe80::1');
  assert.equal(normalizeIp('[2606:4700::1]'), '2606:4700::1');
  assert.equal(normalizeIp(' 203.0.113.10 '), '203.0.113.10');
  assert.equal(normalizeIp('pas-une-ip'), null);
  assert.equal(normalizeIp(''), null);
  assert.equal(normalizeIp(null), null);
});

test('getSocketIp : remoteAddress normalisée', () => {
  assert.equal(getSocketIp(makeReq('::ffff:203.0.113.10')), DIRECT_IP);
});

test('ipMatchesCidr / matcher : cohérence bornes', () => {
  assert.equal(ipMatchesCidr('173.245.48.1', '173.245.48.0/20'), true);
  assert.equal(ipMatchesCidr('173.245.63.255', '173.245.48.0/20'), true);
  assert.equal(ipMatchesCidr('173.245.64.0', '173.245.48.0/20'), false);
  assert.equal(matcher.contains('104.16.0.1'), true);
  assert.equal(matcher.contains(DIRECT_IP), false);
  assert.equal(matcher.contains('2606:4700::abcd'), true);
  assert.equal(matcher.contains('2001:db8::1'), false);
});
