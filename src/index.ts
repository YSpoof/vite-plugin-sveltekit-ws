import fs, { existsSync } from "node:fs";
import path, { resolve } from "node:path";

import { build, type Plugin as EsbuildPlugin } from "esbuild";
import { type Plugin, type ResolvedConfig } from "vite";
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

type EnvVarDef = { name: string; public: boolean; static: boolean };

function firstExistingFile(candidates: string[]): string | null {
  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return candidate;
    }
  }
  return null;
}

function resolveExistingFile(basePath: string): string | null {
  const ext = path.extname(basePath);
  if (ext === ".js" || ext === ".mjs") {
    const stem = basePath.slice(0, -ext.length);
    return firstExistingFile([basePath, `${stem}.ts`, `${stem}.tsx`, `${stem}.mts`]);
  }

  return firstExistingFile([
    basePath,
    `${basePath}.ts`,
    `${basePath}.tsx`,
    `${basePath}.js`,
    path.join(basePath, "index.ts"),
    path.join(basePath, "index.js"),
  ]);
}

function envFilePath(projectRoot: string): string | null {
  return resolveExistingFile(path.join(projectRoot, "src/env"));
}

function parseEnvVars(projectRoot: string): EnvVarDef[] {
  const entry = envFilePath(projectRoot);
  if (!entry) return [];

  const source = fs.readFileSync(entry, "utf8");
  const vars: EnvVarDef[] = [];

  for (const match of source.matchAll(/^\s*([A-Za-z_][\w]*)\s*:\s*\{([^}]*)\}/gm)) {
    vars.push({
      name: match[1],
      public: /\bpublic\s*:\s*true\b/.test(match[2]),
      static: /\bstatic\s*:\s*true\b/.test(match[2]),
    });
  }

  return vars;
}

function envShimSource(
  kind: "private" | "public",
  projectRoot: string,
  vars: EnvVarDef[],
  dev: boolean,
): string {
  const mode = dev ? "development" : "production";
  const names = vars.filter((v) => (kind === "public") === v.public);

  const header = `
import fs from "node:fs";
import path from "node:path";
import { loadEnvFile } from "node:process";

let loaded = false;
function ensureEnvLoaded() {
  if (loaded) return;
  loaded = true;
  const root = ${JSON.stringify(projectRoot)};
  for (const file of ${JSON.stringify([`.env.${mode}.local`, `.env.${mode}`, ".env.local", ".env"])}) {
    const fullPath = path.join(root, file);
    if (!fs.existsSync(fullPath)) continue;
    loadEnvFile(fullPath);
  }
}
ensureEnvLoaded();
`;

  const exports = names
    .map((v) => {
      if (v.static) {
        const value = process.env[v.name];
        return `export const ${v.name} = ${value === undefined ? "undefined" : JSON.stringify(value)};`;
      }
      return `export const ${v.name} = process.env.${v.name};`;
    })
    .join("\n");

  return `${header}\n${exports}\n`;
}

function svelteKitEnvPlugin(projectRoot: string, dev: boolean): EsbuildPlugin {
  return {
    name: "sveltekit-env",
    setup(esbuild) {
      esbuild.onResolve({ filter: /^\$app\/env\/(private|public)$/ }, (args) => ({
        path: args.path,
        namespace: "sveltekit-env",
      }));

      esbuild.onLoad({ filter: /.*/, namespace: "sveltekit-env" }, (args) => {
        const kind = args.path.endsWith("private") ? "private" : "public";
        return {
          contents: envShimSource(kind, projectRoot, parseEnvVars(projectRoot), dev),
          loader: "js",
        };
      });
    },
  };
}

function svelteKitModulesPlugin(projectRoot: string): EsbuildPlugin {
  const libRoot = path.join(projectRoot, "src/lib");

  return {
    name: "sveltekit-modules",
    setup(esbuild) {
      esbuild.onResolve({ filter: /^#lib(\/|$)/ }, (args) => {
        const subpath = args.path === "#lib" ? "" : args.path.slice("#lib/".length);
        const resolved = resolveExistingFile(path.join(libRoot, subpath));
        if (!resolved) {
          return { errors: [{ text: `Could not resolve ${args.path}` }] };
        }
        return { path: resolved };
      });

      esbuild.onResolve({ filter: /^\.\.?\/.*\.js$/ }, (args) => {
        if (!args.resolveDir) return;
        const resolved = resolveExistingFile(path.join(args.resolveDir, args.path));
        if (resolved) return { path: resolved };
      });
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
      absoluteHandlerPath = resolve(config.root, handlerPath);
    },

    configureServer(server) {
      const wss = new WebSocketServer({ noServer: true });

      server.httpServer?.on("upgrade", async (req, socket, head) => {
        const pathname = req.url?.split("?")[0];
        if (pathname !== route) return;

        try {
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

        const safeHandlerPath = absoluteHandlerPath.replace(/\\/g, "/");
        const entryPath = path.join(absoluteOutDir, ".ws-server-entry.mjs");

        fs.writeFileSync(entryPath, generateServerEntry(safeHandlerPath));

        try {
          await build({
            entryPoints: [entryPath],
            outfile: path.join(absoluteOutDir, serverBuildName),
            bundle: true,
            platform: "node",
            format: "esm",
            target: "node22",
            packages: "external",
            external: ["node:*", "ws", "./handler.js"],
            plugins: [svelteKitEnvPlugin(config.root, false), svelteKitModulesPlugin(config.root)],
            logLevel: "silent",
          });
        } finally {
          fs.unlinkSync(entryPath);
        }
      },
    },
  };
}
