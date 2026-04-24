import { RealtimeConnectionPhase } from '../core/connectionPhase';

export type CompileRenderStatus = 'alert' | 'compiling' | 'failed' | 'fallback' | 'recovering' | 'success';
export type CompileTerminalStatus = 'alert' | 'failed' | 'success';

export function resolveCompileRenderStatus(options: {
    connectionPhase: RealtimeConnectionPhase,
    hasProject: boolean,
    inCompiling: boolean,
    lastTerminalStatus: CompileTerminalStatus,
}) : CompileRenderStatus | 'hidden' {
    if (!options.hasProject) {
        return 'hidden';
    }
    if (options.inCompiling) {
        return 'compiling';
    }
    switch (options.connectionPhase) {
        case 'initializing':
        case 'recovering':
            return 'recovering';
        case 'fallback':
            return 'fallback';
        case 'invisible':
        case 'live':
            return options.lastTerminalStatus;
    }
}
