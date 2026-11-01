// The bridge between a dashboard noVNC client's WebSocket and a sign-in session's x11vnc Unix socket. It reads the
// client's RFB stream only to tell keyboard and pointer input from the client's own protocol traffic, since only
// input keeps a sign-in session from idling out.

import { connect } from 'node:net';
import { WebSocket, type RawData } from 'ws';

/** RFB 3.8 client-to-server messages by type, with the length of each, or how to find it. */
type Measure = (buffer: Buffer) => number | undefined;
const fixed = (length: number): Measure => (buffer) => (buffer.length >= length ? length : undefined);
const MESSAGES: Record<number, { input: boolean; length: Measure }> = {
  0: { input: false, length: fixed(20) }, // SetPixelFormat
  2: { input: false, length: (b) => (b.length >= 4 ? 4 + 4 * b.readUInt16BE(2) : undefined) }, // SetEncodings
  3: { input: false, length: fixed(10) }, // FramebufferUpdateRequest
  4: { input: true, length: fixed(8) }, // KeyEvent
  5: { input: true, length: (b) => (b.length >= 2 ? ((b[1]! & 0x80) !== 0 ? 7 : 6) : undefined) }, // PointerEvent
  6: { input: true, length: (b) => (b.length >= 8 ? 8 + Math.abs(b.readInt32BE(4)) : undefined) }, // ClientCutText
  150: { input: false, length: fixed(10) }, // EnableContinuousUpdates
  248: { input: false, length: (b) => (b.length >= 9 ? 9 + b[8]! : undefined) }, // ClientFence
  250: { input: false, length: fixed(4) }, // xvp
  251: { input: false, length: (b) => (b.length >= 8 ? 8 + 16 * b[6]! : undefined) }, // SetDesktopSize
  255: { input: true, length: (b) => (b.length >= 2 ? (b[1] === 0 ? 12 : undefined) : undefined) }, // QEMU extended key event
};

/**
 * Follows a client's RFB stream: the 12-byte version, the 1-byte security choice, and the 1-byte ClientInit, then
 * messages. A message it cannot measure ends the parsing, and every later chunk counts as input, so an unknown
 * client keeps its session open rather than losing it.
 */
export class RfbInputDetector {
  #handshake = 14;
  #buffer: Buffer = Buffer.alloc(0);
  /** Bytes of a cut-text payload still to pass, which are skipped rather than held. */
  #skip = 0;
  #lost = false;

  /** Feed client bytes; returns whether they held input. */
  feed(chunk: Buffer): boolean {
    if (this.#lost) return true;
    let data = chunk;
    if (this.#handshake > 0) {
      const skipped = Math.min(this.#handshake, data.length);
      this.#handshake -= skipped;
      data = data.subarray(skipped);
    }
    let input = false;
    if (this.#skip > 0) {
      const skipped = Math.min(this.#skip, data.length);
      this.#skip -= skipped;
      data = data.subarray(skipped);
      input = true;
    }
    this.#buffer = this.#buffer.length === 0 ? data : Buffer.concat([this.#buffer, data]);
    while (this.#buffer.length > 0) {
      if (this.#buffer[0] === 6 && this.#buffer.length >= 8) {
        // ClientCutText: input, whose payload may be large, so it passes through without being held.
        input = true;
        const payload = Math.abs(this.#buffer.readInt32BE(4));
        const available = Math.min(payload, this.#buffer.length - 8);
        this.#skip = payload - available;
        this.#buffer = this.#buffer.subarray(8 + available);
        continue;
      }
      const message = MESSAGES[this.#buffer[0]!];
      if (!message) {
        this.#lost = true;
        return true;
      }
      const length = message.length(this.#buffer);
      if (length === undefined) {
        if (this.#buffer.length >= 2 && this.#buffer[0] === 255 && this.#buffer[1] !== 0) {
          this.#lost = true;
          return true;
        }
        break;
      }
      if (this.#buffer.length < length) break;
      input ||= message.input;
      this.#buffer = this.#buffer.subarray(length);
    }
    return input;
  }
}

function bytes(raw: RawData): Buffer {
  if (Buffer.isBuffer(raw)) return raw;
  if (Array.isArray(raw)) return Buffer.concat(raw);
  return Buffer.from(raw);
}

/** Bridge a dashboard WebSocket to a VNC Unix socket until either side closes. */
export function bridgeVnc(socket: WebSocket, vncSocket: string, onInput: () => void): () => void {
  const vnc = connect(vncSocket);
  const detector = new RfbInputDetector();
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    vnc.destroy();
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) socket.close(1001, 'session ended');
  };
  vnc.on('data', (chunk) => {
    if (socket.readyState === WebSocket.OPEN) socket.send(chunk, { binary: true });
  });
  vnc.on('close', close);
  vnc.on('error', close);
  socket.on('message', (raw) => {
    const chunk = bytes(raw);
    if (detector.feed(chunk)) onInput();
    vnc.write(chunk);
  });
  socket.on('close', close);
  socket.on('error', close);
  return close;
}
