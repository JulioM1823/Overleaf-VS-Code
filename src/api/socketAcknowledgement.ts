import type { UpdateSchema } from './socketio';

interface Socket {
    emit(event: string, ...args: any[]): unknown,
    on(event: string, listener: (...args: any[]) => void): unknown,
    removeListener(event: string, listener: (...args: any[]) => void): unknown,
}

export function emitWithTimeout(socket: Socket, event: string, args: unknown[], timeoutMs: number): Promise<any[]> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`${event} acknowledgement timeout`)), timeoutMs);
        try {
            socket.emit(event, ...args, (error: unknown, ...data: unknown[]) => {
                clearTimeout(timer);
                if (error) { reject(error); } else { resolve(data); }
            });
        } catch (error) { clearTimeout(timer); reject(error); }
    });
}

/** The callback acknowledges queueing, while otUpdateApplied acknowledges a
 * committed revision. Never mark a document clean based on the callback alone.
 * A transformed revision requires rejoining and a three-way recovery. */
export function sendConfirmedOtUpdate(socket: Socket, docId: string, update: UpdateSchema, timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (error?: unknown) => {
            if (settled) { return; }
            settled = true;
            clearTimeout(timer);
            socket.removeListener('otUpdateApplied', onApplied);
            socket.removeListener('otUpdateError', onError);
            socket.removeListener('disconnect', onDisconnect);
            if (error) { reject(error); } else { resolve(); }
        };
        const onApplied = (incoming: UpdateSchema) => {
            // Overleaf sends its author a version-only acknowledgement. Other
            // collaborators receive operations, which must follow the usual path.
            if (!incoming || incoming.doc!==docId || incoming.op!==undefined) { return; }
            if (!Number.isSafeInteger(incoming.v) || incoming.v < update.v) { return; }
            finish(incoming.v===update.v ? undefined : new Error('OT revision changed while submitting; recovery required'));
        };
        const onError = (_error: unknown, details?: Record<'doc_id', string>) => {
            if (!details?.doc_id || details.doc_id===docId) { finish(new Error('Server rejected the document update; recovery required')); }
        };
        const onDisconnect = () => finish(new Error('Disconnected before document update confirmation'));
        const timer = setTimeout(() => finish(new Error('Document update confirmation timeout')), timeoutMs);
        socket.on('otUpdateApplied', onApplied);
        socket.on('otUpdateError', onError);
        socket.on('disconnect', onDisconnect);
        try {
            socket.emit('applyOtUpdate', docId, update, (error: unknown) => {
                if (error) { finish(error); }
            });
        } catch (error) { finish(error); }
    });
}
