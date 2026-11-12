# p2p-core Cloudflare relay

One WebSocket endpoint for multiple [p2p-core](https://github.com/KakkoiDev/p2p-core) apps. Each app and room key maps to a separate Cloudflare Durable Object. The relay forwards messages between connected tabs, including browsers that have no WebRTC API. It keeps socket membership in WebSocket attachments so idle rooms can hibernate and leaves board storage to the clients.

## Deploy

The Worker and protocol in this directory are reusable. Use a Wrangler
configuration in your deployment repository to supply the Worker name,
allowed browser origins, and Durable Object binding. The Worker expects a
`ROOMS` binding to the exported `RelayRoom` class. Use a SQLite-backed
Durable Object to deploy on Workers Free within
[Cloudflare's limits](https://developers.cloudflare.com/durable-objects/platform/pricing/).

See the [deployment example](https://github.com/KakkoiDev/p2p-core-cloudflare)
for a Wrangler configuration and setup commands. Run the library's tests with
`node --test cloudflare/protocol.test.mjs` from the repository root.

## Connect an app

Use the current p2p-core client. Give each project a distinct `app` name and configure the same URL on every participant.

```js
const room = joinRoom({
  app: 'my-project',
  room: invite.room,
  password: invite.password,
  mode: 'online',
  server: { url: 'wss://p2p-core-cloudflare.YOUR-SUBDOMAIN.workers.dev', roomInUrl: true },
});
```

The client uses `/__p2p-core/ws` and includes its p2p-core room key in the upgrade URL so Cloudflare can route the socket. It then uses the regular p2p-core join and message frames. When WebRTC and the WebSocket relay are both available, p2p-core prefers the WebRTC route over the server.

Start a new room after deploying your app. Verify an edit in each direction
using two browsers or machines. To exercise the fallback, include a browser
where WebRTC is unavailable.

## Trust and limits

Use a relay operator you trust. WSS protects traffic to the Worker. The Worker can read the forwarded board messages, and anyone who obtains the room key can address the room. Give private rooms a strong random invite password. The origin allowlist restricts web pages in browsers. It is not client authentication and non-browser clients can forge Origin headers. The room key appears in the WebSocket request URL, so keep request URLs out of shared logs.

The Worker limits each room to 16 sockets, each message to 384 KiB, and each socket to 120 messages per second. Host your own relay and set the allowed origins to the projects you operate.

- [Cloudflare WebSocket Hibernation](https://developers.cloudflare.com/durable-objects/examples/websocket-hibernation-server/)
- [Cloudflare Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)
