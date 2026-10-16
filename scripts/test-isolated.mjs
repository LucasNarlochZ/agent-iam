import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const image = "agentiam-tests:local";

async function docker(args, label) {
    const started = Date.now();
    console.log(`${label}...`);
    const child = spawn("docker", args, { cwd: root, stdio: "inherit" });
    const progress = setInterval(() => {
        console.log(
            `${label}: ${Math.round((Date.now() - started) / 1000)}s elapsed`,
        );
    }, 20000);
    try {
        const code = await new Promise((resolve, reject) => {
            child.once("error", reject);
            child.once("exit", resolve);
        });
        if (code !== 0) process.exitCode = code ?? 1;
    } finally {
        clearInterval(progress);
    }
    if (process.exitCode) process.exit(process.exitCode);
}

await docker(
    ["build", "--file", "tests/Dockerfile", "--tag", image, "."],
    "Building isolated test image (first build downloads pinned dependencies)",
);
await docker(
    [
        "run",
        "--rm",
        "--network",
        "none",
        image,
        "node",
        "node_modules/vitest/vitest.mjs",
        "run",
        ...process.argv.slice(2),
    ],
    "Running isolated tests",
);
