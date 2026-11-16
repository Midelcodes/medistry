/**
 * Key management (Phase 14). Every use of a key goes through one KeyProvider:
 *   - field encryption keys (AES-256-GCM, versioned so the key can be rotated),
 *   - card signing and the published card JWKS,
 *   - clinician offline-pass signing.
 *
 * KEY_PROVIDER=env (default): EnvKeyProvider, keys from environment variables (earlier behaviour).
 * KEY_PROVIDER=cloud-kms:     CloudKmsKeyProvider, a stub; startup fails until it is implemented.
 *
 * Field key rotation: FIELD_ENCRYPTION_KEY is the current key and FIELD_ENCRYPTION_KEY_VERSION its version
 * (default 1). Older keys stay readable through FIELD_ENCRYPTION_PREVIOUS_KEYS="1:<hex>,2:<hex>". New ciphertexts
 * carry "v<version>:"; ciphertexts without a prefix are version 1. scripts/rotate-field-key.ts re-encrypts stored
 * data under the current version in batches.
 *
 * Card key rotation: OFFLINE_CARD_PRIVATE_KEY signs new cards (its kid goes in each card). Previous public keys
 * in OFFLINE_CARD_PREVIOUS_PUBLIC_KEYS stay in the JWKS, each until the date given after "@" (set it to when the
 * last card signed with that key expires: rotation date + OFFLINE_CARD_VALIDITY_DAYS).
 */
import { appSecret } from '../security/config.ts';
import { loadCardKeyStore, type CardJwk, type CardKeyStore } from './cardKeys.ts';

export interface FieldKey { version: number; key: Buffer }

export interface KeyProvider {
  readonly kind: 'env' | 'cloud-kms';
  /** The key for `version`, or the current key (for new writes) when no version is given. */
  getFieldEncryptionKey(version?: number): FieldKey;
  /** Every field key version this provider can read, current first. */
  getFieldKeyVersions(): number[];
  /** ES256 compact JWS for an offline card, signed with the current card key. */
  signCard(payload: object): string;
  /** Public keys scanners accept: the current key, then previous keys still within their keep-until date. */
  getCardJwks(nowSeconds?: number): CardJwk[];
  /** kid of the current card key (new cards carry it). */
  getCardKid(): string;
  /** ES256 compact JWS for a clinician offline pass. */
  signPass(payload: object): string;
}

function parseHexKey(value: string | undefined, name: string): Buffer {
  const v = (value || '').trim();
  if (!/^[0-9a-fA-F]{64}$/.test(v)) throw new Error(`${name} must be 64 hexadecimal characters (32 bytes)`);
  return Buffer.from(v, 'hex');
}

export class EnvKeyProvider implements KeyProvider {
  readonly kind = 'env' as const;
  private env: NodeJS.ProcessEnv;
  private fieldKeys: Map<number, Buffer> | null = null;
  private currentVersion = 1;
  private cards: CardKeyStore | null = null;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.env = env;
  }

  private loadFieldKeys(): Map<number, Buffer> {
    if (this.fieldKeys) return this.fieldKeys;
    const version = parseInt(this.env.FIELD_ENCRYPTION_KEY_VERSION || '1', 10);
    if (!Number.isInteger(version) || version < 1 || version > 9999) throw new Error('FIELD_ENCRYPTION_KEY_VERSION must be a positive whole number');
    // The process environment keeps appSecret()'s rules (random dev key; fail closed in production).
    const current = this.env === process.env
      ? Buffer.from(appSecret('FIELD_ENCRYPTION_KEY', { hex: true }), 'hex')
      : parseHexKey(this.env.FIELD_ENCRYPTION_KEY, 'FIELD_ENCRYPTION_KEY');
    const keys = new Map<number, Buffer>([[version, current]]);
    for (const entry of (this.env.FIELD_ENCRYPTION_PREVIOUS_KEYS || '').split(',').map((s) => s.trim()).filter(Boolean)) {
      const m = /^(\d{1,4}):(.+)$/.exec(entry);
      if (!m) throw new Error('FIELD_ENCRYPTION_PREVIOUS_KEYS entries must look like <version>:<64 hex characters>');
      const v = Number(m[1]);
      if (v === version) throw new Error('FIELD_ENCRYPTION_PREVIOUS_KEYS must not reuse the current version');
      keys.set(v, parseHexKey(m[2], `FIELD_ENCRYPTION_PREVIOUS_KEYS version ${v}`));
    }
    this.currentVersion = version;
    this.fieldKeys = keys;
    return keys;
  }

  getFieldEncryptionKey(version?: number): FieldKey {
    const keys = this.loadFieldKeys();
    const v = version ?? this.currentVersion;
    const key = keys.get(v);
    if (!key) throw new Error(`No field encryption key for version ${v}. Add it to FIELD_ENCRYPTION_PREVIOUS_KEYS.`);
    return { version: v, key };
  }

  getFieldKeyVersions(): number[] {
    const keys = this.loadFieldKeys();
    return [this.currentVersion, ...[...keys.keys()].filter((v) => v !== this.currentVersion).sort((a, b) => b - a)];
  }

  private cardStore(): CardKeyStore {
    if (!this.cards) this.cards = loadCardKeyStore(this.env);
    return this.cards;
  }

  signCard(payload: object): string { return this.cardStore().signCompactJws(payload); }
  getCardJwks(nowSeconds?: number): CardJwk[] { return this.cardStore().getPublicJwks(nowSeconds); }
  getCardKid(): string { return this.cardStore().getKid(); }
  // Passes use the card key today (one key, one JWKS for scanners). A separate pass key would go here.
  signPass(payload: object): string { return this.cardStore().signCompactJws(payload); }
}

/**
 * Cloud KMS (stub). Design, not yet implemented:
 *   - Signing happens inside the KMS (asymmetric EC_SIGN_P256_SHA256 key): the app sends the JWS signing input
 *     and receives the signature. The private key never enters the app. The public key is read once from the
 *     KMS and published in the JWKS.
 *   - Field encryption: envelope encryption. A data key per version is generated by the KMS and stored only in
 *     wrapped form; the app unwraps it at start-up (KMS decrypt) and keeps it in memory.
 *   - Config: KMS_PROVIDER (gcp|aws|azure), KMS_CARD_KEY_ID, KMS_FIELD_KEY_ID, region pinned to
 *     DEPLOYMENT_REGION so keys stay in-country.
 * TODO: implement against the chosen cloud's KMS. KMS calls are network calls, so signCard/signPass must become
 * async and their callers (card issue, pass issue) must await them.
 * TODO: choose the KMS and region per deployment country (docs/DEPLOYMENT.md).
 */
export class CloudKmsKeyProvider implements KeyProvider {
  readonly kind = 'cloud-kms' as const;

  constructor(_env: NodeJS.ProcessEnv = process.env) {
    throw new Error('KEY_PROVIDER=cloud-kms is not implemented yet (see src/lib/crypto/keyProvider.ts). Use KEY_PROVIDER=env.');
  }

  getFieldEncryptionKey(): FieldKey { throw new Error('TODO: unwrap the data key with the KMS'); }
  getFieldKeyVersions(): number[] { throw new Error('TODO: list wrapped data key versions'); }
  signCard(): string { throw new Error('TODO: sign inside the KMS'); }
  getCardJwks(): CardJwk[] { throw new Error('TODO: read the public key from the KMS'); }
  getCardKid(): string { throw new Error('TODO: kid of the KMS public key'); }
  signPass(): string { throw new Error('TODO: sign inside the KMS'); }
}

let active: KeyProvider | null = null;

export function createKeyProvider(env: NodeJS.ProcessEnv = process.env): KeyProvider {
  const kind = (env.KEY_PROVIDER || 'env').trim().toLowerCase();
  if (kind === 'env') return new EnvKeyProvider(env);
  if (kind === 'cloud-kms') return new CloudKmsKeyProvider(env);
  throw new Error('KEY_PROVIDER must be env or cloud-kms');
}

/** The process-wide provider (created on first use from the environment). */
export function keyProvider(): KeyProvider {
  if (!active) active = createKeyProvider();
  return active;
}

/** Replaces the process-wide provider (tests and tools). */
export function setKeyProvider(provider: KeyProvider | null): void {
  active = provider;
}
