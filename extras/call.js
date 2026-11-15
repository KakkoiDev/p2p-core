/**
 * Calls: audio, video and screen sharing between everyone in a room.
 *
 *   import { call } from './vendor/p2p-core/extras/call.js';
 *   const media = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
 *   const c = call(room, { stream: media });
 *   c.onStream((id, stream) => showVideo(id, stream));
 *   c.onLeave((id) => removeVideo(id));
 *   c.setState({ audio: false });          // tell others you muted
 *   c.hangUp();
 *
 * Unlike room.addStream (internet relays only), a call negotiates its own WebRTC
 * links through the room's messages, so it works over every transport: the local
 * server, other tabs, pairing codes and the relays. Media always flows over a
 * direct (or TURN) WebRTC link, end-to-end encrypted; the transport only carries
 * the handshake.
 *
 * Everyone in the room is in the call: a full mesh, fine for a handful of people.
 * Each pair has one link with one audio and one video slot. The peer with the
 * lower id offers; turning the camera off, switching devices or sharing the
 * screen swaps tracks in place (replaceTrack), with no renegotiation.
 */

const DEFAULT_RTC = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };
const MAX_SDP = 64 * 1024;
const MAX_CANDIDATE = 2048;

function validDescription(d) {
  return d && typeof d === 'object' && (d.type === 'offer' || d.type === 'answer')
    && typeof d.sdp === 'string' && d.sdp.length < MAX_SDP;
}
function validCandidate(c) {
  return c && typeof c === 'object' && (c.candidate === undefined || (typeof c.candidate === 'string' && c.candidate.length < MAX_CANDIDATE))
    && (c.sdpMid === undefined || c.sdpMid === null || typeof c.sdpMid === 'string')
    && (c.sdpMLineIndex === undefined || c.sdpMLineIndex === null || Number.isInteger(c.sdpMLineIndex));
}
/** A media state is a few booleans (and an optional short label); anything else is dropped. */
export function cleanState(s) {
  if (!s || typeof s !== 'object') return null;
  const out = {};
  for (const key of ['audio', 'video', 'screen', 'hand']) if (typeof s[key] === 'boolean') out[key] = s[key];
  return out;
}

/** The peer with the lower id makes the offer; the other is "polite" and yields on collisions. */
export function isOfferer(selfId, peerId) {
  return String(selfId) < String(peerId);
}

export function call(room, {
  stream = null,
  kind = 'call',
  rtcConfig = DEFAULT_RTC,
  state = { audio: true, video: true },
  RTCPeerConnectionImpl = globalThis.RTCPeerConnection,
  MediaStreamImpl = globalThis.MediaStream,
} = {}) {
  if (typeof RTCPeerConnectionImpl !== 'function') throw new Error('p2p-core call: this browser has no WebRTC (RTCPeerConnection).');
  const links = new Map();               // peerId -> link
  const handlers = { stream: [], leave: [], state: [], connection: [] };
  const emit = (name, ...args) => { for (const fn of handlers[name]) { try { fn(...args); } catch (err) { console.error(err); } } };
  let local = stream;
  let mine = cleanState(state) || {};
  let ended = false;
  const offs = [];

  const trackOf = (kindName) => local?.getTracks().find((t) => t.kind === kindName) || null;
  const send = (data, to) => { if (!ended) room.send(kind, data, to); };

  function slots(link) {
    // One sender per kind: found through the transceiver's receiver, which always has a kind.
    const out = {};
    for (const t of link.pc.getTransceivers()) {
      const k = t.receiver?.track?.kind;
      if (k && !out[k]) out[k] = t;
    }
    return out;
  }
  async function attachTracks(link) {
    for (const [k, t] of Object.entries(slots(link))) {
      if (t.direction !== 'sendrecv') { try { t.direction = 'sendrecv'; } catch { /* stopped */ } }
      try { await t.sender.replaceTrack(trackOf(k)); } catch { /* closed link */ }
    }
  }

  function open(id) {
    if (links.has(id) || ended) return links.get(id);
    const pc = new RTCPeerConnectionImpl(rtcConfig);
    const link = { id, pc, polite: !isOfferer(room.selfId, id), makingOffer: false, ignoreOffer: false,
      remote: MediaStreamImpl ? new MediaStreamImpl() : null, announced: false, state: {} };
    links.set(id, link);
    pc.onicecandidate = ({ candidate }) => {
      if (candidate) send({ c: candidate.toJSON ? candidate.toJSON() : candidate }, id);
    };
    pc.ontrack = (event) => {
      if (link.remote && !link.remote.getTracks().includes(event.track)) link.remote.addTrack(event.track);
      const out = link.remote || event.streams?.[0];
      if (!link.announced && out) { link.announced = true; emit('stream', id, out); }
    };
    pc.onnegotiationneeded = async () => {
      try {
        link.makingOffer = true;
        await pc.setLocalDescription();
        send({ d: pc.localDescription.toJSON ? pc.localDescription.toJSON() : pc.localDescription }, id);
      } catch (err) {
        console.warn('p2p-core call: could not make an offer', err);
      } finally {
        link.makingOffer = false;
      }
    };
    pc.onconnectionstatechange = () => {
      emit('connection', id, pc.connectionState);
      if (pc.connectionState === 'failed' && !link.polite) {
        try { pc.restartIce(); } catch { /* old browser */ }
      }
    };
    if (!link.polite) {
      // The offerer creates both slots; the other side answers into them.
      pc.addTransceiver(trackOf('audio') || 'audio', { direction: 'sendrecv' });
      pc.addTransceiver(trackOf('video') || 'video', { direction: 'sendrecv' });
    }
    send({ s: mine }, id);
    return link;
  }

  function close(id) {
    const link = links.get(id);
    if (!link) return;
    links.delete(id);
    try { link.pc.close(); } catch { /* already */ }
    emit('leave', id);
  }

  async function onSignal(data, from) {
    if (ended || !data || typeof data !== 'object') return;
    if (data.bye === true) { close(from); return; }
    const link = open(from);
    if (!link) return;
    const { pc } = link;
    if ('s' in data) {
      const s = cleanState(data.s);
      if (s) { link.state = s; emit('state', from, s); }
    }
    if ('d' in data) {
      const d = data.d;
      if (!validDescription(d)) return;
      const collision = d.type === 'offer' && (link.makingOffer || pc.signalingState !== 'stable');
      link.ignoreOffer = !link.polite && collision;
      if (link.ignoreOffer) return;
      try {
        await pc.setRemoteDescription(d);
        if (d.type === 'offer') {
          await attachTracks(link);
          await pc.setLocalDescription();
          send({ d: pc.localDescription.toJSON ? pc.localDescription.toJSON() : pc.localDescription }, from);
        }
      } catch (err) {
        console.warn('p2p-core call: bad description from', from, err);
      }
    }
    if ('c' in data) {
      if (!validCandidate(data.c)) return;
      try { await pc.addIceCandidate(data.c); } catch (err) { if (!link.ignoreOffer) console.warn('p2p-core call: bad candidate', err); }
    }
  }

  offs.push(room.onMessage(kind, onSignal));
  offs.push(room.onPeerJoin((id) => open(id)));
  offs.push(room.onPeerLeave((id) => close(id)));
  for (const p of room.peers()) open(p.id);

  const api = {
    /** Swap the media everyone receives: another camera, the screen, or null for nothing. */
    async setStream(next) {
      local = next;
      await Promise.all([...links.values()].map(attachTracks));
    },
    /** Tell everyone your state: { audio, video, screen, hand } booleans. */
    setState(next) {
      mine = { ...mine, ...(cleanState(next) || {}) };
      send({ s: mine });
    },
    state: () => ({ ...mine }),
    peers: () => [...links.values()].map((l) => ({ id: l.id, stream: l.remote, state: { ...l.state }, connection: l.pc.connectionState })),
    onStream: (fn) => { handlers.stream.push(fn); return () => { handlers.stream = handlers.stream.filter((f) => f !== fn); }; },
    onLeave: (fn) => { handlers.leave.push(fn); return () => { handlers.leave = handlers.leave.filter((f) => f !== fn); }; },
    onState: (fn) => { handlers.state.push(fn); return () => { handlers.state = handlers.state.filter((f) => f !== fn); }; },
    onConnection: (fn) => { handlers.connection.push(fn); return () => { handlers.connection = handlers.connection.filter((f) => f !== fn); }; },
    /** Leave the call (the room stays joined unless you leave it too). */
    hangUp() {
      if (ended) return;
      send({ bye: true });
      ended = true;
      for (const off of offs) { try { off?.(); } catch { /* ignore */ } }
      for (const id of [...links.keys()]) close(id);
    },
  };
  return api;
}
