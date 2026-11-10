export function calculateRecoveryDelayMs(retryConnection: number) {
    const retryCount = Math.max(0, Math.trunc(retryConnection));
    if (retryCount <= 1) {
        return 0;
    }
    return Math.min(1000 * 2 ** (retryCount - 2), 30000);
}

export function extractOutputBuildId(outputs: Array<{url?: string}>) {
    return outputs.find((output) => output.url)?.url?.match(/\/build\/([^\/]+)/)?.[1];
}

export function hasCompileOutputs(outputs: Array<unknown> | undefined | null) {
    return Array.isArray(outputs) && outputs.length > 0;
}

export function shouldClearAuxFilesBeforeCompile(options: {
    outputBuildId?: string | null,
    outputs?: Array<unknown> | undefined | null,
}) {
    if (options.outputBuildId) {
        return false;
    }
    return !hasCompileOutputs(options.outputs);
}
