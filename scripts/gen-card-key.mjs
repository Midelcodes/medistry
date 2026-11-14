#!/usr/bin/env node
// Generates an ES256 (ECDSA P-256) key for signing offline emergency cards.
// Prints OFFLINE_CARD_PRIVATE_KEY (base64 of the PKCS8 DER) for .env or the Railway variables.
// The private key goes to stdout only: do not commit it, paste it into chat or tickets, or log it.
// Usage: node scripts/gen-card-key.mjs
import crypto from 'node:crypto';

const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
const der = privateKey.export({ format: 'der', type: 'pkcs8' });
const { kty, crv, x, y } = publicKey.export({ format: 'jwk' });
const kid = crypto.createHash('sha256').update(JSON.stringify({ crv, kty, x, y })).digest('base64url');
const spki = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');

console.error('New offline card signing key (ES256, P-256).');
console.error(`kid (RFC 7638 thumbprint): ${kid}`);
console.error(`Public key (SPKI, base64), for OFFLINE_CARD_PREVIOUS_PUBLIC_KEYS after a later rotation:\n${spki}`);
console.error('Keep the line below secret. It is printed to stdout only.\n');
console.log(`OFFLINE_CARD_PRIVATE_KEY=${der.toString('base64')}`);
