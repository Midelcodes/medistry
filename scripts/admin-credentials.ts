#!/usr/bin/env node
// Credentials for the first platform admin (Phase 12). Reads the password from stdin (never from the command
// line, so it stays out of shell history) and prints the three environment values to set on the server:
//   PLATFORM_ADMIN_PASSWORD_HASH  scrypt hash (N=2^15, r=8, p=1, 16-byte salt)
//   PLATFORM_ADMIN_TOTP_SECRET    RFC 4648 base32 secret; add it to an authenticator app (or use the otpauth URI)
// plus PLATFORM_ADMIN_EMAIL, which you choose. Set them as secrets; never commit them.
//
//   node --experimental-strip-types scripts/admin-credentials.ts admin@example.org
import crypto from 'node:crypto';
import { hashPassword, toRfc4648Base32, MIN_PASSWORD_LENGTH } from '../src/lib/auth/security.ts';

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) process.stderr.write('Admin password (input is not hidden; pipe it in to avoid echo), then Enter: ');
  let data = '';
  for await (const chunk of process.stdin) {
    data += chunk;
    if (process.stdin.isTTY && data.includes('\n')) break;
  }
  return data.replace(/\r?\n$/, '');
}

const email = (process.argv[2] || 'admin@example.org').trim();
const password = await readStdin();
if (password.length < MIN_PASSWORD_LENGTH) {
  console.error(`The password must have at least ${MIN_PASSWORD_LENGTH} characters.`);
  process.exit(1);
}
const secret = toRfc4648Base32(crypto.randomBytes(20));
console.log(`PLATFORM_ADMIN_EMAIL=${email}`);
console.log(`PLATFORM_ADMIN_PASSWORD_HASH=${await hashPassword(password)}`);
console.log(`PLATFORM_ADMIN_TOTP_SECRET=${secret}`);
console.log(`# Authenticator app: otpauth://totp/Medistry:${encodeURIComponent(email)}?secret=${secret}&issuer=Medistry&algorithm=SHA1&digits=6&period=30`);
