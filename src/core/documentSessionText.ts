import * as DiffMatchPatch from 'diff-match-patch';
import { UpdateSchema } from '../api/socketio';

type OverleafUpdateOperation = NonNullable<UpdateSchema['op']>[number];
import { mergeTextFromCommonBase } from './threeWayMerge';

export function extractTextOperations(ops: UpdateSchema['op']) {
    if (ops!==undefined && !Array.isArray(ops)) {
        throw new Error('Invalid text operation list');
    }
    return (ops ?? []).filter((op) => {
        if (!op || typeof op!== 'object') { throw new Error('Invalid text operation'); }
        if (op.i!==undefined && typeof op.i!=='string' || op.d!==undefined && typeof op.d!=='string') {
            throw new Error('Invalid text operation content');
        }
        return typeof op.i==='string' || typeof op.d==='string';
    });
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
        if (!Number.isSafeInteger(op.p) || op.p < 0 || op.p > nextText.length
            || (typeof op.i==='string' && typeof op.d==='string')) {
            throw new Error('Invalid text operation');
        }
        if (typeof op.i === 'string') {
            nextText = nextText.slice(0, op.p) + op.i + nextText.slice(op.p);
        } else if (typeof op.d === 'string') {
            // OT operations use JavaScript strings and UTF-16 offsets. Only the
            // joinDoc snapshot is packed UTF-8; decoding deletes corrupts text.
            if (nextText.slice(op.p, op.p + op.d.length)!==op.d) {
                throw new Error('Text operation delete does not match its base');
            }
            nextText = nextText.slice(0, op.p) + nextText.slice(op.p + op.d.length);
        }
    }
    return nextText;
}

export function buildTextOperations(sourceText: string, targetText: string): OverleafUpdateOperation[] {
    const dmp = new DiffMatchPatch();
    let currentPos = 0;
    const operations: OverleafUpdateOperation[] = [];
    dmp.diff_main(sourceText, targetText).forEach((part) => {
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

export function mergeRemoteTextIntoLocalText(
    previousRemoteText: string,
    nextRemoteText: string,
    currentLocalText: string,
) {
    return mergeTextFromCommonBase(previousRemoteText, currentLocalText, nextRemoteText);
}

export function resolveJoinedDocumentTextState(arg: {
    joinedText: string,
    localText?: string,
    remoteText?: string,
}) {
    const hasLocalDivergence = arg.localText!==undefined
        && (arg.remoteText===undefined || arg.localText!==arg.remoteText);
    const merged = hasLocalDivergence && arg.remoteText!==undefined
        ? mergeTextFromCommonBase(arg.remoteText, arg.localText!, arg.joinedText)
        : undefined;
    const recoveryRequired = hasLocalDivergence && (!merged || merged.kind==='conflict');
    const nextLocalText = hasLocalDivergence
        ? merged?.kind==='merged' ? merged.mergedText : arg.localText!
        : arg.joinedText;
    return {
        contentToOpen: nextLocalText,
        hasLocalDivergence,
        nextLocalText,
        nextRemoteText: arg.joinedText,
        recoveryRequired,
    };
}
