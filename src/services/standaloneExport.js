// "Export as standalone app": one tenant as a self-hostable ZIP. It holds this server's code and the web app's
// source, the tenant's data (services/tenantData.js), and an edition file that turns the copy into a single-tenant
// install of that workspace (config/edition.js): no provider console, fixed modules, and a setup wizard that imports
// the data. Everything is generated from the running install, so the export always matches this version.
import fs from "node:fs";
import path from "node:path";
import { SERVER_ROOT } from "../config/store.js";
import { HttpError } from "../utils/http.js";
import { exportTenantData } from "./tenantData.js";
import { industryOf } from "./moduleCatalog.js";
import { parseFeatures } from "./tenants.js";
import { ZipWriter } from "./zipWriter.js";

const REPO_ROOT = path.resolve(SERVER_ROOT, "..");
/** The web app's source (next to the server folder; TASKFLOW_WEB_ROOT overrides, e.g. for a server copy in tests). */
const WEB_ROOT = process.env.TASKFLOW_WEB_ROOT ? path.resolve(SERVER_ROOT, process.env.TASKFLOW_WEB_ROOT) : path.join(REPO_ROOT, "web");

/** Never copied, at any depth. */
const SKIP_NAMES = new Set(["node_modules", ".git", ".env", ".DS_Store", "Thumbs.db", ".turbo", ".vercel", "coverage"]);
const skip = name => SKIP_NAMES.has(name) || name.startsWith(".next") || name.endsWith(".tsbuildinfo") || name.endsWith(".log") || name.startsWith(".env.") && name !== ".env.example";

/** Files under `dir` (recursive), as paths relative to `dir` with forward slashes. */
function walk(dir, prefix = "") {
  if (!fs.existsSync(dir)) return [];
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (skip(entry.name)) continue;
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...walk(path.join(dir, entry.name), relative));
    else if (entry.isFile()) files.push(relative);
  }
  return files;
}

/** The source files that make up the app: [archive path, absolute path]. */
function sourceFiles() {
  const list = [];
  const add = (root, archiveRoot, relative) => list.push([`${archiveRoot}/${relative}`, path.join(root, relative)]);
  for (const file of walk(path.join(SERVER_ROOT, "src"), "src")) add(SERVER_ROOT, "server", file);
  for (const file of ["package.json", "package-lock.json"]) if (fs.existsSync(path.join(SERVER_ROOT, file))) add(SERVER_ROOT, "server", file);
  if (!fs.existsSync(path.join(WEB_ROOT, "package.json")) || !fs.existsSync(path.join(WEB_ROOT, "src"))) {
    throw new HttpError(503, `The web app's source isn't next to this server (looked in ${WEB_ROOT}), so a standalone app can't be built here.`, { code: "WEB_SOURCE_MISSING" });
  }
  {
    for (const file of walk(path.join(WEB_ROOT, "src"), "src")) add(WEB_ROOT, "web", file);
    for (const file of walk(path.join(WEB_ROOT, "public"), "public")) add(WEB_ROOT, "web", file);
    for (const file of ["package.json", "package-lock.json", "next.config.ts", "tsconfig.json", "postcss.config.mjs", "eslint.config.mjs", "next-env.d.ts"]) {
      if (fs.existsSync(path.join(WEB_ROOT, file))) add(WEB_ROOT, "web", file);
    }
  }
  return list;
}

const readJson = file => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
};

/** "server 1.0.0, web 2.0.0" */
export function sourceVersion() {
  const server = readJson(path.join(SERVER_ROOT, "package.json"))?.version ?? "?";
  const web = readJson(path.join(WEB_ROOT, "package.json"))?.version ?? "?";
  return `server ${server}, web ${web}`;
}

export const standaloneFileName = slug => `${slug}-taskflow-standalone.zip`;

/**
 * Streams the standalone ZIP of one tenant to `output` (an Express response with its headers already set).
 * @param {import("knex").Knex} db
 * @param {Object} tenantRow - the tenants row
 * @returns {Promise<{ files: number, rows: number }>}
 */
export async function writeStandaloneZip(db, tenantRow, output) {
  const version = sourceVersion();
  const data = await exportTenantData(db, tenantRow.id, { sourceVersion: version });
  const industry = industryOf(tenantRow.industry);
  const edition = {
    mode: "standalone",
    slug: tenantRow.slug,
    name: tenantRow.name,
    features: parseFeatures(tenantRow.features),
    industry: industry.key,
    exportedAt: data.exportedAt,
    sourceVersion: version,
    schemaVersion: data.schemaVersion,
    dataFile: "../data/tenant-export.json",
  };
  const sources = sourceFiles(); // throws before anything is sent when the web source is missing
  const rows = Object.values(data.counts).reduce((sum, count) => sum + count, 0);
  const root = `${tenantRow.slug}-taskflow`;
  const zip = new ZipWriter(output);
  const now = new Date();

  const generated = generatedFiles({ edition, industryLabel: industry.label, counts: data.counts });
  for (const [name, content, options] of generated) await zip.addFile(`${root}/${name}`, content, { mtime: now, ...options });
  await zip.addFile(`${root}/server/edition.json`, `${JSON.stringify(edition, null, 2)}\n`, { mtime: now });
  await zip.addFile(`${root}/data/tenant-export.json`, JSON.stringify(data), { mtime: now });
  for (const [name, file] of sources) {
    const stat = fs.statSync(file);
    await zip.addFile(`${root}/${name}`, fs.readFileSync(file), { mtime: stat.mtime });
  }
  await zip.finish();
  return { files: generated.length + 2 + sources.length, rows };
}

/** Root scripts, Docker files, examples, and the README: [path, content, options]. */
function generatedFiles({ edition, industryLabel, counts }) {
  const { slug, name } = edition;
  const users = counts.users ?? 0;
  const packageJson = {
    name: `${slug}-taskflow`,
    private: true,
    description: `${name}: TaskFlow standalone edition (single workspace).`,
    scripts: {
      "install:all": "npm install && npm install --prefix server && npm install --prefix web",
      build: "npm run build --prefix web",
      start: 'concurrently -n api,web -c blue,magenta "npm start --prefix server" "npm start --prefix web"',
      dev: 'concurrently -n api,web -c blue,magenta "npm run dev --prefix server" "npm run dev --prefix web"',
    },
    devDependencies: { concurrently: "^10.0.5" },
    engines: { node: ">=22.13" },
  };

  const startBat = [
    "@echo off",
    "setlocal",
    `title ${name.replace(/[&|<>^%]/g, "")} (TaskFlow)`,
    'cd /d "%~dp0"',
    "",
    "where node >nul 2>nul",
    "if errorlevel 1 (",
    "    echo [ERROR] Node.js was not found. Install Node.js 22.13 or newer from https://nodejs.org and try again.",
    "    pause",
    "    exit /b 1",
    ")",
    "",
    'if not exist "web\\node_modules" (',
    "    echo Installing dependencies. This takes a few minutes the first time...",
    "    call npm run install:all || goto :fail",
    ")",
    'if not exist "web\\.next\\BUILD_ID" (',
    "    echo Building the web app...",
    "    call npm run build || goto :fail",
    ")",
    "",
    "echo Starting on http://localhost:3000 (close this window to stop)",
    'start "" cmd /c "timeout /t 8 /nobreak >nul && start http://localhost:3000"',
    "call npm start",
    "exit /b 0",
    "",
    ":fail",
    "echo [ERROR] Something went wrong. See the messages above.",
    "pause",
    "exit /b 1",
    "",
  ].join("\r\n");

  const startSh = [
    "#!/usr/bin/env sh",
    "# Installs (first run), builds (first run), and starts the API and the web app. Ctrl+C stops both.",
    "set -e",
    'cd "$(dirname "$0")"',
    "if ! command -v node >/dev/null 2>&1; then",
    '  echo "Node.js was not found. Install Node.js 22.13 or newer from https://nodejs.org and try again."',
    "  exit 1",
    "fi",
    'if [ ! -d web/node_modules ]; then echo "Installing dependencies..."; npm run install:all; fi',
    'if [ ! -f web/.next/BUILD_ID ]; then echo "Building the web app..."; npm run build; fi',
    'echo "Starting on http://localhost:3000 (Ctrl+C stops it)"',
    "exec npm start",
    "",
  ].join("\n");

  const rootEnv = [
    "# Used by docker-compose.yml. Copy to .env and change what you need.",
    "# Ports on this computer: the web app, and the API (the browser connects to the API's port for live updates).",
    "WEB_PORT=3000",
    "API_PORT=4000",
    "# The optional PostgreSQL service (docker compose --profile postgres up). In the setup wizard use host \"db\".",
    "POSTGRES_USER=taskflow",
    "POSTGRES_PASSWORD=change-me-please",
    "POSTGRES_DB=taskflow",
    "# Behind HTTPS on one domain (see README-STANDALONE.md), e.g. wss://tasks.example.com. Rebuild after changing it.",
    "NEXT_PUBLIC_WS_URL=",
    "",
  ].join("\n");

  const serverEnv = [
    "# Copy to .env in this folder (optional). The database is chosen in the setup wizard, not here.",
    "PORT=4000",
    "# production: sign-in cookies are sent over HTTPS only. Set it when the app is served over HTTPS.",
    "# NODE_ENV=production",
    "",
  ].join("\n");

  const webEnv = [
    "# Read when the web app is BUILT (npm run build): change them, then build again.",
    "# Where the web server forwards /api requests (the API's address as seen from the web server).",
    "TASKFLOW_API_ORIGIN=http://localhost:4000",
    "# The API's port as seen from the browser (live updates connect to it directly).",
    "NEXT_PUBLIC_API_PORT=4000",
    "# Or the full WebSocket address when a reverse proxy serves the API, e.g. wss://tasks.example.com",
    "# NEXT_PUBLIC_WS_URL=",
    "",
  ].join("\n");

  const apiDockerfile = [
    "# The API. Build context: the folder that contains this docker folder.",
    "FROM node:24-alpine",
    "WORKDIR /app/server",
    "COPY server/package.json server/package-lock.json ./",
    "RUN npm ci --omit=dev",
    "COPY server/ ./",
    "COPY data/ /app/data/",
    "ENV PORT=4000 NODE_ENV=production",
    "EXPOSE 4000",
    "# The setup result and the SQLite database live here: keep it on a volume.",
    "VOLUME /app/server/data",
    'CMD ["node", "src/index.js"]',
    "",
  ].join("\n");

  const webDockerfile = [
    "# The web app. /api requests are forwarded to TASKFLOW_API_ORIGIN, which is baked in when the app is built.",
    "FROM node:24-alpine",
    "WORKDIR /app/web",
    "COPY web/package.json web/package-lock.json ./",
    "RUN npm ci",
    "COPY web/ ./",
    "ARG TASKFLOW_API_ORIGIN=http://api:4000",
    "ARG NEXT_PUBLIC_API_PORT=4000",
    "ARG NEXT_PUBLIC_WS_URL=",
    "ENV TASKFLOW_API_ORIGIN=$TASKFLOW_API_ORIGIN NEXT_PUBLIC_API_PORT=$NEXT_PUBLIC_API_PORT NEXT_PUBLIC_WS_URL=$NEXT_PUBLIC_WS_URL NEXT_TELEMETRY_DISABLED=1",
    "RUN npm run build",
    "ENV NODE_ENV=production",
    "EXPOSE 3000",
    'CMD ["npx", "next", "start", "--port", "3000"]',
    "",
  ].join("\n");

  const compose = [
    `# ${name}: TaskFlow standalone. Start: docker compose up -d --build   (with PostgreSQL: docker compose --profile postgres up -d --build)`,
    "# Then open http://localhost:3000 and finish the setup wizard (it imports your data).",
    "services:",
    "  api:",
    "    build: { context: ., dockerfile: docker/api.Dockerfile }",
    "    restart: unless-stopped",
    "    ports: [\"${API_PORT:-4000}:4000\"]",
    "    volumes: [\"taskflow-data:/app/server/data\"]",
    "  web:",
    "    build:",
    "      context: .",
    "      dockerfile: docker/web.Dockerfile",
    "      args:",
    "        TASKFLOW_API_ORIGIN: http://api:4000",
    "        NEXT_PUBLIC_API_PORT: ${API_PORT:-4000}",
    "        NEXT_PUBLIC_WS_URL: ${NEXT_PUBLIC_WS_URL:-}",
    "    restart: unless-stopped",
    "    depends_on: [api]",
    "    ports: [\"${WEB_PORT:-3000}:3000\"]",
    "  db:",
    "    image: postgres:17-alpine",
    "    profiles: [postgres]",
    "    restart: unless-stopped",
    "    environment:",
    "      POSTGRES_USER: ${POSTGRES_USER:-taskflow}",
    "      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:-change-me-please}",
    "      POSTGRES_DB: ${POSTGRES_DB:-taskflow}",
    "    volumes: [\"taskflow-postgres:/var/lib/postgresql/data\"]",
    "volumes:",
    "  taskflow-data:",
    "  taskflow-postgres:",
    "",
  ].join("\n");

  const dockerignore = ["**/node_modules", "web/.next*", "server/data", "**/.env", "**/*.log", ""].join("\n");
  const gitignore = ["node_modules/", "web/.next*/", "server/data/", ".env", "*.log", "web/*.tsbuildinfo", ""].join("\n");

  return [
    ["package.json", `${JSON.stringify(packageJson, null, 2)}\n`],
    ["start.bat", startBat],
    ["start.sh", startSh, { executable: true }],
    [".env.example", rootEnv],
    ["server/.env.example", serverEnv],
    ["web/.env.example", webEnv],
    ["docker-compose.yml", compose],
    ["docker/api.Dockerfile", apiDockerfile],
    ["docker/web.Dockerfile", webDockerfile],
    [".dockerignore", dockerignore],
    [".gitignore", gitignore],
    ["README-STANDALONE.md", readme({ edition, industryLabel, users })],
  ];
}

function readme({ edition, industryLabel, users }) {
  const { slug, name, features, exportedAt, sourceVersion: version } = edition;
  return `# ${name} — TaskFlow standalone

This folder is a complete copy of the **${name}** workspace: the TaskFlow app (code) and all of its data, exported on
${exportedAt.slice(0, 10)} (${version}). You host it yourself. It runs only this one workspace:

- Address: \`/${slug}\` (sign in at \`/${slug}/login\`)
- Industry: ${industryLabel}
- Modules: ${features.join(", ")} (fixed in \`server/edition.json\`)
- People: ${users} account${users === 1 ? "" : "s"}. **Everyone keeps their password** and signs in exactly as before.

There is no provider console and no subscription: the app never expires or locks you out.

## What's inside

| Path | What it is |
| --- | --- |
| \`server/\` | The API (Node.js, Express). \`server/edition.json\` makes it a single-workspace install. |
| \`web/\` | The web app (Next.js). |
| \`data/tenant-export.json\` | Your data. The setup wizard imports it once. Keep it private: it contains every record and the password hashes. |
| \`start.bat\` / \`start.sh\` | One-click start for Windows / macOS and Linux. |
| \`docker-compose.yml\`, \`docker/\` | Run it with Docker instead (optional). |

## 1. Install Node.js

Install **Node.js 22.13 or newer** (the current LTS, 24, is recommended) from <https://nodejs.org>. The built-in SQLite
support it includes is what the app uses, so nothing else is needed for SQLite. Check it in a terminal:

\`\`\`bash
node --version
\`\`\`

## 2. Install, build, and start

Open a terminal in this folder and run:

\`\`\`bash
npm run install:all   # once: downloads the libraries (a few minutes)
npm run build         # once, and again after changing web settings
npm start             # starts the API (port 4000) and the web app (port 3000)
\`\`\`

On Windows you can double-click **start.bat** instead (it does all three). On macOS / Linux: \`sh start.sh\`.

## 3. Open the app and run the setup wizard

Open **http://localhost:3000** (from another computer: \`http://<this-computer's-address>:3000\`). The setup wizard opens:

1. **Choose the database.**
   - **SQLite**: one file on this computer (\`server/data/taskflow.db\` by default). Nothing to install. Good for small teams.
   - **PostgreSQL**: for larger teams. In pgAdmin (or your hosting panel) note the host, port (usually 5432), user, and
     password. Leave "Create the database if it doesn't exist" ticked, or create an **empty** database in pgAdmin first.
2. Click **Test connection**, then **Continue**.
3. **Import your data.** The wizard creates the tables and copies everything from \`data/tenant-export.json\` into the
   database. It refuses a database that already holds TaskFlow data, so nothing is ever overwritten.
4. You land on the sign-in page \`/${slug}/login\`. Sign in with your usual email and password.

The address \`/\` always goes straight to your workspace.

## Backups

- **SQLite:** stop the app and copy the \`server/data\` folder (the \`.db\` file plus any \`-wal\` / \`-shm\` files next to it).
  While it runs, make a consistent copy with:
  \`node -e "new (require('node:sqlite').DatabaseSync)('server/data/taskflow.db').exec(\\"VACUUM INTO 'backup.db'\\")"\`
- **PostgreSQL:** in pgAdmin right-click the database → **Backup…**, or \`pg_dump -Fc -f taskflow.backup <database>\`.
- Also keep \`server/data/config.json\` (the database settings and the sign-in secret).

To move to another database later: stop the app, run \`npm run setup:reset --prefix server\`, start it again, and the
wizard opens. Importing needs an empty database; your existing data is not copied automatically.

## Running behind HTTPS (recommended on a network)

Put a reverse proxy (nginx, Caddy, IIS, Traefik) in front:

- \`https://tasks.example.com/\` → \`http://127.0.0.1:3000\` (the web app; it forwards \`/api\` to the API itself)
- \`https://tasks.example.com/ws\` → \`http://127.0.0.1:4000/ws\` (live updates; enable WebSocket upgrade)

Then, because the web app's settings are **baked in when it is built**:

\`\`\`bash
# web/.env.production (or environment variables while building)
NEXT_PUBLIC_WS_URL=wss://tasks.example.com
\`\`\`

run \`npm run build\` again, set \`NODE_ENV=production\` for the API (in \`server/.env\`, so sign-in cookies are HTTPS-only),
and restart. Example for Caddy:

\`\`\`
tasks.example.com {
  reverse_proxy /ws* 127.0.0.1:4000
  reverse_proxy 127.0.0.1:3000
}
\`\`\`

Without a proxy, the browser connects to the API's port (4000) for live updates, so open ports 3000 and 4000 in the firewall.

## Docker (optional)

\`\`\`bash
cp .env.example .env                           # optional: ports, PostgreSQL password
docker compose up -d --build                   # SQLite (stored in the "taskflow-data" volume)
docker compose --profile postgres up -d --build  # with a PostgreSQL container: in the wizard use host "db"
\`\`\`

The web image is built with \`TASKFLOW_API_ORIGIN=http://api:4000\` (how the web container reaches the API) and
\`NEXT_PUBLIC_API_PORT\` (how browsers reach it). These are **baked in at build time**: after changing them, rebuild with
\`docker compose build web\`.

## Settings

| Where | Setting | Default |
| --- | --- | --- |
| \`server/.env\` | \`PORT\` (API port) | 4000 |
| \`server/.env\` | \`NODE_ENV=production\` (HTTPS-only cookies) | not set |
| \`web/.env.production\` | \`TASKFLOW_API_ORIGIN\` (API address seen from the web server), build time | http://localhost:4000 |
| \`web/.env.production\` | \`NEXT_PUBLIC_API_PORT\` / \`NEXT_PUBLIC_WS_URL\` (live updates), build time | 4000 |
| \`web/package.json\` | web port (\`next start --port 3000\`) | 3000 |

## Troubleshooting

- **"Can't reach the TaskFlow server"**: the API isn't running, or the web app was built with a different
  \`TASKFLOW_API_ORIGIN\`. Start both with \`npm start\`; rebuild after changing settings.
- **"This database already contains TaskFlow data"**: pick a new SQLite file name or an empty PostgreSQL database.
- **Live updates don't arrive**: port 4000 is blocked, or set \`NEXT_PUBLIC_WS_URL\` behind a proxy and rebuild.
`;
}
