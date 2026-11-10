/* eslint-disable @typescript-eslint/naming-convention */
import * as http from 'http';
import * as https from 'https';
import * as stream from 'stream';
import FormData = require('form-data');
import { randomUUID as uuidv4 } from 'crypto';
import { Response } from 'node-fetch';
import { fetchWithLimits as fetch } from './httpTransport';
import { FileEntity, FileType, FolderEntity, OutputFileEntity } from '../core/remoteFileSystemProvider';
import { logDiagnostic } from '../utils/diagnostics';
import { buildPasswordLoginUnavailableMessage } from '../utils/authFlow';
import { mergeCookieHeaders, normalizeCookieHeader } from './cookieHelpers';
import { extractHtmlMetaContent, extractJsonMetaContent } from './htmlMeta';
import type { ProjectPageMetadata } from './projectBootstrap';
import { patchSocketIoClientForNode } from './socketioRuntimePatch';
import {
    buildOverleafChatSendFailure,
    type OverleafChatSendFailureCode,
} from '../collaboration/chatSendResult';
import {
    OverleafCommentAuthor,
    OverleafCommentMessage,
    OverleafCommentThread,
} from '../comments/types';
import {
    buildRealtimeHandshakeUrl,
    parseRealtimeHandshakeResponse,
    type RealtimeHandshakeMetadata,
    type SocketConnectionTarget,
} from './socketioHelpers';

export interface Identity {
    csrfToken: string;
    cookies: string;
}

export interface RealtimeHandshakeProbe {
    cookies: string,
    metadata?: RealtimeHandshakeMetadata,
    setCookieCount: number,
    status: number,
    url: string,
}

export interface NewProjectResponseSchema {
    project_id: string,
    owner_ref: string,
    owner: MemberEntity
}

export interface CompileResponseSchema {
    status?: string;
    compileGroup?: string;
    outputFiles?: Array<OutputFileEntity>;
    stats?: {
        "latexmk-errors":number, "pdf-size":number,
        "latex-runs":number, "latex-runs-with-errors":number,
        "latex-runs-0":number, "latex-runs-with-error-0s":number,
    };
    timings?: {
        "sync":number, "compile":number, "output":number, "compileE2E":number,
    };
    enableHybridPdfDownload?: boolean;
    buildId?: string;
    clsiServerId?: string;
    errors?: unknown[];
    logs?: unknown;
    validationProblems?: unknown[];
    [key: string]: unknown;
}

export interface SyncPdfResponseSchema {
    file: string,
    line: number,
    column: number
}

export interface SyncCodeResponseSchema {
    pdf: Array<{
        page: number,
        h: number,
        v: number,
        width: number,
        height: number,
    }>
}

export interface SnippetItemSchema {
    meta: string,
    score: number,
    caption: string,
    snippet: string,
}

export interface MisspellingItemSchema {
    index: number,
    suggestions: string[]
}

export interface MemberEntity {
    _id: string,
    first_name: string,
    last_name?: string,
    email: string,
    privileges?: string,
    signUpDate?: string,
}

export interface MetadataResponseScheme {
    projectId: string,
    projectMeta: {
        [id:string]: {
            labels: string[],
            packages: {[K:string]: SnippetItemSchema[]}
        }
    }
}

export interface ProjectPersist {
    id: string;
    userId: string;
    name: string;
    lastUpdated?: string;
    lastUpdatedBy?: MemberEntity;
    source?: 'owner' | 'collaborator' | 'readOnly';
    accessLevel: 'owner' | 'collaborator' | 'readOnly';
    archived?: boolean;
    trashed?: boolean;
    scm?: any; //injected by SCMCollectionProvider
}

export interface ProjectTagsResponseSchema {
    __v: number,
    _id: string,
    name: string,
    user_id: string,
    project_ids: string[],
}

export interface ProjectLabelResponseSchema {
    id: string,
    comment: string,
    version: string,
    user_id: string,
    created_at: number,
    user_display_name?: string,
}

export interface ProjectUpdateMeta {
    users: {id:string, first_name:string, last_name?:string, email:string}[],
    start_ts: number,
    end_ts: number,
}

export interface ProjectHistoryResponseSchema {
    fromV: number,
    toV: number,
    meta: ProjectUpdateMeta,
    labels: ProjectLabelResponseSchema[],
    pathnames: string[],
    project_ops:{
        add?: {pathname:string},
        remove?: {pathname:string},
        atV: number,
    }[],
}

export interface ProjectUpdateResponseSchema {
    updates: ProjectHistoryResponseSchema[],
    nextBeforeTimestamp: number,
}

export interface ProjectFileDiffResponseSchema {
    diff: {
        u?: string, d?: string, i?: string,
        meta?: ProjectUpdateMeta,
    }[]
}

export interface ProjectFileTreeDiffResponseSchema {
    diff: {
        pathname: string,
        newPathname?: string,
        operation?: 'edited' | 'added' | 'removed' | 'renamed',
        deletedAtV?: number,
    }[]
}

export interface ProjectMessageResponseSchema {
    id: string,
    content: string,
    edited_at?: number,
    timestamp: number,
    user_id: string,
    user: {id:string, first_name:string, last_name?:string, email:string},
    clientId?: string,
}

export type ProjectCommentThreadMessageSchema = OverleafCommentMessage;
export type ProjectCommentThreadResponseSchema = OverleafCommentThread;
export type ProjectCommentThreadsResponseSchema = Record<string, ProjectCommentThreadResponseSchema>;

export interface ProjectSettingsSchema {
    learnedWords: string[],
    languages: {code:string, name:string}[],
    compilers: {code:string, name:string}[],
}

export interface ResponseSchema {
    type: 'success' | 'error';
    method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
    raw?: ArrayBuffer;
    message?: string;
    route?: string;
    statusCode?: number;
    responseBody?: string;
    userInfo?: {userId:string, userEmail:string};
    identity?: Identity;
    projects?: ProjectPersist[];
    entity?: FileEntity;
    entities?: {path:string, type:string}[];
    compile?: CompileResponseSchema;
    content?: Uint8Array;
    syncPdf?: SyncPdfResponseSchema;
    syncCode?: SyncCodeResponseSchema;
    meta?: MetadataResponseScheme;
    misspellings?: MisspellingItemSchema[];
    tags?: ProjectTagsResponseSchema[];
    labels?: ProjectLabelResponseSchema[];
    updates?: ProjectUpdateResponseSchema;
    diff?: ProjectFileDiffResponseSchema;
    treeDiff?: ProjectFileTreeDiffResponseSchema;
    messages?: ProjectMessageResponseSchema[];
    settings?: ProjectSettingsSchema;
    commentMessage?: ProjectCommentThreadMessageSchema;
    commentThreads?: ProjectCommentThreadsResponseSchema;
}

function resolveBrowserLikeUserAgent() {
    switch (process.platform) {
        case 'darwin':
            return 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.4 Safari/605.1.15';
        case 'win32': {
            const chromeVersion = process.versions.chrome ?? '147.0.0.0';
            return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`;
        }
        default: {
            const chromeVersion = process.versions.chrome ?? '147.0.0.0';
            return `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`;
        }
    }
}

function resolveBrowserLikeAcceptLanguage() {
    const locale = Intl.DateTimeFormat().resolvedOptions().locale.replace(/_/g, '-');
    if (!locale) {
        return 'en-US,en;q=0.9';
    }
    if (locale.toLowerCase().startsWith('en')) {
        return `${locale},en;q=0.9`;
    }
    return `${locale},en-US;q=0.9,en;q=0.8`;
}

function sanitizeChatRequestHeadersForDiagnostics(headers: Record<string, string>) {
    return {
        accept: headers.Accept ?? '',
        acceptEncoding: headers['Accept-Encoding'] ?? '',
        acceptLanguage: headers['Accept-Language'] ?? '',
        contentType: headers['Content-Type'] ?? '',
        hasCookie: Boolean(headers.Cookie),
        hasCsrfToken: Boolean(headers['X-Csrf-Token']),
        origin: headers.Origin ?? '',
        priority: headers.Priority ?? '',
        referer: headers.Referer ?? '',
        secFetchDest: headers['Sec-Fetch-Dest'] ?? '',
        secFetchMode: headers['Sec-Fetch-Mode'] ?? '',
        secFetchSite: headers['Sec-Fetch-Site'] ?? '',
        userAgent: headers['User-Agent'] ?? '',
    };
}

function pickChatResponseHeaders(headers: Response['headers']) {
    return {
        cfRay: headers.get('cf-ray') ?? '',
        retryAfter: headers.get('retry-after') ?? '',
        server: headers.get('server') ?? '',
        setCookieCount: headers.raw()['set-cookie']?.length ?? 0,
        via: headers.get('via') ?? '',
        xServedBy: headers.get('x-served-by') ?? '',
    };
}

export interface ChatSendApiResponseSchema extends ResponseSchema {
    chatSendErrorCode?: OverleafChatSendFailureCode;
    responsePreview?: string;
}

type ProjectPageUser = {
    _id?: string,
    first_name?: string,
    last_name?: string,
    email?: string,
};

export type AuthenticatedUserContext = {
    userId: string,
    userEmail: string,
    csrfToken: string,
};

type PasswordLoginMessage = {
    message?: string,
    text?: string,
    type?: string,
};

type PasswordLoginResponsePayload = {
    errorReason?: string,
    message?: PasswordLoginMessage | string,
    redir?: string,
};

type PasswordLoginPreflightResult = {
    canSkipCaptcha?: boolean,
    identity: Identity,
    supported: boolean,
    status: number,
};

const CAPTCHA_REQUIRED_ERROR_REASON = 'cannot_verify_user_not_robot';

function safeParseJson<T>(body: string): T | undefined {
    if (body.trim()==='') {
        return undefined;
    }
    try {
        return JSON.parse(body) as T;
    } catch {
        return undefined;
    }
}

function asObject(value: unknown): Record<string, unknown> | undefined {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
        ? value as Record<string, unknown>
        : undefined;
}

export function normalizeCompileResponsePayload(payload: unknown): CompileResponseSchema {
    const response = asObject(payload) ?? {};
    const compile = asObject(response.compile) ?? response;
    return {
        ...compile,
        outputFiles: Array.isArray(compile.outputFiles)
            ? compile.outputFiles as OutputFileEntity[]
            : [],
    } as CompileResponseSchema;
}

function extractPasswordLoginErrorMessage(payload?: PasswordLoginResponsePayload) {
    if (!payload?.message) {
        return undefined;
    }
    if (typeof payload.message === 'string') {
        return payload.message;
    }
    return payload.message.text ?? payload.message.message;
}

function parseCanSkipCaptchaResponse(payload: unknown) {
    if (typeof payload === 'boolean') {
        return payload;
    }
    if (typeof payload === 'object' && payload!==null && 'canSkipCaptcha' in payload) {
        const canSkipCaptcha = (payload as {canSkipCaptcha?: unknown}).canSkipCaptcha;
        if (typeof canSkipCaptcha === 'boolean') {
            return canSkipCaptcha;
        }
    }
    return undefined;
}

export function extractAuthenticatedUserContext(body: string): AuthenticatedUserContext | undefined {
    const user = extractJsonMetaContent<ProjectPageUser>(body, 'ol-user');
    const userId = user?._id ?? extractHtmlMetaContent(body, 'ol-user_id');
    const userEmail = user?.email ?? extractHtmlMetaContent(body, 'ol-usersEmail') ?? '';
    const csrfToken = extractHtmlMetaContent(body, 'ol-csrfToken');

    if (!userId || !csrfToken) {
        return undefined;
    }

    return { userId, userEmail, csrfToken };
}

function isLoopbackHostname(hostname: string) {
    const normalized = hostname.toLowerCase();
    if (normalized==='localhost' || normalized==='[::1]' || normalized==='::1') {
        return true;
    }

    const ipv4Match = normalized.match(/^127(?:\.(\d{1,3})){3}$/);
    if (!ipv4Match) {
        return false;
    }

    return normalized.split('.').every(segment => {
        const octet = Number(segment);
        return Number.isInteger(octet) && octet >= 0 && octet <= 255;
    });
}

export function normalizeBaseApiUrl(url: string): string {
    const parsed = new URL(url);
    if (parsed.username || parsed.password) {
        throw new Error('Overleaf server URL must not contain embedded credentials.');
    }
    if (parsed.protocol!=='http:' && parsed.protocol!=='https:') {
        throw new Error('Overleaf server URL must use http or https.');
    }
    if (parsed.protocol==='http:' && !isLoopbackHostname(parsed.hostname)) {
        throw new Error('Overleaf server URL must use HTTPS unless it targets localhost.');
    }
    parsed.hash = '';
    parsed.search = '';
    if (!parsed.pathname.endsWith('/')) {
        parsed.pathname = `${parsed.pathname}/`;
    }
    return parsed.toString();
}

function buildHttpFailureMessage(status: string | number): string {
    return `${status}: Overleaf request failed.`;
}

export class BaseAPI {
    public readonly url: string;
    private readonly origin: string;
    private agent: http.Agent | https.Agent;
    private identity?: Identity;

    constructor(url:string) {
        this.url = normalizeBaseApiUrl(url);
        const parsedUrl = new URL(this.url);
        this.origin = parsedUrl.origin;
        this.agent = parsedUrl.protocol==='http:' ? new http.Agent({keepAlive: true}) : new https.Agent({keepAlive: true});
    }

    private debugLog(event: string, fields: Record<string, unknown> = {}, error?: unknown) {
        logDiagnostic('BaseAPI', event, {
            baseUrl: this.url,
            ...fields,
        }, error);
    }

    private resolveSameOriginUrl(route: string): string {
        const resolved = new URL(route, this.url);
        if (resolved.origin!==this.origin || resolved.username || resolved.password) {
            throw new Error('Refusing to send Overleaf credentials to a different origin.');
        }
        return resolved.toString();
    }

    private resolveCredentialOrigin(url: string): string | undefined {
        try {
            const parsed = new URL(url, this.url);
            const protocol = parsed.protocol==='wss:' ? 'https:'
                : parsed.protocol==='ws:' ? 'http:'
                    : parsed.protocol;
            return `${protocol}//${parsed.host}`;
        } catch {
            return undefined;
        }
    }

    private isSameOriginUrl(url: string): boolean {
        return this.resolveCredentialOrigin(url)===this.origin;
    }

    private async getCsrfToken(): Promise<Identity> {
        const route = this.resolveSameOriginUrl('login');
        this.debugLog('auth.csrf_token_requested', {
            route,
        });
        const res = await fetch(route, {
            method: 'GET', redirect: 'manual', agent: this.agent,
        });
        const body = await res.text();
        const match = body.match(/<input.*name="_csrf".*value="([^"]*)">/);
        if (!match) {
            this.debugLog('auth.csrf_token_failed_missing', {
                route,
                status: res.status,
            });
            throw new Error('Failed to get CSRF token.');
        } else {
            const csrfToken = match[1];
            const cookies = mergeCookieHeaders('', res.headers.raw()['set-cookie'] ?? []);
            this.debugLog('auth.csrf_token_loaded', {
                route,
                setCookieCount: (res.headers.raw()['set-cookie'] ?? []).length,
                status: res.status,
            });
            return { csrfToken, cookies };
        }
    }

    private async preflightPasswordLogin(email: string): Promise<PasswordLoginPreflightResult> {
        const identity = await this.getCsrfToken();
        const route = this.resolveSameOriginUrl('login/can-skip-captcha');
        this.debugLog('auth.password_login.captcha_preflight_started', {
            hasExistingCookies: identity.cookies.length > 0,
            route,
        });
        const res = await fetch(route, {
            method: 'POST', redirect: 'manual', agent: this.agent,
            headers: {
                'Accept': 'application/json',
                'Connection': 'keep-alive',
                'Content-Type': 'application/json',
                'Cookie': identity.cookies,
                'X-Csrf-Token': identity.csrfToken,
            },
            body: JSON.stringify({ email }),
        });
        const body = await res.text();
        const payload = safeParseJson<unknown>(body);
        const canSkipCaptcha = parseCanSkipCaptchaResponse(payload);
        identity.cookies = mergeCookieHeaders(identity.cookies, res.headers.raw()['set-cookie'] ?? []);
        const supported = res.status!==404 && res.status!==405 && canSkipCaptcha!==undefined;
        this.debugLog('auth.password_login.captcha_preflight_response', {
            canSkipCaptcha: canSkipCaptcha ?? null,
            responseParsed: payload !== undefined,
            route,
            setCookieCount: (res.headers.raw()['set-cookie'] ?? []).length,
            status: res.status,
            supported,
        });
        return {
            canSkipCaptcha,
            identity,
            supported,
            status: res.status,
        };
    }

    private extractPasswordLoginRedirect(res: Response, body: string, payload?: PasswordLoginResponsePayload) {
        const normalizeRedirect = (redirect?: string) => {
            if (!redirect) {
                return undefined;
            }
            try {
                const baseUrl = new URL(this.url);
                const resolvedUrl = new URL(redirect, this.url);
                if (resolvedUrl.origin===baseUrl.origin) {
                    return `${resolvedUrl.pathname}${resolvedUrl.search}${resolvedUrl.hash}`;
                }
            } catch {
                // Fall through to returning the raw redirect string.
            }
            return redirect;
        };

        const headerLocation = res.headers.get('location');
        if (headerLocation) {
            return normalizeRedirect(headerLocation);
        }
        if (payload?.redir) {
            return normalizeRedirect(payload.redir);
        }
        const legacyRedirectMatch = body.match(/Found\. Redirecting to ([^\s<]+)/);
        return normalizeRedirect(legacyRedirectMatch?.[1]);
    }

    private async getUserId(cookies:string) {
        const normalizedCookies = normalizeCookieHeader(cookies);
        const route = this.resolveSameOriginUrl('project');
        const res = await fetch(route, {
            method: 'GET', redirect:'manual', agent: this.agent,
            headers: {
                'Connection': 'keep-alive',
                'Cookie': normalizedCookies,
            }
        });

        const body = await res.text();
        this.debugLog('auth.project_page_response', {
            location: res.headers.get('location') ?? '',
            status: res.status,
            url: route,
        });
        const mergedCookies = mergeCookieHeaders(
            normalizedCookies,
            res.headers.raw()['set-cookie'] ?? [],
        );
        const authContext = extractAuthenticatedUserContext(body);
        this.debugLog('auth.project_page_parsed', {
            hasCsrfMeta: extractHtmlMetaContent(body, 'ol-csrfToken') !== undefined,
            hasLegacyUserIdMeta: extractHtmlMetaContent(body, 'ol-user_id') !== undefined,
            hasUserJsonMeta: extractHtmlMetaContent(body, 'ol-user') !== undefined,
            responseKind: body.includes('<title>Login</title>') ? 'login_page'
                : body.includes('name="ol-project_id"') ? 'project_page'
                : 'unknown',
            userIdFound: authContext?.userId !== undefined,
        });
        if (authContext) {
            const { userId, userEmail, csrfToken } = authContext;
            return {userId, userEmail, csrfToken, cookies: mergedCookies};
        }

        return undefined;
    }

    // Reference: "github:overleaf/overleaf/services/web/frontend/js/ide/connection/ConnectionManager.js#L137"
    _initSocketV0(identity:Identity, target:SocketConnectionTarget, query?:string, options?:object) {
        const mergedQuery = [target.query, query].filter(Boolean).join('&');
        const sameOriginTarget = this.isSameOriginUrl(target.connectUrl);
        const ioClient = require('socket.io-client');
        if (patchSocketIoClientForNode(ioClient)) {
            this.debugLog('socket_client_patch_applied', {
                target: target.connectUrl,
            });
        }
        if (!sameOriginTarget) {
            this.debugLog('socket.cross_origin_credentials_suppressed', {
                target: target.connectUrl,
            });
        }
        return (ioClient.connect as any)(target.connectUrl, {
            'auto connect': false,
            'connect timeout': 30 * 1000,
            reconnect: false,
            'force new connection': true,
            resource: target.resource,
            ...(mergedQuery ? {query: mergedQuery} : {}),
            extraHeaders: {
                'Origin': this.origin,
                ...(sameOriginTarget ? {'Cookie': identity.cookies} : {}),
            },
            ...options,
        });
    }

    async probeRealtimeHandshake(identity: Identity, target: SocketConnectionTarget, query?: string): Promise<RealtimeHandshakeProbe> {
        const normalizedCookies = normalizeCookieHeader(identity.cookies);
        const mergedQuery = [target.query, query].filter(Boolean).join('&');
        const url = buildRealtimeHandshakeUrl(target, mergedQuery);
        const sameOriginTarget = this.isSameOriginUrl(url);
        if (!sameOriginTarget) {
            this.debugLog('socket_handshake_probe.cross_origin_credentials_suppressed', {
                url,
            });
        }
        const res = await fetch(url, {
            method: 'GET',
            redirect: 'manual',
            agent: this.agent,
            headers: {
                'Connection': 'keep-alive',
                ...(sameOriginTarget ? {'Cookie': normalizedCookies} : {}),
            }
        });

        const body = await res.text();
        const setCookieHeaders = res.headers.raw()['set-cookie'] ?? [];
        const cookies = sameOriginTarget
            ? mergeCookieHeaders(normalizedCookies, setCookieHeaders)
            : normalizedCookies;
        const metadata = res.status===200 ? parseRealtimeHandshakeResponse(body) : undefined;
        this.debugLog('socket_handshake_probe.response', {
            parsed: metadata !== undefined,
            parsedSessionIdPrefix: metadata?.sessionId?.slice(0, 8) ?? '',
            redirectLocation: res.headers.get('location') ?? '',
            route: url,
            setCookieCount: setCookieHeaders.length,
            setCookieNames: setCookieHeaders.map((header) => header.split('=', 1)[0]).filter(Boolean),
            status: res.status,
            transportCount: metadata?.transports.length ?? 0,
            transports: metadata?.transports ?? [],
        });

        return {
            cookies,
            metadata,
            setCookieCount: setCookieHeaders.length,
            status: res.status,
            url,
        };
    }

    async passportLogin(email:string, password:string): Promise<ResponseSchema> {
        this.debugLog('auth.password_login.started', {
            emailProvided: email.length > 0,
        });
        const preflight = await this.preflightPasswordLogin(email);
        if (preflight.supported && preflight.canSkipCaptcha===false) {
            const blockedMessage = buildPasswordLoginUnavailableMessage();
            this.debugLog('auth.password_login.blocked_captcha_required', {
                preflightStatus: preflight.status,
            }, blockedMessage);
            return {
                type: 'error',
                message: blockedMessage,
            };
        }
        const identity = preflight.identity;
        this.debugLog('auth.password_login.request_started', {
            captchaPreflightSupported: preflight.supported,
            captchaPreflightStatus: preflight.status,
        });
        const route = this.resolveSameOriginUrl('login');
        const res = await fetch(route, {
            method: 'POST', redirect: 'manual', agent: this.agent,
            headers: {
                'Accept': 'application/json',
                'Accept-Encoding': 'gzip, deflate, br',
                'Connection': 'keep-alive',
                'Content-Type': 'application/json',
                'Cookie': identity.cookies,
                'X-Csrf-Token': identity.csrfToken,
            },
            body: JSON.stringify({ _csrf: identity.csrfToken, email: email, password: password })
        });
        const body = await res.text();
        const payload = safeParseJson<PasswordLoginResponsePayload>(body);
        const cookies = mergeCookieHeaders(identity.cookies, res.headers.raw()['set-cookie'] ?? []);
        const redirect = this.extractPasswordLoginRedirect(res, body, payload);
        const errorReason = payload?.errorReason ?? '';
        this.debugLog('auth.password_login.response_received', {
            errorReason,
            redirect: redirect ?? '',
            setCookieCount: (res.headers.raw()['set-cookie'] ?? []).length,
            status: res.status,
        });

        if (redirect?.startsWith('/project')) {
            this.debugLog('auth.password_login.succeeded', {
                redirect,
                status: res.status,
            });
            return (await this.cookiesLogin(cookies));
        }

        if (errorReason===CAPTCHA_REQUIRED_ERROR_REASON) {
            const blockedMessage = buildPasswordLoginUnavailableMessage();
            this.debugLog('auth.password_login.failed_captcha_required', {
                status: res.status,
            }, blockedMessage);
            return {
                type: 'error',
                message: blockedMessage,
            };
        }

        if (redirect) {
            const redirectMessage = `Password login succeeded, but Overleaf redirected to ${redirect}. Complete sign-in in the browser, then use Login with Cookies.`;
            this.debugLog('auth.password_login.failed_redirect', {
                redirect,
                status: res.status,
            }, redirectMessage);
            return {
                type: 'error',
                message: redirectMessage,
            };
        }

        const errorMessage = extractPasswordLoginErrorMessage(payload) ?? buildHttpFailureMessage(res.status);
        this.debugLog('auth.password_login.failed', {
            errorReason,
            responseParsed: payload !== undefined,
            status: res.status,
        }, errorMessage);
        return {
            type: 'error',
            message: errorMessage
        };
    }

    async cookiesLogin(cookies: string): Promise<ResponseSchema> {
        const normalizedCookies = normalizeCookieHeader(cookies);
        const res = await this.getUserId(normalizedCookies);
        if (res) {
            const { userId, userEmail, csrfToken, cookies: refreshedCookies } = res;
            const identity: Identity =  await this.updateCookies({ cookies: refreshedCookies, csrfToken });
            return {
                type: 'success',
                userInfo: {userId, userEmail},
                identity: identity
            };
        } else {
            return {
                type: 'error',
                message: 'Failed to get User ID.'
            };
        }
    }

    async updateCookies(identity: Identity, socketScriptUrl?: string) {
        identity.cookies = normalizeCookieHeader(identity.cookies);
        const refreshedUser = await this.getUserId(identity.cookies);
        if (refreshedUser) {
            identity.cookies = refreshedUser.cookies;
            identity.csrfToken = refreshedUser.csrfToken;
        }

        const socketBootstrapUrl = socketScriptUrl ?? new URL('socket.io/socket.io.js', this.url).toString();
        const parsedBootstrapUrl = new URL(socketBootstrapUrl);
        if (parsedBootstrapUrl.username || parsedBootstrapUrl.password
            || (parsedBootstrapUrl.protocol!=='https:' && !this.isSameOriginUrl(socketBootstrapUrl))) {
            throw new Error('Refusing an insecure or credential-bearing socket bootstrap URL');
        }
        const sameOriginSocketBootstrap = this.isSameOriginUrl(socketBootstrapUrl);
        if (!sameOriginSocketBootstrap) {
            this.debugLog('auth.socket_bootstrap_cross_origin_credentials_suppressed', {
                socketBootstrapUrl,
            });
        }
        const res = await fetch(socketBootstrapUrl, {
            method: 'GET',
            redirect: 'manual',
            agent: sameOriginSocketBootstrap ? this.agent : undefined,
            headers: {
                'Connection': 'keep-alive',
                ...(sameOriginSocketBootstrap ? {'Cookie': identity.cookies} : {}),
            }
        });
        if (sameOriginSocketBootstrap) {
            identity.cookies = mergeCookieHeaders(
                identity.cookies,
                res.headers.raw()['set-cookie'] ?? [],
            );
        }
        // Only response headers are used; do not leave the script body/socket
        // alive until the transport timeout on every credential refresh.
        (res.body as stream.Readable).destroy();
        return identity;
    };

    setIdentity(identity: Identity) {
        this.identity = identity;
        return this;
    }

    protected async request(type:'GET'|'POST'|'PUT'|'DELETE', route:string, body?:FormData|object, callback?: (res?:string)=>object|undefined, extraHeaders?:object ): Promise<ResponseSchema> {
        if (this.identity===undefined) { return Promise.reject(); }

        const requestUrl = this.resolveSameOriginUrl(route);
        let res = undefined;
        switch(type) {
            case 'GET':
                res = await fetch(requestUrl, {
                    method: 'GET', redirect: 'manual', agent: this.agent,
                    headers: {
                        'Connection': 'keep-alive',
                        'Cookie': this.identity.cookies,
                        ...extraHeaders
                    }
                });
                break;
            case 'POST':
                // if body is FormData, then it is a raw body
                const content_type = body instanceof FormData ? undefined : {'Content-Type': 'application/json'};
                const raw_body = body instanceof FormData ? body : JSON.stringify({
                    _csrf: this.identity.csrfToken,
                    ...body
                });
                res = await fetch(requestUrl, {
                    method: 'POST', redirect: 'manual', agent: this.agent,
                    headers: {
                        'Connection': 'keep-alive',
                        'Cookie': this.identity.cookies,
                        ...content_type,
                        ...extraHeaders
                    },
                    body: raw_body
                });
                break;
            case 'PUT':
                throw new Error('PUT requests are not implemented');
            case 'DELETE':
                res = await fetch(requestUrl, {
                    method: 'DELETE', redirect: 'manual', agent: this.agent,
                    headers: {
                        'Connection': 'keep-alive',
                        'Cookie': this.identity.cookies,
                        'X-Csrf-Token': this.identity.csrfToken,
                        ...extraHeaders
                    }
                });
                break;
        };

        if (res && this.identity) {
            this.identity.cookies = mergeCookieHeaders(
                this.identity.cookies,
                res.headers.raw()['set-cookie'] ?? [],
            );
        }

        if (res && (res.status===200 || res.status===201 || res.status===204)) {
            const _res = (res.status===200 || res.status===201) ? await res.text() : undefined;
            let response = undefined;
            try {
                response = callback && callback(_res);
            } catch (error) {
                this.debugLog('request.callback_failed', {
                    responsePreview: _res?.slice(0, 200) ?? '',
                    route,
                    status: res.status,
                    type,
                }, error);
                return {
                    type: 'error',
                    message: error instanceof Error ? error.message : String(error),
                };
            }
            return {
                type: 'success',
                method: type,
                route,
                statusCode: res.status,
                ...response
            } as ResponseSchema;
        } else {
            res = res || { status:'undefined', text:()=>'' };
            const responseBody = await res.text();
            return {
                type: 'error',
                method: type,
                route,
                statusCode: Number(res.status),
                responseBody,
                message: buildHttpFailureMessage(res.status),
            };
        }
    }

    protected async download(route:string) {
        if (this.identity===undefined) { return Promise.reject(); }

        const requestUrl = this.resolveSameOriginUrl(route);
        const chunks: Buffer[] = [];
        let offset = 0;
        let total: number | undefined;
        const maxBytes = 512 * 1024 * 1024;
        while (true) {
            const res = await fetch(requestUrl, {
                method: 'GET', redirect: 'manual', agent: this.agent, size: maxBytes,
                headers: {
                    Cookie: this.identity.cookies,
                    ...(offset > 0 ? {Range: `bytes=${offset}-`} : {}),
                },
            });
            if (res.status!==200 && res.status!==206) {
                (res.body as stream.Readable).destroy();
                throw new Error(`Download failed (HTTP ${res.status})`);
            }
            if (res.status===200 && offset!==0) {
                (res.body as stream.Readable).destroy();
                throw new Error('Server ignored the partial-download range');
            }
            const range = res.status===206 ? /^bytes (\d+)-(\d+)\/(\d+)$/.exec(res.headers.get('content-range') ?? '') : null;
            if (res.status===206 && (!range || Number(range[1])!==offset || Number(range[2]) < offset
                || Number(range[3]) > maxBytes || Number(range[2]) >= Number(range[3])
                || (total!==undefined && total!==Number(range[3])))) {
                (res.body as stream.Readable).destroy();
                throw new Error('Invalid or non-progressing partial-download range');
            }
            const bytes = await res.buffer();
            if (range && bytes.length!==Number(range[2]) - offset + 1) {
                throw new Error('Partial download length does not match its range');
            }
            offset += bytes.length;
            if (offset > maxBytes) { throw new Error('Download exceeds the size limit'); }
            chunks.push(bytes);
            if (res.status===200) { break; }
            total = Number(range![3]);
            if (offset===total) { break; }
        }
        return Buffer.concat(chunks, offset);
    }

    protected async downloadWithRedirects(route:string, maxRedirects=5) {
        if (this.identity===undefined) { return Promise.reject(); }

        let target = this.resolveSameOriginUrl(route);
        for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount += 1) {
            const parsedTarget = new URL(target);
            if (parsedTarget.username || parsedTarget.password
                || (parsedTarget.protocol!=='https:' && !(parsedTarget.protocol==='http:' && this.isSameOriginUrl(target)))) {
                throw new Error('Refusing an insecure or unsupported download redirect');
            }
            const sameOrigin = this.isSameOriginUrl(target);
            const res = await fetch(target, {
                method: 'GET',
                redirect: 'manual',
                agent: sameOrigin ? this.agent : undefined,
                headers: {
                    'Connection': 'keep-alive',
                    ...(sameOrigin ? {'Cookie': this.identity.cookies} : {}),
                }
            });
            this.debugLog('download_with_redirects.response', {
                redirectCount,
                route,
                sameOrigin,
                status: res.status,
                target,
            });

            if (res.status===200) {
                const content = await res.buffer();
                this.debugLog('download_with_redirects.completed', {
                    bytes: content.length,
                    redirectCount,
                    route,
                    status: res.status,
                    target,
                });
                return content;
            }

            if ([301, 302, 303, 307, 308].includes(res.status)) {
                const location = res.headers.get('location');
                (res.body as stream.Readable).destroy();
                if (!location) {
                    this.debugLog('download_with_redirects.redirect_missing_location', {
                        redirectCount,
                        route,
                        status: res.status,
                        target,
                    });
                    break;
                }
                target = new URL(location, target).toString();
                continue;
            }

            (res.body as stream.Readable).destroy();
            break;
        }

        this.debugLog('download_with_redirects.failed', {
            maxRedirects,
            route,
            target,
        });
        throw new Error('Project download failed or exceeded its redirect limit');
    }

    async logout(identity:Identity): Promise<ResponseSchema> {
        this.setIdentity(identity);
        return this.request('POST', 'logout');
    }

    async userProjectsJson(identity:Identity): Promise<ResponseSchema> {
        this.setIdentity(identity);
        return this.request('GET', 'user/projects', undefined, (res) => {
            const projects = (JSON.parse(res!) as any).projects as any[];
            projects.forEach(project => {
                project.id = project._id;
                delete project._id;
            });
            return {projects};
        });
    }

    async getProjectsJson(identity:Identity): Promise<ResponseSchema> {
        this.setIdentity(identity);
        return this.request('POST', 'api/project', {}, (res) => {
            const projects = (JSON.parse(res!) as any).projects;
            return {projects};
        });
    }

    async projectEntitiesJson(identity:Identity, projectId:string): Promise<ResponseSchema> {
        this.setIdentity(identity);
        return this.request('GET', `project/${projectId}/entities`, undefined, (res) => {
            const entities = JSON.parse(res!).entities;
            return {entities};
        });
    }

    async newProject(identity:Identity, projectName:string, template:'none'|'example') {
        this.setIdentity(identity);
        return this.request('POST', 'project/new', {projectName, template}, (res) => {
            const message = (JSON.parse(res!) as NewProjectResponseSchema).project_id;
            return {message};
        });
    }

    async cloneProject(identity:Identity, projectId:string, projectName:string) {
        this.setIdentity(identity);
        return this.request('POST', `project/${projectId}/clone`, {projectName}, (res) => {
            const message = (JSON.parse(res!) as NewProjectResponseSchema).project_id;
            return {message};
        });
    }

    async renameProject(identity:Identity, projectId:string, newProjectName:string) {
        this.setIdentity(identity);
        return this.request('POST', `project/${projectId}/rename`, {newProjectName});
    }

    async deleteProject(identity:Identity, projectId:string) {
        this.setIdentity(identity);
        return this.request('DELETE', `project/${projectId}`);
    }

    async archiveProject(identity:Identity, projectId:string) {
        this.setIdentity(identity);
        return this.request('POST', `project/${projectId}/archive`,
                            undefined, undefined, {'X-Csrf-Token': identity.csrfToken});
    }

    async unarchiveProject(identity:Identity, projectId:string) {
        this.setIdentity(identity);
        return this.request('DELETE', `project/${projectId}/archive`);
    }

    async trashProject(identity:Identity, projectId:string) {
        this.setIdentity(identity);
        return this.request('POST', `project/${projectId}/trash`,
                            undefined, undefined, {'X-Csrf-Token': identity.csrfToken});
    }

    async untrashProject(identity:Identity, projectId:string) {
        this.setIdentity(identity);
        return this.request('DELETE', `project/${projectId}/trash`);
    }

    async getFile(identity:Identity, projectId:string, fileId:string) {
        this.setIdentity(identity);
        const content = await this.download(`project/${projectId}/file/${fileId}`);
        return {
            type: 'success',
            content: new Uint8Array( content )
        };
    }

    async addDoc(identity:Identity, projectId:string, parentFolderId:string, filename:string) {
        this.setIdentity(identity);
        return this.request('POST', `project/${projectId}/doc`, {parent_folder_id:parentFolderId, name:filename}, (res) => {
            const {_id} = JSON.parse(res!) as any;
            const entity = {_type:'doc', _id, name:filename} as FileEntity;
            return {entity};
        }, {'X-Csrf-Token': identity.csrfToken});
    }

    async uploadFile(identity:Identity, projectId:string, parentFolderId:string, filename:string, fileContent:Uint8Array) {
        const fileStream = stream.Readable.from([fileContent]);
        const formData = new FormData();
        const mimeType = require('mime-types').lookup(filename);
        formData.append('targetFolderId', parentFolderId);
        formData.append('name', filename);
        formData.append('type', mimeType? mimeType : 'text/plain');
        formData.append('qqfile', fileStream, {filename, knownLength: fileContent.byteLength});

        this.setIdentity(identity);
        const query = new URLSearchParams({folder_id: parentFolderId}).toString();
        return this.request('POST', `project/${projectId}/upload?${query}`, formData, (res) => {
            const {success, entity_id, entity_type} = JSON.parse(res!) as any;
            if (success!==true || typeof entity_id!=='string' || !/^[a-f\d]{24}$/i.test(entity_id)
                || (entity_type!=='doc' && entity_type!=='file')) {
                throw new Error('Overleaf did not confirm the uploaded file');
            }
            const entity = {_type:entity_type, _id:entity_id, name:filename} as FileEntity;
            return {entity};
        }, {'X-Csrf-Token': identity.csrfToken});
    }

    async uploadProject(identity:Identity, filename:string, fileContent:Uint8Array) {
        const uuid = uuidv4();
        const fileStream = stream.Readable.from([fileContent]);
        const formData = new FormData();
        formData.append('qqfile', fileStream, {filename, knownLength: fileContent.byteLength});

        this.setIdentity(identity);
        const query = new URLSearchParams({
            _csrf: identity.csrfToken,
            qquuid: uuid,
            qqfilename: filename,
            qqtotalfilesize: String(fileContent.length),
        }).toString();
        return this.request('POST', `project/new/upload?${query}`, formData, (res) => {
            const message = (JSON.parse(res!) as NewProjectResponseSchema).project_id;
            return {message};
        });
    }

    async addFolder(identity:Identity, projectId:string, folderName:string, parentFolderId:string) {
        const body = { name: folderName, parent_folder_id: parentFolderId };

        this.setIdentity(identity);
        return this.request('POST', `project/${projectId}/folder`, body, (res) => {
            const entity = JSON.parse(res!) as FolderEntity;
            return {entity};
        }, {'X-Csrf-Token': identity.csrfToken});
    }

    async deleteEntity(identity:Identity, projectId:string, fileType:FileType, fileId:string) {
        this.setIdentity(identity);
        return this.request('DELETE', `project/${projectId}/${fileType}/${fileId}`);
    }

    async deleteAuxFiles(identity:Identity, projectId:string) {
        this.setIdentity(identity);
        return this.request('DELETE', `project/${projectId}/output`);
    }

    async renameEntity(identity:Identity, projectId:string, entityType:string, entityId:string, name:string) {
        this.setIdentity(identity);
        return this.request('POST', `project/${projectId}/${entityType}/${entityId}/rename`,
                            {name}, undefined, {'X-Csrf-Token': identity.csrfToken});
    }

    async moveEntity(identity:Identity, projectId:string, entityType:string, entityId:string, newParentFolderId:string) {
        this.setIdentity(identity);
        return this.request('POST', `project/${projectId}/${entityType}/${entityId}/move`,
                            {folder_id:newParentFolderId}, undefined, {'X-Csrf-Token': identity.csrfToken});
    }

    async compile(identity:Identity, projectId:string, rootResourcePath:string|null,
        draft:boolean=false, stopOnFirstError:boolean=false
    ) {
        const body = {
            check: 'silent',
            draft,
            incrementalCompilesEnabled: true,
            rootResourcePath,   // file path e.g. "main.tex"
            stopOnFirstError
        };

        this.setIdentity(identity);
        return this.request('POST', `project/${projectId}/compile?auto_compile=true`, body, (res) => {
            const compile = normalizeCompileResponsePayload(JSON.parse(res!));
            // Output URLs do not include the compiler routing parameters.
            // Without them, web may route the download to a different CLSI
            // worker, where this build does not exist (HTTP 404).
            compile.outputFiles = compile.outputFiles?.map(file => {
                const url = new URL(this.resolveSameOriginUrl(file.url));
                if (typeof compile.compileGroup==='string') {
                    url.searchParams.set('compileGroup', compile.compileGroup);
                }
                const serverId = compile.fromCache===true
                    ? (typeof compile.clsiCacheShard==='string' ? compile.clsiCacheShard : 'cache')
                    : compile.clsiServerId;
                if (typeof serverId==='string') {
                    url.searchParams.set('clsiserverid', serverId);
                }
                return {...file, url: url.toString()};
            });
            return {compile};
        }, {'X-Csrf-Token': identity.csrfToken});
    }

    async stopCompile(identity:Identity, projectId:string) {
        this.setIdentity(identity);
        return this.request('POST', `project/${projectId}/compile/stop`, undefined, undefined, {'X-Csrf-Token': identity.csrfToken});
    }

    async indexAll(identity:Identity, projectId:string) {
        this.setIdentity(identity);
        return this.request('POST', `project/${projectId}/references/indexAll`, {shouldBroadcast: false}, undefined);
    }

    async getMetadata(identity:Identity, projectId:string) {
        this.setIdentity(identity);
        return this.request('GET', `project/${projectId}/metadata`, undefined, (res) => {
            const meta = JSON.parse(res!) as MetadataResponseScheme;
            return {meta};
        });
    }

    async proxyRequestToSpellingApi(identity:Identity, language:string, userId:string, words: string[]) {
        const body = {
            language,
            skipLearnedWords: true,
            token: userId,
            words
        };

        this.setIdentity(identity);
        return this.request('POST', 'spelling/check', body, (res) => {
            const misspellings = JSON.parse(res!).misspellings as MisspellingItemSchema[];
            return {misspellings};
        });
    }

    async spellingControllerLearn(identity:Identity, userId:string, word: string) {
        const body = {
            token: userId,
            word
        };

        this.setIdentity(identity);
        return this.request('POST', 'spelling/learn', body);
    }

    async spellingControllerUnlearn(identity:Identity, word: string) {
        this.setIdentity(identity);
        return this.request('POST', 'spelling/unlearn', {word}, undefined, {'X-Csrf-Token': identity.csrfToken});
    }

    async getProjectSettings(identity:Identity, projectId:string) {
        const metadata = await this.getProjectPageMetadata(identity, projectId);
        return {
            type: 'success',
            settings: metadata.settings,
        } as ResponseSchema;
    }

    async getProjectPageMetadata(identity: Identity, projectId: string): Promise<ProjectPageMetadata> {
        this.setIdentity(identity);
        const body = await this.requestProjectPage(`project/${projectId}`);

        const learnedWords = extractJsonMetaContent<string[]>(body, 'ol-learnedWords') ?? [];
        const languages = extractJsonMetaContent<{code:string,name:string}[]>(body, 'ol-languages') ?? [];
        if (languages.length > 0 && !languages.some((item) => item.code === '')) {
            languages.unshift({name:'Off', code:''});
        }

        const compilers = [
            {code: 'pdflatex', name: 'pdfLaTex'},
            {code: 'latex',    name: 'LaTex'},
            {code: 'xelatex',  name: 'XeLaTex'},
            {code: 'lualatex', name: 'LuaLaTex'},
        ];

        return {
            projectName: extractHtmlMetaContent(body, 'ol-projectName'),
            user: extractJsonMetaContent<ProjectPageUser>(body, 'ol-user'),
            wsUrl: extractHtmlMetaContent(body, 'ol-wsUrl'),
            settings: {
                learnedWords,
                languages,
                compilers,
            },
        };
    }

    async updateProjectSettings(identity:Identity, projectId:string, setting:any) {
        this.setIdentity(identity);
        return this.request('POST', `project/${projectId}/settings`, setting);
    }

    private async requestProjectPage(route: string): Promise<string> {
        if (this.identity===undefined) {
            return Promise.reject();
        }

        const res = await fetch(this.resolveSameOriginUrl(route), {
            method: 'GET', redirect: 'manual', agent: this.agent,
            headers: {
                'Connection': 'keep-alive',
                'Cookie': this.identity.cookies,
            }
        });

        if (res.status===200) {
            return await res.text();
        }

        await res.text();
        throw new Error(buildHttpFailureMessage(res.status));
    }

    async getFileFromClsi(identity:Identity, url:string, compileGroup:string) {
        this.setIdentity(identity);
        const target = new URL(this.resolveSameOriginUrl(url));
        if (!target.searchParams.has('compileGroup')) {
            target.searchParams.set('compileGroup', compileGroup);
        }
        const content = await this.download(target.toString());
        return {
            type: 'success',
            content: new Uint8Array( content )
        };
    }

    async proxySyncPdf(identity:Identity, projectId:string, page:number, h:number, v:number, buildId:string) {
        this.setIdentity(identity);
        const query = new URLSearchParams({
            page: String(page),
            h: h.toFixed(2),
            v: v.toFixed(2),
            editorId: uuidv4(),
            buildId,
        }).toString();
        return this.request('GET', `project/${projectId}/sync/pdf?${query}`,
                            undefined, (res) => {
                                const syncPdf = (JSON.parse(res!) as any).code[0] as SyncPdfResponseSchema;
                                return {syncPdf};
                            });
    }

    async proxySyncCode(identity:Identity, projectId:string, file:string, line:number, column:number, buildId:string) {
        this.setIdentity(identity);
        const query = new URLSearchParams({
            file,
            line: String(line),
            column: String(column),
            editorId: uuidv4(),
            buildId,
        }).toString();
        return this.request('GET', `project/${projectId}/sync/code?${query}`,
                            undefined, (res) => {
                                const syncCode = (JSON.parse(res!) as any).pdf as SyncCodeResponseSchema;
                                return {syncCode};
                            });
    }

    async getAllTags(identity:Identity) {
        this.setIdentity(identity);
        return this.request('GET', 'tag', undefined, (res) => {
            const tags = JSON.parse(res!) as ProjectTagsResponseSchema[];
            return {tags};
        });
    }

    async createTag(identity:Identity, name:string) {
        this.setIdentity(identity);
        return this.request('POST', 'tag', {name}, (res) => {
            const tags = JSON.parse(res!) as ProjectTagsResponseSchema[];
            return {tags};
        });
    }

    async renameTag(identity:Identity, tagId:string, name:string) {
        this.setIdentity(identity);
        return this.request('POST', `tag/${tagId}/rename`, {name});
    }

    async deleteTag(identity:Identity, tagId:string) {
        this.setIdentity(identity);
        return this.request('DELETE', `tag/${tagId}`);
    }

    async addProjectToTag(identity:Identity, tagId:string, projectId:string) {
        this.setIdentity(identity);
        return this.request('POST', `tag/${tagId}/project/${projectId}`);
    }

    async removeProjectFromTag(identity:Identity, tagId:string, projectId:string) {
        this.setIdentity(identity);
        return this.request('DELETE', `tag/${tagId}/project/${projectId}`);
    }

    async proxyToHistoryApiAndGetUpdates(identity:Identity, projectId:string, before?:number) {
        const beforeQuery = before? `&before=${before}` : '';

        this.setIdentity(identity);
        return this.request('GET', `project/${projectId}/updates?min_count=10${beforeQuery}`, undefined, (res) => {
            const updates = JSON.parse(res!) as ProjectUpdateResponseSchema;
            return {updates};
        });
    }

    async proxyToHistoryApiAndGetFileDiff(identity:Identity, projectId:string, pathname:string, from:number, to:number) {
        this.setIdentity(identity);
        const query = new URLSearchParams({
            pathname,
            from: String(from),
            to: String(to),
        }).toString();
        return this.request('GET', `project/${projectId}/diff?${query}`, undefined, (res) => {
            const diff = JSON.parse(res!) as ProjectFileDiffResponseSchema;
            return {diff};
        });
    }

    async proxyToHistoryApiAndGetFileTreeDiff(identity:Identity, projectId:string, from:number, to:number) {
        this.setIdentity(identity);
        return this.request('GET', `project/${projectId}/filetree/diff?from=${from}&to=${to}`, undefined, (res) => {
            const treeDiff = JSON.parse(res!) as ProjectFileTreeDiffResponseSchema;
            return {treeDiff};
        });
    }

    async downloadZipOfVersion(identity:Identity, projectId:string, version:number) {
        this.setIdentity(identity);
        const content = await this.downloadWithRedirects(`project/${projectId}/version/${version}/zip`);
        return {
            type: 'success',
            content: new Uint8Array(content)
        };
    }

    async downloadCurrentProjectZip(identity:Identity, projectId:string) {
        this.setIdentity(identity);
        const content = await this.downloadWithRedirects(`project/${projectId}/download/zip`);
        return {
            type: 'success',
            content: new Uint8Array(content)
        };
    }

    async getLabels(identity:Identity, projectId:string) {
        this.setIdentity(identity);
        return this.request('GET', `project/${projectId}/labels`, undefined, (res) => {
            const labels = JSON.parse(res!) as ProjectLabelResponseSchema[];
            return {labels};
        });
    }

    async createLabel(identity:Identity, projectId:string, comment:string, version:number) {
        this.setIdentity(identity);
        return this.request('POST', `project/${projectId}/labels`, {comment, version}, (res) => {
            const labels = [JSON.parse(res!)] as ProjectLabelResponseSchema[];
            return {labels};
        });
    }

    private buildProjectChatHeaders(identity: Identity, projectId: string) {
        return {
            'Accept': 'application/json',
            'Accept-Encoding': 'gzip, deflate, br, zstd',
            'Accept-Language': resolveBrowserLikeAcceptLanguage(),
            'Content-Type': 'application/json',
            'Origin': new URL(this.url).origin,
            'Priority': 'u=3, i',
            'Referer': new URL(`project/${projectId}`, this.url).toString(),
            'Sec-Fetch-Dest': 'empty',
            'Sec-Fetch-Mode': 'cors',
            'Sec-Fetch-Site': 'same-origin',
            'User-Agent': resolveBrowserLikeUserAgent(),
            'X-Csrf-Token': identity.csrfToken,
        };
    }

    async deleteLabel(identity:Identity, projectId:string, labelId:string) {
        this.setIdentity(identity);
        return this.request('DELETE', `project/${projectId}/labels/${labelId}`);
    }

    async getMessages(identity:Identity, projectId:string, limit:number=50, before?: number) {
        this.setIdentity(identity);
        const beforeQuery = before!==undefined ? `&before=${before}` : '';
        const route = `project/${projectId}/messages?limit=${limit}${beforeQuery}`;
        this.debugLog('chat.messages_fetch_started', {
            before: before ?? '',
            limit,
            projectId,
            route,
        });
        const response = await this.request('GET', route, undefined, (res) => {
            const messages = JSON.parse(res!) as ProjectMessageResponseSchema[];
            return {messages};
        }, this.buildProjectChatHeaders(identity, projectId));
        this.debugLog(response.type==='success' ? 'chat.messages_fetch_completed' : 'chat.messages_fetch_failed', {
            before: before ?? '',
            limit,
            messageCount: response.messages?.length ?? 0,
            projectId,
        }, response.type==='error' ? response.message : undefined);
        return response;
    }

    async sendMessage(identity:Identity, projectId:string, client_id:string, content:string): Promise<ChatSendApiResponseSchema> {
        this.setIdentity(identity);
        this.debugLog('chat.message_send_started', {
            clientId: client_id,
            contentLength: content.trim().length,
            projectId,
            route: `project/${projectId}/messages`,
        });
        const route = `project/${projectId}/messages`;
        const headers = {
            'Cookie': normalizeCookieHeader(identity.cookies),
            ...this.buildProjectChatHeaders(identity, projectId),
        };
        this.debugLog('chat.message_send_http_request', {
            ...sanitizeChatRequestHeadersForDiagnostics(headers),
            bodyKeys: ['content'],
            projectId,
            route,
        });
        const res = await fetch(this.resolveSameOriginUrl(route), {
            method: 'POST',
            redirect: 'manual',
            agent: this.agent,
            headers,
            body: JSON.stringify({content}),
        });
        identity.cookies = mergeCookieHeaders(identity.cookies, res.headers.raw()['set-cookie'] ?? []);
        this.debugLog('chat.message_send_http_response', {
            ...pickChatResponseHeaders(res.headers),
            projectId,
            route,
            statusCode: res.status,
        });
        const responseBody = res.status===204 ? '' : await res.text();
        const response: ChatSendApiResponseSchema = (res.status===200 || res.status===201 || res.status===204)
            ? {
                type: 'success',
                method: 'POST',
                route,
                statusCode: res.status,
            }
            : {
                type: 'error',
                method: 'POST',
                route,
                statusCode: res.status,
                responseBody,
                message: buildHttpFailureMessage(res.status),
            };
        if (response.type==='success') {
            this.debugLog('chat.message_send_completed', {
                clientId: client_id,
                contentLength: content.trim().length,
                projectId,
            });
            return response;
        }

        const failure = buildOverleafChatSendFailure({
            message: response.message,
            responseBody: response.responseBody,
            route: response.route,
            statusCode: response.statusCode,
        });
        this.debugLog('chat.message_send_failed', {
            chatSendErrorCode: failure.code,
            clientId: client_id,
            contentLength: content.trim().length,
            projectId,
            responsePreview: failure.responsePreview ?? '',
            route: response.route,
            statusCode: response.statusCode,
        }, response.message);
        return {
            ...response,
            chatSendErrorCode: failure.code,
            responsePreview: failure.responsePreview,
        };
    }

    async editChatMessage(identity:Identity, projectId:string, messageId:string, content:string) {
        this.setIdentity(identity);
        this.debugLog('chat.message_edit_started', {
            contentLength: content.length,
            messageId,
            projectId,
            route: `project/${projectId}/messages/${messageId}/edit`,
        });
        const response = await this.request('POST', `project/${projectId}/messages/${messageId}/edit`, {content}, undefined, {
            ...this.buildProjectChatHeaders(identity, projectId),
        });
        this.debugLog(response.type==='success' ? 'chat.message_edit_completed' : 'chat.message_edit_failed', {
            messageId,
            projectId,
        }, response.type==='error' ? response.message : undefined);
        return response;
    }

    async deleteChatMessage(identity:Identity, projectId:string, messageId:string) {
        this.setIdentity(identity);
        this.debugLog('chat.message_delete_started', {
            messageId,
            projectId,
            route: `project/${projectId}/messages/${messageId}`,
        });
        const response = await this.request('DELETE', `project/${projectId}/messages/${messageId}`, undefined, undefined, {
            ...this.buildProjectChatHeaders(identity, projectId),
        });
        this.debugLog(response.type==='success' ? 'chat.message_delete_completed' : 'chat.message_delete_failed', {
            messageId,
            projectId,
        }, response.type==='error' ? response.message : undefined);
        return response;
    }

    async getCommentThreads(identity:Identity, projectId:string) {
        this.setIdentity(identity);
        this.debugLog('comments.fetch_started', {
            projectId,
            route: `project/${projectId}/threads`,
        });
        const response = await this.request('GET', `project/${projectId}/threads`, undefined, (res) => {
            const commentThreads = JSON.parse(res!) as ProjectCommentThreadsResponseSchema;
            return {commentThreads};
        }, {'X-Csrf-Token': identity.csrfToken});
        this.debugLog(response.type==='success' ? 'comments.fetch_completed' : 'comments.fetch_failed', {
            projectId,
            threadCount: response.commentThreads ? Object.keys(response.commentThreads).length : 0,
        }, response.type==='error' ? response.message : undefined);
        return response;
    }

    async createCommentMessage(identity:Identity, projectId:string, threadId:string, content:string) {
        this.setIdentity(identity);
        this.debugLog('comments.create_message_started', {
            contentLength: content.length,
            projectId,
            threadId,
        });
        const response = await this.request('POST', `project/${projectId}/thread/${threadId}/messages`, {content}, (res) => {
            const commentMessage = res ? safeParseJson<ProjectCommentThreadMessageSchema>(res) : undefined;
            return {commentMessage};
        }, {'X-Csrf-Token': identity.csrfToken});
        this.debugLog(response.type==='success' ? 'comments.create_message_completed' : 'comments.create_message_failed', {
            contentLength: content.length,
            hasCommentMessage: Boolean(response.commentMessage),
            messageId: response.commentMessage?.id ?? '',
            projectId,
            threadId,
        }, response.type==='error' ? response.message : undefined);
        return response;
    }

    async editCommentMessage(identity:Identity, projectId:string, threadId:string, messageId:string, content:string) {
        this.setIdentity(identity);
        this.debugLog('comments.edit_message_started', {
            contentLength: content.length,
            messageId,
            projectId,
            threadId,
        });
        const response = await this.request('POST', `project/${projectId}/thread/${threadId}/messages/${messageId}/edit`, {content}, undefined, {
            'X-Csrf-Token': identity.csrfToken,
        });
        this.debugLog(response.type==='success' ? 'comments.edit_message_completed' : 'comments.edit_message_failed', {
            messageId,
            projectId,
            threadId,
        }, response.type==='error' ? response.message : undefined);
        return response;
    }

    async deleteCommentMessage(identity:Identity, projectId:string, threadId:string, messageId:string) {
        this.setIdentity(identity);
        this.debugLog('comments.delete_message_started', {
            messageId,
            projectId,
            threadId,
        });
        const response = await this.request('DELETE', `project/${projectId}/thread/${threadId}/messages/${messageId}`, undefined, undefined, {
            'X-Csrf-Token': identity.csrfToken,
        });
        this.debugLog(response.type==='success' ? 'comments.delete_message_completed' : 'comments.delete_message_failed', {
            messageId,
            projectId,
            threadId,
        }, response.type==='error' ? response.message : undefined);
        return response;
    }

    async deleteOwnCommentMessage(identity:Identity, projectId:string, threadId:string, messageId:string) {
        this.setIdentity(identity);
        this.debugLog('comments.delete_own_message_started', {
            messageId,
            projectId,
            threadId,
        });
        const response = await this.request('DELETE', `project/${projectId}/thread/${threadId}/own-messages/${messageId}`, undefined, undefined, {
            'X-Csrf-Token': identity.csrfToken,
        });
        this.debugLog(response.type==='success' ? 'comments.delete_own_message_completed' : 'comments.delete_own_message_failed', {
            messageId,
            projectId,
            threadId,
        }, response.type==='error' ? response.message : undefined);
        return response;
    }

    async resolveCommentThread(identity:Identity, projectId:string, docId:string, threadId:string) {
        this.setIdentity(identity);
        this.debugLog('comments.resolve_thread_started', {
            docId,
            projectId,
            threadId,
        });
        const response = await this.request('POST', `project/${projectId}/doc/${docId}/thread/${threadId}/resolve`, {}, undefined, {
            'X-Csrf-Token': identity.csrfToken,
        });
        this.debugLog(response.type==='success' ? 'comments.resolve_thread_completed' : 'comments.resolve_thread_failed', {
            docId,
            projectId,
            threadId,
        }, response.type==='error' ? response.message : undefined);
        return response;
    }

    async reopenCommentThread(identity:Identity, projectId:string, docId:string, threadId:string) {
        this.setIdentity(identity);
        this.debugLog('comments.reopen_thread_started', {
            docId,
            projectId,
            threadId,
        });
        const response = await this.request('POST', `project/${projectId}/doc/${docId}/thread/${threadId}/reopen`, {}, undefined, {
            'X-Csrf-Token': identity.csrfToken,
        });
        this.debugLog(response.type==='success' ? 'comments.reopen_thread_completed' : 'comments.reopen_thread_failed', {
            docId,
            projectId,
            threadId,
        }, response.type==='error' ? response.message : undefined);
        return response;
    }

    async deleteCommentThread(identity:Identity, projectId:string, docId:string, threadId:string) {
        this.setIdentity(identity);
        this.debugLog('comments.delete_thread_started', {
            docId,
            projectId,
            threadId,
        });
        const response = await this.request('DELETE', `project/${projectId}/doc/${docId}/thread/${threadId}`, undefined, undefined, {
            'X-Csrf-Token': identity.csrfToken,
        });
        this.debugLog(response.type==='success' ? 'comments.delete_thread_completed' : 'comments.delete_thread_failed', {
            docId,
            projectId,
            threadId,
        }, response.type==='error' ? response.message : undefined);
        return response;
    }
}
