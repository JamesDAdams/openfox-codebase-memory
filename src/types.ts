export interface LocalizedString {
  en: string
  fr: string
}

export interface CbmInstallationStatus {
  installed: boolean
  version?: string
  path?: string
  error?: string
}

export interface CbmProject {
  name: string
  rootPath: string
  branch?: string
  nodes?: number
  edges?: number
  status?: string
  indexedAt?: string
}

export interface OpenFoxProject {
  id: string
  name: string
  workdir: string
}

export interface PluginContext {
  settings(scope?: 'global' | 'project', projectId?: string): Record<string, unknown>
  publish(panelId: string | undefined, key: string, value: unknown): void
  notify(request: {
    title: LocalizedString
    body?: LocalizedString
    level?: 'info' | 'success' | 'warning' | 'error'
  }): void
  projects?(): Array<{ id: string; name: string; workdir: string }>
  logger: {
    debug(msg: string, ctx?: Record<string, unknown>): void
    info(msg: string, ctx?: Record<string, unknown>): void
    warn(msg: string, ctx?: Record<string, unknown>): void
    error(msg: string, ctx?: Record<string, unknown>): void
  }
}

export interface PluginRegistry {
  readonly context: PluginContext
  readonly runtime: {
    configDirectory: string
  }
  registerSettings(schema: any): void
  registerRpc(method: string, handler: any): void
  registerUiPanel(panel: any): void
  registerUiAction(action: any): void
  registerUiComponent(component: any): void
  registerSettingsTab(tab: any): void
  registerTool(tool: any): void
  registerHook(event: string, handler: any): void
  registerAsset?(path: string): void
}

export interface CodebaseMemoryPluginSettings {
  showHeaderButton?: boolean
  uiPort?: number
  autoIndexOnSessionStart?: boolean
  mcpCommand?: string
}
