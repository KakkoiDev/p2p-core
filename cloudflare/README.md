# p2p-core Cloudflare relay

One WebSocket endpoint for multiple [p2p-core](https://github.com/KakkoiDev/p2p-core) apps. Each app and room key maps to a separate Cloudflare Durable Object. The relay forwards messages between connected tabs, including browsers that have no WebRTC API. It keeps socket membership in WebSocket attachments so idle rooms can hibernate and leaves board storage to the clients.

## Deploy

1. Create a Cloudflare account and enable Workers Free. Register a `workers.dev` subdomain if prompted.
2. Clone p2p-core and open the `cloudflare/` directory. In `wrangler.toml`, set `ALLOWED_ORIGINS` to the exact HTTPS origins of your apps, separated by commas. An origin has no trailing slash or path.
3. With Node.js 22 or newer, run the tests and deploy.

   ```sh
   node --test
   npx wrangler@4 login
   npx wrangler@4 deploy
   ```

4. Copy the deployed URL and change `https://` to `wss://`. Configure each app to use that endpoint. Add new app origins to the same configuration and redeploy the relay.

Workers Free supports SQLite-backed Durable Objects within [its free-tier limits](https://developers.cloudflare.com/durable-objects/platform/pricing/). The SQLite binding is required for the free plan. This relay does not write board data to SQLite.

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

For Mini Flow, set `liveRelayUrl` near the top of `mini-flow-live.js` in your deployment to the same WSS origin. Start a fresh session after deploying, then open the invite on another browser. Under **Live session**, check that **WebSocket relay** is ready and verify that edits travel in both directions. Use two browsers or machines to exercise the relay path. On Safari with WebRTC unavailable, no direct connection is expected.

## Trust and limits

Use a relay operator you trust. WSS protects traffic to the Worker. The Worker can read the forwarded board messages, and anyone who obtains the room key can address the room. Give private rooms a strong random invite password. The origin allowlist restricts web pages in browsers. It is not client authentication and non-browser clients can forge Origin headers. The room key appears in the WebSocket request URL, so keep request URLs out of shared logs.

The Worker limits each room to 16 sockets, each message to 384 KiB, and each socket to 120 messages per second. Host your own relay and set the allowed origins to the projects you operate.

- [Cloudflare WebSocket Hibernation](https://developers.cloudflare.com/durable-objects/examples/websocket-hibernation-server/)
- [Cloudflare Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)
