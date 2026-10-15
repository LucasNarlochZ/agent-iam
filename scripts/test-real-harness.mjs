import { spawnSync } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import { delimiter, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const harness = process.argv[2];
const versions = JSON.parse(
    await readFile(join(root, "tests/harness-versions.json"), "utf8"),
);
const selected = harness === "all" ? Object.keys(versions) : [harness];

if (!selected.length || selected.some((name) => !versions[name])) {
    throw new Error(
        `Usage: node scripts/test-real-harness.mjs <${[...Object.keys(versions), "all"].join("|")}>`,
    );
}

if (process.platform === "win32") {
    throw new Error("Real harness integration tests currently require POSIX.");
}

const cache = resolve(
    process.env.AGENTIAM_HARNESS_CACHE ??
        join(root, ".cache/agentiam-harnesses"),
);
const bin = join(cache, "node_modules/.bin");

await mkdir(cache, { recursive: true });
const packages = selected.map(
    (name) => `${versions[name].package}@${versions[name].version}`,
);
const install = spawnSync(
    "npm",
    [
        "install",
        "--prefix",
        cache,
        "--no-save",
        "--package-lock=false",
        ...packages,
    ],
    { cwd: root, stdio: "inherit" },
);
if (install.error) throw install.error;
if (install.status !== 0) {
    process.exit(install.status ?? 1);
}

const build = spawnSync("npm", ["run", "build"], {
    cwd: root,
    stdio: "inherit",
});
if (build.error) throw build.error;
if (build.status !== 0) process.exit(build.status ?? 1);

const tests = selected.map((name) => `tests/integration/real-${name}.test.ts`);
const vitest = spawnSync(
    process.execPath,
    [join(root, "node_modules/vitest/vitest.mjs"), "run", ...tests],
    {
        cwd: root,
        env: {
            ...process.env,
            PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
        },
        stdio: "inherit",
    },
);
if (vitest.error) throw vitest.error;
process.exit(vitest.status ?? 1);
