import test from 'node:test';
import assert from 'node:assert/strict';
import {
  audioInputArgs,
  audioOutputArgs,
  packAudioChunk,
  packVideoFrame,
  splitBytes,
  unpackAudioChunk,
  unpackVideoFrame,
  videoInputArgs,
} from '../extras/node-media.js';

test('node media: camera input selects the AVFoundation pixel format cameras accept', () => {
  assert.deepEqual(videoInputArgs({ video: 'camera', camera: '2', width: 80, height: 48, fps: 10 }), [
    '-f', 'avfoundation', '-framerate', '30', '-video_size', '640x480',
    '-pixel_format', 'uyvy422', '-i', '2:none', '-vf', 'fps=10,scale=80:48,hflip',
  ]);
});

test('node media: synthetic video and audio inputs run in realtime', () => {
  assert.deepEqual(videoInputArgs({ video: 'test', camera: '0', width: 40, height: 24, fps: 5 }), [
    '-re', '-f', 'lavfi', '-i', 'testsrc2=size=40x24:rate=5',
  ]);
  assert.deepEqual(audioInputArgs({ audio: 'test', mic: '0', rate: 16000 }), [
    '-re', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=16000',
  ]);
  assert.deepEqual(audioInputArgs({ audio: 'mic', mic: '3', rate: 16000 }), [
    '-f', 'avfoundation', '-i', ':3',
  ]);
  assert.deepEqual(audioOutputArgs({ rate: 16000 }), [
    '-hide_banner', '-loglevel', 'error', '-nodisp', '-fflags', 'nobuffer',
    '-f', 's16le', '-ar', '16000', '-ch_layout', 'mono', '-i', 'pipe:0',
  ]);
});

test('node media: byte splitter preserves fixed chunks across stream boundaries', () => {
  const frames = [];
  const push = splitBytes(4, (frame) => frames.push([...frame]));
  push(Uint8Array.from([1, 2, 3]));
  push(Uint8Array.from([4, 5, 6, 7, 8, 9]));
  push(Uint8Array.from([10, 11, 12]));
  assert.deepEqual(frames, [[1, 2, 3, 4], [5, 6, 7, 8], [9, 10, 11, 12]]);
});

test('node media: video message framing round-trips dimensions and rgb24 bytes', () => {
  const rgb = Uint8Array.from([255, 0, 0, 0, 255, 0]);
  const message = packVideoFrame({ width: 2, height: 1, data: rgb });
  assert.deepEqual([...message], [0, 2, 0, 1, ...rgb]);
  const frame = unpackVideoFrame(message);
  assert.deepEqual({ width: frame.width, height: frame.height, data: [...frame.data] }, {
    width: 2, height: 1, data: [...rgb],
  });
  assert.equal(unpackVideoFrame(message.subarray(0, -1)), null);
});

test('node media: s16le audio message framing round-trips one PCM chunk', () => {
  const pcm = Uint8Array.from([1, 0, 255, 127]);
  const message = packAudioChunk(pcm);
  assert.deepEqual([...message], [...pcm]);
  assert.deepEqual([...unpackAudioChunk(message)], [...pcm]);
  assert.equal(unpackAudioChunk(Uint8Array.from([1])), null);
});
