import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { runWithShims } from "../../src/runner.js";

describe("shim runner", () => {
    it("intercepts tools launched by a child process", async () => {
        const home = await mkdtemp(join(tmpdir(), "agentiam-run-home-"));
        const bin = await mkdtemp(join(tmpdir(), "agentiam-run-bin-"));
        const agent = join(bin, "agent");
        const output = join(home, "args.txt");
        await mkdir(join(home, ".agentiam"));
        await writeFile(
            join(home, ".agentiam", "policy.yaml"),
            "allow:\n  git.commit: true\n",
        );
        await writeFile(
            join(bin, "git"),
            '#!/bin/sh\nprintf \'%s\\n\' "$@" > "$AGENTIAM_TEST_OUTPUT"\n',
        );
        await chmod(join(bin, "git"), 0o755);
        await writeFile(agent, "#!/bin/sh\ngit commit -m runner-test\n");
        await chmod(agent, 0o755);
        const result = await runWithShims(agent, [], {
            entrypoint: resolve("dist/index.js"),
            env: { HOME: home, PATH: `${bin}`, AGENTIAM_TEST_OUTPUT: output },
            cwd: home,
        });
        expect(result).toEqual({ code: 0, signal: null });
        expect(await readFile(output, "utf8")).toBe(
            "commit\n-m\nrunner-test\n",
        );
    });
});
