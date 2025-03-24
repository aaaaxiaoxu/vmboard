import type http from "node:http";
import { vm as vmTable } from "@/db/schema/vm";
import { eq } from "drizzle-orm";
import { Client } from "ssh2";
import { WebSocketServer } from "ws";
import db from "@/db";
import { auth } from "@/lib/auth";
import { sshKeysTable } from "@/db/schema/ssh-key";

export const setupTerminalWebSocketServer = (
  server: http.Server<typeof http.IncomingMessage, typeof http.ServerResponse>,
) => {
  const wssTerm = new WebSocketServer({
    noServer: true,
    path: "/wss/terminal",
  });

  server.on("upgrade", (req, socket, head) => {
    const { pathname } = new URL(
      req.url ?? "/",
      `http://${req.headers.host ?? "localhost"}`,
    );
    if (pathname === "/_next/webpack-hmr") {
      return;
    }
    if (pathname === "/wss/terminal") {
      wssTerm.handleUpgrade(req, socket, head, function done(ws) {
        wssTerm.emit("connection", ws, req);
      });
    }
  });

  wssTerm.on("connection", async (ws, req) => {
    const url = new URL(
      req.url ?? "/",
      `http://${req.headers.host ?? "localhost"}`,
    );

    const session = await auth.api.getSession({
      headers: new Headers(req.headers as Record<string, string>),
    });

    if (!session) {
      ws.send("[ERROR] Unauthorized");
      ws.close();
      return;
    }

    const vmId = url.searchParams.get("vmId");
    // Get terminal size parameters
    const cols = Number.parseInt(url.searchParams.get("cols") ?? "80");
    const rows = Number.parseInt(url.searchParams.get("rows") ?? "30");

    if (!vmId) {
      ws.send("[ERROR] Invalid request");
      ws.close();
      return;
    }

    const vm = await db.query.vm.findFirst({
      where: eq(vmTable.id, Number(vmId)),
    });

    if (!vm) {
      ws.send("[ERROR] Server not found");
      ws.close();
      return;
    }

    if (!vm.sshInfo) {
      ws.send("[ERROR] No SSH key or password available for this server");
      ws.close();
      return;
    }

    const sshKey = vm.sshInfo.sshKeyId
      ? await db.query.sshKeysTable.findFirst({
          where: eq(sshKeysTable.id, vm.sshInfo.sshKeyId),
        })
      : null;

    const privateKey = sshKey?.privateKey ?? vm.sshInfo.privateKey;

    const conn = new Client();
    // const bufferSize = 1024 * 1024; // 1MB buffer
    // let stdout = "";
    // let stderr = "";

    // Set heartbeat to maintain connection
    const pingInterval = setInterval(() => {
      if (ws.readyState === ws.OPEN) {
        ws.ping();
      }
    }, 30000);

    ws.send("正在尝试连接服务器...\r");

    conn
      .once("ready", () => {
        conn.shell(
          {
            term: "xterm-256color",
            cols: cols,
            rows: rows,
            width: cols * 7, // Estimating character width
            height: rows * 14, // Estimate character height
          },
          (err, stream) => {
            if (err) {
              ws.send(`[ERROR] Shell error: ${err.message}`);
              ws.close();
              return;
            }
            const clearScreenCommand = "\x1b[2J";
            ws.send(clearScreenCommand);

            stream.setEncoding("utf8");

            stream
              .on("close", (code: number) => {
                clearInterval(pingInterval);
                ws.send(`\nConnection closed (${code})\n`);
                conn.end();
                ws.close();
              })
              .on("data", (data: string) => {
                // stdout += data.toString();
                // if (stdout.length > bufferSize) {
                //   stdout = stdout.slice(-bufferSize);
                // }
                ws.send(data.toString());
              })
              .stderr.on("data", (data) => {
                // stderr += data.toString();
                ws.send(data.toString());
                console.error("Error: ", data.toString());
              });

            ws.on("message", (message) => {
              try {
                let command: string | Buffer[] | Buffer | ArrayBuffer;
                if (Buffer.isBuffer(message)) {
                  command = message.toString("utf8");
                } else {
                  command = message;
                }
                try {
                  const data = JSON.parse(message.toString()) as {
                    type?: string;
                    rows?: number;
                    cols?: number;
                    data?: string;
                  };
                  if (data.type === "resize") {
                    if (
                      typeof data.rows === "number" &&
                      typeof data.cols === "number"
                    ) {
                      stream.setWindow(
                        data.rows,
                        data.cols,
                        data.cols * 7,
                        data.rows * 14,
                      );
                    }
                  } else {
                    stream.write(
                      typeof data.data === "string"
                        ? data.data
                        : message.toString(),
                    );
                  }
                } catch (error) {
                  // If JSON parsing fails, treat as plain command
                  if (error instanceof SyntaxError) {
                    stream.write(command.toString());
                  } else {
                    throw error; // Re-throw other errors
                  }
                }
              } catch (error) {
                const errorMessage =
                  error instanceof Error ? error.message : "Unknown error";
                ws.send(`[ERROR] ${errorMessage}`);
              }
            });

            ws.on("close", () => {
              clearInterval(pingInterval);
              console.log("close");
              stream.end();
              conn.end();
            });

            stream.on("error", (err: Error) => {
              console.error("Stream error:", err);
              ws.send(`[ERROR] Stream error: ${err.message}`);
            });
          },
        );
      })
      .on("error", (err) => {
        console.log("error", err);
        clearInterval(pingInterval);
        if (err.level === "client-authentication") {
          ws.send(
            `[ERROR] Authentication failed: Invalid SSH private key. ❌ Error: ${err.message} ${err.level}`,
          );
        } else {
          ws.send(`[ERROR] SSH connection error: ${err.message}`);
        }
        conn.end();
        ws.close();
      })
      .connect({
        timeout: 3000,
        keepaliveInterval: 10000,
        readyTimeout: 3000,
        ...vm.sshInfo,
        host: vm.sshInfo.host || vm.ipAddress || undefined,
        port: vm.sshInfo.port || 22,
        username: vm.sshInfo.username || "root",
        privateKey,
      });
  });
};
