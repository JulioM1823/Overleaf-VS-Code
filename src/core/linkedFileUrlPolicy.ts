import * as net from 'net';

export type ExternalLinkedFileUrlValidationIssue =
    | 'empty'
    | 'invalid'
    | 'unsupported-protocol'
    | 'embedded-credentials'
    | 'unsupported-port'
    | 'private-host'
    | 'internal-host'
    | 'credential-query';

export type ExternalLinkedFileUrlValidationResult =
    | {
        issue: ExternalLinkedFileUrlValidationIssue,
        ok: false,
    }
    | {
        normalizedUrl: string,
        ok: true,
        suggestedFileName: string,
    };

const BLOCKED_HOST_SUFFIXES = [
    '.corp',
    '.home',
    '.internal',
    '.invalid',
    '.lan',
    '.local',
    '.localhost',
    '.test',
];

const CREDENTIAL_QUERY_PARAMETER_NAMES = new Set([
    'access_key',
    'access-token',
    'access_token',
    'apikey',
    'api_key',
    'auth',
    'authorization',
    'awsaccesskeyid',
    'code',
    'credential',
    'expires',
    'key',
    'key-pair-id',
    'policy',
    'private_key',
    'sas',
    'secret',
    'security-token',
    'signature',
    'sig',
    'token',
    'x-amz-credential',
    'x-amz-security-token',
    'x-amz-signature',
    'x-goog-credential',
    'x-goog-security-token',
    'x-goog-signature',
]);

const CREDENTIAL_QUERY_PARAMETER_PATTERNS = [
    /credential/i,
    /private[_-]?key/i,
    /secret/i,
    /signature/i,
    /token/i,
];

function normalizeHostname(hostname: string) {
    const lower = hostname.toLowerCase();
    const withoutBrackets = lower.startsWith('[') && lower.endsWith(']')
        ? lower.slice(1, -1)
        : lower;
    return withoutBrackets.replace(/\.$/, '');
}

function parseIpv4Address(hostname: string) {
    const parts = hostname.split('.');
    if (parts.length!==4 || parts.some(part => !/^\d+$/.test(part))) {
        return undefined;
    }
    const octets = parts.map(part => Number(part));
    if (octets.some(octet => !Number.isInteger(octet) || octet<0 || octet>255)) {
        return undefined;
    }
    return octets as [number, number, number, number];
}

function isPrivateOrReservedIpv4(hostname: string) {
    const octets = parseIpv4Address(hostname);
    if (!octets) {
        return false;
    }

    const [first, second, third] = octets;
    return first===0
        || first===10
        || first===127
        || (first===100 && second>=64 && second<=127)
        || (first===169 && second===254)
        || (first===172 && second>=16 && second<=31)
        || (first===192 && second===0 && third===0)
        || (first===192 && second===0 && third===2)
        || (first===192 && second===168)
        || (first===198 && (second===18 || second===19))
        || (first===198 && second===51 && third===100)
        || (first===203 && second===0 && third===113)
        || first>=224;
}

function isPrivateOrReservedIpv6(hostname: string) {
    if (net.isIP(hostname)!==6) {
        return false;
    }
    if (hostname==='::' || hostname==='::1' || hostname.startsWith('::ffff:')) {
        return true;
    }

    const firstHextet = Number.parseInt(hostname.split(':')[0] || '0', 16);
    return (firstHextet>=0xfc00 && firstHextet<=0xfdff)
        || (firstHextet>=0xfe80 && firstHextet<=0xfebf)
        || (firstHextet>=0xff00 && firstHextet<=0xffff)
        || hostname.startsWith('2001:db8:');
}

function classifyExternalLinkedFileHost(hostname: string): ExternalLinkedFileUrlValidationIssue | undefined {
    if (!hostname) {
        return 'invalid';
    }
    if (hostname==='localhost'
        || BLOCKED_HOST_SUFFIXES.some(suffix => hostname.endsWith(suffix))
        || isPrivateOrReservedIpv4(hostname)
        || isPrivateOrReservedIpv6(hostname)) {
        return 'private-host';
    }
    if (net.isIP(hostname)===0 && !hostname.includes('.')) {
        return 'internal-host';
    }
    return undefined;
}

function hasCredentialLikeQueryParameter(url: URL) {
    for (const key of url.searchParams.keys()) {
        const normalizedKey = key.trim().toLowerCase();
        if (CREDENTIAL_QUERY_PARAMETER_NAMES.has(normalizedKey)
            || CREDENTIAL_QUERY_PARAMETER_PATTERNS.some(pattern => pattern.test(normalizedKey))) {
            return true;
        }
    }
    return false;
}

function suggestFileNameFromUrl(url: URL) {
    const encodedName = url.pathname.split('/').filter(Boolean).pop();
    if (!encodedName) {
        return 'linked-file';
    }
    try {
        return decodeURIComponent(encodedName) || 'linked-file';
    } catch {
        return encodedName || 'linked-file';
    }
}

export function validateExternalLinkedFileUrl(input: string | undefined): ExternalLinkedFileUrlValidationResult {
    const rawInput = input?.trim();
    if (!rawInput) {
        return {ok: false, issue: 'empty'};
    }

    let parsed: URL;
    try {
        parsed = new URL(rawInput);
    } catch {
        return {ok: false, issue: 'invalid'};
    }

    if (parsed.protocol!=='https:') {
        return {ok: false, issue: 'unsupported-protocol'};
    }
    if (parsed.username || parsed.password) {
        return {ok: false, issue: 'embedded-credentials'};
    }
    if (parsed.port && parsed.port!=='443') {
        return {ok: false, issue: 'unsupported-port'};
    }

    const hostname = normalizeHostname(parsed.hostname);
    const hostIssue = classifyExternalLinkedFileHost(hostname);
    if (hostIssue) {
        return {ok: false, issue: hostIssue};
    }
    if (hasCredentialLikeQueryParameter(parsed)) {
        return {ok: false, issue: 'credential-query'};
    }

    parsed.hash = '';
    return {
        normalizedUrl: parsed.toString(),
        ok: true,
        suggestedFileName: suggestFileNameFromUrl(parsed),
    };
}
