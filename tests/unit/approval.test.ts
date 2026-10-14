import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import {
    persistApproval,
    requestApproval,
    selectWithArrowKeys,
} from "../../src/approval.js";
import { parsePolicy } from "../../src/policy/schema.js";

describe("interactive approval", () => {
    it("provides an interactive approval prompt", async () => {
        const approval = await import("../../src/approval.js");

        expect(approval.requestApproval).toBeTypeOf("function");
        expect(approval.selectWithArrowKeys).toBeTypeOf("function");
    });

    it("skips approval when no TTY is available", async () => {
        let selected = false;

        await expect(
            requestApproval(
                {
                    service: "git",
                    action: "push",
                    canonical: "git.push",
                    constraints: { branches: ["main"] },
                },
                {
                    isTTY: false,
                    select: async () => {
                        selected = true;
                        return "allow";
                    },
                },
            ),
        ).resolves.toBe("skip");
        expect(selected).toBe(false);
    });

    it("offers a context-specific allow when context is available", async () => {
        let message = "";

        await expect(
            requestApproval(
                {
                    service: "github",
                    action: "merge",
                    canonical: "github.pr.merge",
                    constraints: { repository: "owner/repo", pullRequest: 42 },
                },
                {
                    isTTY: true,
                    select: async (prompt, choices) => {
                        message = `${prompt}\n${choices
                            .map(({ label }) => label)
                            .join("\n")}`;
                        return choices[1]!.value;
                    },
                },
            ),
        ).resolves.toBe("allow-context");
        expect(message).toContain("github.pr.merge");
        expect(message).toContain("Allow for repository owner/repo");
        expect(message).toContain("Explicitly deny");
        expect(message).toContain("Skip");
    });

    it("omits context when unavailable", async () => {
        let labels: string[] = [];

        await expect(
            requestApproval(
                {
                    service: "git",
                    action: "status",
                    canonical: "git.status",
                },
                {
                    isTTY: true,
                    select: async (_prompt, choices) => {
                        labels = choices.map(({ label }) => label);
                        return choices[1]!.value;
                    },
                },
            ),
        ).resolves.toBe("deny");
        expect(labels).toEqual([
            "Allow this capability",
            "Explicitly deny",
            "Skip",
        ]);
    });

    it("selects an approval choice with arrow keys", async () => {
        const input = new PassThrough() as unknown as NodeJS.ReadStream;
        const output = new PassThrough();
        Object.defineProperty(input, "isRaw", {
            value: false,
            writable: true,
        });
        input.setRawMode = (mode) => {
            input.isRaw = mode;
            return input;
        };
        let rendered = "";
        output.on("data", (chunk) => {
            rendered += chunk.toString();
        });

        const selection = selectWithArrowKeys(
            "Choose",
            [
                { label: "Allow", value: "allow" },
                { label: "Deny", value: "deny" },
                { label: "Skip", value: "skip" },
            ],
            input,
            output,
        );
        input.write("\u001B[B\r");

        await expect(selection).resolves.toBe("deny");
        expect(input.isRaw).toBe(false);
        expect(rendered).toContain("❯ Allow");
        expect(rendered).toContain("❯ Deny");
    });

    it("adds a context to an existing constrained allow rule", async () => {
        const directory = await mkdtemp(join(tmpdir(), "agentiam-approval-"));
        const path = join(directory, "policy.yaml");
        const policy = {
            allow: {
                "github.pr.merge": { repos: ["owner/first"] },
            },
            deny: {},
        };
        await writeFile(path, "allow: {}\ndeny: {}\n");

        await persistApproval(
            path,
            policy,
            {
                service: "github",
                action: "merge",
                canonical: "github.pr.merge",
                constraints: { repository: "owner/second" },
            },
            "allow-context",
        );

        expect(parsePolicy(await readFile(path, "utf8"))).toEqual({
            allow: {
                "github.pr.merge": {
                    repos: ["owner/first", "owner/second"],
                },
            },
            deny: {},
        });
    });
});
