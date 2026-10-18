import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HOST = process.env.FALKORDB_HOST ?? "127.0.0.1";
const PORT = Number(process.env.FALKORDB_PORT ?? 6379);
const BROWSER_PORT = Number(process.env.FALKORDB_BROWSER_PORT ?? 3000);
const DATA_ROOT =
  process.env.FALKORDB_DATA_DIR ??
  path.join(os.homedir(), ".mnemos", "falkordb");
const IMAGE = process.env.FALKORDB_IMAGE ?? "falkordb/falkordb:latest";
const CONTAINER = process.env.FALKORDB_CONTAINER ?? "mnemos-falkordb";
const PASSWORD = process.env.FALKORDB_PASSWORD ?? "";

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });
    let out = "";
    child.stdout?.on("data", (chunk) => {
      out += chunk.toString();
    });
    child.stderr?.on("data", (chunk) => {
      out += chunk.toString();
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve(out.trim());
      else reject(new Error(out.trim() || `${command} exited ${code}`));
    });
  });
}

function pingRedis(timeoutMs = 1500) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: HOST, port: PORT });
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, timeoutMs);

    const finish = (ok) => {
      clearTimeout(timer);
      socket.destroy();
      resolve(ok);
    };

    socket.once("error", () => finish(false));
    socket.once("connect", () => {
      socket.write("*1\r\n$4\r\nPING\r\n");
    });
    socket.on("data", (chunk) => {
      const text = chunk.toString();
      // +PONG when open, -NOAUTH when a password is required. Either means FalkorDB is up.
      if (text.includes("PONG") || text.includes("NOAUTH")) finish(true);
    });
  });
}

async function waitForReady(attempts = 120) {
  for (let i = 0; i < attempts; i += 1) {
    if (await pingRedis()) return;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(
    `FalkorDB did not become ready at redis://${HOST}:${PORT}`
  );
}

async function containerState() {
  try {
    const state = await run("docker", [
      "inspect",
      "-f",
      "{{.State.Running}}",
      CONTAINER,
    ]);
    return state;
  } catch {
    return null;
  }
}

async function startDocker() {
  await run("docker", ["version"]);
  mkdirSync(DATA_ROOT, { recursive: true });

  const state = await containerState();
  if (state === "true") {
    console.log(`[falkordb] container ${CONTAINER} already running`);
    await waitForReady();
    return;
  }
  if (state === "false") {
    console.log(`[falkordb] starting existing container ${CONTAINER}`);
    await run("docker", ["start", CONTAINER]);
    await waitForReady();
    return;
  }

  console.log(`[falkordb] pulling ${IMAGE}`);
  await run("docker", ["pull", IMAGE]);

  const args = [
    "run",
    "-d",
    "--name",
    CONTAINER,
    "--restart",
    "unless-stopped",
    "-p",
    `${PORT}:6379`,
    "-p",
    `${BROWSER_PORT}:3000`,
    "-v",
    `${DATA_ROOT}:/var/lib/falkordb/data`,
  ];
  if (PASSWORD) {
    args.push("-e", `REDIS_ARGS=--requirepass ${PASSWORD}`);
  }
  args.push(IMAGE);

  await run("docker", args);
  await waitForReady();
}

async function main() {
  if (process.argv.includes("--status")) {
    const ok = await pingRedis();
    if (!ok) {
      console.error(`[falkordb] not reachable at redis://${HOST}:${PORT}`);
      process.exit(1);
    }
    console.log(`[falkordb] ready at redis://${HOST}:${PORT}`);
    return;
  }

  if (await pingRedis()) {
    console.log(`[falkordb] already running at redis://${HOST}:${PORT}`);
    console.log(`[falkordb] browser http://127.0.0.1:${BROWSER_PORT}`);
    return;
  }

  try {
    await startDocker();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      [
        message,
        "FalkorDB runs as the official Docker image.",
        "Start Docker Desktop, then retry: npm run memory:start",
        "Hackathon: https://www.wemakedevs.org/hackathons/falkordb",
        "Source: https://github.com/FalkorDB/FalkorDB",
      ].join("\n")
    );
  }

  console.log(`[falkordb] ready  redis://${HOST}:${PORT}`);
  console.log(`[falkordb] browser http://127.0.0.1:${BROWSER_PORT}`);
}

main().catch((error) => {
  console.error(`[falkordb] ${error instanceof Error ? error.message : error}`);
  process.exit(1);
});
