import { constants } from "node:fs";
import {
    mkdir,
    open,
    readdir,
    readFile,
    rename,
    rm,
    writeFile,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const maximumRequestBytes = 1_048_576;
const requestPattern = /^[0-9a-f-]{36}\.request\.json$/;

export async function startFileBroker(
    directory: string,
    handle: (input: string) => Promise<unknown>,
): Promise<{ close(): Promise<void> }> {
    await mkdir(directory, { mode: 0o700 });
    let stopped = false;
    const pending = (async () => {
        while (!stopped) {
            for (const name of await readdir(directory)) {
                if (!requestPattern.test(name)) continue;
                const requestPath = join(directory, name);
                const responsePath = requestPath.replace(
                    /\.request\.json$/,
                    ".response.json",
                );
                let response: { ok: boolean; value?: unknown; error?: string };
                try {
                    const file = await open(
                        requestPath,
                        constants.O_RDONLY |
                            constants.O_NOFOLLOW |
                            constants.O_NONBLOCK,
                    );
                    let input: string;
                    try {
                        const stat = await file.stat();
                        if (!stat.isFile() || stat.size > maximumRequestBytes) {
                            throw new Error("Invalid file broker request size");
                        }
                        input = await file.readFile("utf8");
                    } finally {
                        await file.close();
                    }
                    response = { ok: true, value: await handle(input) };
                } catch (error) {
                    response = {
                        ok: false,
                        error:
                            error instanceof Error
                                ? error.message
                                : String(error),
                    };
                }
                try {
                    const temporary = `${responsePath}.tmp`;
                    await writeFile(temporary, JSON.stringify(response), {
                        mode: 0o600,
                        flag: "wx",
                    });
                    await rename(temporary, responsePath);
                } finally {
                    await rm(requestPath, { force: true });
                }
            }
            if (!stopped) await delay(25);
        }
    })();
    void pending.catch(() => {});
    return {
        async close() {
            stopped = true;
            await pending;
        },
    };
}

export async function requestFileBroker(
    directory: string,
    payload: unknown,
    timeout: number,
): Promise<unknown> {
    const input = JSON.stringify(payload);
    if (input === undefined || Buffer.byteLength(input) > maximumRequestBytes) {
        throw new Error("Invalid file broker request size");
    }
    const id = randomUUID();
    const temporary = join(directory, `${id}.tmp`);
    const request = join(directory, `${id}.request.json`);
    const response = join(directory, `${id}.response.json`);
    try {
        await writeFile(temporary, input, { mode: 0o600, flag: "wx" });
        await rename(temporary, request);
        const deadline = Date.now() + timeout;
        while (Date.now() < deadline) {
            let result: { ok?: unknown; value?: unknown; error?: unknown };
            try {
                result = JSON.parse(await readFile(response, "utf8"));
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
                    throw error;
                }
                await delay(25);
                continue;
            }
            if (result?.ok === true) return result.value;
            throw new Error(
                typeof result?.error === "string"
                    ? result.error
                    : "Invalid file broker response",
            );
        }
        throw new Error("File broker acknowledgement timed out");
    } finally {
        await Promise.all(
            [temporary, request, response].map((path) =>
                rm(path, { force: true }),
            ),
        );
    }
}
