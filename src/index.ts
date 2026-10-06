import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import { CodebaseMemoryClient } from './client.js'
import type { PluginRegistry, PluginContext, CbmProject, LocalizedString } from './types.js'

const require = createRequire(import.meta.url)

function getHostDatabaseConstructor() {
  try {
    return require('better-sqlite3')
  } catch {
    try {
      const parentPaths = [
        path.join(process.cwd(), 'node_modules/better-sqlite3'),
        path.join(os.homedir(), 'Library/Application Support/openfox-dev/node_modules/better-sqlite3'),
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

const SPINNER_ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>'

const LOADING_LABEL: LocalizedString = {
  en: 'Loading Codebase Memory projects...',
  fr: 'Chargement des projets Codebase Memory...',
}

let client = new CodebaseMemoryClient()
let autoIndexOverride: boolean | null = null
let cachedProjects: CbmProject[] = []
let cachedIndexedStatus = new Map<string, { indexed: boolean; project?: CbmProject }>()
let activeWorkdirContext: string | undefined
let activeProjectNameContext: string | undefined

export function getClient(): CodebaseMemoryClient {
  return client
}

export async function fetchOpenFoxProjects(contextConfigDir?: string): Promise<Array<{ id: string; name: string; workdir: string }>> {
  const discovered = new Map<string, { id: string; name: string; workdir: string }>()

  const addProjects = (rows: Array<{ id?: string; name?: string; workdir?: string }>) => {
    for (const r of rows) {
      if (r && r.workdir && typeof r.workdir === 'string') {
        let actualWorkdir = r.workdir
        if (!fs.existsSync(actualWorkdir) && r.name) {
          const candidate = path.join(home, 'Documents/Dev/Perso', r.name)
          if (fs.existsSync(candidate)) {
            actualWorkdir = candidate
          }
        }
        const norm = actualWorkdir.replace(/\/+$/, '')
        if (norm && !discovered.has(norm)) {
          const name = r.name || norm.split('/').pop() || norm
          const id = r.id || norm
          discovered.set(norm, { id, name, workdir: actualWorkdir })
        }
      }
    }
  }

  // 1. Query OpenFox sqlite database directly across standard platforms and modes
  const home = os.homedir()
  const dbPaths = [
    ...(contextConfigDir ? [path.join(contextConfigDir, 'sessions.db'), path.join(path.dirname(contextConfigDir), 'sessions.db')] : []),
    path.join(home, 'Library/Application Support/openfox-dev/sessions.db'),
    path.join(home, 'Library/Application Support/openfox/sessions.db'),
    path.join(home, '.local/share/openfox-dev/sessions.db'),
    path.join(home, '.local/share/openfox/sessions.db'),
    path.join(home, '.config/openfox-dev/sessions.db'),
    path.join(home, '.config/openfox/sessions.db'),
  ]

  if (process.env['LOCALAPPDATA']) {
    dbPaths.push(
      path.join(process.env['LOCALAPPDATA'], 'openfox-dev/sessions.db'),
      path.join(process.env['LOCALAPPDATA'], 'openfox/sessions.db'),
    )
  }
  if (process.env['APPDATA']) {
    dbPaths.push(
      path.join(process.env['APPDATA'], 'openfox-dev/sessions.db'),
      path.join(process.env['APPDATA'], 'openfox/sessions.db'),
    )
  }

  try {
    const DatabaseConstructor = getHostDatabaseConstructor()
    if (typeof DatabaseConstructor === 'function') {
      for (const dbPath of dbPaths) {
        if (fs.existsSync(dbPath)) {
          try {
            const db = new DatabaseConstructor(dbPath, { readonly: true })
            const rows = db.prepare('SELECT id, name, workdir FROM projects ORDER BY updated_at DESC').all() as Array<{ id: string; name: string; workdir: string }>
            db.close()
            if (Array.isArray(rows)) {
              addProjects(rows)
            }
          } catch {
            // ignore
          }
        }
      }
    }
  } catch {
    // ignore
  }

  // 2. Fallback: HTTP API only if SQLite discovery found nothing
  if (discovered.size === 0) {
    const candidatePorts = [10469, 10369]
    const hosts = ['127.0.0.1', 'localhost']
    for (const p of candidatePorts) {
      for (const h of hosts) {
        try {
          const controller = new AbortController()
          const timeoutId = setTimeout(() => controller.abort(), 300)
          const res = await fetch(`http://${h}:${p}/api/projects`, { signal: controller.signal })
          clearTimeout(timeoutId)
          if (res.ok) {
            const data = (await res.json()) as { projects?: Array<{ id: string; name: string; workdir: string }> }
            if (Array.isArray(data.projects)) {
              addProjects(data.projects)
            }
          }
        } catch {
          // try next
        }
      }
    }
  }

  return Array.from(discovered.values())
}
async function resolveProjectContext(
  params?: Record<string, unknown>,
): Promise<{ workdir?: string; projectName?: string }> {
  let rawWorkdir = typeof params?.['workdir'] === 'string' && params['workdir'] ? params['workdir'] : undefined
  let projectName = typeof params?.['projectName'] === 'string' && params['projectName'] ? params['projectName'] : undefined
  const projectId = typeof params?.['projectId'] === 'string' && params['projectId'] ? params['projectId'] : undefined
  const sessionId = typeof params?.['sessionId'] === 'string' && params['sessionId'] ? params['sessionId'] : undefined

  if ((!rawWorkdir || !projectName) && sessionId) {
    try {
      const res = await fetch(`http://localhost:10469/api/sessions/${encodeURIComponent(sessionId)}`)
      if (res.ok) {
        const data = (await res.json()) as { session?: { workdir?: string; projectId?: string } }
        if (data.session?.workdir && !rawWorkdir) {
          rawWorkdir = data.session.workdir
        }
        if (data.session?.projectId && !projectId) {
          const pRes = await fetch(`http://localhost:10469/api/projects/${encodeURIComponent(data.session.projectId)}`)
          if (pRes.ok) {
            const pData = (await pRes.json()) as { project?: { workdir?: string; name?: string } }
            if (pData.project) {
              if (!rawWorkdir && pData.project.workdir) rawWorkdir = pData.project.workdir
              if (!projectName && pData.project.name) projectName = pData.project.name
            }
          }
        }
      }
    } catch {
      // ignore
    }
  }

  if ((!rawWorkdir || !projectName) && projectId) {
    try {
      const res = await fetch(`http://localhost:10469/api/projects/${encodeURIComponent(projectId)}`)
      if (res.ok) {
        const data = (await res.json()) as { project?: { workdir?: string; name?: string } }
        if (data.project) {
          if (!rawWorkdir && data.project.workdir) rawWorkdir = data.project.workdir
          if (!projectName && data.project.name) projectName = data.project.name
        }
      }
    } catch {
      // ignore
    }
  }

  // Fallback if no context was forwarded: fetch the latest active session from OpenFox
  if (!rawWorkdir || !projectName) {
    try {
      const sRes = await fetch('http://127.0.0.1:10469/api/sessions?limit=1')
      if (sRes.ok) {
        const sData = (await sRes.json()) as { sessions?: Array<{ workdir?: string; projectId?: string }> }
        const latest = sData.sessions?.[0]
        if (latest) {
          if (latest.workdir && !rawWorkdir) rawWorkdir = latest.workdir
          if (latest.projectId && !projectName) {
            const pRes = await fetch(`http://127.0.0.1:10469/api/projects/${encodeURIComponent(latest.projectId)}`)
            if (pRes.ok) {
              const pData = (await pRes.json()) as { project?: { workdir?: string; name?: string } }
              if (pData.project) {
                if (!rawWorkdir && pData.project.workdir) rawWorkdir = pData.project.workdir
                if (!projectName && pData.project.name) projectName = pData.project.name
              }
            }
          }
        }
      }
    } catch {
      // ignore
    }
  }

  if (!projectName && rawWorkdir) {
    const parts = rawWorkdir.replace(/\/+$/, '').split('/')
    projectName = parts[parts.length - 1]
  }

  return { workdir: rawWorkdir, projectName }
}
function readSettings(context: PluginContext) {
  const settings = context.settings() ?? {}
  const rawPort = Number(settings['uiPort'])
  const parsedPort = Number.isInteger(rawPort) && rawPort > 0 ? rawPort : 9749
  const mcpCommand =
    typeof settings['mcpCommand'] === 'string' && settings['mcpCommand'].trim()
      ? settings['mcpCommand'].trim()
      : 'codebase-memory-mcp'

  return {
    showHeaderButton: settings['showHeaderButton'] === true,
    uiPort: parsedPort,
    autoIndexOnSessionStart:
      autoIndexOverride !== null
        ? autoIndexOverride
        : settings['autoIndexOnSessionStart'] !== false,
    mcpCommand,
  }
}

export function buildHeaderComponent(isIndexed: boolean, showHeader: boolean) {
  if (!showHeader) {
    return {
      type: 'stack' as const,
      direction: 'row' as const,
      children: [],
    }
  }

  const dotColor = isIndexed ? '#22c55e' : '#ef4444'
  const tooltipText = isIndexed
    ? { en: 'Codebase Memory: Synced (Click to open graph)', fr: 'Codebase Memory : Synchronisé (Cliquer pour ouvrir le graphe)' }
    : { en: 'Codebase Memory: Not Synced (Click to open)', fr: 'Codebase Memory : Non synchronisé (Cliquer pour ouvrir)' }

  return {
    type: 'button' as const,
    variant: 'ghost' as const,
    label: { en: 'Memory MCP', fr: 'Memory MCP' },
    tooltip: tooltipText,
    icon: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><circle cx="6" cy="6" r="2.5"/><circle cx="18" cy="6" r="2.5"/><circle cx="12" cy="18" r="2.5"/><path d="M8.5 6h7M7.5 8l3 8M16.5 8l-3 8"/><circle cx="20" cy="4" r="3" fill="${dotColor}" stroke="#0f172a" stroke-width="1.5"/></svg>`,
    onActivate: {
      kind: 'openPanel' as const,
      panelId: 'cbm-modal',
    },
  }
}

export function buildComposerTopComponent(isIndexed: boolean, projectName?: string, workdir?: string) {
  if (isIndexed) {
    return {
      type: 'badge' as const,
      tone: 'success' as const,
      label: {
        en: 'Memory: Synced',
        fr: 'Memory : Synchronisé',
      },
      tooltip: {
        en: 'Codebase memory MCP is synced with this repository',
        fr: 'Le MCP codebase memory est synchronisé avec ce dépôt',
      },
    }
  }

  return {
    type: 'button' as const,
    variant: 'ghost' as const,
    label: {
      en: 'Add this project to Memory MCP',
      fr: 'Ajouter ce projet au memory mcp',
    },
    tooltip: {
      en: 'Index this repository in codebase-memory-mcp',
      fr: 'Indexer ce dépôt dans codebase-memory-mcp',
    },
    onActivate: {
      kind: 'rpc' as const,
      method: 'cbm.indexProject',
      params: { repoPath: workdir, projectName },
    },
  }
}

export function formatSyncDate(isoStr?: string): { en: string; fr: string } | undefined {
  if (!isoStr) return undefined
  try {
    const d = new Date(isoStr)
    if (isNaN(d.getTime())) return { en: `Last sync: ${isoStr}`, fr: `Dernière synchro : ${isoStr}` }
    const now = new Date()
    const diffMs = Math.max(0, now.getTime() - d.getTime())
    const diffMin = Math.floor(diffMs / 60000)
    const diffHours = Math.floor(diffMin / 60)
    const diffDays = Math.floor(diffHours / 24)

    let relEn = ''
    let relFr = ''
    if (diffMin < 1) {
      relEn = 'just now'
      relFr = 'à l’instant'
    } else if (diffMin < 60) {
      relEn = `${diffMin}m ago`
      relFr = `il y a ${diffMin} min`
    } else if (diffHours < 24) {
      relEn = `${diffHours}h ago`
      relFr = `il y a ${diffHours} h`
    } else {
      relEn = `${diffDays}d ago`
      relFr = `il y a ${diffDays} j`
    }

    const pad = (n: number) => n.toString().padStart(2, '0')
    const fullDate = `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`

    return {
      en: `Last sync: ${relEn} (${fullDate})`,
      fr: `Dernière synchro : ${relFr} (${fullDate})`,
    }
  } catch {
    return { en: `Last sync: ${isoStr}`, fr: `Dernière synchro : ${isoStr}` }
  }
}

export function buildLoadingContent(message?: LocalizedString) {
  return {
    type: 'stack' as const,
    direction: 'column' as const,
    gap: 'sm' as const,
    align: 'center' as const,
    justify: 'center' as const,
    className: 'py-12',
    children: [
      {
        type: 'icon' as const,
        icon: SPINNER_ICON,
        className: 'animate-spin w-6 h-6 text-accent-primary',
      },
      {
        type: 'text' as const,
        text: message ?? LOADING_LABEL,
        className: 'text-sm text-text-muted font-medium',
      },
    ],
  }
}

/**
 * Panel content must be published as an array of declarative nodes: the host
 * only reads a published `content` value when it is an array, otherwise it
 * falls back to the panel's static content (empty here) and the panel blanks.
 */
function publishModalContent(context: PluginContext, content: unknown) {
  context.publish('cbm-modal', 'content', Array.isArray(content) ? content : [content])
}

function publishModalLoading(context: PluginContext, message?: LocalizedString) {
  publishModalContent(context, buildLoadingContent(message))
}

export function buildModalContent(
  projects: CbmProject[],
  currentWorkdir: string | undefined,
  currentIndexed: boolean,
  currentProject: CbmProject | undefined,
  autoIndexEnabled: boolean,
  activeIframeProject?: string,
  uiPort = 9749,
  isLoading = false,
  activeProjectName?: string,
  pendingDeleteProject?: string,
  syncingProject?: string,
  allOpenFoxProjects: Array<{ id: string; name: string; workdir: string }> = [],
) {
  if (isLoading) {
    return buildLoadingContent()
  }

  // If a project graph iframe is active, display the full-modal graph view
  if (activeIframeProject) {
    return {
      type: 'stack' as const,
      direction: 'column' as const,
      gap: 'md' as const,
      className: 'w-full',
      children: [
        {
          type: 'card' as const,
          className: 'w-full',
          children: [
            {
              type: 'stack' as const,
              direction: 'row' as const,
              align: 'center' as const,
              justify: 'between' as const,
              className: 'w-full',
              children: [
                {
                  type: 'stack' as const,
                  direction: 'column' as const,
                  gap: 'xs' as const,
                  children: [
                    {
                      type: 'text' as const,
                      text: {
                        en: `Graph Explorer: ${activeIframeProject}`,
                        fr: `Visualisation Graphe : ${activeIframeProject}`,
                      },
                      className: 'font-semibold text-base',
                    },
                    {
                      type: 'text' as const,
                      text: {
                        en: 'Interactive structural code graph & dependencies',
                        fr: 'Graphe structurel de code et dépendances interactif',
                      },
                      muted: true,
                      className: 'text-xs',
                    },
                  ],
                },
                {
                  type: 'button' as const,
                  variant: 'default' as const,
                  label: { en: '← Back to Projects', fr: '← Retour aux projets' },
                  onActivate: {
                    kind: 'rpc' as const,
                    method: 'cbm.toggleIframe',
                    params: { projectName: activeIframeProject },
                  },
                },
              ],
            },
          ],
        },
        {
          type: 'iframe' as const,
          url: `/api/plugins/openfox-codebase-memory/assets/assets/index.html?tab=graph&project=${encodeURIComponent(activeIframeProject)}`,
          height: 650,
          width: '100%',
        },
      ],
    }
  }

  const children: any[] = []

  // Header / Top section
  children.push({
    type: 'card',
    className: 'w-full',
    children: [
      {
        type: 'stack',
        direction: 'row',
        align: 'center',
        justify: 'between',
        className: 'w-full',
        children: [
          {
            type: 'text',
            text: {
              en: 'Codebase Memory MCP Status',
              fr: 'Statut Codebase Memory MCP',
            },
            className: 'font-semibold text-base',
          },
          {
            type: 'button',
            variant: 'default',
            label: { en: 'Refresh Projects', fr: 'Actualiser les projets' },
            onActivate: { kind: 'rpc', method: 'cbm.refreshModal' },
          },
        ],
      },
    ],
  })

  // Automatic indexing global setting
  children.push({
    type: 'card',
    className: 'w-full',
    children: [
      {
        type: 'stack',
        direction: 'row',
        align: 'center',
        justify: 'between',
        className: 'w-full',
        children: [
          {
            type: 'stack',
            direction: 'column',
            gap: 'xs',
            children: [
              {
                type: 'text',
                text: {
                  en: 'Automatic indexing on MCP session start (Global)',
                  fr: 'Indexation automatique au démarrage de session MCP (Global)',
                },
                className: 'font-medium',
              },
              {
                type: 'text',
                text: {
                  en: 'Automatically sync and re-index repository when a new session starts (enabled by default)',
                  fr: 'Synchroniser et ré-indexer automatiquement le dépôt lors du démarrage d’une session (activé par défaut)',
                },
                muted: true,
              },
            ],
          },
          {
            type: 'toggle',
            id: 'autoIndexGlobal',
            enabled: autoIndexEnabled,
            label: {
              en: 'Automatic indexing on MCP session start (Global)',
              fr: 'Indexation automatique au démarrage de session MCP (Global)',
            },
            onActivate: {
              kind: 'rpc',
              method: 'cbm.toggleAutoIndex',
            },
          },
        ],
      },
    ],
  })

  // Helper to determine if an OpenFox project is already synced into Codebase Memory
  const isAlreadySynced = (op: { name?: string; workdir?: string }) => {
    const opNorm = op.workdir ? op.workdir.replace(/\/+$/, '').toLowerCase() : ''
    const opFolder = op.workdir ? op.workdir.replace(/\/+$/, '').split('/').pop()?.toLowerCase() : ''
    const opName = op.name ? op.name.toLowerCase() : ''

    return projects.some((p) => {
      const pNorm = p.rootPath ? p.rootPath.replace(/\/+$/, '').toLowerCase() : ''
      const pFolder = p.rootPath ? p.rootPath.replace(/\/+$/, '').split('/').pop()?.toLowerCase() : ''
      const pName = p.name ? p.name.toLowerCase() : ''

      if (opNorm && pNorm && opNorm === pNorm) return true
      if (opName && pName && (opName === pName || pName.endsWith(`-${opName}`))) return true
      if (opFolder && pFolder && opFolder === pFolder) return true
      if (opName && pFolder && opName === pFolder) return true
      if (opFolder && pName && (opFolder === pName || pName.endsWith(`-${opFolder}`))) return true
      return false
    })
  }

  // Helper to check if a project is the current active session project
  const isCurrentProject = (item: { name?: string; rootPath?: string; workdir?: string }) => {
    const itemPath = (item.rootPath || item.workdir || '').replace(/\/+$/, '').toLowerCase()
    const itemFolder = (item.rootPath || item.workdir || '').replace(/\/+$/, '').split('/').pop()?.toLowerCase() || ''
    const itemName = (item.name || '').toLowerCase()

    const curNorm = currentWorkdir ? currentWorkdir.replace(/\/+$/, '').toLowerCase() : ''
    const curFolder = currentWorkdir ? currentWorkdir.replace(/\/+$/, '').split('/').pop()?.toLowerCase() || '' : ''
    const activeName = (activeProjectName || '').toLowerCase()

    if (curNorm && itemPath && curNorm === itemPath) return true
    if (activeName && itemName && (activeName === itemName || itemName.endsWith(`-${activeName}`))) return true
    if (activeName && itemFolder && activeName === itemFolder) return true
    if (curFolder && itemFolder && curFolder === itemFolder) return true
    if (curFolder && itemName && (curFolder === itemName || itemName.endsWith(`-${curFolder}`))) return true
    return false
  }

  // Synchronized projects list
  const projectRows: any[] = []

  const sortedProjects = [...projects].sort((a, b) => {
    const aIsCurrent = isCurrentProject(a) ? 1 : 0
    const bIsCurrent = isCurrentProject(b) ? 1 : 0
    if (aIsCurrent !== bIsCurrent) return bIsCurrent - aIsCurrent
    return (a.name || '').localeCompare(b.name || '')
  })

  for (const p of sortedProjects) {
    const isCurrent = isCurrentProject(p)
    const isConfirmingDelete = pendingDeleteProject === p.name
    const syncDate = formatSyncDate(p.indexedAt)

    const displayName = p.rootPath
      ? p.rootPath.replace(/\/+$/, '').split('/').pop() || p.name
      : p.name

    projectRows.push({
      type: 'card',
      className: 'w-full',
      children: [
        {
          type: 'stack',
          direction: 'column',
          gap: 'sm',
          className: 'w-full',
          children: [
            {
              type: 'stack',
              direction: 'row',
              align: 'center',
              justify: 'between',
              className: 'w-full',
              children: [
                {
                  type: 'stack',
                  direction: 'column',
                  gap: 'xs',
                  children: [
                    {
                      type: 'stack',
                      direction: 'row',
                      align: 'center',
                      gap: 'sm',
                      children: [
                        {
                          type: 'text',
                          text: { en: displayName, fr: displayName },
                          className: 'font-bold text-sm',
                        },
                        ...(isCurrent ? [{
                          type: 'badge',
                          tone: 'info',
                          label: { en: 'Current Project', fr: 'Projet actuel' },
                        }] : []),
                      ],
                    },
                    {
                      type: 'text',
                      text: { en: p.rootPath, fr: p.rootPath },
                      muted: true,
                      className: 'text-xs',
                    },
                    ...(syncDate ? [{
                      type: 'text' as const,
                      text: syncDate,
                      muted: true,
                      className: 'text-xs opacity-75',
                    }] : []),
                  ],
                },
                {
                  type: 'stack',
                  direction: 'row',
                  align: 'center',
                  justify: 'end',
                  gap: 'sm',
                  className: 'flex-1 min-w-0',
                  children: [
                    {
                      type: 'button',
                      variant: 'default',
                      disabled: syncingProject === p.name,
                      label: syncingProject === p.name
                        ? { en: 'Syncing…', fr: 'Synchronisation…' }
                        : { en: 'Force Sync', fr: 'Forcer la synchronisation' },
                      icon: syncingProject === p.name
                        ? SPINNER_ICON
                        : undefined,
                      tooltip: { en: 'Force re-indexing codebase into memory MCP', fr: 'Forcer la ré-indexation du code dans memory MCP' },
                      onActivate: syncingProject === p.name
                        ? undefined
                        : {
                            kind: 'rpc',
                            method: 'cbm.forceSync',
                            params: { repoPath: p.rootPath, projectName: p.name },
                          },
                    },
                    {
                      type: 'button',
                      variant: 'primary',
                      label: { en: 'Graph UI', fr: 'Graphe UI' },
                      tooltip: { en: 'Open Graph Visualization UI in full modal', fr: 'Ouvrir la visualisation graphique en plein écran' },
                      onActivate: {
                        kind: 'rpc',
                        method: 'cbm.toggleIframe',
                        params: { projectName: p.name },
                      },
                    },
                    {
                      type: 'button',
                      variant: 'danger',
                      label: { en: 'Unsync', fr: 'Désynchroniser' },
                      tooltip: { en: 'Remove project from Codebase Memory knowledge graph', fr: 'Supprimer le projet du graphe Codebase Memory' },
                      onActivate: {
                        kind: 'rpc',
                        method: 'cbm.requestUnsync',
                        params: { projectName: p.name },
                      },
                    },
                  ],
                },
              ],
            },
            ...(isConfirmingDelete ? [
              {
                type: 'callout' as const,
                tone: 'warning' as const,
                title: {
                  en: 'Confirm Unsync',
                  fr: 'Confirmer la désynchronisation',
                },
                text: {
                  en: `Are you sure you want to remove "${p.name}" from Codebase Memory? The indexed graph knowledge will be deleted.`,
                  fr: `Êtes-vous sûr de vouloir supprimer "${p.name}" de Codebase Memory ? Le graphe de connaissance indexé sera supprimé.`,
                },
              },
              {
                type: 'stack' as const,
                direction: 'row' as const,
                align: 'center' as const,
                justify: 'end' as const,
                gap: 'sm' as const,
                className: 'w-full pt-1',
                children: [
                  {
                    type: 'button' as const,
                    variant: 'ghost' as const,
                    label: { en: 'Cancel', fr: 'Annuler' },
                    onActivate: {
                      kind: 'rpc' as const,
                      method: 'cbm.cancelUnsync',
                    },
                  },
                  {
                    type: 'button' as const,
                    variant: 'danger' as const,
                    label: { en: 'Confirm Unsync', fr: 'Confirmer la suppression' },
                    onActivate: {
                      kind: 'rpc' as const,
                      method: 'cbm.confirmUnsync',
                      params: { projectName: p.name },
                    },
                  },
                ],
              },
            ] : []),
          ],
        },
      ],
    })
  }

  if (projects.length === 0) {
    projectRows.push({
      type: 'text',
      text: {
        en: 'No projects indexed in codebase-memory-mcp yet.',
        fr: 'Aucun projet indexé dans codebase-memory-mcp pour le moment.',
      },
      muted: true,
    })
  }

  // Section 1: Synchronized Projects
  children.push({
    type: 'stack',
    direction: 'column',
    gap: 'md',
    className: 'w-full',
    children: [
      {
        type: 'text',
        text: { en: 'Synchronized Projects', fr: 'Projets Synchronisés' },
        className: 'font-semibold text-base mt-2',
      },
      ...projectRows,
    ],
  })

  // Section 2: OpenFox Projects available to add
  const unsyncedProjects = allOpenFoxProjects.filter((op) => !isAlreadySynced(op))

  const sortedUnsyncedProjects = [...unsyncedProjects].sort((a, b) => {
    const aIsCurrent = isCurrentProject(a) ? 1 : 0
    const bIsCurrent = isCurrentProject(b) ? 1 : 0
    if (aIsCurrent !== bIsCurrent) return bIsCurrent - aIsCurrent
    return (a.name || '').localeCompare(b.name || '')
  })

  const openFoxRows: any[] = []
  if (sortedUnsyncedProjects.length > 0) {
    for (const op of sortedUnsyncedProjects) {
      const isSyncing = syncingProject === op.name || syncingProject === op.workdir
      const folderName = op.workdir ? op.workdir.replace(/\/+$/, '').split('/').pop() || op.name : op.name
      const isCurrent = isCurrentProject(op)

      openFoxRows.push({
        type: 'card',
        className: 'w-full',
        children: [
          {
            type: 'stack',
            direction: 'row',
            align: 'center',
            justify: 'between',
            className: 'w-full',
            children: [
              {
                type: 'stack',
                direction: 'column',
                gap: 'xs',
                children: [
                  {
                    type: 'stack',
                    direction: 'row',
                    align: 'center',
                    gap: 'sm',
                    children: [
                      {
                        type: 'text',
                        text: { en: folderName, fr: folderName },
                        className: 'font-bold text-sm',
                      },
                      ...(isCurrent ? [{
                        type: 'badge',
                        tone: 'info',
                        label: { en: 'Current Project', fr: 'Projet actuel' },
                      }] : []),
                    ],
                  },
                  {
                    type: 'text',
                    text: { en: op.workdir, fr: op.workdir },
                    muted: true,
                    className: 'text-xs',
                  },
                ],
              },
              {
                type: 'button',
                variant: 'primary',
                disabled: isSyncing,
                label: isSyncing
                  ? { en: 'Syncing…', fr: 'Indexation…' }
                  : { en: 'Add to Memory', fr: 'Ajouter au Memory' },
                icon: isSyncing ? SPINNER_ICON : undefined,
                tooltip: {
                  en: 'Add this project to Codebase Memory MCP',
                  fr: 'Ajouter ce projet à Codebase Memory MCP',
                },
                onActivate: isSyncing
                  ? undefined
                  : {
                      kind: 'rpc',
                      method: 'cbm.indexProject',
                      params: { repoPath: op.workdir, projectName: op.name },
                    },
              },
            ],
          },
        ],
      })
    }
  } else {
    openFoxRows.push({
      type: 'text',
      text: {
        en: 'All OpenFox projects are already synchronized.',
        fr: 'Tous les projets OpenFox sont déjà synchronisés.',
      },
      muted: true,
    })
  }

  children.push({
    type: 'stack',
    direction: 'column',
    gap: 'md',
    className: 'w-full',
    children: [
      {
        type: 'text',
        text: { en: 'OpenFox Projects', fr: 'Projets OpenFox' },
        className: 'font-semibold text-base mt-4',
      },
      ...openFoxRows,
    ],
  })

  return {
    type: 'stack',
    direction: 'column',
    gap: 'md',
    className: 'w-full',
    children,
  }
}

export async function updateAllUi(
  context: PluginContext,
  activeIframeProject?: string,
  runtimeWorkdir?: string,
  runtimeProjectName?: string,
  pendingDeleteProject?: string,
  forceRefreshProjects = false,
  syncingProject?: string,
) {
  const settings = readSettings(context)
  client.setCommand(settings.mcpCommand)
  client.setUiPort(settings.uiPort)

  if (runtimeWorkdir) activeWorkdirContext = runtimeWorkdir
  if (runtimeProjectName) activeProjectNameContext = runtimeProjectName

  const effectiveWorkdir = activeWorkdirContext || runtimeWorkdir || ''
  const effectiveProjectName = activeProjectNameContext || runtimeProjectName

  // Check installation on OS
  const installationStatus = await client.checkInstallation()

  // Fetch projects (use cached if available, unless forced or empty)
  let projects = cachedProjects
  if (forceRefreshProjects || projects.length === 0) {
    projects = await client.listProjects(false)
    cachedProjects = projects
    cachedIndexedStatus.clear()
  }

  let indexResult: { indexed: boolean; project?: CbmProject } = { indexed: false, project: undefined }
  if (effectiveWorkdir) {
    if (!forceRefreshProjects && cachedIndexedStatus.has(effectiveWorkdir)) {
      indexResult = cachedIndexedStatus.get(effectiveWorkdir)!
    } else {
      indexResult = await client.isProjectIndexed(effectiveWorkdir, effectiveProjectName)
      cachedIndexedStatus.set(effectiveWorkdir, indexResult)
    }
  }
  const { indexed, project } = indexResult

  // 1. Header action
  const headerNode = buildHeaderComponent(indexed, settings.showHeaderButton)
  context.publish('cbm-header-btn', 'content', headerNode)

  // 2. Composer Top status badge or add button
  const resolvedProjectName = effectiveProjectName || (effectiveWorkdir ? effectiveWorkdir.replace(/\/+$/, '').split('/').pop() : undefined) || project?.name
  const composerNode = buildComposerTopComponent(indexed, resolvedProjectName, effectiveWorkdir)
  context.publish('cbm-composer-top', 'content', composerNode)

  // Fetch OpenFox projects
  let allOpenFoxProjects: Array<{ id: string; name: string; workdir: string }> = []
  if (typeof context.projects === 'function') {
    allOpenFoxProjects = context.projects() || []
  }
  if (allOpenFoxProjects.length === 0) {
    allOpenFoxProjects = await fetchOpenFoxProjects((context as any).runtime?.configDirectory)
  }

  // Ensure current active project is present in OpenFox projects list if not already
  if (effectiveWorkdir) {
    const normEffective = effectiveWorkdir.replace(/\/+$/, '')
    const exists = allOpenFoxProjects.some(
      (op) => op.workdir && op.workdir.replace(/\/+$/, '') === normEffective,
    )
    if (!exists) {
      allOpenFoxProjects.unshift({
        id: effectiveWorkdir,
        name: resolvedProjectName || normEffective.split('/').pop() || effectiveWorkdir,
        workdir: effectiveWorkdir,
      })
    }
  }

  // 3. Modal content
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
    allOpenFoxProjects,
  )
  context.logger.info(`ALL OPENFOX PROJECTS COUNT: ${allOpenFoxProjects.length}`)
  publishModalContent(context, modalContent)

  return { indexed, projects, modalContent, installationStatus }
}

export async function register(registry: PluginRegistry): Promise<void> {
  const context = registry.context

  // Register assets
  if (typeof registry.registerAsset === 'function') {
    registry.registerAsset('assets/index.html')
    registry.registerAsset('assets/index-D-K5gNgQ.js')
    registry.registerAsset('assets/index-e0GBPCTE.css')
  }

  // Register Settings
  registry.registerSettings({
    title: {
      en: 'Codebase Memory Configuration',
      fr: 'Configuration Codebase Memory',
    },
    description: {
      en: 'Configure Codebase Memory MCP integration and header display.',
      fr: 'Configurer l’intégration Codebase Memory MCP et l’affichage dans le header.',
    },
    fields: [
      {
        key: 'cbmStatus',
        type: 'status',
        label: {
          en: 'Installation Status',
          fr: 'Statut de l’installation',
        },
        description: {
          en: 'Checks if codebase-memory-mcp binary is installed on your OS.',
          fr: 'Vérifie si le binaire codebase-memory-mcp est installé sur votre système.',
        },
        rpcMethod: 'cbm.checkInstallationStatus',
      },
      {
        key: 'cbmInstall',
        type: 'button',
        label: {
          en: 'Install Codebase Memory',
          fr: 'Installer Codebase Memory',
        },
        buttonLabel: {
          en: 'Install / Update on OS',
          fr: 'Installer / Mettre à jour sur l’OS',
        },
        buttonVariant: 'primary',
        description: {
          en: 'Download and run official codebase-memory-mcp installer for your OS.',
          fr: 'Télécharger et exécuter le script officiel d’installation codebase-memory-mcp pour votre OS.',
        },
        rpcMethod: 'cbm.installBinary',
      },
      {
        key: 'showHeaderButton',
        label: {
          en: 'Show button in header',
          fr: 'Afficher le bouton dans le header',
        },
        type: 'boolean',
        description: {
          en: 'Add a fast-access button to the Codebase Memory graph modal directly in the header.',
          fr: 'Ajouter un bouton d’accès rapide à la modale Codebase Memory directement dans le header.',
        },
        default: false,
        defaultValue: false,
      },
    ],
  })

  // Fast static content to display instantly when panel is clicked
  const initialFastContent = buildModalContent([], undefined, false, undefined, true)

  // Register UI Panel (Modal) with size full
  registry.registerUiPanel({
    id: 'cbm-modal',
    title: {
      en: 'Codebase Memory MCP',
      fr: 'Codebase Memory MCP',
    },
    kind: 'declarative',
    size: 'full',
    content: Array.isArray(initialFastContent) ? initialFastContent : [initialFastContent],
  })

  // Register Menu Action (in Plugins menu)
  registry.registerUiAction({
    id: 'cbm-open-modal-action',
    slot: 'plugin.menu',
    label: {
      en: 'Codebase Memory',
      fr: 'Codebase Memory',
    },
    onActivate: {
      kind: 'openPanel',
      panelId: 'cbm-modal',
    },
  })

  // Static initial registration of UI components
  registry.registerUiComponent({
    id: 'cbm-header-btn',
    zone: 'header.actions',
    component: buildHeaderComponent(false, false),
    contentSource: {
      kind: 'rpc',
      method: 'cbm.getHeaderBtn',
      refreshMs: 2000,
    },
  })

  registry.registerUiComponent({
    id: 'cbm-composer-top',
    zone: 'composer.top',
    component: buildComposerTopComponent(false),
    contentSource: {
      kind: 'rpc',
      method: 'cbm.getComposerTop',
      refreshMs: 4000,
    },
  })

  let currentIframeProject: string | undefined
  let currentPendingDeleteProject: string | undefined

  // RPC Handlers
  registry.registerRpc('initPanel', async (params?: Record<string, unknown>) => {
    const { workdir: rawWorkdir, projectName } = await resolveProjectContext(params)

    const res = await updateAllUi(context, currentIframeProject, rawWorkdir, projectName, currentPendingDeleteProject, true)
    return {
      content: Array.isArray(res.modalContent) ? res.modalContent : [res.modalContent],
    }
  })

  registry.registerRpc('cbm.getHeaderBtn', async (params?: Record<string, unknown>) => {
    const { workdir: rawWorkdir, projectName } = await resolveProjectContext(params)
    const effectiveWorkdir = rawWorkdir || activeWorkdirContext || ''
    const effectiveProjectName = projectName || activeProjectNameContext
    const settings = readSettings(context)
    const { indexed } = (effectiveWorkdir || effectiveProjectName)
      ? await client.isProjectIndexed(effectiveWorkdir, effectiveProjectName)
      : { indexed: false }
    const node = buildHeaderComponent(indexed, settings.showHeaderButton)
    return {
      content: node,
    }
  })

  registry.registerRpc('cbm.getComposerTop', async (params?: Record<string, unknown>) => {
    const { workdir: rawWorkdir, projectName } = await resolveProjectContext(params)
    const effectiveWorkdir = rawWorkdir || activeWorkdirContext || ''
    const effectiveProjectName = projectName || activeProjectNameContext
    const { indexed, project } = (effectiveWorkdir || effectiveProjectName)
      ? await client.isProjectIndexed(effectiveWorkdir, effectiveProjectName)
      : { indexed: false, project: undefined }
    const displayProjectName = effectiveProjectName || project?.name || (effectiveWorkdir ? effectiveWorkdir.replace(/\/+$/, '').split('/').pop() : undefined)
    const node = buildComposerTopComponent(indexed, displayProjectName, effectiveWorkdir)
    return {
      content: node,
    }
  })

  registry.registerRpc('cbm.refreshModal', async (params?: Record<string, unknown>) => {
    const { workdir: rawWorkdir, projectName } = await resolveProjectContext(params)
    publishModalLoading(context, { en: 'Refreshing projects...', fr: 'Actualisation des projets...' })
    await updateAllUi(context, currentIframeProject, rawWorkdir, projectName, currentPendingDeleteProject, true)
    return { success: true }
  })

  registry.registerRpc('cbm.toggleIframe', async (params: Record<string, unknown>) => {
    const projectName = typeof params?.['projectName'] === 'string' ? params['projectName'] : undefined

    if (currentIframeProject === projectName) {
      currentIframeProject = undefined
      // Instant switch back to projects list using cached project data & preserving current OpenFox project context
      const res = await updateAllUi(context, undefined, activeWorkdirContext, activeProjectNameContext, currentPendingDeleteProject, false)
      return {
        success: true,
        activeIframeProject: undefined,
        content: Array.isArray(res.modalContent) ? res.modalContent : [res.modalContent],
      }
    } else {
      currentIframeProject = projectName
      // Publish loader first so user sees spinner while iframe connects
      publishModalLoading(context, {
        en: `Loading Graph Explorer for ${projectName}...`,
        fr: `Chargement de l’explorateur de graphe pour ${projectName}...`,
      })
      const res = await updateAllUi(context, currentIframeProject, activeWorkdirContext, activeProjectNameContext, currentPendingDeleteProject, false)
      return {
        success: true,
        activeIframeProject: currentIframeProject,
        content: Array.isArray(res.modalContent) ? res.modalContent : [res.modalContent],
      }
    }
  })

  registry.registerRpc('cbm.requestUnsync', async (params: Record<string, unknown>) => {
    const projectName = typeof params?.['projectName'] === 'string' ? params['projectName'] : undefined
    const rawWorkdir = typeof params?.['workdir'] === 'string' ? params['workdir'] : undefined
    currentPendingDeleteProject = projectName
    await updateAllUi(context, currentIframeProject, rawWorkdir, undefined, currentPendingDeleteProject)
    return { success: true, pendingDeleteProject: currentPendingDeleteProject }
  })

  registry.registerRpc('cbm.cancelUnsync', async (params?: Record<string, unknown>) => {
    const rawWorkdir = typeof params?.['workdir'] === 'string' ? params['workdir'] : undefined
    currentPendingDeleteProject = undefined
    await updateAllUi(context, currentIframeProject, rawWorkdir, undefined, undefined)
    return { success: true }
  })

  registry.registerRpc('cbm.confirmUnsync', async (params: Record<string, unknown>) => {
    const projectName = typeof params?.['projectName'] === 'string' ? params['projectName'] : undefined
    const rawWorkdir = typeof params?.['workdir'] === 'string' ? params['workdir'] : undefined
    if (!projectName) return { success: false, error: 'Missing projectName' }

    publishModalLoading(context, {
      en: `Unsyncing ${projectName}...`,
      fr: `Désynchronisation de ${projectName}...`,
    })
    context.notify({
      title: { en: 'Unsyncing project...', fr: 'Désynchronisation du projet...' },
      body: { en: `Removing ${projectName} from Codebase Memory`, fr: `Suppression de ${projectName} de Codebase Memory` },
      level: 'info',
    })

    const res = await client.deleteProject(projectName)
    currentPendingDeleteProject = undefined

    if (res.success) {
      cachedProjects = []
      cachedIndexedStatus.clear()
      context.notify({
        title: { en: 'Project unsynced', fr: 'Projet désynchronisé' },
        body: { en: `Successfully removed ${projectName}`, fr: `${projectName} supprimé avec succès` },
        level: 'success',
      })
    } else {
      context.notify({
        title: { en: 'Unsync failed', fr: 'Échec de la désynchronisation' },
        body: { en: res.error || 'Unknown error', fr: res.error || 'Erreur inconnue' },
        level: 'error',
      })
    }
    await updateAllUi(context, currentIframeProject, rawWorkdir, undefined, undefined, true)
    return res
  })

  registry.registerRpc('cbm.indexProject', async (params: Record<string, unknown>) => {
    let repoPath = typeof params?.['repoPath'] === 'string' ? params['repoPath'] : process.cwd()
    const projectName = typeof params?.['projectName'] === 'string' ? params['projectName'] : undefined

    if (!fs.existsSync(repoPath) && projectName) {
      const candidate = path.join(os.homedir(), 'Documents/Dev/Perso', projectName)
      if (fs.existsSync(candidate)) {
        repoPath = candidate
      }
    }
    
    // Update UI to show button spinner specifically on this project
    await updateAllUi(context, currentIframeProject, undefined, undefined, undefined, false, projectName || repoPath)

    context.notify({
      title: { en: 'Indexing repository...', fr: 'Indexation du dépôt...' },
      body: { en: `Indexing ${projectName || repoPath} into Codebase Memory MCP`, fr: `Indexation de ${projectName || repoPath} dans Codebase Memory MCP` },
      level: 'info',
    })
    const res = await client.indexRepository(repoPath, projectName)
    if (res.success) {
      cachedProjects = []
      cachedIndexedStatus.clear()
      context.notify({
        title: { en: 'Repository indexed', fr: 'Dépôt indexé' },
        body: { en: `Successfully indexed ${projectName || repoPath}`, fr: `Dépôt ${projectName || repoPath} indexé avec succès` },
        level: 'success',
      })
    } else {
      context.notify({
        title: { en: 'Indexing failed', fr: 'Échec de l’indexation' },
        body: { en: res.error || 'Unknown error', fr: res.error || 'Erreur inconnue' },
        level: 'error',
      })
    }
    // Remove spinner and refresh projects list
    await updateAllUi(context, currentIframeProject, undefined, undefined, undefined, true, undefined)
    return res
  })

  registry.registerRpc('cbm.forceSync', async (params: Record<string, unknown>) => {
    let repoPath = typeof params?.['repoPath'] === 'string' ? params['repoPath'] : process.cwd()
    const projectName = typeof params?.['projectName'] === 'string' ? params['projectName'] : undefined

    if (!fs.existsSync(repoPath) && projectName) {
      const candidate = path.join(os.homedir(), 'Documents/Dev/Perso', projectName)
      if (fs.existsSync(candidate)) {
        repoPath = candidate
      }
    }
    
    publishModalLoading(context, { en: 'Syncing repository...', fr: 'Synchronisation du dépôt...' })

    context.notify({
      title: { en: 'Syncing repository...', fr: 'Synchronisation du dépôt...' },
      body: { en: `Re-indexing ${projectName || repoPath}`, fr: `Ré-indexation de ${projectName || repoPath}` },
      level: 'info',
    })
    const res = await client.indexRepository(repoPath, projectName, 'full')
    if (res.success) {
      cachedProjects = []
      cachedIndexedStatus.clear()
      context.notify({
        title: { en: 'Synchronization completed', fr: 'Synchronisation terminée' },
        body: { en: `Successfully synced ${projectName || repoPath}`, fr: `Synchronisation de ${projectName || repoPath} réussie` },
        level: 'success',
      })
    } else {
      context.notify({
        title: { en: 'Sync failed', fr: 'Échec de la synchronisation' },
        body: { en: res.error || 'Unknown error', fr: res.error || 'Erreur inconnue' },
        level: 'error',
      })
    }
    // Refresh status
    await updateAllUi(context, currentIframeProject, undefined, undefined, undefined, true, undefined)
    return res
  })

  registry.registerRpc('cbm.toggleAutoIndex', async (params?: Record<string, unknown>) => {
    const workdir = (typeof params?.['workdir'] === 'string' && params['workdir']) || process.cwd()
    const settings = readSettings(context)
    const nextVal = !settings.autoIndexOnSessionStart
    autoIndexOverride = nextVal
    publishModalLoading(context, { en: 'Updating setting...', fr: 'Mise à jour du paramètre...' })
    context.notify({
      title: { en: 'Auto-index setting updated', fr: 'Paramètre d’auto-indexation mis à jour' },
      body: {
        en: `Automatic indexing is now ${nextVal ? 'enabled' : 'disabled'}`,
        fr: `L’indexation automatique est maintenant ${nextVal ? 'activée' : 'désactivée'}`,
      },
      level: 'info',
    })
    await updateAllUi(context, currentIframeProject, workdir)
    return { success: true, autoIndexOnSessionStart: nextVal }
  })

  registry.registerRpc('cbm.getStatus', async (params?: Record<string, unknown>) => {
    const workdir = (typeof params?.['workdir'] === 'string' && params['workdir']) || process.cwd()
    const { indexed, project } = await client.isProjectIndexed(workdir)
    const installationStatus = await client.checkInstallation()
    return { indexed, project, workdir, installationStatus }
  })

  registry.registerRpc('cbm.checkInstallationStatus', async () => {
    const status = await client.checkInstallation()
    if (status.installed) {
      return {
        installed: true,
        statusTone: 'success',
        statusText: {
          en: status.version ? `Installed (v${status.version})` : 'Installed on OS',
          fr: status.version ? `Installé (v${status.version})` : 'Installé sur l’OS',
        },
      }
    }
    return {
      installed: false,
      statusTone: 'danger',
      statusText: {
        en: 'Not installed on OS',
        fr: 'Non installé sur l’OS',
      },
    }
  })

  registry.registerRpc('cbm.installBinary', async (params?: Record<string, unknown>) => {
    const { workdir: rawWorkdir, projectName } = await resolveProjectContext(params)

    publishModalLoading(context, {
      en: 'Installing codebase-memory-mcp on your system...',
      fr: 'Installation de codebase-memory-mcp sur votre système...',
    })
    context.notify({
      title: { en: 'Installing Codebase Memory...', fr: 'Installation de Codebase Memory...' },
      body: {
        en: 'Running official installer script for your OS...',
        fr: 'Exécution du script d’installation officiel pour votre OS...',
      },
      level: 'info',
    })

    const res = await client.installCodebaseMemory()
    if (res.success) {
      cachedProjects = []
      cachedIndexedStatus.clear()
      context.notify({
        title: { en: 'Installation complete', fr: 'Installation terminée' },
        body: {
          en: 'codebase-memory-mcp was installed. Restart OpenFox so the new PATH is picked up.',
          fr: 'codebase-memory-mcp a été installé. Redémarrez OpenFox pour prendre en compte le nouveau PATH.',
        },
        level: 'success',
      })
    } else {
      context.notify({
        title: { en: 'Installation failed', fr: 'Échec de l’installation' },
        body: {
          en: res.error || 'Failed to install codebase-memory-mcp',
          fr: res.error || 'Échec de l’installation de codebase-memory-mcp',
        },
        level: 'error',
      })
    }

    await updateAllUi(context, currentIframeProject, rawWorkdir, projectName, currentPendingDeleteProject, true, undefined)
    return res
  })

  // Hook on session start to auto-index if enabled
  if (typeof registry.registerHook === 'function') {
    registry.registerHook('session.started', async (payload: any) => {
      const settings = readSettings(context)
      if (settings.autoIndexOnSessionStart) {
        const workdir = payload?.workdir || process.cwd()
        const { indexed } = await client.isProjectIndexed(workdir)
        if (indexed) {
          await client.indexRepository(workdir, payload?.projectName, 'fast')
          await updateAllUi(context, currentIframeProject, workdir)
        }
      }
    })
  }

  // Initial UI build - only register static components, don't publish server process.cwd()
}
