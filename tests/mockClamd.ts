// A stand-in clamd for tests: speaks the INSTREAM and PING commands over TCP and reports "FOUND" when the
// streamed bytes contain the EICAR test string. Not a test file itself (tests/*.test.ts is the test glob).
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { EICAR_TEST_STRING } from '../src/lib/clinical/virusScanners.ts';

export interface MockClamd { port: number; scans: number; close(): Promise<void> }

export async function startMockClamd(): Promise<MockClamd> {
  const state = { scans: 0 };
  const server = net.createServer((socket) => {
    let buf = Buffer.alloc(0);
    let command: string | null = null;
    const received: Buffer[] = [];
    socket.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (command === null) {
        const end = buf.indexOf(0);
        if (end < 0) return;
        command = buf.subarray(0, end).toString();
        buf = buf.subarray(end + 1);
        if (command === 'zPING') { socket.end('PONG\0'); return; }
        if (command !== 'zINSTREAM') { socket.end('UNKNOWN COMMAND\0'); return; }
      }
      while (buf.length >= 4) {
        const len = buf.readUInt32BE(0);
        if (len === 0) {
          state.scans++;
          const body = Buffer.concat(received).toString('latin1');
          socket.end(body.includes(EICAR_TEST_STRING) ? 'stream: Eicar-Signature FOUND\0' : 'stream: OK\0');
          return;
        }
        if (buf.length < 4 + len) return;
        received.push(buf.subarray(4, 4 + len));
        buf = buf.subarray(4 + len);
      }
    });
    socket.on('error', () => {});
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: (server.address() as AddressInfo).port,
    get scans() { return state.scans; },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
