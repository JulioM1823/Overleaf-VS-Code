import * as DiffMatchPatch from 'diff-match-patch';
import { UpdateSchema } from '../api/socketio';

type OverleafUpdateOperation = NonNullable<UpdateSchema['op']>[number];
type ScanOperation =
    | {kind: 'insert', text: string}
    | {kind: 'remove', length: number}
    | {kind: 'retain', length: number};

function decodeDeleteText(value: string) {
    return Buffer.from(value, 'ascii').toString('utf-8');
}

export function extractTextOperations(ops: UpdateSchema['op']) {
    return (ops ?? []).filter((op) => typeof op.i === 'string' || typeof op.d === 'string');
}

export function serializeTextOperations(ops: UpdateSchema['op']) {
    return JSON.stringify(
        extractTextOperations(ops).map((op) => ({
            d: typeof op.d === 'string' ? op.d : undefined,
            i: typeof op.i === 'string' ? op.i : undefined,
            p: op.p,
        })),
    );
}

export function applyTextOperationsToString(text: string, ops: UpdateSchema['op']) {
    let nextText = text;
    for (const op of extractTextOperations(ops)) {
        if (typeof op.i === 'string') {
            nextText = nextText.slice(0, op.p) + op.i + nextText.slice(op.p);
            continue;
        }
        if (typeof op.d === 'string') {
            const deletedText = decodeDeleteText(op.d);
            nextText = nextText.slice(0, op.p) + nextText.slice(op.p + deletedText.length);
        }
    }
    return nextText;
}

export function buildTextOperations(sourceText: string, targetText: string): OverleafUpdateOperation[] {
    const dmp = new DiffMatchPatch();
    const sourceAscii = Buffer.from(sourceText, 'utf-8').toString('utf-8');
    const targetAscii = Buffer.from(targetText, 'utf-8').toString('utf-8');
    let currentPos = 0;
    const operations: OverleafUpdateOperation[] = [];
    dmp.diff_main(sourceAscii, targetAscii).forEach((part) => {
        const increment = part[0]===-1 ? 0 : part[1].length;
        currentPos += increment;
        if (part[0]===0) {
            return;
        }
        operations.push({
            p: currentPos - increment,
            i: part[0]===1 ? part[1] : undefined,
            d: part[0]===-1 ? part[1] : undefined,
        });
    });
    return operations;
}

function pushRetain(operations: ScanOperation[], length: number) {
    if (length<=0) {
        return;
    }
    const last = operations[operations.length - 1];
    if (last?.kind==='retain') {
        last.length += length;
        return;
    }
    operations.push({kind: 'retain', length});
}

function pushInsert(operations: ScanOperation[], text: string) {
    if (text==='') {
        return;
    }
    const last = operations[operations.length - 1];
    if (last?.kind==='insert') {
        last.text += text;
        return;
    }
    operations.push({kind: 'insert', text});
}

function pushRemove(operations: ScanOperation[], length: number) {
    if (length<=0) {
        return;
    }
    const last = operations[operations.length - 1];
    if (last?.kind==='remove') {
        last.length += length;
        return;
    }
    operations.push({kind: 'remove', length});
}

function buildScanOperations(sourceText: string, targetText: string) {
    const dmp = new DiffMatchPatch();
    const operations: ScanOperation[] = [];
    dmp.diff_main(sourceText, targetText).forEach((part) => {
        if (part[0]===0) {
            pushRetain(operations, part[1].length);
            return;
        }
        if (part[0]===1) {
            pushInsert(operations, part[1]);
            return;
        }
        pushRemove(operations, part[1].length);
    });
    return operations;
}

function applyScanOperations(sourceText: string, operations: ScanOperation[]) {
    let cursor = 0;
    let output = '';
    for (const operation of operations) {
        switch (operation.kind) {
            case 'retain':
                if (cursor + operation.length > sourceText.length) {
                    throw new Error('retain_out_of_bounds');
                }
                output += sourceText.slice(cursor, cursor + operation.length);
                cursor += operation.length;
                break;
            case 'insert':
                output += operation.text;
                break;
            case 'remove':
                if (cursor + operation.length > sourceText.length) {
                    throw new Error('remove_out_of_bounds');
                }
                cursor += operation.length;
                break;
        }
    }
    if (cursor!==sourceText.length) {
        throw new Error('partial_apply');
    }
    return output;
}

function scanOperationBaseLength(operations: ScanOperation[]) {
    return operations.reduce((length, operation) => {
        switch (operation.kind) {
            case 'retain':
            case 'remove':
                return length + operation.length;
            case 'insert':
                return length;
        }
    }, 0);
}

function reduceLengthOperation(operation: ScanOperation, length: number) {
    if (operation.kind==='insert') {
        return undefined;
    }
    const remaining = operation.length - length;
    if (remaining<=0) {
        return undefined;
    }
    return {
        kind: operation.kind,
        length: remaining,
    } as ScanOperation;
}

function transformScanOperations(
    operation1: ScanOperation[],
    operation2: ScanOperation[],
): [ScanOperation[], ScanOperation[]] {
    if (scanOperationBaseLength(operation1)!==scanOperationBaseLength(operation2)) {
        throw new Error('base_length_mismatch');
    }

    const operation1Prime: ScanOperation[] = [];
    const operation2Prime: ScanOperation[] = [];
    let i1 = 0;
    let i2 = 0;
    let op1: ScanOperation | undefined = operation1[i1++];
    let op2: ScanOperation | undefined = operation2[i2++];

    while (op1!==undefined || op2!==undefined) {
        if (op1?.kind==='insert') {
            pushInsert(operation1Prime, op1.text);
            pushRetain(operation2Prime, op1.text.length);
            op1 = operation1[i1++];
            continue;
        }
        if (op2?.kind==='insert') {
            pushRetain(operation1Prime, op2.text.length);
            pushInsert(operation2Prime, op2.text);
            op2 = operation2[i2++];
            continue;
        }
        if (!op1 || !op2) {
            throw new Error('incompatible_operation_lengths');
        }

        if (op1.kind==='retain' && op2.kind==='retain') {
            const minLength = Math.min(op1.length, op2.length);
            pushRetain(operation1Prime, minLength);
            pushRetain(operation2Prime, minLength);
            op1 = op1.length===minLength ? operation1[i1++] : reduceLengthOperation(op1, minLength);
            op2 = op2.length===minLength ? operation2[i2++] : reduceLengthOperation(op2, minLength);
            continue;
        }

        if (op1.kind==='remove' && op2.kind==='remove') {
            const minLength = Math.min(op1.length, op2.length);
            op1 = op1.length===minLength ? operation1[i1++] : reduceLengthOperation(op1, minLength);
            op2 = op2.length===minLength ? operation2[i2++] : reduceLengthOperation(op2, minLength);
            continue;
        }

        if (op1.kind==='remove' && op2.kind==='retain') {
            const minLength = Math.min(op1.length, op2.length);
            pushRemove(operation1Prime, minLength);
            op1 = op1.length===minLength ? operation1[i1++] : reduceLengthOperation(op1, minLength);
            op2 = op2.length===minLength ? operation2[i2++] : reduceLengthOperation(op2, minLength);
            continue;
        }

        if (op1.kind==='retain' && op2.kind==='remove') {
            const minLength = Math.min(op1.length, op2.length);
            pushRemove(operation2Prime, minLength);
            op1 = op1.length===minLength ? operation1[i1++] : reduceLengthOperation(op1, minLength);
            op2 = op2.length===minLength ? operation2[i2++] : reduceLengthOperation(op2, minLength);
            continue;
        }

        throw new Error('incompatible_operation_types');
    }

    return [operation1Prime, operation2Prime];
}

export function mergeRemoteTextIntoLocalText(
    previousRemoteText: string,
    nextRemoteText: string,
    currentLocalText: string,
) {
    const localOperation = buildScanOperations(previousRemoteText, currentLocalText);
    const remoteOperation = buildScanOperations(previousRemoteText, nextRemoteText);
    try {
        const [, remotePrime] = transformScanOperations(localOperation, remoteOperation);
        const mergedText = applyScanOperations(currentLocalText, remotePrime);
        return {
            kind: 'merged' as const,
            mergedText,
        };
    } catch {
        // Fall back to patch-based merging for malformed legacy operations.
    }

    const dmp = new DiffMatchPatch();
    const patches = dmp.patch_make(previousRemoteText, nextRemoteText);
    const merged = dmp.patch_apply(patches, currentLocalText);
    const mergedText = merged[0] as string;
    const patchResults = merged[1] as boolean[];
    if (!patchResults.every(Boolean)) {
        return {
            failedPatchCount: patchResults.filter((result) => !result).length,
            kind: 'conflict' as const,
        };
    }
    return {
        kind: 'merged' as const,
        mergedText,
    };
}

export function resolveJoinedDocumentTextState(arg: {
    joinedText: string,
    localText?: string,
    remoteText?: string,
}) {
    const hasLocalDivergence = arg.localText!==undefined
        && (arg.remoteText===undefined || arg.localText!==arg.remoteText);
    const nextLocalText: string = hasLocalDivergence
        ? arg.localText!
        : arg.joinedText;
    return {
        contentToOpen: nextLocalText,
        hasLocalDivergence,
        nextLocalText,
        nextRemoteText: arg.joinedText,
    };
}
