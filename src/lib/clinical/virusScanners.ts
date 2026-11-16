/**
 * Malware scanning for uploads (Phase 14).
 *
 *   ClamdVirusScannerAdapter   real antivirus: ClamAV's clamd over TCP (INSTREAM). The production default.
 *   TestPatternScannerAdapter  NOT antivirus: finds the EICAR test string and a script pattern. Tests and demo only.
 *
 * clamd protocol (clamd(8) manual): connect, send "zINSTREAM\0", then the file as chunks of
 * <4-byte big-endian length><bytes>, then a zero-length chunk. clamd answers "stream: OK", "stream: <name> FOUND"
 * or "... ERROR", terminated by "\0". "zPING\0" is answered with "PONG".
 *
 * Fail closed: with real data (DEMO_MODE=0) an unreachable clamd rejects the upload. Only in demo mode, and only
 * when CLAMD_HOST is set but unreachable, the test-pattern adapter stands in (with a warning).
 */
import net from 'node:net';

export const EICAR_TEST_STRING = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';

export interface IVirusScannerAdapter {
  readonly name: string;
  scanBuffer(buffer: Buffer): Promise<{ clean: boolean; threatName?: string }>;
}

/** clamd could not be reached or answered in a way we do not understand. Uploads must not proceed. */
export class ScannerUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScannerUnavailableError';
  }
}

/** Test and demo only: matches the EICAR test string and an embedded-script pattern. This is not antivirus. */
export class TestPatternScannerAdapter implements IVirusScannerAdapter {
  readonly name = 'test-patterns (not antivirus)';

  async scanBuffer(buffer: Buffer): Promise<{ clean: boolean; threatName?: string }> {
    const contentString = buffer.toString('utf8');
    if (contentString.includes(EICAR_TEST_STRING)) {
      return { clean: false, threatName: 'EICAR_Test_Malware_Signature' };
    }
    if (contentString.includes('<script>') || contentString.includes('javascript:')) {
      return { clean: false, threatName: 'Embedded_Script_Exploit_Pattern' };
    }
    return { clean: true };
  }
}

export interface ClamdOptions {
  host: string;
  port: number;
  timeoutMs?: number;
  chunkSize?: number;
  /** Demo only: used when clamd is unreachable. Never set with real data. */
  fallback?: IVirusScannerAdapter;
}

/** Sends one clamd command (and optional INSTREAM body) and returns the reply without its terminator. */
function clamdExchange(opts: ClamdOptions, command: string, body?: Buffer): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: opts.host, port: opts.port });
    const chunks: Buffer[] = [];
    let settled = false;
    const done = (err: Error | null, reply?: string) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (err) reject(err); else resolve(reply!);
    };
    socket.setTimeout(opts.timeoutMs ?? 30_000, () => done(new ScannerUnavailableError('clamd timed out')));
    socket.on('error', (err: NodeJS.ErrnoException) => done(new ScannerUnavailableError(`clamd unreachable (${err.code || err.name})`)));
    socket.on('data', (d) => {
      chunks.push(d);
      const all = Buffer.concat(chunks);
      const end = all.indexOf(0);
      if (end >= 0) done(null, all.subarray(0, end).toString('utf8').trim());
    });
    socket.on('end', () => done(chunks.length ? null : new ScannerUnavailableError('clamd closed the connection without a reply'), Buffer.concat(chunks).toString('utf8').replace(/\0/g, '').trim()));
    socket.on('connect', () => {
      socket.write(`z${command}\0`);
      if (body) {
        const size = opts.chunkSize ?? 64 * 1024;
        for (let i = 0; i < body.length; i += size) {
          const part = body.subarray(i, i + size);
          const len = Buffer.alloc(4);
          len.writeUInt32BE(part.length);
          socket.write(len);
          socket.write(part);
        }
        socket.write(Buffer.alloc(4)); // zero-length chunk: end of stream
      }
    });
  });
}

export class ClamdVirusScannerAdapter implements IVirusScannerAdapter {
  readonly name: string;
  private opts: ClamdOptions;

  constructor(opts: ClamdOptions) {
    this.opts = opts;
    this.name = `clamd (${opts.host}:${opts.port})`;
  }

  async scanBuffer(buffer: Buffer): Promise<{ clean: boolean; threatName?: string }> {
    let reply: string;
    try {
      reply = await clamdExchange(this.opts, 'INSTREAM', buffer);
    } catch (err) {
      if (err instanceof ScannerUnavailableError && this.opts.fallback) {
        console.warn(`[scanner] ${err.message}; demo mode, so falling back to ${this.opts.fallback.name}`);
        return this.opts.fallback.scanBuffer(buffer);
      }
      throw err;
    }
    if (/^stream: OK$/.test(reply)) return { clean: true };
    const found = reply.match(/^stream: (.+) FOUND$/);
    if (found) return { clean: false, threatName: found[1].slice(0, 120) };
    // "INSTREAM size limit exceeded. ERROR" and anything unexpected: not a clean result.
    throw new ScannerUnavailableError(`clamd could not scan the file (${reply.replace(/[^\w .:-]/g, '').slice(0, 80) || 'no reply'})`);
  }

  /** Health check: true when clamd answers PING with PONG. */
  async ping(timeoutMs = 1500): Promise<boolean> {
    try {
      return (await clamdExchange({ ...this.opts, timeoutMs }, 'PING')) === 'PONG';
    } catch {
      return false;
    }
  }
}

/** Real data (DEMO_MODE=0) must never upload without a working antivirus scan. */
export const scannerFailsClosed = (env: NodeJS.ProcessEnv = process.env) => env.DEMO_MODE === '0';

/**
 * The scanner for this environment: clamd when CLAMD_HOST is set or with real data (DEMO_MODE=0, default
 * localhost:3310, no fallback); otherwise (demo, tests) the test-pattern adapter.
 */
export function createVirusScanner(env: NodeJS.ProcessEnv = process.env): IVirusScannerAdapter {
  const host = (env.CLAMD_HOST || '').trim();
  const failClosed = scannerFailsClosed(env);
  if (!host && !failClosed) return new TestPatternScannerAdapter();
  const port = parseInt(env.CLAMD_PORT || '3310', 10) || 3310;
  return new ClamdVirusScannerAdapter({ host: host || 'localhost', port, ...(failClosed ? {} : { fallback: new TestPatternScannerAdapter() }) });
}
