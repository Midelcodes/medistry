/**
 * Upload content checks (Phase 14): the file type comes from the bytes, not from the name or the declared MIME
 * type, and image metadata (EXIF, XMP, IPTC, comments, text chunks) is removed before storage. Only PDF, PNG and
 * JPEG are accepted.
 */
export type SafeFileType = 'application/pdf' | 'image/png' | 'image/jpeg';

const EXTENSIONS: Record<SafeFileType, string[]> = {
  'application/pdf': ['pdf'],
  'image/png': ['png'],
  'image/jpeg': ['jpg', 'jpeg'],
};

/** File type from magic bytes: PDF "%PDF-", PNG "\x89PNG\r\n\x1a\n", JPEG FF D8 FF. Anything else: null. */
export function detectFileType(buf: Buffer): SafeFileType | null {
  if (buf.length >= 5 && buf.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  return null;
}

/**
 * The bytes must be a PDF, PNG or JPEG, match the declared MIME type, and (if the name has an extension) match
 * it too. An EXE renamed to .pdf fails here. Returns the detected type.
 */
export function assertSafeFileType(buf: Buffer, declaredMime: string, filename?: string): SafeFileType {
  const detected = detectFileType(buf);
  if (!detected) throw new Error('File content is not a PDF, PNG or JPEG. Upload rejected.');
  if (String(declaredMime || '').toLowerCase() !== detected) {
    throw new Error(`File content (${detected}) does not match the declared type (${String(declaredMime).slice(0, 40)}). Upload rejected.`);
  }
  const ext = /\.([A-Za-z0-9]{1,8})$/.exec(String(filename || ''))?.[1]?.toLowerCase();
  if (ext && !EXTENSIONS[detected].includes(ext)) {
    throw new Error(`File extension .${ext} does not match its content (${detected}). Upload rejected.`);
  }
  return detected;
}

/** JPEG without APP1 (EXIF, XMP), APP13 (IPTC) and comment segments. Image data is untouched. */
function stripJpeg(buf: Buffer): Buffer {
  const out: Buffer[] = [buf.subarray(0, 2)];
  let i = 2;
  while (i < buf.length) {
    if (buf[i] !== 0xff) throw new Error('Malformed JPEG. Upload rejected.');
    const marker = buf[i + 1];
    if (marker === 0xff) { i += 1; continue; } // fill byte
    if (marker === 0xd9 || marker === 0xda) { out.push(buf.subarray(i)); break; } // end of image / start of scan
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { out.push(buf.subarray(i, i + 2)); i += 2; continue; }
    if (i + 4 > buf.length) throw new Error('Malformed JPEG. Upload rejected.');
    const end = i + 2 + buf.readUInt16BE(i + 2);
    if (end > buf.length) throw new Error('Malformed JPEG. Upload rejected.');
    if (marker !== 0xe1 && marker !== 0xed && marker !== 0xfe) out.push(buf.subarray(i, end));
    i = end;
  }
  return Buffer.concat(out);
}

const PNG_METADATA_CHUNKS = new Set(['eXIf', 'tEXt', 'iTXt', 'zTXt', 'tIME']);

/** PNG without eXIf, text and time chunks. */
function stripPng(buf: Buffer): Buffer {
  const out: Buffer[] = [buf.subarray(0, 8)];
  let i = 8;
  while (i + 12 <= buf.length) {
    const len = buf.readUInt32BE(i);
    const type = buf.subarray(i + 4, i + 8).toString('latin1');
    const end = i + 12 + len;
    if (end > buf.length) throw new Error('Malformed PNG. Upload rejected.');
    if (!PNG_METADATA_CHUNKS.has(type)) out.push(buf.subarray(i, end));
    i = end;
    if (type === 'IEND') break;
  }
  return Buffer.concat(out);
}

/** Voice notes for AI intake (Phase 15): the formats browsers record (MediaRecorder) and common phone formats. */
export type SafeAudioType = 'audio/webm' | 'audio/ogg' | 'audio/wav' | 'audio/mp4' | 'audio/mpeg';

/** Audio type from magic bytes: WebM (EBML), Ogg, WAV (RIFF/WAVE), MP4/M4A (ftyp box), MP3 (ID3 tag or frame sync). */
export function detectAudioType(buf: Buffer): SafeAudioType | null {
  if (buf.length >= 4 && buf.readUInt32BE(0) === 0x1a45dfa3) return 'audio/webm';
  if (buf.length >= 4 && buf.subarray(0, 4).toString('latin1') === 'OggS') return 'audio/ogg';
  if (buf.length >= 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WAVE') return 'audio/wav';
  if (buf.length >= 8 && buf.subarray(4, 8).toString('latin1') === 'ftyp') return 'audio/mp4';
  if (buf.length >= 3 && (buf.subarray(0, 3).toString('latin1') === 'ID3' || (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0))) return 'audio/mpeg';
  return null;
}

/** The bytes must be one of the accepted audio formats and match the declared type (codec parameters ignored). */
export function assertSafeAudioType(buf: Buffer, declaredMime: string): SafeAudioType {
  const detected = detectAudioType(buf);
  if (!detected) throw new Error('Audio content is not WebM, Ogg, WAV, MP4 or MP3. Upload rejected.');
  const declared = String(declaredMime || '').toLowerCase().split(';')[0].trim();
  const aliases: Record<string, SafeAudioType> = { 'audio/x-wav': 'audio/wav', 'audio/wave': 'audio/wav', 'audio/m4a': 'audio/mp4', 'audio/x-m4a': 'audio/mp4', 'audio/mp3': 'audio/mpeg', 'video/webm': 'audio/webm' };
  if ((aliases[declared] || declared) !== detected) throw new Error(`Audio content (${detected}) does not match the declared type. Upload rejected.`);
  return detected;
}

/** Removes image metadata (location, device, names in comments). PDFs are returned unchanged. */
export function stripImageMetadata(buf: Buffer, type: SafeFileType): Buffer {
  if (type === 'image/jpeg') return stripJpeg(buf);
  if (type === 'image/png') return stripPng(buf);
  return buf;
}
