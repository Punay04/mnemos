import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const IMAGE = process.env.FALKORDB_IMAGE ?? "falkordb/falkordb:latest";

function runInherit(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      stdio: "inherit",
      shell: false,
    });
    child.on("error", (error) => {
      reject(
        new Error(
          error.code === "ENOENT"
            ? "Docker is required to install FalkorDB. Start Docker Desktop, then retry."
            : error.message
        )
      );
    });
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited ${code}`));
    });
  });
}

async function main() {
  console.log(`[falkordb] pulling ${IMAGE}`);
  await runInherit("docker", ["pull", IMAGE]);
  console.log("[falkordb] bootstrap finished. Next: npm run memory:start");
}

main().catch((error) => {
  console.error(`[falkordb] ${error instanceof Error ? error.message : error}`);
  process.exit(1);
});
