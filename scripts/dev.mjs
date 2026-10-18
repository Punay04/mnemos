import { spawn } from "node:child_process";
import { platform } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const children = [];
const isWin = platform() === "win32";

// Node 22's bundled SQLite is built without FTS5, so the schema fails with a
// bare "no such module: fts5" that points at SQLite rather than the runtime.
// Fail here instead, where the cause is obvious.
const MIN_NODE_MAJOR = 24;
const nodeMajor = Number(process.versions.node.split(".")[0]);
if (nodeMajor < MIN_NODE_MAJOR) {
  console.error(
    `\n[dev] Mnemos needs Node ${MIN_NODE_MAJOR} or newer — this is Node ${process.versions.node}.\n` +
      `      Node 22 and older ship SQLite without FTS5 and the capture API will\n` +
      `      crash on startup with "no such module: fts5".\n\n` +
      `      With nvm:  nvm use 24    (the repo has an .nvmrc)\n`
  );
  process.exit(1);
}

function run(label, command, args, { fatal = false } = {}) {
  const child = spawn(command, args, {
    cwd: root,
    stdio: "inherit",
    shell: isWin,
    env: process.env,
  });

  children.push(child);

  child.on("exit", (code, signal) => {
    if (signal) return;
    if (code && code !== 0) {
      console.error(`[dev] ${label} exited with code ${code}`);
      if (fatal) shutdown(code ?? 1);
    }
  });

  return child;
}

function shutdown(exitCode = 0) {
  for (const child of children) {
    if (!child.killed) child.kill("SIGTERM");
  }
  process.exit(exitCode);
}

run("falkordb", "node", [path.join(root, "scripts", "falkordb-start.mjs")]);
run("backend", "npm", ["run", "backend:dev"], { fatal: true });

const app = run("app", "npx", ["vite"], { fatal: true });
app.on("exit", (code) => shutdown(code ?? 0));

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
