import type { CompileResponseSchema } from '../api/base';
import type { OutputFileEntity } from '../core/remoteFileSystemProvider';
import { extractOutputBuildId } from '../core/recoveryPolicy';
import { isCompileLogArtifact, normalizeCompileArtifactPath } from './compileArtifacts';

function asRecord(value: unknown): Record<string, unknown> | undefined {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
        ? value as Record<string, unknown>
        : undefined;
}

function arrayCount(value: unknown) {
    return Array.isArray(value) ? value.length : 0;
}

function firstStringValue(value: unknown): string | undefined {
    if (typeof value === 'string' && value.trim().length > 0) {
        return value.trim();
    }
    const record = asRecord(value);
    if (!record) {
        return undefined;
    }
    for (const key of ['message', 'error', 'reason', 'description', 'text']) {
        const item = record[key];
        if (typeof item === 'string' && item.trim().length > 0) {
            return item.trim();
        }
    }
    return undefined;
}

function summarizeArrayValue(value: unknown, limit: number) {
    if (!Array.isArray(value)) {
        return [];
    }
    return value
        .map(firstStringValue)
        .filter((item): item is string => item !== undefined)
        .slice(0, limit);
}

export function getCompileFailureSummary(
    compile: CompileResponseSchema | undefined,
    fallbackMessage?: string,
) {
    const summaryItems = [
        ...summarizeArrayValue(compile?.errors, 3),
        ...summarizeArrayValue(compile?.validationProblems, 3),
    ];
    if (summaryItems.length > 0) {
        return summaryItems.join(' | ');
    }
    return fallbackMessage;
}

export function buildCompileFailureDiagnostics(
    compile: CompileResponseSchema | undefined,
    rootResourcePath: string | null,
    responseType: string,
) {
    const rawOutputFiles = compile?.outputFiles;
    const outputFiles = Array.isArray(rawOutputFiles)
        ? rawOutputFiles as OutputFileEntity[]
        : [];
    const buildId = typeof compile?.buildId === 'string'
        ? compile.buildId
        : extractOutputBuildId(outputFiles) ?? '';
    const clsiServerId = typeof compile?.clsiServerId === 'string'
        ? compile.clsiServerId
        : '';

    return {
        buildId,
        clsiServerId,
        compilePayload: compile ?? null,
        compilePayloadKeys: Object.keys(asRecord(compile) ?? {}).sort(),
        compileStatus: compile?.status ?? '',
        errorCount: arrayCount(compile?.errors),
        hasOutputLog: outputFiles.some(isCompileLogArtifact),
        outputFileCount: outputFiles.length,
        outputFilePaths: outputFiles
            .map((output) => normalizeCompileArtifactPath(output.path || output.name || ''))
            .filter((path) => path.length > 0)
            .slice(0, 20),
        outputTypes: Array.from(new Set(
            outputFiles
                .map((output) => output.type)
                .filter((type): type is string => typeof type === 'string' && type.length > 0),
        )).sort(),
        responseType,
        rootResourcePath,
        validationProblemCount: arrayCount(compile?.validationProblems),
    };
}
