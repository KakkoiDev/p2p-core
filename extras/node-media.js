/**
 * Raw media helpers for Node apps that carry audio/video through room messages.
 *
 * Video is rgb24 with a four-byte big-endian width/height header. Audio is raw
 * mono s16le; one room message is one audio chunk. ffmpeg does capture and
 * conversion, so p2p-core itself has no native media dependency.
 */
import { spawn } from 'node:child_process';

/** ffmpeg input arguments for an AVFoundation camera or realtime lavfi source. */
export function videoInputArgs({ video, camera, width, height, fps }) {
  const lavfi = video === 'test' ? 'testsrc2' : video.startsWith('lavfi:') ? video.slice(6) : null;
  if (lavfi) return ['-re', '-f', 'lavfi', '-i', `${lavfi}=size=${width}x${height}:rate=${fps}`];

  // ffmpeg 8 defaults to yuv420p, which AVFoundation cameras commonly reject.
  return ['-f', 'avfoundation', '-framerate', '30', '-video_size', '640x480',
    '-pixel_format', 'uyvy422', '-i', `${camera}:none`, '-vf', `fps=${fps},scale=${width}:${height},hflip`];
}

/** ffmpeg input arguments for an AVFoundation microphone or realtime test tone. */
export function audioInputArgs({ audio, mic, rate }) {
  return audio === 'test'
    ? ['-re', '-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=${rate}`]
    : ['-f', 'avfoundation', '-i', `:${mic}`];
}

/** ffplay arguments for low-latency mono s16le playback. */
export function audioOutputArgs({ rate }) {
  return ['-hide_banner', '-loglevel', 'error', '-nodisp', '-fflags', 'nobuffer',
    '-f', 's16le', '-ar', String(rate), '-ch_layout', 'mono', '-i', 'pipe:0'];
}

/** Cut streamed bytes into independent, fixed-size Uint8Array chunks. */
export function splitBytes(size, onChunk) {
  if (!Number.isInteger(size) || size <= 0) throw new RangeError('p2p-core node media: chunk size must be a positive integer');
  let buf = new Uint8Array(size);
  let fill = 0;
  return (chunk) => {
    let i = 0;
    while (i < chunk.length) {
      const n = Math.min(size - fill, chunk.length - i);
      buf.set(chunk.subarray(i, i + n), fill);
      fill += n;
      i += n;
      if (fill === size) {
        onChunk(buf);
        buf = new Uint8Array(size);
        fill = 0;
      }
    }
  };
}

/** Pack one rgb24 frame for room.send(). */
export function packVideoFrame({ width, height, data }) {
  if (!Number.isInteger(width) || width <= 0 || width > 0xffff
    || !Number.isInteger(height) || height <= 0 || height > 0xffff
    || !(data instanceof Uint8Array) || data.length !== width * height * 3) {
    throw new TypeError('p2p-core node media: expected width*height rgb24 bytes');
  }
  const message = new Uint8Array(4 + data.length);
  message.set([width >> 8, width & 255, height >> 8, height & 255]);
  message.set(data, 4);
  return message;
}

/** Validate and unpack one received rgb24 frame; malformed input returns null. */
export function unpackVideoFrame(message) {
  if (!(message instanceof Uint8Array) || message.length <= 4) return null;
  const width = (message[0] << 8) | message[1];
  const height = (message[2] << 8) | message[3];
  if (width === 0 || height === 0 || message.length !== 4 + width * height * 3) return null;
  return { width, height, data: message.subarray(4) };
}

/** Pack one mono s16le PCM chunk for room.send(). */
export function packAudioChunk(pcm) {
  if (!(pcm instanceof Uint8Array) || pcm.length === 0 || pcm.length % 2 !== 0) {
    throw new TypeError('p2p-core node media: expected non-empty s16le PCM bytes');
  }
  return pcm;
}

/** Validate one received mono s16le PCM chunk; malformed input returns null. */
export function unpackAudioChunk(message) {
  return message instanceof Uint8Array && message.length > 0 && message.length % 2 === 0 ? message : null;
}

function runFfmpeg(args, onData, { command = 'ffmpeg', onError = () => {} } = {}) {
  const child = spawn(command, ['-hide_banner', '-loglevel', 'error', ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', onData);
  child.stderr.on('data', (data) => onError(new Error(String(data).trim())));
  child.on('error', onError);
  return child;
}

/** Start ffmpeg camera capture and call onFrame with packed rgb24 messages. */
export function captureVideo(options, onFrame) {
  const { width, height, fps, video = 'camera', camera = '0' } = options;
  const input = videoInputArgs({ video, camera, width, height, fps });
  return runFfmpeg(
    [...input, '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1'],
    splitBytes(width * height * 3, (data) => onFrame(packVideoFrame({ width, height, data }))),
    options,
  );
}

/** Start ffmpeg microphone capture and call onChunk with mono s16le messages. */
export function captureAudio(options, onChunk) {
  const { rate = 16000, chunkMs = 40, audio = 'mic', mic = '0' } = options;
  const size = rate * 2 * chunkMs / 1000;
  if (!Number.isInteger(size)) throw new RangeError('p2p-core node media: audio chunk size must be whole bytes');
  const input = audioInputArgs({ audio, mic, rate });
  return runFfmpeg(
    [...input, '-ac', '1', '-ar', String(rate), '-f', 's16le', 'pipe:1'],
    splitBytes(size, (pcm) => onChunk(packAudioChunk(pcm))),
    options,
  );
}

/** Create a lazy ffplay sink for received mono s16le chunks. */
export function createAudioPlayer({ rate = 16000, command = 'ffplay', onError = () => {} } = {}) {
  let child = null;
  return {
    write(message) {
      const pcm = unpackAudioChunk(message);
      if (!pcm) return false;
      if (!child) {
        child = spawn(command, audioOutputArgs({ rate }), { stdio: ['pipe', 'ignore', 'ignore'] });
        child.on('error', onError);
        child.stdin.on('error', () => {});
      }
      child.stdin.write(pcm);
      return true;
    },
    stop() {
      if (child) child.kill();
      child = null;
    },
  };
}
