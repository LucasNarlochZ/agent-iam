import { main } from "./cli/cli.js";

main(process.argv.slice(2))
    .then((code) => {
        process.exitCode = code;
    })
    .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[agentiam] ERROR ${message}`);
        process.exitCode = 1;
    });
