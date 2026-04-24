export type OverleafChatSendFailureCode =
    | 'missing-client-id'
    | 'auth-invalid'
    | 'permission-denied'
    | 'rate-limited'
    | 'validation-failed'
    | 'connectivity-failure'
    | 'server-error';

export type OverleafChatSendResult =
    | {
        ok: true,
        deliveryState: 'delivered',
        mode: 'online',
        transport: 'rest' | 'offline',
    }
    | {
        ok: true,
        deliveryState: 'queued',
        mode: 'offline-queued',
        queuedMessageId: string,
        transport: 'rest' | 'offline',
    }
    | OverleafChatSendFailure;

export interface OverleafChatSendFailure {
    ok: false,
    code: OverleafChatSendFailureCode,
    message: string,
    responsePreview?: string,
    route?: string,
    statusCode?: number,
    transport: 'rest',
}

type Translator = (message: string) => string;

function normalizeResponsePreview(responseBody?: string, maxLength = 160) {
    const normalized = responseBody
        ?.replace(/<[^>]*>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    if (!normalized) {
        return undefined;
    }
    if (normalized.length <= maxLength) {
        return normalized;
    }
    return `${normalized.slice(0, maxLength - 3)}...`;
}

export function classifyOverleafChatSendFailure(input: {
    message?: string,
    responseBody?: string,
    statusCode?: number,
}): OverleafChatSendFailureCode {
    const statusCode = input.statusCode;
    const diagnosticText = `${input.message ?? ''}\n${input.responseBody ?? ''}`.toLowerCase();

    if (statusCode===302 || statusCode===401) {
        return 'auth-invalid';
    }
    if (statusCode===403) {
        if (/(csrf|login|log in|sign in|unauthori[sz]ed|session)/.test(diagnosticText)) {
            return 'auth-invalid';
        }
        return 'permission-denied';
    }
    if (statusCode===429 || /rate limit/.test(diagnosticText)) {
        return 'rate-limited';
    }
    if (statusCode===400 || statusCode===409 || statusCode===422 || /(invalid|required|validation)/.test(diagnosticText)) {
        return 'validation-failed';
    }
    return 'server-error';
}

export function formatOverleafChatSendFailureMessage(
    code: OverleafChatSendFailureCode,
    translator: Translator = (message) => message,
    options: {
        responsePreview?: string,
        statusCode?: number,
    } = {},
) {
    const statusSuffix = options.statusCode ? ` (${options.statusCode})` : '';
    switch (code) {
        case 'missing-client-id':
            return translator('Overleaf chat is still connecting. Try again in a moment.');
        case 'auth-invalid':
            return `${translator('Unable to send the Overleaf chat message because the Overleaf session is no longer valid. Reconnect and try again.')}${statusSuffix}`;
        case 'permission-denied':
            return `${translator('Unable to send the Overleaf chat message because this account is not allowed to post in the project chat.')}${statusSuffix}`;
        case 'rate-limited':
            return `${translator('Unable to send the Overleaf chat message because Overleaf is rate limiting requests. Try again in a moment.')}${statusSuffix}`;
        case 'validation-failed':
            return appendResponsePreview(
                `${translator('Unable to send the Overleaf chat message because Overleaf rejected the message payload.')}${statusSuffix}`,
                options.responsePreview,
                translator,
            );
        case 'connectivity-failure':
            return translator('Unable to send the Overleaf chat message because the network connection to Overleaf was interrupted.');
        case 'server-error':
        default:
            return appendResponsePreview(
                `${translator('Unable to send the Overleaf chat message due to an Overleaf server error.')}${statusSuffix}`,
                options.responsePreview,
                translator,
            );
    }
}

function appendResponsePreview(message: string, responsePreview: string | undefined, translator: Translator) {
    if (!responsePreview) {
        return message;
    }
    return `${message} ${translator('Server response')}: ${responsePreview}`;
}

export function buildOverleafChatSendFailure(input: {
    code?: OverleafChatSendFailureCode,
    message?: string,
    responseBody?: string,
    route?: string,
    statusCode?: number,
    translator?: Translator,
}): OverleafChatSendFailure {
    const code = input.code ?? classifyOverleafChatSendFailure(input);
    const responsePreview = normalizeResponsePreview(input.responseBody ?? input.message);
    return {
        ok: false,
        code,
        message: formatOverleafChatSendFailureMessage(code, input.translator, {
            responsePreview,
            statusCode: input.statusCode,
        }),
        responsePreview,
        route: input.route,
        statusCode: input.statusCode,
        transport: 'rest',
    };
}
