import { spawn } from "node:child_process";
import { stripVTControlCharacters } from "node:util";

export function startTerminal(
    command: string[],
    options: { cwd: string; env: NodeJS.ProcessEnv },
) {
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    const child = spawn(
        "/usr/bin/script",
        [
            "--quiet",
            "--return",
            "--flush",
            "--command",
            `stty rows 50 cols 160 && exec ${command.map(quote).join(" ")}`,
            "/dev/null",
        ],
        { ...options, env: { ...options.env, TERM: "xterm-256color" } },
    );
    let output = "";
    let pendingQueries = "";
    let exited = false;
    let failure: Error | undefined;
    const listeners = new Set<() => void>();
    const notify = () => listeners.forEach((listener) => listener());
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
        output += chunk;
        pendingQueries += chunk;
        for (const [query, reply] of [
            ["\u001b[6n", "\u001b[1;1R"],
            ["\u001b[?u", "\u001b[?0u"],
            ["\u001b[c", "\u001b[?1;2c"],
            ["\u001b]10;?\u001b\\", "\u001b]10;rgb:ffff/ffff/ffff\u001b\\"],
            ["\u001b]11;?\u001b\\", "\u001b]11;rgb:0000/0000/0000\u001b\\"],
        ] as const) {
            while (pendingQueries.includes(query)) {
                pendingQueries = pendingQueries.replace(query, "");
                child.stdin.write(reply);
            }
        }
        pendingQueries = pendingQueries.slice(-64);
        notify();
    });
    child.stderr.on("data", (chunk) => {
        output += chunk.toString();
        notify();
    });
    const exit = new Promise<number | null>((resolve) => {
        child.once("error", (error) => {
            failure = error;
            exited = true;
            notify();
            resolve(null);
        });
        child.once("close", (code) => {
            exited = true;
            notify();
            resolve(code);
        });
    });
    child.stdin.on("error", (error) => {
        failure = error;
        notify();
    });
    const transcript = () => stripVTControlCharacters(output);
    return {
        write: (keys: string) => child.stdin.write(keys),
        output: transcript,
        async waitFor(text: string, timeout = 20_000) {
            await new Promise<void>((resolve, reject) => {
                let settled: ReturnType<typeof setTimeout> | undefined;
                const finish = (error?: Error) => {
                    clearTimeout(timer);
                    clearTimeout(settled);
                    listeners.delete(check);
                    if (error) reject(error);
                    else resolve();
                };
                const check = () => {
                    clearTimeout(settled);
                    if (failure) finish(failure);
                    else if (transcript().includes(text))
                        settled = setTimeout(() => finish(), 100);
                    else if (exited)
                        finish(
                            new Error(
                                `Terminal exited waiting for ${text}:\n${transcript().slice(-12_000)}`,
                            ),
                        );
                };
                const timer = setTimeout(
                    () =>
                        finish(
                            new Error(
                                `Terminal timed out waiting for ${text}:\n${transcript().slice(-12_000)}`,
                            ),
                        ),
                    timeout,
                );
                listeners.add(check);
                check();
            });
        },
        async close() {
            if (!exited) child.kill("SIGTERM");
            const timer = setTimeout(() => child.kill("SIGKILL"), 5_000);
            try {
                await exit;
            } finally {
                clearTimeout(timer);
            }
        },
    };
}
