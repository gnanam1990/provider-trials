import http from "node:http";
import { Db } from "./db.ts";
import { defaultConfig, makeCtx } from "./context.ts";
import { buildApi } from "./http/api.ts";

export interface RunningServer {
  server: http.Server;
  port: number;
  close: () => Promise<void>;
}

export function createServer(dbPath?: string, overrides: Partial<ReturnType<typeof defaultConfig>> = {}) {
  const config = { ...defaultConfig(), ...overrides };
  const db = Db.open(dbPath ?? process.env.PT_DB ?? "data/provider-trials.db");
  const ctx = makeCtx(db, config);
  const api = buildApi(ctx);
  const server = http.createServer((req, res) => {
    api.dispatch(req, res).catch(() => {
      if (!res.writableEnded) {
        res.writeHead(500).end();
      }
    });
  });
  return { server, ctx, db, config };
}

export async function listen(server: http.Server, port: number): Promise<number> {
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  return (server.address() as any).port;
}

// Direct execution: `node src/server.ts`
if (process.argv[1] && process.argv[1].endsWith("server.ts")) {
  const { server } = createServer();
  const port = Number(process.env.PT_PORT ?? 8787);
  server.listen(port, "127.0.0.1", () => {
    console.log(`provider-trials listening on http://127.0.0.1:${port}`);
  });
}
