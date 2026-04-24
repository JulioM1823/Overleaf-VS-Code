export type ConnectionScheme = 'Alt' | 'v1' | 'v2';
export type SocketEventTimeoutScope = 'default' | 'joinProject';
export type JoinProjectStrategy = 'emit_callback' | 'handshake_auto_join';
export interface SocketTransportOptions {
    'auto connect': boolean,
    transports: string[],
    'try multiple transports': boolean,
}
export interface RealtimeHandshakeMetadata {
    sessionId: string,
    heartbeatTimeoutSeconds: number,
    closeTimeoutSeconds: number,
    transports: string[],
}

export interface SocketConnectionTarget {
    connectUrl: string,
    resource: string,
    socketScriptUrl: string,
    query: string,
}

export const MAX_WEBSOCKET_FAILURES = 3;

export type JoinFailureReason =
    | 'connectionRejected'
    | 'connect_failed'
    | 'timeout'
    | 'error';

export function getPreferredConnectionScheme(url: string): ConnectionScheme {
    void url;
    // The extension currently ships the Overleaf-maintained 0.9.x socket.io client.
    // Default to the legacy protocol unless a true v2 client is introduced.
    return 'v1';
}

export function shouldForcePollingTransport(url: string): boolean {
    void url;
    return false;
}

export function getSocketTransportOptions(
    url: string,
    websocketFailureCount = 0,
): SocketTransportOptions {
    void url;
    const transports = ['xhr-polling'];
    if (websocketFailureCount < MAX_WEBSOCKET_FAILURES) {
        transports.unshift('websocket');
    }
    return {
        'auto connect': false,
        transports,
        'try multiple transports': true,
    };
}

export function resolveSocketConnectionTarget(siteUrl: string, wsUrl?: string): SocketConnectionTarget {
    const endpoint = new URL(wsUrl || '/socket.io', siteUrl);
    const resource = endpoint.pathname.replace(/^\/+/, '') || 'socket.io';
    const socketScriptUrl = new URL(
        `${endpoint.pathname.replace(/\/+$/, '')}/socket.io.js`,
        endpoint.origin,
    ).toString();
    return {
        connectUrl: endpoint.origin,
        resource,
        socketScriptUrl,
        query: endpoint.search.replace(/^\?/, ''),
    };
}

export function buildRealtimeHandshakeQuery(projectId: string, now = Date.now()): string {
    void now;
    return new URLSearchParams({ projectId }).toString();
}

export function buildRealtimeHandshakeUrl(
    target: SocketConnectionTarget,
    query = '',
    now = Date.now(),
): string {
    const endpoint = new URL(`${target.resource.replace(/^\/+|\/+$/g, '')}/1/`, `${target.connectUrl.replace(/\/+$/, '')}/`);
    const search = new URLSearchParams(query || target.query);
    search.set('t', String(now));
    endpoint.search = search.toString();
    return endpoint.toString();
}

export function parseRealtimeHandshakeResponse(body: string): RealtimeHandshakeMetadata | undefined {
    const [sessionId, heartbeatTimeout, closeTimeout, transports] = body.trim().split(':');
    if (!sessionId || !heartbeatTimeout || !closeTimeout || !transports) {
        return undefined;
    }

    const heartbeatTimeoutSeconds = Number(heartbeatTimeout);
    const closeTimeoutSeconds = Number(closeTimeout);
    if (!Number.isFinite(heartbeatTimeoutSeconds) || !Number.isFinite(closeTimeoutSeconds)) {
        return undefined;
    }

    return {
        sessionId,
        heartbeatTimeoutSeconds,
        closeTimeoutSeconds,
        transports: transports.split(',').filter(Boolean),
    };
}

export function getJoinProjectStrategy(scheme: ConnectionScheme): JoinProjectStrategy {
    switch (scheme) {
        case 'Alt':
            return 'emit_callback';
        case 'v1':
        case 'v2':
            return 'handshake_auto_join';
    }
}

export function nextConnectionSchemeOnJoinFailure(
    currentScheme: ConnectionScheme,
    reason: JoinFailureReason,
): ConnectionScheme {
    void reason;
    return currentScheme;
}

export function getSocketEmitTimeoutMs(scope: SocketEventTimeoutScope): number {
    switch (scope) {
        case 'joinProject':
            return 20000;
        default:
            return 5000;
    }
}
