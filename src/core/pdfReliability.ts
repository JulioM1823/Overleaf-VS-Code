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

export function getPdfReadFailureMessage(error: unknown): string {
    const message = error instanceof Error ? error.message : '';
    const status = /Download failed \(HTTP (\d{3})\)/.exec(message)?.[1];
    if (status) {
        return `Unable to download the compiled PDF (HTTP ${status}). Compile again; if the error persists, check the Overleaf session and compilation diagnostics.`;
    }
    if (message==='Downloaded content is not a PDF.') {
        return 'The generated file is empty or is not a PDF. Check the compilation diagnostics and compile again.';
    }
    return 'Unable to read the compiled PDF. Check the compilation diagnostics and the Overleaf connection, then compile again.';
}
