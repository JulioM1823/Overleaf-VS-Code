export function patchSocketIoClientForNode(ioClient: any): boolean {
    if (!ioClient?.util || typeof ioClient.util.request !== 'function') {
        return false;
    }
    if (ioClient.__overleafWorkshopNodeRequestPatched) {
        return false;
    }

    const originalRequest = ioClient.util.request;
    ioClient.util.request = function patchedRequest(...args: any[]) {
        const req = originalRequest.apply(this, args);
        req?.setDisableHeaderCheck?.(true);
        return req;
    };
    ioClient.__overleafWorkshopNodeRequestPatched = true;
    return true;
}
