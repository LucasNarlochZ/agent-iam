FROM node:24.21.0-bookworm@sha256:3d27e5c11e5786e309ec3e03f93ae536eb36e6e5eb3714d5eb3300a36157add0

RUN printf 'deb [check-valid-until=no] https://snapshot.debian.org/archive/debian/20260101T000000Z bookworm main\n' > /etc/apt/sources.list \
    && rm /etc/apt/sources.list.d/debian.sources \
    && apt-get update \
    && apt-get install -y --no-install-recommends zsh \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/harnesses
COPY tests/harnesses/package.json tests/harnesses/package-lock.json ./
RUN npm ci --no-audit --no-fund && npm cache clean --force

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund && npm cache clean --force

COPY tsconfig.json tsup.config.ts vitest.config.ts ./
COPY src ./src
COPY tests ./tests
COPY examples/policy.yaml ./examples/policy.yaml
RUN node --input-type=module -e 'import fs from "node:fs"; const versions = JSON.parse(fs.readFileSync("tests/harness-versions.json")); const { dependencies } = JSON.parse(fs.readFileSync("/opt/harnesses/package.json")); for (const tool of Object.values(versions)) { if (dependencies[tool.package] !== tool.version) throw new Error("Harness pins do not match tests/harness-versions.json"); }' \
    && npm run build

ENV PATH="/opt/harnesses/node_modules/.bin:${PATH}"
ENV OPENCODE_DISABLE_MODELS_FETCH=true
CMD ["node", "node_modules/vitest/vitest.mjs", "run"]
