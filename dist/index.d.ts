interface LocalizedString {
    en: string;
    fr: string;
}
interface CbmProject {
    name: string;
    rootPath: string;
    branch?: string;
    nodes?: number;
    edges?: number;
    status?: string;
    indexedAt?: string;
}
interface PluginContext {
    settings(scope?: 'global' | 'project', projectId?: string): Record<string, unknown>;
    publish(panelId: string | undefined, key: string, value: unknown): void;
    notify(request: {
        title: LocalizedString;
        body?: LocalizedString;
        level?: 'info' | 'success' | 'warning' | 'error';
    }): void;
    projects?(): Array<{
        id: string;
        name: string;
        workdir: string;
    }>;
    logger: {
        debug(msg: string, ctx?: Record<string, unknown>): void;
        info(msg: string, ctx?: Record<string, unknown>): void;
        warn(msg: string, ctx?: Record<string, unknown>): void;
        error(msg: string, ctx?: Record<string, unknown>): void;
    };
}
interface PluginRegistry {
    readonly context: PluginContext;
    readonly runtime: {
        configDirectory: string;
    };
    registerSettings(schema: any): void;
    registerRpc(method: string, handler: any): void;
    registerUiPanel(panel: any): void;
    registerUiAction(action: any): void;
    registerUiComponent(component: any): void;
    registerSettingsTab(tab: any): void;
    registerTool(tool: any): void;
    registerHook(event: string, handler: any): void;
    registerAsset?(path: string): void;
}

declare class CodebaseMemoryClient {
    private command;
    private uiPort;
    constructor(command?: string, uiPort?: number);
    setCommand(cmd: string): void;
    setUiPort(port: number): void;
    getUiUrl(projectName?: string): string;
    runCli(tool: string, args?: Record<string, unknown>): Promise<any>;
    listProjectsFromSqlite(): Promise<CbmProject[]>;
    listProjects(withStatus?: boolean): Promise<CbmProject[]>;
    private parseListProjectsText;
    isProjectIndexed(workdir?: string, projectName?: string): Promise<{
        indexed: boolean;
        project?: CbmProject;
    }>;
    indexRepository(repoPath: string, name?: string, mode?: 'full' | 'moderate' | 'fast'): Promise<{
        success: boolean;
        error?: string;
    }>;
    deleteProject(projectName: string): Promise<{
        success: boolean;
        error?: string;
    }>;
    getIndexStatus(projectName: string): Promise<any>;
}

declare function getClient(): CodebaseMemoryClient;
declare function fetchOpenFoxProjects(contextConfigDir?: string): Promise<Array<{
    id: string;
    name: string;
    workdir: string;
}>>;
declare function buildHeaderComponent(isIndexed: boolean, showHeader: boolean): {
    type: "stack";
    direction: "row";
    children: never[];
    variant?: undefined;
    label?: undefined;
    tooltip?: undefined;
    icon?: undefined;
    onActivate?: undefined;
} | {
    type: "button";
    variant: "ghost";
    label: {
        en: string;
        fr: string;
    };
    tooltip: {
        en: string;
        fr: string;
    };
    icon: string;
    onActivate: {
        kind: "openPanel";
        panelId: string;
    };
    direction?: undefined;
    children?: undefined;
};
declare function buildComposerTopComponent(isIndexed: boolean, projectName?: string, workdir?: string): {
    type: "badge";
    tone: "success";
    label: {
        en: string;
        fr: string;
    };
    tooltip: {
        en: string;
        fr: string;
    };
    variant?: undefined;
    onActivate?: undefined;
} | {
    type: "button";
    variant: "ghost";
    label: {
        en: string;
        fr: string;
    };
    tooltip: {
        en: string;
        fr: string;
    };
    onActivate: {
        kind: "rpc";
        method: string;
        params: {
            repoPath: string | undefined;
            projectName: string | undefined;
        };
    };
    tone?: undefined;
};
declare function formatSyncDate(isoStr?: string): {
    en: string;
    fr: string;
} | undefined;
declare function buildLoadingContent(message?: LocalizedString): {
    type: "stack";
    direction: "column";
    gap: "sm";
    align: "center";
    justify: "center";
    className: string;
    children: ({
        type: "icon";
        icon: string;
        className: string;
        text?: undefined;
    } | {
        type: "text";
        text: LocalizedString;
        className: string;
        icon?: undefined;
    })[];
};
declare function buildModalContent(projects: CbmProject[], currentWorkdir: string | undefined, currentIndexed: boolean, currentProject: CbmProject | undefined, autoIndexEnabled: boolean, activeIframeProject?: string, uiPort?: number, isLoading?: boolean, activeProjectName?: string, pendingDeleteProject?: string, syncingProject?: string, allOpenFoxProjects?: Array<{
    id: string;
    name: string;
    workdir: string;
}>): {
    type: "stack";
    direction: "column";
    gap: "sm";
    align: "center";
    justify: "center";
    className: string;
    children: ({
        type: "icon";
        icon: string;
        className: string;
        text?: undefined;
    } | {
        type: "text";
        text: LocalizedString;
        className: string;
        icon?: undefined;
    })[];
} | {
    type: string;
    direction: string;
    gap: string;
    className: string;
    children: any[];
};
declare function updateAllUi(context: PluginContext, activeIframeProject?: string, runtimeWorkdir?: string, runtimeProjectName?: string, pendingDeleteProject?: string, forceRefreshProjects?: boolean, syncingProject?: string): Promise<{
    indexed: boolean;
    projects: CbmProject[];
    modalContent: {
        type: "stack";
        direction: "column";
        gap: "sm";
        align: "center";
        justify: "center";
        className: string;
        children: ({
            type: "icon";
            icon: string;
            className: string;
            text?: undefined;
        } | {
            type: "text";
            text: LocalizedString;
            className: string;
            icon?: undefined;
        })[];
    } | {
        type: string;
        direction: string;
        gap: string;
        className: string;
        children: any[];
    };
}>;
declare function register(registry: PluginRegistry): Promise<void>;

export { buildComposerTopComponent, buildHeaderComponent, buildLoadingContent, buildModalContent, fetchOpenFoxProjects, formatSyncDate, getClient, register, updateAllUi };
