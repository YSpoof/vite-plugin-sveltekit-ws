# Vite Plugin SvelteKit WebSocket

A small Vite plugin that adds WebSocket support to SvelteKit using [`ws`](https://www.npmjs.com/package/ws).

It works in both **development** and **production** with `adapter-node`.

## Installation

```bash
npm install ws
npm install -D vite-plugin-sveltekit-ws
```

## Usage

Create a WebSocket handler:

```ts
// src/lib/server/ws.ts
import type { IncomingMessage } from "node:http";
import type { WebSocket } from "ws";

export default function handler(ws: WebSocket, req: IncomingMessage) {
  ws.send("Connected!");

  ws.on("message", (message) => {
    console.log(message.toString());
  });
}
```

Add the plugin to `vite.config.ts`:

```ts
import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vite";
import { svelteKitWebSocket } from "vite-plugin-sveltekit-ws";

export default defineConfig({
  plugins: [
    sveltekit(),
    svelteKitWebSocket({
      handlerPath: "./src/lib/server/ws.ts",
    }),
  ],
});
```

The WebSocket endpoint is now:

```text
ws://0.0.0.0:5173/ws
```

## Options

```ts
svelteKitWebSocket({
  handlerPath: "./src/lib/server/ws.ts",
  exportName: "default",
  route: "/ws",
  outDir: "build",
  serverBuildName: "server.js",
});
```

| Option            | Default     | Description                    |
| ----------------- | ----------- | ------------------------------ |
| `handlerPath`     | —           | Path to your WebSocket handler |
| `exportName`      | `default`   | Export containing the handler  |
| `route`           | `/ws`       | WebSocket URL path             |
| `outDir`          | `build`     | SvelteKit output directory     |
| `serverBuildName` | `server.js` | Generated server filename      |

## Production

The plugin generates a server that combines the SvelteKit `adapter-node` server with the WebSocket server.

After building:

```bash
npm run build
node build/server.js
```

Set `PORT` to change the port:

```bash
PORT=8080 node build/server.js
```

That's it — the plugin provides the WebSocket upgrade handling while your handler manages the connections.

## Source Code

Since this plugin is MIT licensed, you can also contribute to it at it's repo on [GitHub](https://github.com/yspoof/vite-plugin-sveltekit-ws)
