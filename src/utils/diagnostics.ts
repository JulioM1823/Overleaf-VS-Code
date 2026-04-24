import * as crypto from 'crypto';

type Primitive = string | number | boolean | null;
type DiagnosticValue = Primitive | DiagnosticValue[] | {[key: string]: DiagnosticValue};

export type DiagnosticLevel = 'debug' | 'info' | 'warning' | 'error';
export type DiagnosticCategory =
    | 'sync'
    | 'chat'
    | 'comments'
    | 'filesystem'
    | 'network'
    | 'compile'
    | 'offline'
    | 'core'
    | 'scm'
    | 'intellisense'
    | 'project'
    | 'review'
    | 'unknown';

type DiagnosticMap = {[key: string]: DiagnosticValue};

export type DiagnosticsRuntimeConfiguration = {
    enabled: boolean,
    verbose: boolean,
    minLevel: DiagnosticLevel,
    enabledCategories: DiagnosticCategory[],
    maxBufferRecords: number,
    includeErrorStack: boolean,
    consoleEnabled: boolean,
};

export type DiagnosticLogOptions = {
    level?: DiagnosticLevel,
    category?: DiagnosticCategory,
    traceId?: string,
    operationId?: string,
    durationMs?: number,
};

export type DiagnosticTraceContext = {
    traceId: string,
    operationId: string,
};

export type DiagnosticStateProvider = () => Record<string, unknown>;

type DiagnosticSink = (scope: string, formattedRecord: string, record: DiagnosticMap) => void;

const diagnosticLevels: readonly DiagnosticLevel[] = ['debug', 'info', 'warning', 'error'];
export const DIAGNOSTIC_LEVELS = [...diagnosticLevels];

const diagnosticCategories: readonly DiagnosticCategory[] = [
    'sync',
    'chat',
    'comments',
    'filesystem',
    'network',
    'compile',
    'offline',
    'core',
    'scm',
    'intellisense',
    'project',
    'review',
    'unknown',
];
export const DIAGNOSTIC_CATEGORIES = [...diagnosticCategories];

const levelPriority: Record<DiagnosticLevel, number> = {
    debug: 10,
    info: 20,
    warning: 30,
    error: 40,
};

const scopeCategoryOverrides: Record<string, DiagnosticCategory> = {
    collaboration: 'chat',
    compilemanager: 'compile',
    diagnostics: 'core',
    documentsessions: 'sync',
    eventbus: 'core',
    historyview: 'scm',
    localreplicascm: 'offline',
    pdfdocument: 'compile',
    projectmanager: 'project',
    projectsearch: 'intellisense',
    referenceintellisense: 'intellisense',
    referencenavigation: 'intellisense',
    remotefilesystem: 'filesystem',
    reviewview: 'comments',
    scmcollection: 'scm',
    texparser: 'intellisense',
};

const defaultRuntimeConfiguration: DiagnosticsRuntimeConfiguration = {
    enabled: false,
    verbose: false,
    minLevel: 'warning',
    enabledCategories: [],
    maxBufferRecords: 800,
    includeErrorStack: false,
    consoleEnabled: true,
};

let runtimeConfiguration: DiagnosticsRuntimeConfiguration = {
    ...defaultRuntimeConfiguration,
};

const diagnosticRecordBuffer: DiagnosticMap[] = [];
const diagnosticStateProviders = new Map<string, DiagnosticStateProvider>();
let diagnosticSink: DiagnosticSink | undefined;
let traceSequence = 0;
let diagnosticSequence = 0;

const exactSensitiveDiagnosticKeys = new Set([
    'activeChatClientId',
    'authorName',
    'baseText',
    'baseUrl',
    'body',
    'content',
    'cookies',
    'csrfToken',
    'email',
    'fileUri',
    'identifier',
    'identity',
    'lineText',
    'localText',
    'nextRemoteText',
    'origin',
    'password',
    'previousRemoteText',
    'projectId',
    'projectName',
    'publicId',
    'raw',
    'remoteText',
    'responseBody',
    'responsePreview',
    'selectedText',
    'serverName',
    'snapshotUri',
    'storageRoot',
    'target',
    'uri',
    'url',
    'userEmail',
    'userId',
    'username',
    'workspaceRootUri',
]);
const normalizedSensitiveDiagnosticKeys = new Set(
    Array.from(exactSensitiveDiagnosticKeys).map((key) => key.replace(/[_-]/g, '').toLowerCase()),
);

const sensitiveDiagnosticKeyPattern = /(?:authorization|cookie|credential|csrf|identity|password|secret|sessionid|token)/i;
const emailPattern = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const cookieValuePattern = /\b([A-Za-z0-9_.-]*(?:sid|session|cookie)[A-Za-z0-9_.-]*=)[^;\s]+/gi;
const sensitiveQueryPattern = /([?&](?:_?csrf|access_token|auth|code|cookie|password|session|token)=)[^&#\s]+/gi;
const absolutePathPattern = /(?:\/Users\/[^/\s"'<>]+(?:\/[^\s"'<>]*)?|[A-Za-z]:\\[^\s"'<>]*)/g;
const diagnosticStringMaxLength = 2048;

function digestDiagnosticValue(value: string): string {
    return crypto.createHash('sha256').update(value).digest('hex').slice(0, 12);
}

function redactedDiagnosticValue(value: string, label = 'value'): string {
    return `[redacted-${label}:${digestDiagnosticValue(value)}]`;
}

function normalizeDiagnosticKey(key?: string) {
    return key?.replace(/[_-]/g, '').toLowerCase();
}

function isSensitiveDiagnosticKey(key?: string): boolean {
    if (!key) {
        return false;
    }
    if (exactSensitiveDiagnosticKeys.has(key)) {
        return true;
    }
    const normalizedKey = normalizeDiagnosticKey(key) ?? '';
    return normalizedSensitiveDiagnosticKeys.has(normalizedKey)
        || sensitiveDiagnosticKeyPattern.test(key);
}

function isPathLikeDiagnosticKey(key?: string): boolean {
    return key!==undefined && /(?:path|uri|url|origin|referer|location|route)$/i.test(key);
}

function sanitizeUrlLikeDiagnosticValue(value: string): string {
    const trimmed = value.trim();
    if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) {
        return redactedDiagnosticValue(trimmed, 'url');
    }
    if (trimmed.startsWith('/') || trimmed.includes('\\')) {
        return redactedDiagnosticValue(trimmed, 'path');
    }
    return value.replace(sensitiveQueryPattern, (_match, prefix) => `${prefix}[redacted]`);
}

function sanitizeDiagnosticString(value: string, key?: string): string {
    if (isSensitiveDiagnosticKey(key)) {
        return redactedDiagnosticValue(value, normalizeDiagnosticKey(key) ?? 'value');
    }

    let sanitized = value
        .replace(emailPattern, (match) => redactedDiagnosticValue(match, 'email'))
        .replace(cookieValuePattern, (_match, prefix) => `${prefix}[redacted]`)
        .replace(sensitiveQueryPattern, (_match, prefix) => `${prefix}[redacted]`)
        .replace(absolutePathPattern, (match) => redactedDiagnosticValue(match, 'path'));

    if (isPathLikeDiagnosticKey(key)) {
        sanitized = sanitizeUrlLikeDiagnosticValue(sanitized);
    }

    if (sanitized.length > diagnosticStringMaxLength) {
        return `${sanitized.slice(0, diagnosticStringMaxLength)}...[truncated:${sanitized.length}]`;
    }

    return sanitized;
}

function normalizePrimitive(value: unknown): Primitive | undefined {
    if (value === null) {
        return null;
    }

    switch (typeof value) {
        case 'string':
        case 'number':
        case 'boolean':
            return value;
        default:
            return undefined;
    }
}

function normalizeObject(value: Record<string, unknown>): {[key: string]: DiagnosticValue} {
    const normalizedEntries = Object.entries(value)
        .map(([key, item]) => [key, normalizeValue(item, key)] as const)
        .filter((entry): entry is readonly [string, DiagnosticValue] => entry[1] !== undefined)
        .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey));

    return Object.fromEntries(normalizedEntries);
}

function normalizeError(error: unknown, includeStack: boolean): {[key: string]: DiagnosticValue} | undefined {
    if (error === undefined) {
        return undefined;
    }

    if (error instanceof Error) {
        const normalized: {[key: string]: DiagnosticValue} = {
            errorMessage: error.message,
            errorName: error.name,
        };
        const code = (error as Error & {code?: string}).code;
        if (code) {
            normalized.errorCode = code;
        }
        if (includeStack && error.stack) {
            normalized.errorStack = error.stack;
        }
        return normalizeObject(normalized);
    }

    if (typeof error === 'string') {
        return {errorMessage: error};
    }

    if (typeof error === 'object' && error !== null) {
        return normalizeObject(error as Record<string, unknown>);
    }

    return {errorMessage: String(error)};
}

function normalizeValue(value: unknown, key?: string): DiagnosticValue | undefined {
    const primitive = normalizePrimitive(value);
    if (primitive !== undefined) {
        if (typeof primitive === 'string') {
            return sanitizeDiagnosticString(primitive, key);
        }
        return primitive;
    }

    if (Array.isArray(value)) {
        return value
            .map(item => normalizeValue(item, key))
            .filter((item): item is DiagnosticValue => item !== undefined);
    }

    if (value instanceof Date) {
        return sanitizeDiagnosticString(
            Number.isNaN(value.getTime()) ? value.toString() : value.toISOString(),
            key,
        );
    }

    if (value instanceof Error) {
        return normalizeError(value, runtimeConfiguration.includeErrorStack);
    }

    if (typeof value === 'object' && value !== null) {
        return normalizeObject(value as Record<string, unknown>);
    }

    if (value === undefined) {
        return undefined;
    }

    return sanitizeDiagnosticString(String(value), key);
}

function normalizeDiagnosticLevel(level: string): DiagnosticLevel | undefined {
    return diagnosticLevels.includes(level as DiagnosticLevel)
        ? level as DiagnosticLevel
        : undefined;
}

function normalizeDiagnosticCategory(category: string): DiagnosticCategory | undefined {
    return diagnosticCategories.includes(category as DiagnosticCategory)
        ? category as DiagnosticCategory
        : undefined;
}

function normalizeDiagnosticCategories(categories: readonly string[]): DiagnosticCategory[] {
    const normalized = categories
        .map((category) => normalizeDiagnosticCategory(category))
        .filter((category): category is DiagnosticCategory => category !== undefined);
    return Array.from(new Set(normalized));
}

function clampBufferSize(size: number): number {
    if (!Number.isFinite(size)) {
        return defaultRuntimeConfiguration.maxBufferRecords;
    }
    return Math.max(1, Math.min(10000, Math.trunc(size)));
}

function trimDiagnosticBuffer() {
    if (diagnosticRecordBuffer.length <= runtimeConfiguration.maxBufferRecords) {
        return;
    }
    const amountToTrim = diagnosticRecordBuffer.length - runtimeConfiguration.maxBufferRecords;
    diagnosticRecordBuffer.splice(0, amountToTrim);
}

function inferDiagnosticCategory(scope: string, event: string): DiagnosticCategory {
    const loweredScope = scope.toLowerCase();
    const loweredEvent = event.toLowerCase();

    if (scopeCategoryOverrides[loweredScope]) {
        return scopeCategoryOverrides[loweredScope];
    }

    if (loweredEvent.startsWith('chat.') || loweredScope.includes('chat')) {
        return 'chat';
    }
    if (loweredEvent.startsWith('comment') || loweredEvent.startsWith('review.') || loweredScope.includes('review')) {
        return 'comments';
    }
    if (loweredEvent.startsWith('session.') || loweredEvent.startsWith('sync.') || loweredScope.includes('session')) {
        return 'sync';
    }
    if (loweredEvent.startsWith('vfs.') || loweredEvent.startsWith('fs.') || loweredScope.includes('filesystem')) {
        return 'filesystem';
    }
    if (loweredEvent.startsWith('api.') || loweredEvent.startsWith('socket') || loweredScope.includes('network')) {
        return 'network';
    }
    if (loweredEvent.startsWith('compile.') || loweredScope.includes('compile') || loweredScope.includes('pdf')) {
        return 'compile';
    }
    if (loweredEvent.startsWith('offline') || loweredScope.includes('offline') || loweredScope.includes('replica')) {
        return 'offline';
    }
    if (loweredEvent.startsWith('history.') || loweredEvent.startsWith('scm.') || loweredScope.includes('scm')) {
        return 'scm';
    }
    if (loweredEvent.startsWith('search.') || loweredEvent.startsWith('citation.') || loweredEvent.startsWith('definition.')) {
        return 'intellisense';
    }
    if (loweredScope.includes('project')) {
        return 'project';
    }
    if (loweredScope.includes('event') || loweredScope.includes('diagnostics') || loweredScope.includes('extension')) {
        return 'core';
    }
    return 'unknown';
}

function inferDiagnosticLevel(event: string, error: unknown): DiagnosticLevel {
    if (error !== undefined) {
        return 'error';
    }

    const loweredEvent = event.toLowerCase();

    if (/(failed|error|exception|fatal|unhandled|aborted)/.test(loweredEvent)) {
        return 'error';
    }

    if (/(warn|warning|retry|timeout|cooldown|cancelled|canceled|skipped|fallback|degraded|rate_limit)/.test(loweredEvent)) {
        return 'warning';
    }

    if (/(started|completed|created|opened|closed|resolved|updated|loaded|queued|scheduled|changed|refresh|init|initialized)/.test(loweredEvent)) {
        return 'info';
    }

    return 'debug';
}

function effectiveMinimumLevel(): DiagnosticLevel {
    if (!runtimeConfiguration.enabled) {
        return 'warning';
    }
    if (runtimeConfiguration.verbose) {
        return 'debug';
    }
    return runtimeConfiguration.minLevel;
}

function shouldEmitRecord(level: DiagnosticLevel, category: DiagnosticCategory): boolean {
    if (levelPriority[level] < levelPriority[effectiveMinimumLevel()]) {
        return false;
    }

    if (!runtimeConfiguration.enabled) {
        return true;
    }

    if (runtimeConfiguration.enabledCategories.length===0) {
        return true;
    }

    return runtimeConfiguration.enabledCategories.includes(category);
}

function buildDiagnosticRecord(
    event: string,
    fields: Record<string, unknown> = {},
    error?: unknown,
    includeStack = false,
): DiagnosticMap {
    const record: DiagnosticMap = {
        event,
        ...normalizeObject(fields),
    };
    const normalizedError = normalizeError(error, includeStack);
    if (normalizedError) {
        Object.assign(record, normalizedError);
    }
    return record;
}

function emitToConsole(scope: string, level: DiagnosticLevel, message: string) {
    if (!runtimeConfiguration.consoleEnabled) {
        return;
    }

    switch (level) {
        case 'debug':
            console.debug(`${scope}: ${message}`);
            break;
        case 'info':
            console.info(`${scope}: ${message}`);
            break;
        case 'warning':
            console.warn(`${scope}: ${message}`);
            break;
        case 'error':
            console.error(`${scope}: ${message}`);
            break;
    }
}

function appendDiagnosticRecord(record: DiagnosticMap) {
    diagnosticRecordBuffer.push(record);
    trimDiagnosticBuffer();
}

function buildDiagnosticIdentifier(prefix: string): string {
    traceSequence = (traceSequence + 1) % 1000000;
    return `${prefix}-${Date.now().toString(36)}-${traceSequence.toString(36)}`;
}

function collectProviderState(): Record<string, DiagnosticValue> {
    const state: Record<string, DiagnosticValue> = {};
    for (const [scope, provider] of diagnosticStateProviders.entries()) {
        try {
            state[scope] = normalizeObject(provider());
        } catch (error) {
            state[scope] = {
                providerState: 'failed',
                ...(normalizeError(error, runtimeConfiguration.includeErrorStack) ?? {errorMessage: 'Unknown error'}),
            };
        }
    }
    return state;
}

export function formatDiagnosticRecord(
    event: string,
    fields: Record<string, unknown> = {},
    error?: unknown,
): string {
    return JSON.stringify(buildDiagnosticRecord(event, fields, error, false));
}

export function logDiagnostic(
    scope: string,
    event: string,
    fields: Record<string, unknown> = {},
    error?: unknown,
    options: DiagnosticLogOptions = {},
) {
    const level = options.level ?? inferDiagnosticLevel(event, error);
    const category = options.category ?? inferDiagnosticCategory(scope, event);

    if (!shouldEmitRecord(level, category)) {
        return;
    }

    diagnosticSequence += 1;

    const enrichedFields: Record<string, unknown> = {
        ...fields,
        category,
        level,
        sequence: diagnosticSequence,
        scope,
        timestamp: new Date().toISOString(),
    };
    if (options.traceId) {
        enrichedFields.traceId = options.traceId;
    }
    if (options.operationId) {
        enrichedFields.operationId = options.operationId;
    }
    if (options.durationMs !== undefined) {
        enrichedFields.durationMs = options.durationMs;
    }

    const record = buildDiagnosticRecord(event, enrichedFields, error, runtimeConfiguration.includeErrorStack);
    const formattedRecord = JSON.stringify(record);

    appendDiagnosticRecord(record);
    emitToConsole(scope, level, formattedRecord);

    if (!diagnosticSink) {
        return;
    }

    try {
        diagnosticSink(scope, formattedRecord, record);
    } catch (sinkError) {
        const failureRecord = buildDiagnosticRecord(
            'diagnostics.sink_failed',
            {
                sinkType: 'custom',
                sourceScope: scope,
            },
            sinkError,
            runtimeConfiguration.includeErrorStack,
        );
        emitToConsole('Diagnostics', 'error', JSON.stringify(failureRecord));
    }
}

export function configureDiagnostics(configuration: Partial<DiagnosticsRuntimeConfiguration>) {
    const nextConfiguration: DiagnosticsRuntimeConfiguration = {
        ...runtimeConfiguration,
    };

    if (configuration.enabled !== undefined) {
        nextConfiguration.enabled = configuration.enabled;
    }
    if (configuration.verbose !== undefined) {
        nextConfiguration.verbose = configuration.verbose;
    }
    if (configuration.minLevel) {
        const normalizedLevel = normalizeDiagnosticLevel(configuration.minLevel);
        if (normalizedLevel) {
            nextConfiguration.minLevel = normalizedLevel;
        }
    }
    if (configuration.enabledCategories) {
        nextConfiguration.enabledCategories = normalizeDiagnosticCategories(configuration.enabledCategories);
    }
    if (configuration.maxBufferRecords !== undefined) {
        nextConfiguration.maxBufferRecords = clampBufferSize(configuration.maxBufferRecords);
    }
    if (configuration.includeErrorStack !== undefined) {
        nextConfiguration.includeErrorStack = configuration.includeErrorStack;
    }
    if (configuration.consoleEnabled !== undefined) {
        nextConfiguration.consoleEnabled = configuration.consoleEnabled;
    }

    runtimeConfiguration = nextConfiguration;
    trimDiagnosticBuffer();
}

export function getDiagnosticsRuntimeConfiguration(): DiagnosticsRuntimeConfiguration {
    return {
        ...runtimeConfiguration,
        enabledCategories: [...runtimeConfiguration.enabledCategories],
    };
}

export function setDiagnosticSink(sink?: DiagnosticSink) {
    diagnosticSink = sink;
}

export function clearDiagnosticBuffer() {
    diagnosticRecordBuffer.length = 0;
}

export function getRecentDiagnosticRecords(limit = runtimeConfiguration.maxBufferRecords): DiagnosticMap[] {
    const safeLimit = Math.max(0, Math.trunc(limit));
    if (safeLimit===0) {
        return [];
    }

    const start = Math.max(0, diagnosticRecordBuffer.length - safeLimit);
    return diagnosticRecordBuffer.slice(start).map(record => ({...record}));
}

export function sanitizeDiagnosticPayload(payload: unknown): DiagnosticValue | undefined {
    return normalizeValue(payload);
}

export function registerDiagnosticStateProvider(scope: string, provider: DiagnosticStateProvider): {dispose: () => void} {
    diagnosticStateProviders.set(scope, provider);
    return {
        dispose: () => {
            diagnosticStateProviders.delete(scope);
        },
    };
}

export function collectDiagnosticSnapshot(options: {recentLimit?: number} = {}) {
    return {
        bufferedRecords: diagnosticRecordBuffer.length,
        emittedRecordCount: diagnosticSequence,
        recentRecords: getRecentDiagnosticRecords(options.recentLimit ?? runtimeConfiguration.maxBufferRecords),
        runtimeConfiguration: getDiagnosticsRuntimeConfiguration(),
        state: collectProviderState(),
    };
}

export function createDiagnosticTraceContext(traceId?: string): DiagnosticTraceContext {
    return {
        traceId: traceId ?? buildDiagnosticIdentifier('trace'),
        operationId: buildDiagnosticIdentifier('op'),
    };
}

export function withDiagnosticTraceFields(
    fields: Record<string, unknown>,
    traceContext: Partial<DiagnosticTraceContext>,
): Record<string, unknown> {
    const nextFields = {...fields};
    if (traceContext.traceId) {
        nextFields.traceId = traceContext.traceId;
    }
    if (traceContext.operationId) {
        nextFields.operationId = traceContext.operationId;
    }
    return nextFields;
}

export function startDiagnosticSpan(
    scope: string,
    event: string,
    fields: Record<string, unknown> = {},
    options: DiagnosticLogOptions = {},
): {
    traceContext: DiagnosticTraceContext,
    end: (fields?: Record<string, unknown>) => void,
    fail: (error: unknown, fields?: Record<string, unknown>) => void,
} {
    const startedAt = Date.now();
    const traceContext: DiagnosticTraceContext = {
        traceId: options.traceId ?? buildDiagnosticIdentifier('trace'),
        operationId: options.operationId ?? buildDiagnosticIdentifier('op'),
    };
    const baseFields = withDiagnosticTraceFields(fields, traceContext);

    logDiagnostic(scope, `${event}.started`, baseFields, undefined, {
        ...options,
        level: options.level ?? 'info',
        traceId: traceContext.traceId,
        operationId: traceContext.operationId,
    });

    let finished = false;

    return {
        traceContext,
        end: (completionFields: Record<string, unknown> = {}) => {
            if (finished) {
                return;
            }
            finished = true;
            const durationMs = Date.now() - startedAt;
            logDiagnostic(scope, `${event}.completed`, {
                ...baseFields,
                ...completionFields,
                durationMs,
            }, undefined, {
                ...options,
                traceId: traceContext.traceId,
                operationId: traceContext.operationId,
                durationMs,
            });
        },
        fail: (spanError: unknown, failureFields: Record<string, unknown> = {}) => {
            if (finished) {
                return;
            }
            finished = true;
            const durationMs = Date.now() - startedAt;
            logDiagnostic(scope, `${event}.failed`, {
                ...baseFields,
                ...failureFields,
                durationMs,
            }, spanError, {
                ...options,
                level: 'error',
                traceId: traceContext.traceId,
                operationId: traceContext.operationId,
                durationMs,
            });
        },
    };
}
