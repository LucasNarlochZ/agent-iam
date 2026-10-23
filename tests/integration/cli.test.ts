import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const exec = promisify(execFile);

describe("built CLI", () => {
    it("prints the package version from outside the project directory", async () => {
        const home = await mkdtemp(join(tmpdir(), "agentiam-cli-home-"));
        const { version } = JSON.parse(
            await readFile(resolve("package.json"), "utf8"),
        );

        const result = await exec(
            process.execPath,
            [resolve("dist/index.js"), "--version"],
            { cwd: home, env: { ...process.env, HOME: home } },
        );

        expect(result.stdout).toBe(`${version}\n`);
        expect(result.stderr).toBe("");
    });

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
            [cli, "inspect", "policy"],
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
        expect(allowed.stderr).toBe("");
        expect(await readFile(output, "utf8")).toBe("commit\n-m\ncli-test\n");
        await expect(
            exec(
                process.execPath,
                [cli, "run", "--", "sh", "-c", "gh pr merge 42"],
                execOptions,
            ),
        ).rejects.toMatchObject({ code: 126 });
        const logs = await exec(
            process.execPath,
            [cli, "inspect", "logs", "--tail", "1", "--json"],
            execOptions,
        );
        expect(JSON.parse(logs.stdout)).toMatchObject({
            decision: "DENY",
            reasonCode: "deny_rule",
            policyScope: "global",
            capability: { canonical: "github.pr.merge" },
        });
        const first = await exec(
            process.execPath,
            [cli, "inspect", "logs", "--head", "1"],
            execOptions,
        );
        expect(first.stdout).toContain("ALLOW git.commit");
        expect(first.stdout).toContain("matched global allow rule");
    }, 15_000);
});
