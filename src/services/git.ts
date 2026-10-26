import { staticService } from "./static-service.js";

const gitActions = {
    add: ["branches"],
    am: [],
    apply: [],
    archive: [],
    bisect: [],
    blame: [],
    branch: [],
    "branch.create": [],
    bundle: [],
    checkout: [],
    "cherry-pick": [],
    clean: [],
    clone: [],
    commit: ["paths", "branches"],
    push: ["branches", "force"],
    remote: [],
    config: [],
    "symbolic-ref": [],
    status: [],
    log: [],
    diff: [],
    "rev-parse": [],
    describe: [],
    fetch: [],
    grep: [],
    init: [],
    "ls-files": [],
    "ls-remote": [],
    merge: [],
    mv: [],
    pull: [],
    rebase: [],
    reflog: [],
    reset: [],
    restore: [],
    revert: [],
    rm: [],
    show: [],
    stash: [],
    submodule: [],
    switch: [],
    tag: [],
    worktree: [],
} as const;

const actions: Record<string, readonly string[]> = Object.fromEntries(
    Object.entries(gitActions).map(([action, constraints]) => [
        action,
        [...new Set([...constraints, "force"])],
    ]),
);
for (const action of [
    "add",
    "list",
    "lock",
    "move",
    "prune",
    "remove",
    "repair",
    "unlock",
]) {
    actions[`worktree.${action}`] = ["force"];
}
for (const action of [
    "add",
    "rename",
    "remove",
    "set-head",
    "set-branches",
    "get-url",
    "set-url",
    "show",
    "prune",
    "update",
]) {
    actions[`remote.${action}`] = ["force"];
}

export const gitService = staticService("git", actions, {
    force: (capability) => {
        const force = capability.constraints?.force;
        return typeof force === "boolean"
            ? { values: [String(force)], label: `force ${force}` }
            : undefined;
    },
    paths: (capability) => {
        const paths = capability.constraints?.paths;
        return Array.isArray(paths) && paths.length > 0
            ? { values: paths, label: `paths ${paths.join(", ")}` }
            : undefined;
    },
    branches: (capability) => {
        const branches = capability.constraints?.branches;
        return Array.isArray(branches) && branches.length > 0
            ? { values: branches, label: `branch ${branches.join(", ")}` }
            : undefined;
    },
});
