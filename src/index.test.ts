import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  register,
  updateAllUi,
  getClient,
  buildHeaderComponent,
  buildComposerTopComponent,
  buildModalContent,
  formatSyncDate,
} from './index.js'
import type { PluginRegistry, PluginContext } from './types.js'

describe('openfox-codebase-memory plugin', () => {
  let mockContext: PluginContext
  let mockRegistry: PluginRegistry

  beforeEach(() => {
    vi.restoreAllMocks()
    vi.spyOn(getClient(), 'listProjects').mockResolvedValue([])
    vi.spyOn(getClient(), 'isProjectIndexed').mockResolvedValue({ indexed: false })
    vi.spyOn(getClient(), 'indexRepository').mockResolvedValue({ success: true })

    mockContext = {
      settings: vi.fn().mockReturnValue({
        showHeaderButton: false,
        uiPort: 9749,
        autoIndexOnSessionStart: false,
      }),
      publish: vi.fn(),
      notify: vi.fn(),
      logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
    }

    mockRegistry = {
      context: mockContext,
      runtime: {
        configDirectory: '/tmp/openfox-test',
      },
      registerSettings: vi.fn(),
      registerRpc: vi.fn(),
      registerUiPanel: vi.fn(),
      registerUiAction: vi.fn(),
      registerUiComponent: vi.fn(),
      registerSettingsTab: vi.fn(),
      registerTool: vi.fn(),
      registerHook: vi.fn(),
    }
  })

  it('registers settings, panel, actions and rpc methods', async () => {
    await register(mockRegistry)

    expect(mockRegistry.registerSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        fields: expect.arrayContaining([
          expect.objectContaining({ key: 'cbmStatus', type: 'status' }),
          expect.objectContaining({ key: 'cbmInstall', type: 'button' }),
          expect.objectContaining({ key: 'showHeaderButton', type: 'boolean' }),
        ]),
      }),
    )
    expect(mockRegistry.registerUiPanel).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'cbm-modal',
        kind: 'declarative',
      }),
    )
    expect(mockRegistry.registerUiAction).toHaveBeenCalledWith(
      expect.objectContaining({
        slot: 'plugin.menu',
      }),
    )
    expect(mockRegistry.registerRpc).toHaveBeenCalledWith('cbm.refreshModal', expect.any(Function))
    expect(mockRegistry.registerRpc).toHaveBeenCalledWith('cbm.getHeaderBtn', expect.any(Function))
    expect(mockRegistry.registerRpc).toHaveBeenCalledWith('cbm.toggleIframe', expect.any(Function))
    expect(mockRegistry.registerRpc).toHaveBeenCalledWith('cbm.indexProject', expect.any(Function))
    expect(mockRegistry.registerRpc).toHaveBeenCalledWith('cbm.forceSync', expect.any(Function))
    expect(mockRegistry.registerRpc).toHaveBeenCalledWith('cbm.toggleAutoIndex', expect.any(Function))
    expect(mockRegistry.registerRpc).toHaveBeenCalledWith('cbm.checkInstallationStatus', expect.any(Function))
    expect(mockRegistry.registerRpc).toHaveBeenCalledWith('cbm.installBinary', expect.any(Function))
  })

  it('builds header component based on showHeader setting and sync status', () => {
    // When showHeader is false
    const hidden = buildHeaderComponent(true, false)
    expect(hidden.type).toBe('stack')
    expect(hidden.children).toHaveLength(0)

    // When showHeader is true and indexed
    const visibleIndexed = buildHeaderComponent(true, true)
    expect(visibleIndexed.type).toBe('button')
    expect(visibleIndexed.icon).toContain('#22c55e') // Green dot

    // When showHeader is true and not indexed
    const visibleNotIndexed = buildHeaderComponent(false, true)
    expect(visibleNotIndexed.type).toBe('button')
    expect(visibleNotIndexed.icon).toContain('#ef4444') // Red dot
  })

  it('builds composer top component with status badge when indexed', () => {
    const comp = buildComposerTopComponent(true, 'my-project', '/tmp/repo')
    expect(comp.type).toBe('badge')
    expect(comp.tone).toBe('success')
    expect(comp.label.en).toBe('Memory: Synced')
    expect(comp.label.fr).toBe('Memory : Synchronisé')
  })

  it('builds composer top component with a clickable text when not indexed', () => {
    const comp = buildComposerTopComponent(false, undefined, '/tmp/repo')
    expect(comp.type).toBe('button')
    expect(comp.variant).toBe('ghost')
    expect(comp.label.en).toBe('Add this project to Memory MCP')
    expect(comp.label.fr).toBe('Ajouter ce projet au memory mcp')
    expect(comp.onActivate).toEqual({
      kind: 'rpc',
      method: 'cbm.indexProject',
      params: { repoPath: '/tmp/repo', projectName: undefined },
    })
  })

  it('renders a spinner loader while the modal is loading', () => {
    const loading = buildModalContent([], '/tmp/repo', false, undefined, false, undefined, 9749, true)

    expect(loading.type).toBe('stack')
    expect(loading.children[0].type).toBe('icon')
    expect(loading.children[0].className).toContain('animate-spin')
    expect(loading.children[1].type).toBe('text')
    expect(loading.children[1].text.fr).toContain('Chargement')
  })

  it('publishes the modal content as an array of declarative nodes', async () => {
    await updateAllUi(mockContext)

    const modalPublishes = (mockContext.publish as ReturnType<typeof vi.fn>).mock.calls.filter(
      (call: unknown[]) => call[0] === 'cbm-modal' && call[1] === 'content',
    )
    expect(modalPublishes.length).toBeGreaterThan(0)
    for (const call of modalPublishes) {
      expect(Array.isArray(call[2])).toBe(true)
    }
  })

  it('publishes a spinner loader while long running operations are in flight', async () => {
    const handlers = new Map<string, (params?: Record<string, unknown>) => Promise<unknown>>()
    mockRegistry.registerRpc = vi.fn((method: string, handler: (params?: Record<string, unknown>) => Promise<unknown>) => {
      handlers.set(method, handler)
    }) as unknown as PluginRegistry['registerRpc']

    await register(mockRegistry)
    ;(mockContext.publish as ReturnType<typeof vi.fn>).mockClear()

    await handlers.get('cbm.forceSync')!({ repoPath: '/tmp/repo' })

    const modalCalls = (mockContext.publish as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c: unknown[]) => c[0] === 'cbm-modal' && c[1] === 'content',
    )
    expect(modalCalls.length).toBeGreaterThan(0)
    const firstModalPublish = modalCalls[0]
    const loader = (firstModalPublish?.[2] as any[])[0]
    expect(loader.children[0].className).toContain('animate-spin')
  })

  it('builds modal content with projects list, full-modal iframe support, and auto-index states', () => {
    const projects = [
      { name: 'project-1', rootPath: '/tmp/repo1' },
      { name: 'project-2', rootPath: '/tmp/repo2' },
    ]

    // Modal when project is NOT indexed
    const modalNotIndexed = buildModalContent(
      projects,
      '/tmp/repo3',
      false,
      undefined,
      true,
    )
    expect(modalNotIndexed.type).toBe('stack')
    const configCard = modalNotIndexed.children[1]
    expect(configCard.children[0].type).toBe('stack') // Global Auto-index card
    expect(configCard.className).toBe('w-full')

    // Modal when project IS indexed
    const modalIndexed = buildModalContent(
      projects,
      '/tmp/repo1',
      true,
      projects[0],
      true,
    )
    const indexedConfigCard = modalIndexed.children[1]
    expect(indexedConfigCard.children[0].className).toContain('w-full') // Auto-index is active

    // Project cards have styled buttons (Force Sync = default, Graph UI = primary, Unsync = danger)
    const projectsSection = modalIndexed.children[2]
    const projectCard = projectsSection.children[1]
    const actionStack = projectCard.children[0].children[0].children[1]
    expect(actionStack.children[0].variant).toBe('default') // Force Sync
    expect(actionStack.children[1].variant).toBe('primary') // Graph UI
    expect(actionStack.children[2].variant).toBe('danger') // Unsync

    // Modal with active iframe renders full-modal layout with back button
    const modalWithIframe = buildModalContent(
      projects,
      '/tmp/repo1',
      true,
      projects[0],
      true,
      'project-1',
      9749,
    )
    expect(modalWithIframe.children[0].type).toBe('card') // Header card with back button
    expect(modalWithIframe.children[1].type).toBe('iframe')
    expect(modalWithIframe.children[1].url).toContain('/api/plugins/openfox-codebase-memory/assets/assets/index.html?tab=graph&project=project-1')
  })

  it('renders OpenFox projects section when unsynced projects exist', () => {
    const projects = [{ name: 'project-1', rootPath: '/tmp/repo1' }]
    const openFoxProjects = [
      { id: '1', name: 'project-1', workdir: '/tmp/repo1' },
      { id: '2', name: 'discord-rag', workdir: '/tmp/discord-rag' },
    ]

    const modalWithUnsynced = buildModalContent(
      projects,
      '/tmp/discord-rag',
      false,
      undefined,
      true,
      undefined,
      9749,
      false,
      'discord-rag',
      undefined,
      undefined,
      openFoxProjects,
    )

    // Section 4 is OpenFox Projects
    const unsyncedSection = modalWithUnsynced.children[3]
    expect(unsyncedSection).toBeDefined()
    expect(unsyncedSection.children[0].text.en).toBe('OpenFox Projects')
    expect(unsyncedSection.children[0].text.fr).toBe('Projets OpenFox')
    const unsyncedCard = unsyncedSection.children[1]
    const leftStack = unsyncedCard.children[0].children[0]
    const headerStack = leftStack.children[0]
    expect(headerStack.children[0].text.en).toBe('discord-rag')
    // Should have Current Project badge since workdir matches
    expect(headerStack.children[1].type).toBe('badge')
    expect(headerStack.children[1].label.en).toBe('Current Project')
    expect(headerStack.children[1].label.fr).toBe('Projet actuel')

    const syncButton = unsyncedCard.children[0].children[1]
    expect(syncButton.type).toBe('button')
    expect(syncButton.variant).toBe('primary')
    expect(syncButton.label.en).toBe('Add to Memory')
    expect(syncButton.label.fr).toBe('Ajouter au Memory')
    expect(syncButton.onActivate).toEqual({
      kind: 'rpc',
      method: 'cbm.indexProject',
      params: { repoPath: '/tmp/discord-rag', projectName: 'discord-rag' },
    })
  })

  it('sorts the current project to the very top of Synchronized Projects and OpenFox Projects', () => {
    const projects = [
      { name: 'aaa-project', rootPath: '/tmp/aaa' },
      { name: 'current-synced', rootPath: '/tmp/current-synced' },
      { name: 'zzz-project', rootPath: '/tmp/zzz' },
    ]
    const openFoxProjects = [
      { id: '1', name: 'bbb-project', workdir: '/tmp/bbb' },
      { id: '2', name: 'current-unsynced', workdir: '/tmp/current-unsynced' },
      { id: '3', name: 'ccc-project', workdir: '/tmp/ccc' },
    ]

    // 1. When current project is in Synchronized Projects
    const modalSyncedCurrent = buildModalContent(
      projects,
      '/tmp/current-synced',
      true,
      projects[1],
      true,
      undefined,
      9749,
      false,
      'current-synced',
      undefined,
      undefined,
      openFoxProjects,
    )
    const syncedSection = modalSyncedCurrent.children[2]
    const firstSyncedCard = syncedSection.children[1]
    const firstSyncedTitle = firstSyncedCard.children[0].children[0].children[0].children[0].children[0].text.en
    expect(firstSyncedTitle).toBe('current-synced')

    // 2. When current project is in OpenFox Projects
    const modalUnsyncedCurrent = buildModalContent(
      projects,
      '/tmp/current-unsynced',
      false,
      undefined,
      true,
      undefined,
      9749,
      false,
      'current-unsynced',
      undefined,
      undefined,
      openFoxProjects,
    )
    const unsyncedSection = modalUnsyncedCurrent.children[3]
    const firstUnsyncedCard = unsyncedSection.children[1]
    const firstUnsyncedTitle = firstUnsyncedCard.children[0].children[0].children[0].children[0].text.en
    expect(firstUnsyncedTitle).toBe('current-unsynced')
  })

  it('renders empty message when all OpenFox projects are synchronized', () => {
    const projects = [{ name: 'project-1', rootPath: '/tmp/repo1' }]
    const openFoxProjects = [{ id: '1', name: 'project-1', workdir: '/tmp/repo1' }]

    const modal = buildModalContent(
      projects,
      '/tmp/repo1',
      true,
      projects[0],
      true,
      undefined,
      9749,
      false,
      'project-1',
      undefined,
      undefined,
      openFoxProjects,
    )

    const openFoxSection = modal.children[3]
    expect(openFoxSection).toBeDefined()
    expect(openFoxSection.children[0].text.en).toBe('OpenFox Projects')
    expect(openFoxSection.children[1].type).toBe('text')
    expect(openFoxSection.children[1].text.en).toBe('All OpenFox projects are already synchronized.')
    expect(openFoxSection.children[1].text.fr).toBe('Tous les projets OpenFox sont déjà synchronisés.')
  })

  it('renders loading spinner button when an OpenFox project is currently syncing', () => {
    const projects = [{ name: 'project-1', rootPath: '/tmp/repo1' }]
    const openFoxProjects = [
      { id: '1', name: 'project-1', workdir: '/tmp/repo1' },
      { id: '2', name: 'discord-rag', workdir: '/tmp/discord-rag' },
    ]

    const modal = buildModalContent(
      projects,
      '/tmp/repo1',
      true,
      projects[0],
      true,
      undefined,
      9749,
      false,
      'project-1',
      undefined,
      'discord-rag',
      openFoxProjects,
    )

    const openFoxSection = modal.children[3]
    const card = openFoxSection.children[1]
    const syncButton = card.children[0].children[1]
    expect(syncButton.disabled).toBe(true)
    expect(syncButton.label.en).toBe('Syncing…')
    expect(syncButton.label.fr).toBe('Indexation…')
    expect(syncButton.icon).toBeDefined()
    expect(syncButton.onActivate).toBeUndefined()
  })

  it('does not duplicate synced projects in OpenFox projects list even with different path variations', () => {
    const projects = [{ name: 'discord-rag', rootPath: '/Users/Renaud.Lefevre/Documents/Dev/Perso/discord-rag' }]
    const openFoxProjects = [
      { id: '1', name: 'discord-rag', workdir: '/Users/Renaud.Lefevre/Documents/Dev/Perso/openfox/discord-rag' },
      { id: '2', name: 'super-arr', workdir: '/Users/Renaud.Lefevre/Documents/Dev/Perso/super-arr' },
    ]

    const modal = buildModalContent(
      projects,
      '/Users/Renaud.Lefevre/Documents/Dev/Perso/openfox/discord-rag',
      true,
      projects[0],
      true,
      undefined,
      9749,
      false,
      'discord-rag',
      undefined,
      undefined,
      openFoxProjects,
    )

    // Synchronized Projects has discord-rag with Current Project badge
    const syncedSection = modal.children[2]
    const syncedCard = syncedSection.children[1]
    const headerStack = syncedCard.children[0].children[0].children[0].children[0]
    expect(headerStack.children[0].text.en).toBe('discord-rag')
    expect(headerStack.children[1].label.en).toBe('Current Project')

    // OpenFox Projects only has super-arr (discord-rag is excluded because it is already synced)
    const openFoxSection = modal.children[3]
    expect(openFoxSection.children).toHaveLength(2) // title + 1 card
    const openFoxCard = openFoxSection.children[1]
    const openFoxTitle = openFoxCard.children[0].children[0].children[0].children[0].text.en
    expect(openFoxTitle).toBe('super-arr')
  })

  it('renders confirmation card when unsync is requested', () => {
    const projects = [{ name: 'project-1', rootPath: '/tmp/repo1' }]
    const modalConfirming = buildModalContent(
      projects,
      '/tmp/repo1',
      true,
      projects[0],
      true,
      undefined,
      9749,
      false,
      undefined,
      'project-1',
    )
    const projectsSection = modalConfirming.children[2]
    const projectCard = projectsSection.children[1]
    const cardStack = projectCard.children[0]
    expect(cardStack.children[1].type).toBe('callout')
    expect(cardStack.children[2].type).toBe('stack')
  })

  it('returns synced badge for cbm.getComposerTop when project is indexed under different path variation', async () => {
    const handlers = new Map<string, (params?: Record<string, unknown>) => Promise<unknown>>()
    mockRegistry.registerRpc = vi.fn((method: string, handler: (params?: Record<string, unknown>) => Promise<unknown>) => {
      handlers.set(method, handler)
    }) as unknown as PluginRegistry['registerRpc']

    vi.spyOn(getClient(), 'listProjects').mockResolvedValue([
      { name: 'Users-Renaud.Lefevre-Documents-Dev-Perso-discord-rag', rootPath: '/Users/Renaud.Lefevre/Documents/Dev/Perso/discord-rag' },
    ])
    vi.spyOn(getClient(), 'isProjectIndexed').mockImplementation(async (workdir?: string, projectName?: string) => {
      if (projectName === 'discord-rag' || (workdir && workdir.includes('discord-rag'))) {
        return { indexed: true, project: { name: 'discord-rag', rootPath: '/Users/Renaud.Lefevre/Documents/Dev/Perso/discord-rag' } }
      }
      return { indexed: false }
    })

    await register(mockRegistry)

    const result = (await handlers.get('cbm.getComposerTop')!({
      workdir: '/Users/Renaud.Lefevre/Documents/Dev/Perso/openfox/discord-rag',
      projectName: 'discord-rag',
    })) as { content: any }

    expect(result.content.type).toBe('badge')
    expect(result.content.tone).toBe('success')
    expect(result.content.label.en).toContain('Memory: Synced')
  })

  it('formats last sync date nicely and renders it on project cards', () => {
    const formatted = formatSyncDate('2026-09-29T06:04:54Z')
    expect(formatted).toBeDefined()
    expect(formatted!.en).toContain('Last sync:')
    expect(formatted!.fr).toContain('Dernière synchro :')

    const projects = [
      { name: 'project-1', rootPath: '/tmp/repo1', indexedAt: '2026-09-29T06:04:54Z' },
    ]

    const modal = buildModalContent(
      projects,
      '/tmp/repo1',
      true,
      projects[0],
      true,
    )
    const syncedSection = modal.children[2]
    const card = syncedSection.children[1]
    const textStack = card.children[0].children[0].children[0]
    expect(textStack.children[2]).toBeDefined()
    expect(textStack.children[2].text.en).toContain('Last sync:')
    expect(textStack.children[2].text.fr).toContain('Dernière synchro :')
  })

  it('updates header button dynamically via cbm.getHeaderBtn', async () => {
    const handlers = new Map<string, (params?: Record<string, unknown>) => Promise<unknown>>()
    mockRegistry.registerRpc = vi.fn((method: string, handler: (params?: Record<string, unknown>) => Promise<unknown>) => {
      handlers.set(method, handler)
    }) as unknown as PluginRegistry['registerRpc']

    mockContext.settings = vi.fn().mockReturnValue({ showHeaderButton: true })
    vi.spyOn(getClient(), 'isProjectIndexed').mockResolvedValue({ indexed: true })

    await register(mockRegistry)

    const result = (await handlers.get('cbm.getHeaderBtn')!({
      workdir: '/tmp/repo1',
      projectName: 'repo1',
    })) as { content: any }

    expect(result.content.type).toBe('button')
    expect(result.content.icon).toContain('#22c55e')
  })

  it('does not render the OS installation status card in the modal', () => {
    const modal = buildModalContent(
      [],
      '/tmp/repo1',
      false,
      undefined,
      true,
      undefined,
      9749,
      false,
      'repo1',
      undefined,
      undefined,
      [],
    )

    const serialized = JSON.stringify(modal)
    expect(serialized).not.toContain('OS Installation Status')
    expect(serialized).not.toContain('Reinstall / Update')
    expect(serialized).not.toContain('cbm.installBinary')

    // Auto-index card is now the second child
    expect(modal.children[1].children[0].type).toBe('stack')
  })

  it('handles cbm.checkInstallationStatus and cbm.installBinary RPCs', async () => {
    const handlers = new Map<string, (params?: Record<string, unknown>) => Promise<unknown>>()
    mockRegistry.registerRpc = vi.fn((method: string, handler: (params?: Record<string, unknown>) => Promise<unknown>) => {
      handlers.set(method, handler)
    }) as unknown as PluginRegistry['registerRpc']

    vi.spyOn(getClient(), 'checkInstallation').mockResolvedValue({
      installed: true,
      version: '0.11.0',
    })
    vi.spyOn(getClient(), 'installCodebaseMemory').mockResolvedValue({
      success: true,
    })

    await register(mockRegistry)

    const checkResult = await handlers.get('cbm.checkInstallationStatus')!()
    expect(checkResult).toEqual({
      installed: true,
      statusTone: 'success',
      statusText: { en: 'Installed (v0.11.0)', fr: 'Installé (v0.11.0)' },
    })

    const installResult = (await handlers.get('cbm.installBinary')!({})) as { success: boolean }
    expect(installResult.success).toBe(true)
    expect(mockContext.notify).toHaveBeenCalledWith(
      expect.objectContaining({
        title: expect.objectContaining({ en: 'Installation complete' }),
      }),
    )
  })
})
