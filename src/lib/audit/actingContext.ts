/**
 * Who is really acting during a request. A proxy (parent, guardian, caregiver...) acts under their own identity:
 * while a proxy's request runs, every audit entry written for the represented patient records the proxy's user
 * id as the actor and starts its reason with "Proxy <id> (<relationship>) on behalf of patient <id>".
 * AsyncLocalStorage carries this through the engines, so entries they write internally are covered too.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

export interface ProxyActing {
  proxyUserId: string;
  patientId: string;
  relationship: string;
  relationshipId: string;
}

const storage = new AsyncLocalStorage<ProxyActing>();

export function runActing<T>(acting: ProxyActing | null, fn: () => T): T {
  return acting ? storage.run(acting, fn) : fn();
}

export function currentActing(): ProxyActing | undefined {
  return storage.getStore();
}

export function proxyReasonPrefix(a: ProxyActing): string {
  return `Proxy ${a.proxyUserId} (${a.relationship}) on behalf of patient ${a.patientId}`;
}

/** Rewrites an audit payload made during a proxy's request. Entries about other subjects are left alone. */
export function applyActing<T extends { actorId: string; subjectId?: string; reason?: string }>(payload: T): T {
  const a = storage.getStore();
  if (!a) return payload;
  if (payload.subjectId && payload.subjectId !== a.patientId) return payload;
  const prefix = proxyReasonPrefix(a);
  return {
    ...payload,
    actorId: payload.actorId === a.patientId ? a.proxyUserId : payload.actorId,
    reason: payload.reason ? `${prefix}: ${payload.reason}` : prefix,
  };
}
