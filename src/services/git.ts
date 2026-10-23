import { staticService } from "./static-service.js";

const gitActions = {
    add: [],
    am: [],
    apply: [],
    archive: [],
    bisect: [],
    blame: [],
    branch: [],
    bundle: [],
    checkout: [],
    "cherry-pick": [],
    clean: [],
    clone: [],
    commit: ["paths"],
    push: ["branches"],
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

export const gitService = staticService("git", gitActions, {
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
