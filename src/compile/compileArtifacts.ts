export interface CompileArtifactLike {
    name?: string,
    path: string,
    type?: string,
}

export function normalizeCompileArtifactPath(path: string) {
    return path
        .replace(/\\/g, '/')
        .replace(/^\/+/, '')
        .replace(/^(?:\.\/)+/, '');
}

export function isPdfArtifact(artifact: CompileArtifactLike) {
    const normalizedPath = normalizeCompileArtifactPath(artifact.path || artifact.name || '');
    const normalizedType = (artifact.type || '').toLowerCase();
    return normalizedType === 'pdf' || normalizedPath.toLowerCase().endsWith('.pdf');
}

function basename(path: string) {
    const normalizedPath = normalizeCompileArtifactPath(path);
    const parts = normalizedPath.split('/');
    return parts[parts.length - 1] || '';
}

function dirname(path: string) {
    const normalizedPath = normalizeCompileArtifactPath(path);
    const parts = normalizedPath.split('/');
    if (parts.length <= 1) {
        return '';
    }
    return parts.slice(0, -1).join('/');
}

function primaryPdfScore(artifact: CompileArtifactLike, preferredPdfBasename: string) {
    const normalizedPath = normalizeCompileArtifactPath(artifact.path || artifact.name || '');
    const artifactBasename = basename(normalizedPath).toLowerCase();
    let score = 0;
    if (normalizedPath.toLowerCase()==='output.pdf') {
        score += 100;
    }
    if (artifactBasename==='output.pdf') {
        score += 40;
    }
    if (preferredPdfBasename && artifactBasename===preferredPdfBasename) {
        score += 80;
    }
    score -= normalizedPath.length;
    return score;
}

export function selectPrimaryPdfArtifact(outputs: CompileArtifactLike[], rootDocPath = '') {
    const pdfOutputs = outputs.filter(isPdfArtifact);
    if (pdfOutputs.length===0) {
        return undefined;
    }
    const rootDocBasename = basename(rootDocPath).replace(/\.[^.]+$/, '');
    const preferredPdfBasename = rootDocBasename ? `${rootDocBasename}.pdf`.toLowerCase() : '';
    return [...pdfOutputs].sort((left, right) => {
        return primaryPdfScore(right, preferredPdfBasename) - primaryPdfScore(left, preferredPdfBasename);
    })[0];
}

export function resolvePrimaryPdfOutputPath(outputs: CompileArtifactLike[], rootDocPath: string, outputFolderName: string) {
    const artifact = selectPrimaryPdfArtifact(outputs, rootDocPath);
    if (!artifact) {
        return undefined;
    }
    return `${outputFolderName}/${normalizeCompileArtifactPath(artifact.path)}`;
}

export function resolvePrimaryPdfRenderPath(outputs: CompileArtifactLike[], rootDocPath = '') {
    const artifact = selectPrimaryPdfArtifact(outputs, rootDocPath);
    if (!artifact) {
        return undefined;
    }

    const normalizedRootDocPath = normalizeCompileArtifactPath(rootDocPath);
    const rootDocBase = basename(normalizedRootDocPath).replace(/\.[^.]+$/, '');
    const renderBasename = rootDocBase
        ? `${rootDocBase}.pdf`
        : basename(artifact.path || artifact.name || '');
    const renderDir = dirname(normalizedRootDocPath);
    return renderDir ? `${renderDir}/${renderBasename}` : renderBasename;
}

export function normalizeSyncResultFilePath(file: string, outputFolderName: string) {
    const normalizedPath = normalizeCompileArtifactPath(file);
    if (!normalizedPath) {
        return '';
    }
    if (normalizedPath.startsWith(`${outputFolderName}/`)) {
        return normalizedPath;
    }
    if (/^output\.[^.]+$/i.test(normalizedPath)) {
        return `${outputFolderName}/${normalizedPath}`;
    }
    return normalizedPath;
}
