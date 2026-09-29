// src/index.ts
import os2 from "os";
import path2 from "path";
import fs2 from "fs";
import { createRequire as createRequire2 } from "module";

// src/client.ts
import { execFile, exec } from "child_process";
import { promisify } from "util";
import path from "path";
import os from "os";
import fs from "fs";
import { createRequire } from "module";
var require2 = createRequire(import.meta.url);
var execAsync = promisify(exec);
function getDatabaseConstructor() {
  try {
    return require2("better-sqlite3");
  } catch {
    try {
      const parentPaths = [
        path.join(process.cwd(), "node_modules/better-sqlite3"),
        path.join(os.homedir(), "Library/Application Support/openfox-dev/node_modules/better-sqlite3"),
        "/Users/Renaud.Lefevre/Documents/Dev/Perso/openfox/node_modules/better-sqlite3"
      ];
      for (const p of parentPaths) {
        try {
          if (fs.existsSync(p)) return require2(p);
        } catch {
        }
      }
    } catch {
    }
  }
  return null;
}
var execFileAsync = promisify(execFile);
var CodebaseMemoryClient = class {
  command;
  uiPort;
  constructor(command = "codebase-memory-mcp", uiPort = 9749) {
    this.command = command;
    this.uiPort = uiPort;
  }
  setCommand(cmd) {
    if (cmd && cmd.trim()) {
      this.command = cmd.trim();
    }
  }
  setUiPort(port) {
    if (port && port > 0) {
      this.uiPort = port;
    }
  }
  getUiUrl(projectName) {
    const base = `http://localhost:${this.uiPort}`;
    if (projectName) {
      return `${base}/?project=${encodeURIComponent(projectName)}`;
    }
    return base;
  }
  async runCli(tool, args = {}) {
    const argsJson = JSON.stringify(args);
    let stdoutData = "";
    try {
      const res = await execFileAsync(this.command, ["cli", tool, argsJson, "--json"], { timeout: 6e4 });
      stdoutData = res.stdout;
    } catch (err) {
      if (err.stdout) {
        stdoutData = err.stdout;
      } else {
        throw err;
      }
    }
    try {
      const parsed = JSON.parse(stdoutData);
      if (parsed.isError) {
        const msg = parsed.structuredContent?.hint || parsed.structuredContent?.error || parsed.content && parsed.content[0]?.text || "Tool execution failed";
        throw new Error(msg);
      }
      if (parsed.structuredContent) {
        if (parsed.structuredContent.status === "error") {
          throw new Error(parsed.structuredContent.hint || parsed.structuredContent.error || "Operation failed");
        }
        return parsed.structuredContent;
      }
      if (parsed.content && Array.isArray(parsed.content)) {
        const textContent = parsed.content.find((c) => c.type === "text")?.text || "";
        try {
          const innerParsed = JSON.parse(textContent);
          if (innerParsed.status === "error") {
            throw new Error(innerParsed.hint || innerParsed.error || "Operation failed");
          }
          return innerParsed;
        } catch (jsonErr) {
          if (jsonErr.message && !jsonErr.message.includes("JSON")) {
            throw jsonErr;
          }
          return textContent;
        }
      }
      return parsed;
    } catch (parseErr) {
      if (parseErr.message && !parseErr.message.includes("JSON")) {
        throw parseErr;
      }
      return stdoutData;
    }
  }
  async listProjectsFromSqlite() {
    const home = os.homedir();
    const possibleCacheDirs = [
      path.join(home, ".cache/codebase-memory-mcp"),
      path.join(home, "Library/Caches/codebase-memory-mcp"),
      path.join(home, ".local/share/codebase-memory")
    ];
    try {
      const DatabaseConstructor = getDatabaseConstructor();
      if (typeof DatabaseConstructor === "function") {
        for (const dir of possibleCacheDirs) {
          if (fs.existsSync(dir)) {
            const files = fs.readdirSync(dir);
            const projects = [];
            for (const f of files) {
              if (f.endsWith(".db") && !f.startsWith("_")) {
                try {
                  const db = new DatabaseConstructor(path.join(dir, f), { readonly: true });
                  const rows = db.prepare("SELECT name, root_path, indexed_at FROM projects WHERE root_path IS NOT NULL AND root_path != ''").all();
                  for (const r of rows) {
                    projects.push({
                      name: r.name,
                      rootPath: r.root_path,
                      indexedAt: r.indexed_at
                    });
                  }
                  db.close();
                } catch {
                }
              }
            }
            if (projects.length > 0) return projects;
          }
        }
      }
    } catch {
    }
    return [];
  }
  async listProjects(withStatus = true) {
    try {
      const fastProjects = await this.listProjectsFromSqlite();
      if (fastProjects.length > 0) {
        return fastProjects;
      }
    } catch {
    }
    try {
      const res = await this.runCli("list_projects", {});
      let projects = [];
      if (typeof res === "string") {
        projects = this.parseListProjectsText(res);
      } else if (Array.isArray(res)) {
        projects = res;
      } else if (res && Array.isArray(res.projects)) {
        projects = res.projects;
      }
      if (withStatus && projects.length > 0) {
        await Promise.allSettled(
          projects.map(async (p) => {
            try {
              const statusData = await this.getIndexStatus(p.name);
              if (statusData) {
                if (typeof statusData === "string") {
                  const dateMatch = statusData.match(/indexed_at:\s*([^\n\r]+)/);
                  if (dateMatch && dateMatch[1]) p.indexedAt = dateMatch[1].trim();
                  const nodesMatch = statusData.match(/nodes:\s*(\d+)/);
                  if (nodesMatch && nodesMatch[1]) p.nodes = parseInt(nodesMatch[1], 10);
                  const edgesMatch = statusData.match(/edges:\s*(\d+)/);
                  if (edgesMatch && edgesMatch[1]) p.edges = parseInt(edgesMatch[1], 10);
                } else if (typeof statusData === "object") {
                  if (statusData.indexed_at) p.indexedAt = statusData.indexed_at;
                  if (statusData.indexedAt) p.indexedAt = statusData.indexedAt;
                  if (statusData.nodes) p.nodes = statusData.nodes;
                  if (statusData.edges) p.edges = statusData.edges;
                }
              }
            } catch {
            }
          })
        );
      }
      return projects;
    } catch {
      return [];
    }
  }
  parseListProjectsText(text) {
    const projects = [];
    const lines = text.split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("projects:") || trimmed.startsWith("total:") || trimmed.startsWith("returned:") || trimmed.startsWith("has_more:")) {
        continue;
      }
      const parts = trimmed.split(/\s+/);
      if (parts.length >= 2) {
        projects.push({
          name: parts[0],
          rootPath: parts[1],
          branch: parts[2]
        });
      }
    }
    return projects;
  }
  async isProjectIndexed(workdir, projectName) {
    if (!workdir && !projectName) return { indexed: false };
    const normalizedWorkdir = workdir ? workdir.replace(/\/+$/, "").toLowerCase() : "";
    const folderName = workdir ? workdir.replace(/\/+$/, "").split("/").pop()?.toLowerCase() : "";
    const targetProjectName = projectName ? projectName.toLowerCase() : "";
    const projects = await this.listProjects(false);
    const found = projects.find((p) => {
      const pNorm = p.rootPath ? p.rootPath.replace(/\/+$/, "").toLowerCase() : "";
      const pFolder = p.rootPath ? p.rootPath.replace(/\/+$/, "").split("/").pop()?.toLowerCase() : "";
      const pName = p.name ? p.name.toLowerCase() : "";
      if (normalizedWorkdir && pNorm && pNorm === normalizedWorkdir) return true;
      if (normalizedWorkdir && p.rootPath) {
        try {
          if (path.resolve(p.rootPath) === path.resolve(workdir)) return true;
        } catch {
        }
      }
      if (targetProjectName && pName && (pName === targetProjectName || pName.endsWith(`-${targetProjectName}`))) {
        return true;
      }
      if (targetProjectName && pFolder && pFolder === targetProjectName) {
        return true;
      }
      if (folderName && pFolder && folderName === pFolder) {
        return true;
      }
      if (folderName && pName && (pName === folderName || pName.endsWith(`-${folderName}`))) {
        return true;
      }
      return false;
    });
    if (found) {
      return { indexed: true, project: found };
    }
    return { indexed: false };
  }
  async indexRepository(repoPath, name, mode = "fast") {
    try {
      const args = { repo_path: repoPath, mode };
      if (name) {
        args["name"] = name;
      }
      const res = await this.runCli("index_repository", args);
      if (res && (res.status === "error" || res.isError)) {
        return { success: false, error: res.hint || res.error || "Indexing failed" };
      }
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message || String(err) };
    }
  }
  async deleteProject(projectName) {
    try {
      await this.runCli("delete_project", { project: projectName });
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message || String(err) };
    }
  }
  async getIndexStatus(projectName) {
    try {
      const res = await this.runCli("index_status", { project: projectName });
      return res;
    } catch (err) {
      return { error: err.message || String(err) };
    }
  }
  async checkInstallation() {
    const isWindows = process.platform === "win32";
    const commandToTest = this.command || "codebase-memory-mcp";
    try {
      const { stdout } = await execFileAsync(commandToTest, ["--version"], { timeout: 5e3 });
      const versionMatch = stdout.match(/codebase-memory-mcp\s+([^\s\n\r]+)/i) || stdout.match(/([0-9]+\.[0-9]+\.[0-9]+[^\s\n\r]*)/);
      const version = versionMatch ? versionMatch[1] : stdout.trim();
      return {
        installed: true,
        version: version || void 0,
        path: commandToTest
      };
    } catch {
    }
    const home = os.homedir();
    const candidatePaths = isWindows ? [
      path.join(home, "AppData", "Local", "Programs", "codebase-memory-mcp", "codebase-memory-mcp.exe"),
      path.join(home, ".local", "bin", "codebase-memory-mcp.exe"),
      path.join(home, "bin", "codebase-memory-mcp.exe")
    ] : [
      path.join(home, ".local", "bin", "codebase-memory-mcp"),
      path.join(home, "bin", "codebase-memory-mcp"),
      "/usr/local/bin/codebase-memory-mcp",
      "/opt/homebrew/bin/codebase-memory-mcp",
      "/usr/bin/codebase-memory-mcp"
    ];
    for (const binPath of candidatePaths) {
      try {
        if (fs.existsSync(binPath)) {
          const { stdout } = await execFileAsync(binPath, ["--version"], { timeout: 5e3 });
          const versionMatch = stdout.match(/codebase-memory-mcp\s+([^\s\n\r]+)/i) || stdout.match(/([0-9]+\.[0-9]+\.[0-9]+[^\s\n\r]*)/);
          const version = versionMatch ? versionMatch[1] : stdout.trim();
          this.setCommand(binPath);
          return {
            installed: true,
            version: version || void 0,
            path: binPath
          };
        }
      } catch {
      }
    }
    try {
      const { stdout } = await execFileAsync(isWindows ? "where" : "which", [commandToTest], {
        timeout: 5e3
      });
      const resolvedPath = stdout.split("\n")[0]?.trim();
      if (resolvedPath && fs.existsSync(resolvedPath)) {
        return {
          installed: true,
          path: resolvedPath
        };
      }
    } catch {
    }
    return {
      installed: false
    };
  }
  async installCodebaseMemory() {
    const isWindows = process.platform === "win32";
    try {
      let stdout = "";
      let stderr = "";
      if (isWindows) {
        const psCmd = `powershell -ExecutionPolicy Bypass -Command "Invoke-WebRequest -Uri https://raw.githubusercontent.com/DeusData/codebase-memory-mcp/main/install.ps1 -OutFile install.ps1; Unblock-File .\\install.ps1; .\\install.ps1"`;
        const res = await execAsync(psCmd, { timeout: 18e4 });
        stdout = res.stdout;
        stderr = res.stderr;
      } else {
        const bashCmd = `curl -fsSL https://raw.githubusercontent.com/DeusData/codebase-memory-mcp/main/install.sh | bash`;
        const res = await execAsync(bashCmd, { timeout: 18e4 });
        stdout = res.stdout;
        stderr = res.stderr;
      }
      return { success: true, output: stdout || stderr };
    } catch (err) {
      return { success: false, error: err.message || String(err) };
    }
  }
};

// src/index.ts
var require3 = createRequire2(import.meta.url);
function getHostDatabaseConstructor() {
  try {
    return require3("better-sqlite3");
  } catch {
    try {
      const parentPaths = [
        path2.join(process.cwd(), "node_modules/better-sqlite3"),
        path2.join(os2.homedir(), "Library/Application Support/openfox-dev/node_modules/better-sqlite3"),
        "/Users/Renaud.Lefevre/Documents/Dev/Perso/openfox/node_modules/better-sqlite3"
      ];
      for (const p of parentPaths) {
        try {
          if (fs2.existsSync(p)) return require3(p);
        } catch {
        }
      }
    } catch {
    }
  }
  return null;
}
var SPINNER_ICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>';
var LOADING_LABEL = {
  en: "Loading Codebase Memory projects...",
  fr: "Chargement des projets Codebase Memory..."
};
var client = new CodebaseMemoryClient();
var autoIndexOverride = null;
var cachedProjects = [];
var cachedIndexedStatus = /* @__PURE__ */ new Map();
var activeWorkdirContext;
var activeProjectNameContext;
function getClient() {
  return client;
}
async function fetchOpenFoxProjects(contextConfigDir) {
  const discovered = /* @__PURE__ */ new Map();
  const addProjects = (rows) => {
    for (const r of rows) {
      if (r && r.workdir && typeof r.workdir === "string") {
        let actualWorkdir = r.workdir;
        if (!fs2.existsSync(actualWorkdir) && r.name) {
          const candidate = path2.join(home, "Documents/Dev/Perso", r.name);
          if (fs2.existsSync(candidate)) {
            actualWorkdir = candidate;
          }
        }
        const norm = actualWorkdir.replace(/\/+$/, "");
        if (norm && !discovered.has(norm)) {
          const name = r.name || norm.split("/").pop() || norm;
          const id = r.id || norm;
          discovered.set(norm, { id, name, workdir: actualWorkdir });
        }
      }
    }
  };
  const home = os2.homedir();
  const dbPaths = [
    ...contextConfigDir ? [path2.join(contextConfigDir, "sessions.db"), path2.join(path2.dirname(contextConfigDir), "sessions.db")] : [],
    path2.join(home, "Library/Application Support/openfox-dev/sessions.db"),
    path2.join(home, "Library/Application Support/openfox/sessions.db"),
    path2.join(home, ".local/share/openfox-dev/sessions.db"),
    path2.join(home, ".local/share/openfox/sessions.db"),
    path2.join(home, ".config/openfox-dev/sessions.db"),
    path2.join(home, ".config/openfox/sessions.db")
  ];
  if (process.env["LOCALAPPDATA"]) {
    dbPaths.push(
      path2.join(process.env["LOCALAPPDATA"], "openfox-dev/sessions.db"),
      path2.join(process.env["LOCALAPPDATA"], "openfox/sessions.db")
    );
  }
  if (process.env["APPDATA"]) {
    dbPaths.push(
      path2.join(process.env["APPDATA"], "openfox-dev/sessions.db"),
      path2.join(process.env["APPDATA"], "openfox/sessions.db")
    );
  }
  try {
    const DatabaseConstructor = getHostDatabaseConstructor();
    if (typeof DatabaseConstructor === "function") {
      for (const dbPath of dbPaths) {
        if (fs2.existsSync(dbPath)) {
          try {
            const db = new DatabaseConstructor(dbPath, { readonly: true });
            const rows = db.prepare("SELECT id, name, workdir FROM projects ORDER BY updated_at DESC").all();
            db.close();
            if (Array.isArray(rows)) {
              addProjects(rows);
            }
          } catch {
          }
        }
      }
    }
  } catch {
  }
  if (discovered.size === 0) {
    const candidatePorts = [10469, 10369];
    const hosts = ["127.0.0.1", "localhost"];
    for (const p of candidatePorts) {
      for (const h of hosts) {
        try {
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 300);
          const res = await fetch(`http://${h}:${p}/api/projects`, { signal: controller.signal });
          clearTimeout(timeoutId);
          if (res.ok) {
            const data = await res.json();
            if (Array.isArray(data.projects)) {
              addProjects(data.projects);
            }
          }
        } catch {
        }
      }
    }
  }
  return Array.from(discovered.values());
}
async function resolveProjectContext(params) {
  let rawWorkdir = typeof params?.["workdir"] === "string" && params["workdir"] ? params["workdir"] : void 0;
  let projectName = typeof params?.["projectName"] === "string" && params["projectName"] ? params["projectName"] : void 0;
  const projectId = typeof params?.["projectId"] === "string" && params["projectId"] ? params["projectId"] : void 0;
  const sessionId = typeof params?.["sessionId"] === "string" && params["sessionId"] ? params["sessionId"] : void 0;
  if ((!rawWorkdir || !projectName) && sessionId) {
    try {
      const res = await fetch(`http://localhost:10469/api/sessions/${encodeURIComponent(sessionId)}`);
      if (res.ok) {
        const data = await res.json();
        if (data.session?.workdir && !rawWorkdir) {
          rawWorkdir = data.session.workdir;
        }
        if (data.session?.projectId && !projectId) {
          const pRes = await fetch(`http://localhost:10469/api/projects/${encodeURIComponent(data.session.projectId)}`);
          if (pRes.ok) {
            const pData = await pRes.json();
            if (pData.project) {
              if (!rawWorkdir && pData.project.workdir) rawWorkdir = pData.project.workdir;
              if (!projectName && pData.project.name) projectName = pData.project.name;
            }
          }
        }
      }
    } catch {
    }
  }
  if ((!rawWorkdir || !projectName) && projectId) {
    try {
      const res = await fetch(`http://localhost:10469/api/projects/${encodeURIComponent(projectId)}`);
      if (res.ok) {
        const data = await res.json();
        if (data.project) {
          if (!rawWorkdir && data.project.workdir) rawWorkdir = data.project.workdir;
          if (!projectName && data.project.name) projectName = data.project.name;
        }
      }
    } catch {
    }
  }
  if (!rawWorkdir || !projectName) {
    try {
      const sRes = await fetch("http://127.0.0.1:10469/api/sessions?limit=1");
      if (sRes.ok) {
        const sData = await sRes.json();
        const latest = sData.sessions?.[0];
        if (latest) {
          if (latest.workdir && !rawWorkdir) rawWorkdir = latest.workdir;
          if (latest.projectId && !projectName) {
            const pRes = await fetch(`http://127.0.0.1:10469/api/projects/${encodeURIComponent(latest.projectId)}`);
            if (pRes.ok) {
              const pData = await pRes.json();
              if (pData.project) {
                if (!rawWorkdir && pData.project.workdir) rawWorkdir = pData.project.workdir;
                if (!projectName && pData.project.name) projectName = pData.project.name;
              }
            }
          }
        }
      }
    } catch {
    }
  }
  if (!projectName && rawWorkdir) {
    const parts = rawWorkdir.replace(/\/+$/, "").split("/");
    projectName = parts[parts.length - 1];
  }
  return { workdir: rawWorkdir, projectName };
}
function readSettings(context) {
  const settings = context.settings() ?? {};
  const rawPort = Number(settings["uiPort"]);
  const parsedPort = Number.isInteger(rawPort) && rawPort > 0 ? rawPort : 9749;
  const mcpCommand = typeof settings["mcpCommand"] === "string" && settings["mcpCommand"].trim() ? settings["mcpCommand"].trim() : "codebase-memory-mcp";
  return {
    showHeaderButton: settings["showHeaderButton"] === true,
    uiPort: parsedPort,
    autoIndexOnSessionStart: autoIndexOverride !== null ? autoIndexOverride : settings["autoIndexOnSessionStart"] !== false,
    mcpCommand
  };
}
function buildHeaderComponent(isIndexed, showHeader) {
  if (!showHeader) {
    return {
      type: "stack",
      direction: "row",
      children: []
    };
  }
  const dotColor = isIndexed ? "#22c55e" : "#ef4444";
  const tooltipText = isIndexed ? { en: "Codebase Memory: Synced (Click to open graph)", fr: "Codebase Memory : Synchronis\xE9 (Cliquer pour ouvrir le graphe)" } : { en: "Codebase Memory: Not Synced (Click to open)", fr: "Codebase Memory : Non synchronis\xE9 (Cliquer pour ouvrir)" };
  return {
    type: "button",
    variant: "ghost",
    label: { en: "Memory MCP", fr: "Memory MCP" },
    tooltip: tooltipText,
    icon: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><circle cx="6" cy="6" r="2.5"/><circle cx="18" cy="6" r="2.5"/><circle cx="12" cy="18" r="2.5"/><path d="M8.5 6h7M7.5 8l3 8M16.5 8l-3 8"/><circle cx="20" cy="4" r="3" fill="${dotColor}" stroke="#0f172a" stroke-width="1.5"/></svg>`,
    onActivate: {
      kind: "openPanel",
      panelId: "cbm-modal"
    }
  };
}
function buildComposerTopComponent(isIndexed, projectName, workdir) {
  if (isIndexed) {
    return {
      type: "badge",
      tone: "success",
      label: {
        en: "Memory: Synced",
        fr: "Memory : Synchronis\xE9"
      },
      tooltip: {
        en: "Codebase memory MCP is synced with this repository",
        fr: "Le MCP codebase memory est synchronis\xE9 avec ce d\xE9p\xF4t"
      }
    };
  }
  return {
    type: "button",
    variant: "ghost",
    label: {
      en: "Add this project to Memory MCP",
      fr: "Ajouter ce projet au memory mcp"
    },
    tooltip: {
      en: "Index this repository in codebase-memory-mcp",
      fr: "Indexer ce d\xE9p\xF4t dans codebase-memory-mcp"
    },
    onActivate: {
      kind: "rpc",
      method: "cbm.indexProject",
      params: { repoPath: workdir, projectName }
    }
  };
}
function formatSyncDate(isoStr) {
  if (!isoStr) return void 0;
  try {
    const d = new Date(isoStr);
    if (isNaN(d.getTime())) return { en: `Last sync: ${isoStr}`, fr: `Derni\xE8re synchro : ${isoStr}` };
    const now = /* @__PURE__ */ new Date();
    const diffMs = Math.max(0, now.getTime() - d.getTime());
    const diffMin = Math.floor(diffMs / 6e4);
    const diffHours = Math.floor(diffMin / 60);
    const diffDays = Math.floor(diffHours / 24);
    let relEn = "";
    let relFr = "";
    if (diffMin < 1) {
      relEn = "just now";
      relFr = "\xE0 l\u2019instant";
    } else if (diffMin < 60) {
      relEn = `${diffMin}m ago`;
      relFr = `il y a ${diffMin} min`;
    } else if (diffHours < 24) {
      relEn = `${diffHours}h ago`;
      relFr = `il y a ${diffHours} h`;
    } else {
      relEn = `${diffDays}d ago`;
      relFr = `il y a ${diffDays} j`;
    }
    const pad = (n) => n.toString().padStart(2, "0");
    const fullDate = `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    return {
      en: `Last sync: ${relEn} (${fullDate})`,
      fr: `Derni\xE8re synchro : ${relFr} (${fullDate})`
    };
  } catch {
    return { en: `Last sync: ${isoStr}`, fr: `Derni\xE8re synchro : ${isoStr}` };
  }
}
function buildLoadingContent(message) {
  return {
    type: "stack",
    direction: "column",
    gap: "sm",
    align: "center",
    justify: "center",
    className: "py-12",
    children: [
      {
        type: "icon",
        icon: SPINNER_ICON,
        className: "animate-spin w-6 h-6 text-accent-primary"
      },
      {
        type: "text",
        text: message ?? LOADING_LABEL,
        className: "text-sm text-text-muted font-medium"
      }
    ]
  };
}
function publishModalContent(context, content) {
  context.publish("cbm-modal", "content", Array.isArray(content) ? content : [content]);
}
function publishModalLoading(context, message) {
  publishModalContent(context, buildLoadingContent(message));
}
function buildModalContent(projects, currentWorkdir, currentIndexed, currentProject, autoIndexEnabled, activeIframeProject, uiPort = 9749, isLoading = false, activeProjectName, pendingDeleteProject, syncingProject, allOpenFoxProjects = []) {
  if (isLoading) {
    return buildLoadingContent();
  }
  if (activeIframeProject) {
    return {
      type: "stack",
      direction: "column",
      gap: "md",
      className: "w-full",
      children: [
        {
          type: "card",
          className: "w-full",
          children: [
            {
              type: "stack",
              direction: "row",
              align: "center",
              justify: "between",
              className: "w-full",
              children: [
                {
                  type: "stack",
                  direction: "column",
                  gap: "xs",
                  children: [
                    {
                      type: "text",
                      text: {
                        en: `Graph Explorer: ${activeIframeProject}`,
                        fr: `Visualisation Graphe : ${activeIframeProject}`
                      },
                      className: "font-semibold text-base"
                    },
                    {
                      type: "text",
                      text: {
                        en: "Interactive structural code graph & dependencies",
                        fr: "Graphe structurel de code et d\xE9pendances interactif"
                      },
                      muted: true,
                      className: "text-xs"
                    }
                  ]
                },
                {
                  type: "button",
                  variant: "default",
                  label: { en: "\u2190 Back to Projects", fr: "\u2190 Retour aux projets" },
                  onActivate: {
                    kind: "rpc",
                    method: "cbm.toggleIframe",
                    params: { projectName: activeIframeProject }
                  }
                }
              ]
            }
          ]
        },
        {
          type: "iframe",
          url: `/api/plugins/openfox-codebase-memory/assets/assets/index.html?tab=graph&project=${encodeURIComponent(activeIframeProject)}`,
          height: 650,
          width: "100%"
        }
      ]
    };
  }
  const children = [];
  children.push({
    type: "card",
    className: "w-full",
    children: [
      {
        type: "stack",
        direction: "row",
        align: "center",
        justify: "between",
        className: "w-full",
        children: [
          {
            type: "text",
            text: {
              en: "Codebase Memory MCP Status",
              fr: "Statut Codebase Memory MCP"
            },
            className: "font-semibold text-base"
          },
          {
            type: "button",
            variant: "default",
            label: { en: "Refresh Projects", fr: "Actualiser les projets" },
            onActivate: { kind: "rpc", method: "cbm.refreshModal" }
          }
        ]
      }
    ]
  });
  children.push({
    type: "card",
    className: "w-full",
    children: [
      {
        type: "stack",
        direction: "row",
        align: "center",
        justify: "between",
        className: "w-full",
        children: [
          {
            type: "stack",
            direction: "column",
            gap: "xs",
            children: [
              {
                type: "text",
                text: {
                  en: "Automatic indexing on MCP session start (Global)",
                  fr: "Indexation automatique au d\xE9marrage de session MCP (Global)"
                },
                className: "font-medium"
              },
              {
                type: "text",
                text: {
                  en: "Automatically sync and re-index repository when a new session starts (enabled by default)",
                  fr: "Synchroniser et r\xE9-indexer automatiquement le d\xE9p\xF4t lors du d\xE9marrage d\u2019une session (activ\xE9 par d\xE9faut)"
                },
                muted: true
              }
            ]
          },
          {
            type: "toggle",
            id: "autoIndexGlobal",
            enabled: autoIndexEnabled,
            label: {
              en: "Automatic indexing on MCP session start (Global)",
              fr: "Indexation automatique au d\xE9marrage de session MCP (Global)"
            },
            onActivate: {
              kind: "rpc",
              method: "cbm.toggleAutoIndex"
            }
          }
        ]
      }
    ]
  });
  const isAlreadySynced = (op) => {
    const opNorm = op.workdir ? op.workdir.replace(/\/+$/, "").toLowerCase() : "";
    const opFolder = op.workdir ? op.workdir.replace(/\/+$/, "").split("/").pop()?.toLowerCase() : "";
    const opName = op.name ? op.name.toLowerCase() : "";
    return projects.some((p) => {
      const pNorm = p.rootPath ? p.rootPath.replace(/\/+$/, "").toLowerCase() : "";
      const pFolder = p.rootPath ? p.rootPath.replace(/\/+$/, "").split("/").pop()?.toLowerCase() : "";
      const pName = p.name ? p.name.toLowerCase() : "";
      if (opNorm && pNorm && opNorm === pNorm) return true;
      if (opName && pName && (opName === pName || pName.endsWith(`-${opName}`))) return true;
      if (opFolder && pFolder && opFolder === pFolder) return true;
      if (opName && pFolder && opName === pFolder) return true;
      if (opFolder && pName && (opFolder === pName || pName.endsWith(`-${opFolder}`))) return true;
      return false;
    });
  };
  const isCurrentProject = (item) => {
    const itemPath = (item.rootPath || item.workdir || "").replace(/\/+$/, "").toLowerCase();
    const itemFolder = (item.rootPath || item.workdir || "").replace(/\/+$/, "").split("/").pop()?.toLowerCase() || "";
    const itemName = (item.name || "").toLowerCase();
    const curNorm = currentWorkdir ? currentWorkdir.replace(/\/+$/, "").toLowerCase() : "";
    const curFolder = currentWorkdir ? currentWorkdir.replace(/\/+$/, "").split("/").pop()?.toLowerCase() || "" : "";
    const activeName = (activeProjectName || "").toLowerCase();
    if (curNorm && itemPath && curNorm === itemPath) return true;
    if (activeName && itemName && (activeName === itemName || itemName.endsWith(`-${activeName}`))) return true;
    if (activeName && itemFolder && activeName === itemFolder) return true;
    if (curFolder && itemFolder && curFolder === itemFolder) return true;
    if (curFolder && itemName && (curFolder === itemName || itemName.endsWith(`-${curFolder}`))) return true;
    return false;
  };
  const projectRows = [];
  const sortedProjects = [...projects].sort((a, b) => {
    const aIsCurrent = isCurrentProject(a) ? 1 : 0;
    const bIsCurrent = isCurrentProject(b) ? 1 : 0;
    if (aIsCurrent !== bIsCurrent) return bIsCurrent - aIsCurrent;
    return (a.name || "").localeCompare(b.name || "");
  });
  for (const p of sortedProjects) {
    const isCurrent = isCurrentProject(p);
    const isConfirmingDelete = pendingDeleteProject === p.name;
    const syncDate = formatSyncDate(p.indexedAt);
    const displayName = p.rootPath ? p.rootPath.replace(/\/+$/, "").split("/").pop() || p.name : p.name;
    projectRows.push({
      type: "card",
      className: "w-full",
      children: [
        {
          type: "stack",
          direction: "column",
          gap: "sm",
          className: "w-full",
          children: [
            {
              type: "stack",
              direction: "row",
              align: "center",
              justify: "between",
              className: "w-full",
              children: [
                {
                  type: "stack",
                  direction: "column",
                  gap: "xs",
                  children: [
                    {
                      type: "stack",
                      direction: "row",
                      align: "center",
                      gap: "sm",
                      children: [
                        {
                          type: "text",
                          text: { en: displayName, fr: displayName },
                          className: "font-bold text-sm"
                        },
                        ...isCurrent ? [{
                          type: "badge",
                          tone: "info",
                          label: { en: "Current Project", fr: "Projet actuel" }
                        }] : []
                      ]
                    },
                    {
                      type: "text",
                      text: { en: p.rootPath, fr: p.rootPath },
                      muted: true,
                      className: "text-xs"
                    },
                    ...syncDate ? [{
                      type: "text",
                      text: syncDate,
                      muted: true,
                      className: "text-xs opacity-75"
                    }] : []
                  ]
                },
                {
                  type: "stack",
                  direction: "row",
                  align: "center",
                  justify: "end",
                  gap: "sm",
                  className: "flex-1 min-w-0",
                  children: [
                    {
                      type: "button",
                      variant: "default",
                      disabled: syncingProject === p.name,
                      label: syncingProject === p.name ? { en: "Syncing\u2026", fr: "Synchronisation\u2026" } : { en: "Force Sync", fr: "Forcer la synchronisation" },
                      icon: syncingProject === p.name ? SPINNER_ICON : void 0,
                      tooltip: { en: "Force re-indexing codebase into memory MCP", fr: "Forcer la r\xE9-indexation du code dans memory MCP" },
                      onActivate: syncingProject === p.name ? void 0 : {
                        kind: "rpc",
                        method: "cbm.forceSync",
                        params: { repoPath: p.rootPath, projectName: p.name }
                      }
                    },
                    {
                      type: "button",
                      variant: "primary",
                      label: { en: "Graph UI", fr: "Graphe UI" },
                      tooltip: { en: "Open Graph Visualization UI in full modal", fr: "Ouvrir la visualisation graphique en plein \xE9cran" },
                      onActivate: {
                        kind: "rpc",
                        method: "cbm.toggleIframe",
                        params: { projectName: p.name }
                      }
                    },
                    {
                      type: "button",
                      variant: "danger",
                      label: { en: "Unsync", fr: "D\xE9synchroniser" },
                      tooltip: { en: "Remove project from Codebase Memory knowledge graph", fr: "Supprimer le projet du graphe Codebase Memory" },
                      onActivate: {
                        kind: "rpc",
                        method: "cbm.requestUnsync",
                        params: { projectName: p.name }
                      }
                    }
                  ]
                }
              ]
            },
            ...isConfirmingDelete ? [
              {
                type: "callout",
                tone: "warning",
                title: {
                  en: "Confirm Unsync",
                  fr: "Confirmer la d\xE9synchronisation"
                },
                text: {
                  en: `Are you sure you want to remove "${p.name}" from Codebase Memory? The indexed graph knowledge will be deleted.`,
                  fr: `\xCAtes-vous s\xFBr de vouloir supprimer "${p.name}" de Codebase Memory ? Le graphe de connaissance index\xE9 sera supprim\xE9.`
                }
              },
              {
                type: "stack",
                direction: "row",
                align: "center",
                justify: "end",
                gap: "sm",
                className: "w-full pt-1",
                children: [
                  {
                    type: "button",
                    variant: "ghost",
                    label: { en: "Cancel", fr: "Annuler" },
                    onActivate: {
                      kind: "rpc",
                      method: "cbm.cancelUnsync"
                    }
                  },
                  {
                    type: "button",
                    variant: "danger",
                    label: { en: "Confirm Unsync", fr: "Confirmer la suppression" },
                    onActivate: {
                      kind: "rpc",
                      method: "cbm.confirmUnsync",
                      params: { projectName: p.name }
                    }
                  }
                ]
              }
            ] : []
          ]
        }
      ]
    });
  }
  if (projects.length === 0) {
    projectRows.push({
      type: "text",
      text: {
        en: "No projects indexed in codebase-memory-mcp yet.",
        fr: "Aucun projet index\xE9 dans codebase-memory-mcp pour le moment."
      },
      muted: true
    });
  }
  children.push({
    type: "stack",
    direction: "column",
    gap: "md",
    className: "w-full",
    children: [
      {
        type: "text",
        text: { en: "Synchronized Projects", fr: "Projets Synchronis\xE9s" },
        className: "font-semibold text-base mt-2"
      },
      ...projectRows
    ]
  });
  const unsyncedProjects = allOpenFoxProjects.filter((op) => !isAlreadySynced(op));
  const sortedUnsyncedProjects = [...unsyncedProjects].sort((a, b) => {
    const aIsCurrent = isCurrentProject(a) ? 1 : 0;
    const bIsCurrent = isCurrentProject(b) ? 1 : 0;
    if (aIsCurrent !== bIsCurrent) return bIsCurrent - aIsCurrent;
    return (a.name || "").localeCompare(b.name || "");
  });
  const openFoxRows = [];
  if (sortedUnsyncedProjects.length > 0) {
    for (const op of sortedUnsyncedProjects) {
      const isSyncing = syncingProject === op.name || syncingProject === op.workdir;
      const folderName = op.workdir ? op.workdir.replace(/\/+$/, "").split("/").pop() || op.name : op.name;
      const isCurrent = isCurrentProject(op);
      openFoxRows.push({
        type: "card",
        className: "w-full",
        children: [
          {
            type: "stack",
            direction: "row",
            align: "center",
            justify: "between",
            className: "w-full",
            children: [
              {
                type: "stack",
                direction: "column",
                gap: "xs",
                children: [
                  {
                    type: "stack",
                    direction: "row",
                    align: "center",
                    gap: "sm",
                    children: [
                      {
                        type: "text",
                        text: { en: folderName, fr: folderName },
                        className: "font-bold text-sm"
                      },
                      ...isCurrent ? [{
                        type: "badge",
                        tone: "info",
                        label: { en: "Current Project", fr: "Projet actuel" }
                      }] : []
                    ]
                  },
                  {
                    type: "text",
                    text: { en: op.workdir, fr: op.workdir },
                    muted: true,
                    className: "text-xs"
                  }
                ]
              },
              {
                type: "button",
                variant: "primary",
                disabled: isSyncing,
                label: isSyncing ? { en: "Syncing\u2026", fr: "Indexation\u2026" } : { en: "Add to Memory", fr: "Ajouter au Memory" },
                icon: isSyncing ? SPINNER_ICON : void 0,
                tooltip: {
                  en: "Add this project to Codebase Memory MCP",
                  fr: "Ajouter ce projet \xE0 Codebase Memory MCP"
                },
                onActivate: isSyncing ? void 0 : {
                  kind: "rpc",
                  method: "cbm.indexProject",
                  params: { repoPath: op.workdir, projectName: op.name }
                }
              }
            ]
          }
        ]
      });
    }
  } else {
    openFoxRows.push({
      type: "text",
      text: {
        en: "All OpenFox projects are already synchronized.",
        fr: "Tous les projets OpenFox sont d\xE9j\xE0 synchronis\xE9s."
      },
      muted: true
    });
  }
  children.push({
    type: "stack",
    direction: "column",
    gap: "md",
    className: "w-full",
    children: [
      {
        type: "text",
        text: { en: "OpenFox Projects", fr: "Projets OpenFox" },
        className: "font-semibold text-base mt-4"
      },
      ...openFoxRows
    ]
  });
  return {
    type: "stack",
    direction: "column",
    gap: "md",
    className: "w-full",
    children
  };
}
async function updateAllUi(context, activeIframeProject, runtimeWorkdir, runtimeProjectName, pendingDeleteProject, forceRefreshProjects = false, syncingProject) {
  const settings = readSettings(context);
  client.setCommand(settings.mcpCommand);
  client.setUiPort(settings.uiPort);
  if (runtimeWorkdir) activeWorkdirContext = runtimeWorkdir;
  if (runtimeProjectName) activeProjectNameContext = runtimeProjectName;
  const effectiveWorkdir = activeWorkdirContext || runtimeWorkdir || "";
  const effectiveProjectName = activeProjectNameContext || runtimeProjectName;
  const installationStatus = await client.checkInstallation();
  let projects = cachedProjects;
  if (forceRefreshProjects || projects.length === 0) {
    projects = await client.listProjects(false);
    cachedProjects = projects;
    cachedIndexedStatus.clear();
  }
  let indexResult = { indexed: false, project: void 0 };
  if (effectiveWorkdir) {
    if (!forceRefreshProjects && cachedIndexedStatus.has(effectiveWorkdir)) {
      indexResult = cachedIndexedStatus.get(effectiveWorkdir);
    } else {
      indexResult = await client.isProjectIndexed(effectiveWorkdir, effectiveProjectName);
      cachedIndexedStatus.set(effectiveWorkdir, indexResult);
    }
  }
  const { indexed, project } = indexResult;
  const headerNode = buildHeaderComponent(indexed, settings.showHeaderButton);
  context.publish("cbm-header-btn", "content", headerNode);
  const resolvedProjectName = effectiveProjectName || (effectiveWorkdir ? effectiveWorkdir.replace(/\/+$/, "").split("/").pop() : void 0) || project?.name;
  const composerNode = buildComposerTopComponent(indexed, resolvedProjectName, effectiveWorkdir);
  context.publish("cbm-composer-top", "content", composerNode);
  let allOpenFoxProjects = [];
  if (typeof context.projects === "function") {
    allOpenFoxProjects = context.projects() || [];
  }
  if (allOpenFoxProjects.length === 0) {
    allOpenFoxProjects = await fetchOpenFoxProjects(context.runtime?.configDirectory);
  }
  if (effectiveWorkdir) {
    const normEffective = effectiveWorkdir.replace(/\/+$/, "");
    const exists = allOpenFoxProjects.some(
      (op) => op.workdir && op.workdir.replace(/\/+$/, "") === normEffective
    );
    if (!exists) {
      allOpenFoxProjects.unshift({
        id: effectiveWorkdir,
        name: resolvedProjectName || normEffective.split("/").pop() || effectiveWorkdir,
        workdir: effectiveWorkdir
      });
    }
  }
  const modalContent = buildModalContent(
    projects,
    effectiveWorkdir,
    indexed,
    project,
    settings.autoIndexOnSessionStart,
    activeIframeProject,
    settings.uiPort,
    false,
    resolvedProjectName,
    pendingDeleteProject,
    syncingProject,
    allOpenFoxProjects
  );
  context.logger.info(`ALL OPENFOX PROJECTS COUNT: ${allOpenFoxProjects.length}`);
  publishModalContent(context, modalContent);
  return { indexed, projects, modalContent, installationStatus };
}
async function register(registry) {
  const context = registry.context;
  if (typeof registry.registerAsset === "function") {
    registry.registerAsset("assets/index.html");
    registry.registerAsset("assets/index-D-K5gNgQ.js");
    registry.registerAsset("assets/index-e0GBPCTE.css");
  }
  registry.registerSettings({
    title: {
      en: "Codebase Memory Configuration",
      fr: "Configuration Codebase Memory"
    },
    description: {
      en: "Configure Codebase Memory MCP integration and header display.",
      fr: "Configurer l\u2019int\xE9gration Codebase Memory MCP et l\u2019affichage dans le header."
    },
    fields: [
      {
        key: "cbmStatus",
        type: "status",
        label: {
          en: "Installation Status",
          fr: "Statut de l\u2019installation"
        },
        description: {
          en: "Checks if codebase-memory-mcp binary is installed on your OS.",
          fr: "V\xE9rifie si le binaire codebase-memory-mcp est install\xE9 sur votre syst\xE8me."
        },
        rpcMethod: "cbm.checkInstallationStatus"
      },
      {
        key: "cbmInstall",
        type: "button",
        label: {
          en: "Install Codebase Memory",
          fr: "Installer Codebase Memory"
        },
        buttonLabel: {
          en: "Install / Update on OS",
          fr: "Installer / Mettre \xE0 jour sur l\u2019OS"
        },
        buttonVariant: "primary",
        description: {
          en: "Download and run official codebase-memory-mcp installer for your OS.",
          fr: "T\xE9l\xE9charger et ex\xE9cuter le script officiel d\u2019installation codebase-memory-mcp pour votre OS."
        },
        rpcMethod: "cbm.installBinary"
      },
      {
        key: "showHeaderButton",
        label: {
          en: "Show button in header",
          fr: "Afficher le bouton dans le header"
        },
        type: "boolean",
        description: {
          en: "Add a fast-access button to the Codebase Memory graph modal directly in the header.",
          fr: "Ajouter un bouton d\u2019acc\xE8s rapide \xE0 la modale Codebase Memory directement dans le header."
        },
        default: false,
        defaultValue: false
      }
    ]
  });
  const initialFastContent = buildModalContent([], void 0, false, void 0, true);
  registry.registerUiPanel({
    id: "cbm-modal",
    title: {
      en: "Codebase Memory MCP",
      fr: "Codebase Memory MCP"
    },
    kind: "declarative",
    size: "full",
    content: Array.isArray(initialFastContent) ? initialFastContent : [initialFastContent]
  });
  registry.registerUiAction({
    id: "cbm-open-modal-action",
    slot: "plugin.menu",
    label: {
      en: "Codebase Memory",
      fr: "Codebase Memory"
    },
    onActivate: {
      kind: "openPanel",
      panelId: "cbm-modal"
    }
  });
  registry.registerUiComponent({
    id: "cbm-header-btn",
    zone: "header.actions",
    component: buildHeaderComponent(false, false),
    contentSource: {
      kind: "rpc",
      method: "cbm.getHeaderBtn",
      refreshMs: 2e3
    }
  });
  registry.registerUiComponent({
    id: "cbm-composer-top",
    zone: "composer.top",
    component: buildComposerTopComponent(false),
    contentSource: {
      kind: "rpc",
      method: "cbm.getComposerTop",
      refreshMs: 4e3
    }
  });
  let currentIframeProject;
  let currentPendingDeleteProject;
  registry.registerRpc("initPanel", async (params) => {
    const { workdir: rawWorkdir, projectName } = await resolveProjectContext(params);
    const res = await updateAllUi(context, currentIframeProject, rawWorkdir, projectName, currentPendingDeleteProject, true);
    return {
      content: Array.isArray(res.modalContent) ? res.modalContent : [res.modalContent]
    };
  });
  registry.registerRpc("cbm.getHeaderBtn", async (params) => {
    const { workdir: rawWorkdir, projectName } = await resolveProjectContext(params);
    const effectiveWorkdir = rawWorkdir || activeWorkdirContext || "";
    const effectiveProjectName = projectName || activeProjectNameContext;
    const settings = readSettings(context);
    const { indexed } = effectiveWorkdir || effectiveProjectName ? await client.isProjectIndexed(effectiveWorkdir, effectiveProjectName) : { indexed: false };
    const node = buildHeaderComponent(indexed, settings.showHeaderButton);
    return {
      content: node
    };
  });
  registry.registerRpc("cbm.getComposerTop", async (params) => {
    const { workdir: rawWorkdir, projectName } = await resolveProjectContext(params);
    const effectiveWorkdir = rawWorkdir || activeWorkdirContext || "";
    const effectiveProjectName = projectName || activeProjectNameContext;
    const { indexed, project } = effectiveWorkdir || effectiveProjectName ? await client.isProjectIndexed(effectiveWorkdir, effectiveProjectName) : { indexed: false, project: void 0 };
    const displayProjectName = effectiveProjectName || project?.name || (effectiveWorkdir ? effectiveWorkdir.replace(/\/+$/, "").split("/").pop() : void 0);
    const node = buildComposerTopComponent(indexed, displayProjectName, effectiveWorkdir);
    return {
      content: node
    };
  });
  registry.registerRpc("cbm.refreshModal", async (params) => {
    const { workdir: rawWorkdir, projectName } = await resolveProjectContext(params);
    publishModalLoading(context, { en: "Refreshing projects...", fr: "Actualisation des projets..." });
    await updateAllUi(context, currentIframeProject, rawWorkdir, projectName, currentPendingDeleteProject, true);
    return { success: true };
  });
  registry.registerRpc("cbm.toggleIframe", async (params) => {
    const projectName = typeof params?.["projectName"] === "string" ? params["projectName"] : void 0;
    if (currentIframeProject === projectName) {
      currentIframeProject = void 0;
      const res = await updateAllUi(context, void 0, activeWorkdirContext, activeProjectNameContext, currentPendingDeleteProject, false);
      return {
        success: true,
        activeIframeProject: void 0,
        content: Array.isArray(res.modalContent) ? res.modalContent : [res.modalContent]
      };
    } else {
      currentIframeProject = projectName;
      publishModalLoading(context, {
        en: `Loading Graph Explorer for ${projectName}...`,
        fr: `Chargement de l\u2019explorateur de graphe pour ${projectName}...`
      });
      const res = await updateAllUi(context, currentIframeProject, activeWorkdirContext, activeProjectNameContext, currentPendingDeleteProject, false);
      return {
        success: true,
        activeIframeProject: currentIframeProject,
        content: Array.isArray(res.modalContent) ? res.modalContent : [res.modalContent]
      };
    }
  });
  registry.registerRpc("cbm.requestUnsync", async (params) => {
    const projectName = typeof params?.["projectName"] === "string" ? params["projectName"] : void 0;
    const rawWorkdir = typeof params?.["workdir"] === "string" ? params["workdir"] : void 0;
    currentPendingDeleteProject = projectName;
    await updateAllUi(context, currentIframeProject, rawWorkdir, void 0, currentPendingDeleteProject);
    return { success: true, pendingDeleteProject: currentPendingDeleteProject };
  });
  registry.registerRpc("cbm.cancelUnsync", async (params) => {
    const rawWorkdir = typeof params?.["workdir"] === "string" ? params["workdir"] : void 0;
    currentPendingDeleteProject = void 0;
    await updateAllUi(context, currentIframeProject, rawWorkdir, void 0, void 0);
    return { success: true };
  });
  registry.registerRpc("cbm.confirmUnsync", async (params) => {
    const projectName = typeof params?.["projectName"] === "string" ? params["projectName"] : void 0;
    const rawWorkdir = typeof params?.["workdir"] === "string" ? params["workdir"] : void 0;
    if (!projectName) return { success: false, error: "Missing projectName" };
    publishModalLoading(context, {
      en: `Unsyncing ${projectName}...`,
      fr: `D\xE9synchronisation de ${projectName}...`
    });
    context.notify({
      title: { en: "Unsyncing project...", fr: "D\xE9synchronisation du projet..." },
      body: { en: `Removing ${projectName} from Codebase Memory`, fr: `Suppression de ${projectName} de Codebase Memory` },
      level: "info"
    });
    const res = await client.deleteProject(projectName);
    currentPendingDeleteProject = void 0;
    if (res.success) {
      cachedProjects = [];
      cachedIndexedStatus.clear();
      context.notify({
        title: { en: "Project unsynced", fr: "Projet d\xE9synchronis\xE9" },
        body: { en: `Successfully removed ${projectName}`, fr: `${projectName} supprim\xE9 avec succ\xE8s` },
        level: "success"
      });
    } else {
      context.notify({
        title: { en: "Unsync failed", fr: "\xC9chec de la d\xE9synchronisation" },
        body: { en: res.error || "Unknown error", fr: res.error || "Erreur inconnue" },
        level: "error"
      });
    }
    await updateAllUi(context, currentIframeProject, rawWorkdir, void 0, void 0, true);
    return res;
  });
  registry.registerRpc("cbm.indexProject", async (params) => {
    let repoPath = typeof params?.["repoPath"] === "string" ? params["repoPath"] : process.cwd();
    const projectName = typeof params?.["projectName"] === "string" ? params["projectName"] : void 0;
    if (!fs2.existsSync(repoPath) && projectName) {
      const candidate = path2.join(os2.homedir(), "Documents/Dev/Perso", projectName);
      if (fs2.existsSync(candidate)) {
        repoPath = candidate;
      }
    }
    await updateAllUi(context, currentIframeProject, void 0, void 0, void 0, false, projectName || repoPath);
    context.notify({
      title: { en: "Indexing repository...", fr: "Indexation du d\xE9p\xF4t..." },
      body: { en: `Indexing ${projectName || repoPath} into Codebase Memory MCP`, fr: `Indexation de ${projectName || repoPath} dans Codebase Memory MCP` },
      level: "info"
    });
    const res = await client.indexRepository(repoPath, projectName);
    if (res.success) {
      cachedProjects = [];
      cachedIndexedStatus.clear();
      context.notify({
        title: { en: "Repository indexed", fr: "D\xE9p\xF4t index\xE9" },
        body: { en: `Successfully indexed ${projectName || repoPath}`, fr: `D\xE9p\xF4t ${projectName || repoPath} index\xE9 avec succ\xE8s` },
        level: "success"
      });
    } else {
      context.notify({
        title: { en: "Indexing failed", fr: "\xC9chec de l\u2019indexation" },
        body: { en: res.error || "Unknown error", fr: res.error || "Erreur inconnue" },
        level: "error"
      });
    }
    await updateAllUi(context, currentIframeProject, void 0, void 0, void 0, true, void 0);
    return res;
  });
  registry.registerRpc("cbm.forceSync", async (params) => {
    let repoPath = typeof params?.["repoPath"] === "string" ? params["repoPath"] : process.cwd();
    const projectName = typeof params?.["projectName"] === "string" ? params["projectName"] : void 0;
    if (!fs2.existsSync(repoPath) && projectName) {
      const candidate = path2.join(os2.homedir(), "Documents/Dev/Perso", projectName);
      if (fs2.existsSync(candidate)) {
        repoPath = candidate;
      }
    }
    publishModalLoading(context, { en: "Syncing repository...", fr: "Synchronisation du d\xE9p\xF4t..." });
    context.notify({
      title: { en: "Syncing repository...", fr: "Synchronisation du d\xE9p\xF4t..." },
      body: { en: `Re-indexing ${projectName || repoPath}`, fr: `R\xE9-indexation de ${projectName || repoPath}` },
      level: "info"
    });
    const res = await client.indexRepository(repoPath, projectName, "full");
    if (res.success) {
      cachedProjects = [];
      cachedIndexedStatus.clear();
      context.notify({
        title: { en: "Synchronization completed", fr: "Synchronisation termin\xE9e" },
        body: { en: `Successfully synced ${projectName || repoPath}`, fr: `Synchronisation de ${projectName || repoPath} r\xE9ussie` },
        level: "success"
      });
    } else {
      context.notify({
        title: { en: "Sync failed", fr: "\xC9chec de la synchronisation" },
        body: { en: res.error || "Unknown error", fr: res.error || "Erreur inconnue" },
        level: "error"
      });
    }
    await updateAllUi(context, currentIframeProject, void 0, void 0, void 0, true, void 0);
    return res;
  });
  registry.registerRpc("cbm.toggleAutoIndex", async (params) => {
    const workdir = typeof params?.["workdir"] === "string" && params["workdir"] || process.cwd();
    const settings = readSettings(context);
    const nextVal = !settings.autoIndexOnSessionStart;
    autoIndexOverride = nextVal;
    publishModalLoading(context, { en: "Updating setting...", fr: "Mise \xE0 jour du param\xE8tre..." });
    context.notify({
      title: { en: "Auto-index setting updated", fr: "Param\xE8tre d\u2019auto-indexation mis \xE0 jour" },
      body: {
        en: `Automatic indexing is now ${nextVal ? "enabled" : "disabled"}`,
        fr: `L\u2019indexation automatique est maintenant ${nextVal ? "activ\xE9e" : "d\xE9sactiv\xE9e"}`
      },
      level: "info"
    });
    await updateAllUi(context, currentIframeProject, workdir);
    return { success: true, autoIndexOnSessionStart: nextVal };
  });
  registry.registerRpc("cbm.getStatus", async (params) => {
    const workdir = typeof params?.["workdir"] === "string" && params["workdir"] || process.cwd();
    const { indexed, project } = await client.isProjectIndexed(workdir);
    const installationStatus = await client.checkInstallation();
    return { indexed, project, workdir, installationStatus };
  });
  registry.registerRpc("cbm.checkInstallationStatus", async () => {
    const status = await client.checkInstallation();
    if (status.installed) {
      return {
        installed: true,
        statusTone: "success",
        statusText: {
          en: status.version ? `Installed (v${status.version})` : "Installed on OS",
          fr: status.version ? `Install\xE9 (v${status.version})` : "Install\xE9 sur l\u2019OS"
        }
      };
    }
    return {
      installed: false,
      statusTone: "danger",
      statusText: {
        en: "Not installed on OS",
        fr: "Non install\xE9 sur l\u2019OS"
      }
    };
  });
  registry.registerRpc("cbm.installBinary", async (params) => {
    const { workdir: rawWorkdir, projectName } = await resolveProjectContext(params);
    publishModalLoading(context, {
      en: "Installing codebase-memory-mcp on your system...",
      fr: "Installation de codebase-memory-mcp sur votre syst\xE8me..."
    });
    context.notify({
      title: { en: "Installing Codebase Memory...", fr: "Installation de Codebase Memory..." },
      body: {
        en: "Running official installer script for your OS...",
        fr: "Ex\xE9cution du script d\u2019installation officiel pour votre OS..."
      },
      level: "info"
    });
    const res = await client.installCodebaseMemory();
    if (res.success) {
      cachedProjects = [];
      cachedIndexedStatus.clear();
      context.notify({
        title: { en: "Installation complete", fr: "Installation termin\xE9e" },
        body: {
          en: "codebase-memory-mcp was installed. Restart OpenFox so the new PATH is picked up.",
          fr: "codebase-memory-mcp a \xE9t\xE9 install\xE9. Red\xE9marrez OpenFox pour prendre en compte le nouveau PATH."
        },
        level: "success"
      });
    } else {
      context.notify({
        title: { en: "Installation failed", fr: "\xC9chec de l\u2019installation" },
        body: {
          en: res.error || "Failed to install codebase-memory-mcp",
          fr: res.error || "\xC9chec de l\u2019installation de codebase-memory-mcp"
        },
        level: "error"
      });
    }
    await updateAllUi(context, currentIframeProject, rawWorkdir, projectName, currentPendingDeleteProject, true, void 0);
    return res;
  });
  if (typeof registry.registerHook === "function") {
    registry.registerHook("session.started", async (payload) => {
      const settings = readSettings(context);
      if (settings.autoIndexOnSessionStart) {
        const workdir = payload?.workdir || process.cwd();
        const { indexed } = await client.isProjectIndexed(workdir);
        if (indexed) {
          await client.indexRepository(workdir, payload?.projectName, "fast");
          await updateAllUi(context, currentIframeProject, workdir);
        }
      }
    });
  }
}
export {
  buildComposerTopComponent,
  buildHeaderComponent,
  buildLoadingContent,
  buildModalContent,
  fetchOpenFoxProjects,
  formatSyncDate,
  getClient,
  register,
  updateAllUi
};
//# sourceMappingURL=index.js.map