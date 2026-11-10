// Test-only observer. The production CSP is retained; no document text is logged.
(function () {
    'use strict';
    const acquire = window.acquireVsCodeApi;
    let api;
    window.acquireVsCodeApi = () => { api = acquire(); return api; };
    const metrics = {created: 0, destroyed: 0, active: 0, peak: 0, errors: 0, unhandled: 0, rendered: 0, failureTypes: []};
    const objectUrls = new Set();
    const createObjectURL = URL.createObjectURL.bind(URL);
    const revokeObjectURL = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = value => { const url = createObjectURL(value); objectUrls.add(url); return url; };
    URL.revokeObjectURL = url => { objectUrls.delete(url); return revokeObjectURL(url); };
    let loader;
    let downloadedBytes = 0;
    let printedPages = 0;
    let printElapsedMs = 0;
    const Original = globalThis.OverleafPdfDocumentLoader;
    globalThis.OverleafPdfDocumentLoader = class extends Original {
        constructor(create, display, reportError) {
            super(options => {
                const task = create(options);
                metrics.created++;
                metrics.peak = Math.max(metrics.peak, ++metrics.active);
                const destroy = task.destroy.bind(task);
                let destroyed = false;
                task.destroy = async () => {
                    try { return await destroy(); }
                    finally {
                        if (!destroyed) { destroyed = true; metrics.destroyed++; metrics.active--; }
                    }
                };
                return task;
            }, display, () => { metrics.errors++; reportError(); });
            loader = this;
        }
    };
    window.addEventListener('unhandledrejection', event => {
        metrics.unhandled++;
        metrics.failureTypes.push(String(event.reason?.stack || event.reason?.name || 'rejection'));
    });
    window.addEventListener('error', event => {
        metrics.unhandled++;
        metrics.failureTypes.push(String(event.error?.stack || event.message || 'error'));
    });
    window.addEventListener('load', () => {
        PDFViewerApplication.initializedPromise.then(() => {
            PDFViewerApplication.eventBus.on('pagerendered', () => { metrics.rendered++; });
        });
    });
    window.addEventListener('message', async event => {
        const request = event.data;
        if (request?.type !== 'soakCommand') { return; }
        try {
            await PDFViewerApplication.initializedPromise;
            if (request.action === 'zoom') {
                PDFViewerApplication.pdfViewer.currentScaleValue = '1.5';
                document.getElementById('viewerContainer').scrollTop = 20;
                PDFViewerApplication.eventBus.dispatch('scalechanging', {source: PDFViewerApplication.pdfViewer});
            }
            if (request.action === 'page') { PDFViewerApplication.pdfViewer.currentPageNumber = request.page; }
            if (request.action === 'dispose') { await loader.dispose(); }
            if (request.action === 'download') {
                const manager = PDFViewerApplication.downloadManager;
                const original = manager.download;
                manager.download = async blob => { downloadedBytes = blob.size; };
                try { await PDFViewerApplication.download(); }
                finally { manager.download = original; }
            }
            if (request.action === 'print') {
                PDFViewerApplication.eventBus.dispatch('beforeprint', {source: window});
                const service = PDFViewerApplication.printService;
                if (!service) { throw new Error('Print service was not created'); }
                const started = performance.now();
                const useRenderedPage = service.useRenderedPage.bind(service);
                printedPages = 0;
                service.useRenderedPage = async () => {
                    await useRenderedPage();
                    printedPages++;
                    api.postMessage({type: 'soakProgress', phase: 'print', pages: printedPages});
                };
                try {
                    await service.renderPages();
                    printedPages = document.getElementById('printContainer').children.length;
                } finally { printElapsedMs = performance.now() - started; PDFViewerApplication.afterPrint(); }
            }
            const doc = PDFViewerApplication.pdfDocument;
            let matches = false;
            if (doc && request.expected && !request.action) {
                try {
                    const page = await doc.getPage(request.page || 1);
                    const content = await page.getTextContent();
                    matches = content.items.some(item => item.str === request.expected);
                } catch (_) { /* Replacement/disposal may invalidate an older proxy. */ }
            }
            api.postMessage({type: 'soakResult', id: request.id, ...metrics, matches,
                scale: PDFViewerApplication.pdfViewer.currentScaleValue,
                canvas: !!document.querySelector('.page canvas'),
                renderedCurrent: !!doc && PDFViewerApplication.pdfViewer.getPageView((request.page || 1) - 1)?.renderingState === 3,
                renderState: PDFViewerApplication.pdfViewer.getPageView((request.page || 1) - 1)?.renderingState,
                pages: doc?.numPages,
                pagesReady: PDFViewerApplication.pdfViewer.pageViewsReady,
                currentPage: PDFViewerApplication.pdfViewer.currentPageNumber,
                scrollTop: document.getElementById('viewerContainer').scrollTop,
                hidden: document.hidden,
                visibility: PDFViewerApplication.pdfViewer._getVisiblePages().views.map(page => page.id),
                downloadedBytes, printedPages, printElapsedMs,
                themeButtons: document.querySelectorAll('[id^="theme-"]').length,
                scripting: PDFViewerApplicationOptions.get('enableScripting'),
                eval: PDFViewerApplicationOptions.get('isEvalSupported'),
                heap: performance.memory?.usedJSHeapSize,
                blobUrlsActive: objectUrls.size,
            });
        } catch (_) { api.postMessage({type: 'soakResult', id: request.id, failure: true}); }
    });
}());
