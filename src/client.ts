import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

function getDatabaseConstructor() {
  try {
    return require('better-sqlite3')
  } catch {
    // Try host openfox node_modules
    try {
      const parentPaths = [
        path.join(process.cwd(), 'node_modules/better-sqlite3'),
        path.join(os.homedir(), 'Library/Application Support/openfox-dev/node_modules/better-sqlite3'),
        '/Users/Renaud.Lefevre/Documents/Dev/Perso/openfox/node_modules/better-sqlite3',
      ]
      for (const p of parentPaths) {
        try {
          if (fs.existsSync(p)) return require(p)
        } catch {
          // ignore
        }
      }
    } catch {
      // ignore
    }
  }
  return null
}
import type { CbmProject } from './types.js'

const execFileAsync = promisify(execFile)

export class CodebaseMemoryClient {
  private command: string
  private uiPort: number

  constructor(command = 'codebase-memory-mcp', uiPort = 9749) {
    this.command = command
    this.uiPort = uiPort
  }

  setCommand(cmd: string) {
    if (cmd && cmd.trim()) {
      this.command = cmd.trim()
    }
  }

  setUiPort(port: number) {
    if (port && port > 0) {
      this.uiPort = port
    }
  }

  getUiUrl(projectName?: string): string {
    const base = `http://localhost:${this.uiPort}`
    if (projectName) {
      return `${base}/?project=${encodeURIComponent(projectName)}`
    }
    return base
  }

  async runCli(tool: string, args: Record<string, unknown> = {}): Promise<any> {
    const argsJson = JSON.stringify(args)
    let stdoutData = ''
    try {
      const res = await execFileAsync(this.command, ['cli', tool, argsJson, '--json'], { timeout: 60000 })
      stdoutData = res.stdout
    } catch (err: any) {
      if (err.stdout) {
        stdoutData = err.stdout
      } else {
        throw err
      }
    }

    try {
      const parsed = JSON.parse(stdoutData)
      if (parsed.isError) {
        const msg =
          parsed.structuredContent?.hint ||
          parsed.structuredContent?.error ||
          (parsed.content && parsed.content[0]?.text) ||
          'Tool execution failed'
        throw new Error(msg)
      }
      if (parsed.structuredContent) {
        if (parsed.structuredContent.status === 'error') {
          throw new Error(parsed.structuredContent.hint || parsed.structuredContent.error || 'Operation failed')
        }
        return parsed.structuredContent
      }
      if (parsed.content && Array.isArray(parsed.content)) {
        const textContent = parsed.content.find((c: any) => c.type === 'text')?.text || ''
        try {
          const innerParsed = JSON.parse(textContent)
          if (innerParsed.status === 'error') {
            throw new Error(innerParsed.hint || innerParsed.error || 'Operation failed')
          }
          return innerParsed
        } catch (jsonErr: any) {
          if (jsonErr.message && !jsonErr.message.includes('JSON')) {
            throw jsonErr
          }
          return textContent
        }
      }
      return parsed
    } catch (parseErr: any) {
      if (parseErr.message && !parseErr.message.includes('JSON')) {
        throw parseErr
      }
      return stdoutData
    }
  }

  async listProjectsFromSqlite(): Promise<CbmProject[]> {
    const home = os.homedir()
    const possibleCacheDirs = [
      path.join(home, '.cache/codebase-memory-mcp'),
      path.join(home, 'Library/Caches/codebase-memory-mcp'),
      path.join(home, '.local/share/codebase-memory'),
    ]

    try {
      const DatabaseConstructor = getDatabaseConstructor()
      if (typeof DatabaseConstructor === 'function') {
        for (const dir of possibleCacheDirs) {
          if (fs.existsSync(dir)) {
            const files = fs.readdirSync(dir)
            const projects: CbmProject[] = []
            for (const f of files) {
              if (f.endsWith('.db') && !f.startsWith('_')) {
                try {
                  const db = new DatabaseConstructor(path.join(dir, f), { readonly: true })
                  const rows = db
                    .prepare("SELECT name, root_path, indexed_at FROM projects WHERE root_path IS NOT NULL AND root_path != ''")
                    .all() as Array<{ name: string; root_path: string; indexed_at?: string }>
                  for (const r of rows) {
                    projects.push({
                      name: r.name,
                      rootPath: r.root_path,
                      indexedAt: r.indexed_at,
                    })
                  }
                  db.close()
                } catch {
                  // ignore
                }
              }
            }
            if (projects.length > 0) return projects
          }
        }
      }
    } catch {
      // ignore
    }
    return []
  }

  async listProjects(withStatus = true): Promise<CbmProject[]> {
    // 1. Fast path: direct SQLite reading (~3ms)
    try {
      const fastProjects = await this.listProjectsFromSqlite()
      if (fastProjects.length > 0) {
        return fastProjects
      }
    } catch {
      // fallback to CLI
    }

    // 2. Fallback to CLI
    try {
      const res = await this.runCli('list_projects', {})
      let projects: CbmProject[] = []
      if (typeof res === 'string') {
        projects = this.parseListProjectsText(res)
      } else if (Array.isArray(res)) {
        projects = res
      } else if (res && Array.isArray(res.projects)) {
        projects = res.projects
      }

      if (withStatus && projects.length > 0) {
        await Promise.allSettled(
          projects.map(async (p) => {
            try {
              const statusData = await this.getIndexStatus(p.name)
              if (statusData) {
                if (typeof statusData === 'string') {
                  const dateMatch = statusData.match(/indexed_at:\s*([^\n\r]+)/)
                  if (dateMatch && dateMatch[1]) p.indexedAt = dateMatch[1].trim()
                  const nodesMatch = statusData.match(/nodes:\s*(\d+)/)
                  if (nodesMatch && nodesMatch[1]) p.nodes = parseInt(nodesMatch[1], 10)
                  const edgesMatch = statusData.match(/edges:\s*(\d+)/)
                  if (edgesMatch && edgesMatch[1]) p.edges = parseInt(edgesMatch[1], 10)
                } else if (typeof statusData === 'object') {
                  if (statusData.indexed_at) p.indexedAt = statusData.indexed_at
                  if (statusData.indexedAt) p.indexedAt = statusData.indexedAt
                  if (statusData.nodes) p.nodes = statusData.nodes
                  if (statusData.edges) p.edges = statusData.edges
                }
              }
            } catch {
              // ignore
            }
          }),
        )
      }

      return projects
    } catch {
      return []
    }
  }

  private parseListProjectsText(text: string): CbmProject[] {
    const projects: CbmProject[] = []
    const lines = text.split('\n')
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('projects:') || trimmed.startsWith('total:') || trimmed.startsWith('returned:') || trimmed.startsWith('has_more:')) {
        continue
      }
      const parts = trimmed.split(/\s+/)
      if (parts.length >= 2) {
        projects.push({
          name: parts[0]!,
          rootPath: parts[1]!,
          branch: parts[2],
        })
      }
    }
    return projects
  }

  async isProjectIndexed(workdir?: string, projectName?: string): Promise<{ indexed: boolean; project?: CbmProject }> {
    if (!workdir && !projectName) return { indexed: false }
    const normalizedWorkdir = workdir ? workdir.replace(/\/+$/, '').toLowerCase() : ''
    const folderName = workdir ? workdir.replace(/\/+$/, '').split('/').pop()?.toLowerCase() : ''
    const targetProjectName = projectName ? projectName.toLowerCase() : ''

    const projects = await this.listProjects(false)
    const found = projects.find((p) => {
      const pNorm = p.rootPath ? p.rootPath.replace(/\/+$/, '').toLowerCase() : ''
      const pFolder = p.rootPath ? p.rootPath.replace(/\/+$/, '').split('/').pop()?.toLowerCase() : ''
      const pName = p.name ? p.name.toLowerCase() : ''

      if (normalizedWorkdir && pNorm && pNorm === normalizedWorkdir) return true
      if (normalizedWorkdir && p.rootPath) {
        try {
          if (path.resolve(p.rootPath) === path.resolve(workdir!)) return true
        } catch {
          // ignore
        }
      }
      if (targetProjectName && pName && (pName === targetProjectName || pName.endsWith(`-${targetProjectName}`))) {
        return true
      }
      if (targetProjectName && pFolder && pFolder === targetProjectName) {
        return true
      }
      if (folderName && pFolder && folderName === pFolder) {
        return true
      }
      if (folderName && pName && (pName === folderName || pName.endsWith(`-${folderName}`))) {
        return true
      }
      return false
    })
    if (found) {
      return { indexed: true, project: found }
    }
    return { indexed: false }
  }

  async indexRepository(repoPath: string, name?: string, mode: 'full' | 'moderate' | 'fast' = 'fast'): Promise<{ success: boolean; error?: string }> {
    try {
      const args: Record<string, unknown> = { repo_path: repoPath, mode }
      if (name) {
        args['name'] = name
      }
      const res = await this.runCli('index_repository', args)
      if (res && (res.status === 'error' || res.isError)) {
        return { success: false, error: res.hint || res.error || 'Indexing failed' }
      }
      return { success: true }
    } catch (err: any) {
      return { success: false, error: err.message || String(err) }
    }
  }

  async deleteProject(projectName: string): Promise<{ success: boolean; error?: string }> {
    try {
      await this.runCli('delete_project', { project: projectName })
      return { success: true }
    } catch (err: any) {
      return { success: false, error: err.message || String(err) }
    }
  }

  async getIndexStatus(projectName: string): Promise<any> {
    try {
      const res = await this.runCli('index_status', { project: projectName })
      return res
    } catch (err: any) {
      return { error: err.message || String(err) }
    }
  }
}
