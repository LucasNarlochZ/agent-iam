import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

function quote(value: string): string {
    return `'${value.replaceAll("'", `'\\''`)}'`;
}

function zshStartupFile(
    filename: string,
    shellDirectory: string,
    shimDirectory: string,
    originalZdotdir: string,
): string {
    const initialize =
        filename === ".zshenv"
            ? `typeset -g _AGENTIAM_USER_ZDOTDIR=${quote(originalZdotdir)}\n`
            : "";
    return `${initialize}if [[ -f "$_AGENTIAM_USER_ZDOTDIR/${filename}" ]]; then
    source "$_AGENTIAM_USER_ZDOTDIR/${filename}"
fi
if [[ -n "$ZDOTDIR" && "$ZDOTDIR" != ${quote(shellDirectory)} ]]; then
    typeset -g _AGENTIAM_USER_ZDOTDIR="$ZDOTDIR"
fi
export ZDOTDIR=${quote(shellDirectory)}
export PATH=${quote(shimDirectory)}:"$PATH"
`;
}

function environmentFile(
    originalPath: string | undefined,
    shimDirectory: string,
): string {
    return `${
        originalPath
            ? `if [ -f ${quote(originalPath)} ]; then
    . ${quote(originalPath)}
fi
`
            : ""
    }export PATH=${quote(shimDirectory)}:"$PATH"
`;
}

export async function createShellEnvironment(
    directory: string,
    shimDirectory: string,
    env: NodeJS.ProcessEnv,
): Promise<NodeJS.ProcessEnv> {
    const shellDirectory = join(directory, "shell");
    await mkdir(shellDirectory, { mode: 0o700 });
    const originalZdotdir = env.ZDOTDIR ?? env.HOME ?? homedir();
    await Promise.all(
        [".zshenv", ".zprofile", ".zshrc", ".zlogin"].map((filename) =>
            writeFile(
                join(shellDirectory, filename),
                zshStartupFile(
                    filename,
                    shellDirectory,
                    shimDirectory,
                    originalZdotdir,
                ),
                { encoding: "utf8", mode: 0o600 },
            ),
        ),
    );
    const bashEnv = join(shellDirectory, "bash-env");
    const shEnv = join(shellDirectory, "sh-env");
    await Promise.all([
        writeFile(bashEnv, environmentFile(env.BASH_ENV, shimDirectory), {
            encoding: "utf8",
            mode: 0o600,
        }),
        writeFile(shEnv, environmentFile(env.ENV, shimDirectory), {
            encoding: "utf8",
            mode: 0o600,
        }),
    ]);
    return {
        ZDOTDIR: shellDirectory,
        BASH_ENV: bashEnv,
        ENV: shEnv,
    };
}
