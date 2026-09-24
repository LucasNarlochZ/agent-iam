import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const exec = promisify(execFile);

describe("built CLI", () => {
    it("initializes the user policy from the example", async () => {
        const home = await mkdtemp(join(tmpdir(), "agentiam-cli-home-"));
        const cli = resolve("dist/index.js");

        await exec(process.execPath, [cli, "init"], {
            env: { ...process.env, HOME: home },
            cwd: home,
        });

        await expect(
            readFile(join(home, ".agentiam", "policy.yaml"), "utf8"),
        ).resolves.toBe(
            await readFile(resolve("examples/policy.yaml"), "utf8"),
        );
    });

    it("inspects policy and runs allowed and denied commands", async () => {
        const home = await mkdtemp(join(tmpdir(), "agentiam-cli-home-"));
        const bin = await mkdtemp(join(tmpdir(), "agentiam-cli-bin-"));
        const output = join(home, "args.txt");
        await mkdir(join(home, ".agentiam"));
        await writeFile(
            join(home, ".agentiam", "policy.yaml"),
            "allow:\n  git.commit: true\ndeny:\n  github.pr.merge: true\n",
        );
        await writeFile(
            join(bin, "git"),
            '#!/bin/sh\nprintf \'%s\\n\' "$@" > "$AGENTIAM_TEST_OUTPUT"\n',
        );
        await writeFile(join(bin, "gh"), "#!/bin/sh\nexit 9\n");
        await chmod(join(bin, "git"), 0o755);
        await chmod(join(bin, "gh"), 0o755);
        const cli = resolve("dist/index.js");
        const env = {
            ...process.env,
            HOME: home,
            PATH: `${bin}:${process.env.PATH}`,
            AGENTIAM_TEST_OUTPUT: output,
        };
        const execOptions = { env, cwd: home };
        const inspected = await exec(
            process.execPath,
            [cli, "inspect"],
            execOptions,
        );
        expect(inspected.stdout).toContain("Default: DENY");
        expect(inspected.stdout).toContain("git.commit");
        const allowed = await exec(
            process.execPath,
            [cli, "run", "--", "sh", "-c", "git commit -m cli-test"],
            execOptions,
        );
        expect(allowed.stdout).toBe("");
        expect(await readFile(output, "utf8")).toBe("commit\n-m\ncli-test\n");
        await expect(
            exec(
                process.execPath,
                [cli, "run", "--", "sh", "-c", "gh pr merge 42"],
                execOptions,
            ),
        ).rejects.toMatchObject({ code: 126 });
    });
});
