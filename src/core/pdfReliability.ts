export type PdfUpdateDeliveryAction =
    | 'skip_disposed'
    | 'skip_empty'
    | 'queue_until_ready'
    | 'post';

export function resolvePdfUpdateDeliveryAction(cacheByteLength: number, ready: boolean, disposed: boolean): PdfUpdateDeliveryAction {
    if (disposed) {
        return 'skip_disposed';
    }
    if (cacheByteLength <= 0) {
        return 'skip_empty';
    }
    if (!ready) {
        return 'queue_until_ready';
    }
    return 'post';
}

export function shouldPreservePdfCacheOnReadFailure(cacheByteLength: number) {
    return cacheByteLength > 0;
}

export function isLikelyPdfPayload(content: Uint8Array) {
    if (content.byteLength < 5) {
        return false;
    }
    const headerWindow = content.slice(0, Math.min(content.byteLength, 1024));
    const headerText = new TextDecoder().decode(headerWindow);
    return headerText.includes('%PDF-');
}
