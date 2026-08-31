import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { build, type Plugin, type ResolvedConfig } from "vite";
import { WebSocketServer } from "ws";

export interface SvelteKitWebSocketOptions {
  /**
   * Path to the file exporting the WebSocket handler (e.g., './src/lib/server/ws.ts').
   * Resolved relative to the project root.
   */
  handlerPath: string;
  /**
   * The exported name of the handler function (default: 'default')
   */
  exportName?: string;
  /**
   * The URL path to intercept for WebSocket connections (default: '/ws')
   */
  route?: string;
  /**
   * SvelteKit adapter-node output directory (default: 'build')
   */
  outDir?: string;
  /**
   * Name of the generated custom server file (default: 'server.js')
   */
  serverBuildName?: string;
}

/** Kit only calls set_env() from Server.init(). WS bundle never inits, so append the same call Kit uses in dev. */
function svelteKitEnvPlugin(): Plugin {
  return {
    name: "sveltekit-env",
    enforce: "pre",
    transform(code, id) {
      const file = id.split("?")[0].replaceAll("\\", "/");
      if (!file.includes("/.svelte-kit/generated/") || !file.endsWith("/env/config.js")) return;
      if (code.includes("set_env(nodeProcess.env)")) return;
      return `import nodeProcess from "node:process";\n${code}\nset_env(nodeProcess.env);\n`;
    },
  };
}

export function svelteKitWebSocket(options: SvelteKitWebSocketOptions): Plugin {
  const {
    handlerPath,
    exportName = "default",
    route = "/ws",
    outDir = "build",
    serverBuildName = "server.js",
  } = options;

  let config: ResolvedConfig;
  let absoluteHandlerPath: string;

  const virtualEntryId = "virtual:ws-server-entry";
  const resolvedVirtualEntryId = `\0${virtualEntryId}`;

  // Dynamically templates the server entry point
  const generateServerEntry = (safePath: string) => `
import process from "node:process";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { handler } from "./handler.js";
import { ${exportName} as wsHandler } from "${safePath}";

const port = Number(process.env.PORT) || 3000;

const httpServer = createServer(handler);
const wss = new WebSocketServer({ noServer: true });

httpServer.on("upgrade", (req, socket, head) => {
  const pathname = req.url?.split("?")[0];
  if (pathname !== "${route}") return;
  wss.handleUpgrade(req, socket, head, (ws) => {
    wsHandler(ws, req);
  });
});

httpServer.listen(port, () => {
  console.log(\`[SvelteKit WS] Server listening on http://0.0.0.0:\${port}\`);
});
`;

  return {
    name: "vite-plugin-sveltekit-ws",

    configResolved(resolvedConfig) {
      config = resolvedConfig;
      // Securely resolve the path from the user's project root
      absoluteHandlerPath = resolve(config.root, handlerPath);
    },

    configureServer(server) {
      const wss = new WebSocketServer({ noServer: true });

      server.httpServer?.on("upgrade", async (req, socket, head) => {
        const pathname = req.url?.split("?")[0];
        if (pathname !== route) return;

        try {
          // LIVE HMR: Dynamically load the handler on every request during dev.
          const mod = await server.ssrLoadModule(absoluteHandlerPath);
          const wsHandler = mod[exportName];

          if (!wsHandler) throw new Error(`Export '${exportName}' not found in ${handlerPath}`);

          wss.handleUpgrade(req, socket, head, (ws) => {
            wsHandler(ws, req);
          });
        } catch (err) {
          console.error("[vite-plugin-sveltekit-ws] Error handling WebSocket upgrade:", err);
          socket.destroy();
        }
      });
    },

    // Vite 8 Environment buildApp hook
    buildApp: {
      order: "post",
      async handler() {
        const absoluteOutDir = resolve(config.root, outDir);

        if (!existsSync(resolve(absoluteOutDir, "handler.js"))) {
          console.warn(
            "[vite-plugin-sveltekit-ws] handler.js not found. Make sure adapter-node is used.",
          );
          return;
        }

        // Normalize backslashes for Windows path stringification
        const safeHandlerPath = absoluteHandlerPath.replace(/\\\\/g, "/");

        // Fire a nested build for the server entry
        await build({
          configFile: false,
          root: config.root,
          resolve: {
            alias: config.resolve.alias,
          },
          plugins: [
            svelteKitEnvPlugin(),
            {
              name: "ws-server-entry",
              resolveId(id) {
                if (id === virtualEntryId) return resolvedVirtualEntryId;
                if (id === "./handler.js") return { id: "./handler.js", external: true };
              },
              load(id) {
                if (id === resolvedVirtualEntryId) {
                  return generateServerEntry(safeHandlerPath);
                }
              },
            },
          ],
          build: {
            emptyOutDir: false,
            outDir: absoluteOutDir,
            ssr: true,
            target: "node20",
            minify: false,
            write: true,
            rolldownOptions: {
              input: virtualEntryId,
              output: {
                entryFileNames: serverBuildName,
                format: "es",
              },
              external: (id: string) => id === "ws" || id.startsWith("node:"),
            },
          },
          logLevel: "warn",
        });
      },
    },
  };
}
