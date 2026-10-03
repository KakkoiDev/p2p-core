import { joinRoom, createTestNetwork } from '../p2p-core.js';

export const wait = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

/** Resolves when `check()` is truthy, or rejects after `ms`. */
export async function until(check, ms = 2000, what = 'condition') {
  const start = Date.now();
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what}`);
    await wait(5);
  }
}

/** n rooms on one test network. Leave them all with `done()`. */
export function testRooms(n, options = {}) {
  const network = createTestNetwork();
  const rooms = Array.from({ length: n }, (_, i) => joinRoom({
    app: 'test', network, ...(typeof options === 'function' ? options(i) : options),
  }));
  return { network, rooms, done: () => rooms.forEach((r) => r.leave()) };
}

/**
 * A fake trystero: joinRoom(config, roomId) rooms that reach each other in
 * memory, with trystero's single-handler onPeerJoin and its action shape.
 * `connect(a, b)` opens a link between two of them, as trystero does once
 * WebRTC is up.
 */
export function fakeTrystero() {
  const rooms = new Map();
  function forId(id) {
    return function joinRoomFake(config, roomId) {
      const actions = new Map();
      const room = {
        config, roomId, id,
        links: new Set(),
        onPeerJoin(fn) { room.join = fn; },
        onPeerLeave(fn) { room.part = fn; },
        onPeerStream() {},
        makeAction(name) {
          if (!actions.has(name)) actions.set(name, { handler: null });
          const action = actions.get(name);
          return [
            async (data, to) => {
              const targets = to == null ? [...room.links] : (Array.isArray(to) ? to : [to]);
              for (const peer of targets) {
                if (!room.links.has(peer)) continue;
                const other = rooms.get(peer);
                const copy = JSON.parse(JSON.stringify(data));
                setTimeout(() => other?.actions.get(name)?.handler?.(copy, id), 0);
              }
            },
            (fn) => { action.handler = fn; },
          ];
        },
        actions,
        leave() {
          for (const peer of room.links) { rooms.get(peer)?.links.delete(id); rooms.get(peer)?.part?.(id); }
          room.links.clear();
          rooms.delete(id);
        },
        getPeers: () => Object.fromEntries([...room.links].map((p) => [p, null])),
      };
      rooms.set(id, room);
      return room;
    };
  }
  return {
    rooms,
    joinRoom: forId,
    connect(a, b) {
      rooms.get(a).links.add(b);
      rooms.get(b).links.add(a);
      rooms.get(a).join?.(b);
      rooms.get(b).join?.(a);
    },
    disconnect(a, b) {
      rooms.get(a)?.links.delete(b);
      rooms.get(b)?.links.delete(a);
      rooms.get(a)?.part?.(b);
      rooms.get(b)?.part?.(a);
    },
  };
}
