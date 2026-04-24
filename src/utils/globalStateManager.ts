import * as vscode from 'vscode';
import { Identity, BaseAPI, ProjectPersist } from '../api/base';
import { SocketIOAPI } from '../api/socketio';
import { ExtendedBaseAPI } from '../api/extendedBase';
import { logDiagnostic } from './diagnostics';
import {
    buildAuthAttemptFields,
    buildLoginFailureMessage,
    buildNotAuthenticatedMessage,
    buildSessionExpiredMessage,
} from './authFlow';

const keyServerPersists: string = 'overleaf-servers';
const keyPdfViewPersists: string = 'overleaf-pdf-viewers';

export interface ServerPersist {
    name: string;
    url: string;
    login?: {
        userId: string;
        username: string;
        identity?: Identity;
        identitySecretKey?: string;
        projects?: ProjectPersist[]
    };
}
type ServerPersistMap = {[name: string]: ServerPersist};

export interface ProjectSCMPersist {
    enabled: boolean;
    label: string;
    baseUri: string;
    settings: JSON;
}
type ProjectSCMPersistMap = {[name: string]: ProjectSCMPersist};

type PdfViewPersist = {
    frequency: number,
    state: any,
};
type PdfViewPersistMap = {[uri: string]: PdfViewPersist};

function buildServerIdentitySecretKey(name: string) {
    return `overleaf-workshop.serverIdentity.${encodeURIComponent(name)}`;
}

function isIdentity(value: unknown): value is Identity {
    if (!value || typeof value!=='object') {
        return false;
    }
    const identity = value as Partial<Identity>;
    return typeof identity.cookies==='string'
        && identity.cookies.trim().length > 0
        && typeof identity.csrfToken==='string';
}

function cloneIdentity(identity: Identity): Identity {
    return {
        cookies: identity.cookies,
        csrfToken: identity.csrfToken,
    };
}

export class GlobalStateManager {
    private static readonly identityCache = new Map<string, Identity>();

    private static logDiagnostic(event: string, fields: Record<string, unknown> = {}, error?: unknown) {
        logDiagnostic('AuthState', event, fields, error);
    }

    private static async deleteServerIdentitySecret(
        context: vscode.ExtensionContext,
        name: string,
        server?: ServerPersist,
    ) {
        const secretKey = server?.login?.identitySecretKey ?? buildServerIdentitySecretKey(name);
        this.identityCache.delete(secretKey);
        try {
            await context.secrets.delete(secretKey);
        } catch (error) {
            this.logDiagnostic('identity.secret_delete_failed', {
                serverName: name,
            }, error);
        }
    }

    private static async persistServerIdentity(
        context: vscode.ExtensionContext,
        persists: ServerPersistMap,
        name: string,
        identity: Identity,
    ): Promise<boolean> {
        const server = persists[name];
        if (server?.login===undefined) {
            return false;
        }

        const normalizedIdentity = cloneIdentity(identity);
        const secretKey = server.login.identitySecretKey ?? buildServerIdentitySecretKey(name);

        try {
            await context.secrets.store(secretKey, JSON.stringify(normalizedIdentity));
            this.identityCache.set(secretKey, normalizedIdentity);
            server.login.identitySecretKey = secretKey;
            delete server.login.identity;
            await context.globalState.update(keyServerPersists, persists);
            this.logDiagnostic('identity.secret_persisted', {
                cookieLength: normalizedIdentity.cookies.length,
                serverName: name,
            });
            return true;
        } catch (error) {
            // SecretStorage is the intended path, but keep the existing session
            // usable if VS Code rejects the secret write in a constrained host.
            server.login.identity = normalizedIdentity;
            await context.globalState.update(keyServerPersists, persists);
            this.logDiagnostic('identity.secret_persist_failed_fell_back_to_global_state', {
                serverName: name,
            }, error);
            return false;
        }
    }

    private static async loadServerIdentity(
        context: vscode.ExtensionContext,
        persists: ServerPersistMap,
        name: string,
    ): Promise<Identity | undefined> {
        const server = persists[name];
        const login = server?.login;
        if (!login) {
            return undefined;
        }

        const secretKey = login.identitySecretKey ?? buildServerIdentitySecretKey(name);
        const cachedIdentity = this.identityCache.get(secretKey);
        if (cachedIdentity) {
            return cloneIdentity(cachedIdentity);
        }

        if (isIdentity(login.identity)) {
            const identity = cloneIdentity(login.identity);
            await this.persistServerIdentity(context, persists, name, identity);
            return identity;
        }

        try {
            const serialized = await context.secrets.get(secretKey);
            if (!serialized) {
                return undefined;
            }
            const parsed = JSON.parse(serialized) as unknown;
            if (!isIdentity(parsed)) {
                this.logDiagnostic('identity.secret_invalid', {
                    serverName: name,
                });
                return undefined;
            }
            const identity = cloneIdentity(parsed);
            this.identityCache.set(secretKey, identity);
            if (login.identitySecretKey!==secretKey) {
                login.identitySecretKey = secretKey;
                await context.globalState.update(keyServerPersists, persists);
            }
            return cloneIdentity(identity);
        } catch (error) {
            this.logDiagnostic('identity.secret_load_failed', {
                serverName: name,
            }, error);
            return undefined;
        }
    }

    static getServers(context:vscode.ExtensionContext): {server:ServerPersist, api:BaseAPI}[] {
        const persists = context.globalState.get<ServerPersistMap>(keyServerPersists, {});
        const servers = Object.values(persists).map(persist => {
            return {
                server: persist,
                api: new BaseAPI(persist.url),
            };
        });

        if (servers.length===0) {
            const url = new URL('https://www.overleaf.com');
            this.addServer(context, url.host, url.href);
            return this.getServers(context);
        } else {
            return servers;
        }
    }

    static addServer(context:vscode.ExtensionContext, name:string, url:string): boolean {
        const persists = context.globalState.get<ServerPersistMap>(keyServerPersists, {});
        if ( persists[name]===undefined ) {
            persists[name] = { name, url };
            context.globalState.update(keyServerPersists, persists);
            return true;
        } else {
            return false;
        }
    }

    static removeServer(context:vscode.ExtensionContext, name:string): boolean {
        const persists = context.globalState.get<ServerPersistMap>(keyServerPersists, {});
        if ( persists[name]!==undefined ) {
            void this.deleteServerIdentitySecret(context, name, persists[name]);
            delete persists[name];
            context.globalState.update(keyServerPersists, persists);
            return true;
        } else {
            return false;
        }
    }

    static async loginServer(context:vscode.ExtensionContext, api:BaseAPI, name:string, auth:{[key:string]:string}): Promise<boolean> {
        const persists = context.globalState.get<ServerPersistMap>(keyServerPersists, {});
        const server   = persists[name];
        const authFields = buildAuthAttemptFields(auth);

        this.logDiagnostic('login.started', {
            alreadyLoggedIn: server.login!==undefined,
            serverName: name,
            ...authFields,
        });

        if (server.login===undefined) {
            const res = auth.cookies ? await api.cookiesLogin(auth.cookies) : await api.passportLogin(auth.email, auth.password);
            if (res.type==='success' && res.identity!==undefined && res.userInfo!==undefined) {
                server.login = {
                    userId: res.userInfo.userId,
                    username: auth.email || res.userInfo.userEmail,
                };
                await this.persistServerIdentity(context, persists, name, res.identity);
                this.logDiagnostic('login.succeeded', {
                    serverName: name,
                    userId: res.userInfo.userId,
                    username: auth.email || res.userInfo.userEmail,
                    ...authFields,
                });
                return true;
            } else {
                const failureMessage = res.message ?? buildLoginFailureMessage(authFields.method);
                this.logDiagnostic('login.failed', {
                    serverName: name,
                    ...authFields,
                }, failureMessage);
                if (res.message!==undefined) {
                    vscode.window.showErrorMessage(res.message);
                } else {
                    vscode.window.showErrorMessage(failureMessage);
                }
                return false;
            }
        } else {
            this.logDiagnostic('login.skipped_existing_session', {
                serverName: name,
                username: server.login.username,
                ...authFields,
            });
            return false;
        }
    }

    static async logoutServer(context:vscode.ExtensionContext, api:BaseAPI, name:string): Promise<boolean> {
        const persists = context.globalState.get<ServerPersistMap>(keyServerPersists, {});
        const server   = persists[name];
        this.logDiagnostic('logout.started', {
            hasSession: server.login!==undefined,
            serverName: name,
        });

        if (server.login!==undefined) {
            const identity = await this.loadServerIdentity(context, persists, name);
            if (identity) {
                await api.logout(identity);
            }
            await this.deleteServerIdentitySecret(context, name, server);
            delete server.login;
            await context.globalState.update(keyServerPersists, persists);
            this.logDiagnostic('logout.succeeded', {
                serverName: name,
            });
            return true;
        } else {
            this.logDiagnostic('logout.skipped_missing_session', {
                serverName: name,
            });
            return false;
        }
    }

    static async fetchServerProjects(context:vscode.ExtensionContext, api:BaseAPI, name:string): Promise<ProjectPersist[]> {
        const persists = context.globalState.get<ServerPersistMap>(keyServerPersists, {});
        const server   = persists[name];

        if (server.login!==undefined) {
            const identity = await this.loadServerIdentity(context, persists, name);
            if (!identity) {
                this.logDiagnostic('projects.fetch_skipped_missing_identity', {
                    serverName: name,
                    username: server.login.username,
                });
                return [];
            }
            this.logDiagnostic('projects.fetch_started', {
                serverName: name,
                username: server.login.username,
            });
            let res = await api.getProjectsJson(identity);
            if (res.type!=='success') {
                // fallback to `userProjectsJson`
                res = await api.userProjectsJson(identity);
            }
            if (res.type==='success' && res.projects!==undefined) {
                Object.values(res.projects).forEach(project => {
                    project.userId = (server.login as any).userId;
                });
                const projects = res.projects.map(project => {
                    const existProject = server.login?.projects?.find(p => p.id===project.id);
                    // merge existing scm
                    if (existProject) {
                        project.scm = existProject.scm;
                    }
                    return project;
                });
                server.login.projects = projects;
                await context.globalState.update(keyServerPersists, persists);
                this.logDiagnostic('projects.fetch_completed', {
                    projectCount: projects.length,
                    serverName: name,
                    username: server.login.username,
                });
                return projects;
            } else {
                // regex match for cookie expired
                const cookieExpireRegex = /^302/;
                if (res.message && cookieExpireRegex.test(res.message)) {
                    const message = vscode.l10n.t(buildSessionExpiredMessage());
                    this.logDiagnostic('projects.session_expired', {
                        serverName: name,
                        username: server.login.username,
                    }, res.message);
                    vscode.window.showErrorMessage(message);
                    return Promise.reject();
                }
                this.logDiagnostic('projects.fetch_failed', {
                    serverName: name,
                    username: server.login.username,
                }, res.message);
                if (res.message!==undefined) {
                    vscode.window.showErrorMessage(res.message);
                }
                return [];
            }
        } else {
            this.logDiagnostic('projects.fetch_skipped_missing_session', {
                serverName: name,
            });
            return [];
        }
    }

    static async authenticate(context:vscode.ExtensionContext, name:string): Promise<Identity> {
        const persists = context.globalState.get<ServerPersistMap>(keyServerPersists, {});
        const server   = persists[name];
        if (server?.login!==undefined) {
            const identity = await this.loadServerIdentity(context, persists, name);
            if (identity) {
                return identity;
            }
        }
        const error = new Error(buildNotAuthenticatedMessage(name));
        this.logDiagnostic('authenticate.rejected', {
            serverName: name,
        }, error);
        return Promise.reject(error);
    }

    static async updateServerIdentity(context:vscode.ExtensionContext, name:string, identity: Identity): Promise<boolean> {
        const persists = context.globalState.get<ServerPersistMap>(keyServerPersists, {});
        const server = persists[name];
        if (server?.login===undefined) {
            this.logDiagnostic('identity.update_skipped_missing_session', {
                serverName: name,
            });
            return false;
        }

        await this.persistServerIdentity(context, persists, name, identity);
        this.logDiagnostic('identity.updated', {
            cookieLength: identity.cookies.length,
            serverName: name,
        });
        return true;
    }

    static async initSocketIOAPI(context:vscode.ExtensionContext, name:string, projectId:string) {
        const persists = context.globalState.get<ServerPersistMap>(keyServerPersists, {});
        const server   = persists[name];

        if (server.login!==undefined) {
            const identity = await this.loadServerIdentity(context, persists, name);
            if (!identity) {
                this.logDiagnostic('socket.initialization_skipped_missing_identity', {
                    projectId,
                    serverName: name,
                    username: server.login.username,
                });
                return undefined;
            }
            const api = new ExtendedBaseAPI(server.url);
            const socket = new SocketIOAPI(server.url, api, identity, projectId);
            this.logDiagnostic('socket.initialized', {
                projectId,
                serverName: name,
                username: server.login.username,
            });
            return {api, socket};
        }
        this.logDiagnostic('socket.initialization_skipped_missing_session', {
            projectId,
            serverName: name,
        });
    }

    static getServerProjectSCMPersists(context:vscode.ExtensionContext, serverName:string, projectId:string) {
        const persists = context.globalState.get<ServerPersistMap>(keyServerPersists, {});
        const server   = persists[serverName];
        const project  = server.login?.projects?.find(project => project.id===projectId);
        const scmPersists = project?.scm ? project.scm as ProjectSCMPersistMap : {};
        return scmPersists;
    }

    static updateServerProjectSCMPersist(context:vscode.ExtensionContext, serverName:string, projectId:string, scmKey:string, scmPersist?:ProjectSCMPersist) {
        const persists = context.globalState.get<ServerPersistMap>(keyServerPersists, {});
        const server   = persists[serverName];
        const project  = server.login?.projects?.find(project => project.id===projectId);
        if (project) {
            const scmPersists = (project.scm ?? {}) as ProjectSCMPersistMap;
            if (scmPersist===undefined) {
                delete scmPersists[scmKey];
            } else {
                scmPersists[scmKey] = scmPersist;
            }
            project.scm = scmPersists;
            context.globalState.update(keyServerPersists, persists);
        }
    }

    static getPdfViewPersist(context:vscode.ExtensionContext, uri:string): any {
        return context.globalState.get<PdfViewPersistMap>(keyPdfViewPersists, {})[uri]?.state;
    }

    static updatePdfViewPersist(context:vscode.ExtensionContext, uri:string, state:any) {
        const persists = context.globalState.get<PdfViewPersistMap>(keyPdfViewPersists, {});

        // update record
        if (persists[uri]!==undefined) {
            persists[uri].frequency++;
            persists[uri].state = state;
        } else {
            persists[uri] = {frequency: 1, state};
        }

        // when length>=100, remove first least used record
        if (Object.keys(persists).length>=100) {
            let minFrequency = Number.MAX_SAFE_INTEGER;
            let minUri = '';
            Object.entries(persists).forEach(([uri, persist]) => {
                if (persist.frequency<minFrequency) {
                    minFrequency = persist.frequency;
                    minUri = uri;
                }
            });
            delete persists[minUri];
        }

        context.globalState.update(keyPdfViewPersists, persists);
    }

}
