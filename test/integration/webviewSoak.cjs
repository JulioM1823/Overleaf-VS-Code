const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');
const {createMinimalPdfFixture, createCorruptPdfFixture, createMultipagePdfFixture} = require('../fixtures/pdf/minimalPdf.cjs');
const root = path.resolve(__dirname, '../..');
const {PdfDocument, PdfViewEditorProvider} = require(path.join(root, 'out/core/pdfViewEditorProvider'));

exports.run = async function () {
    const start = Date.now();
    const cycles = Number(process.env.OVERLEAF_SOAK_CYCLES || 200);
    const interval = Number(process.env.OVERLEAF_SOAK_INTERVAL_MS || 0);
    assert(Number.isSafeInteger(cycles) && cycles >= 10 && cycles <= 10000);
    assert(Number.isSafeInteger(interval) && interval >= 0 && interval <= 5000);
    const values = new Map();
    const context = {
        extensionUri: vscode.Uri.file(root),
        globalState: {get: (key, fallback) => values.get(key) ?? fallback,
            update: async (key, value) => { values.set(key, value); }},
    };
    const provider = new PdfViewEditorProvider(context);
    const checkpoints = [];
    let panel;
    let document;
    let counter = 0;
    let latest;
    let progress;
    async function open(label) {
        document = new PdfDocument(vscode.Uri.parse('overleaf-workshop://soak/Disposable/output.pdf'));
        document.cache = Uint8Array.from(createMinimalPdfFixture(label));
        panel = vscode.window.createWebviewPanel('overleaf-soak', 'Overleaf PDF soak', vscode.ViewColumn.One,
            {enableScripts: true, retainContextWhenHidden: true});
        const ready = new Promise((resolve, reject) => {
            const timer = setTimeout(() => { listener.dispose(); reject(new Error('PDF webview ready timeout')); }, 30000);
            const listener = panel.webview.onDidReceiveMessage(message => {
                if (message.type === 'soakProgress') { progress = message; }
                if (message.type === 'ready') { clearTimeout(timer); listener.dispose(); resolve(); }
            });
        });
        // Add an external, test-only observer before index.js. Keep the real CSP.
        const original = provider.getHtmlForWebview.bind(provider);
        provider.getHtmlForWebview = async webview => {
            const html = await original(webview);
            const probe = webview.asWebviewUri(vscode.Uri.file(path.join(__dirname, 'webviewProbe.js')));
            return html.replace(/(<script src="[^"]*\/index\.js"><\/script>)/, `<script src="${probe}"></script>$1`);
        };
        await provider.resolveCustomEditor(document, panel);
        provider.getHtmlForWebview = original;
        panel.webview.options = {...panel.webview.options,
            localResourceRoots: [...panel.webview.options.localResourceRoots, vscode.Uri.file(__dirname)]};
        await ready;
    }
    async function inspect(expected, action, page = 1) {
        const id = ++counter;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => { listener.dispose(); reject(new Error('Webview probe timeout')); }, action === 'print' ? 90000 : 15000);
            const listener = panel.webview.onDidReceiveMessage(message => {
                if (message.type === 'soakProgress') { progress = message; }
                if (message.type === 'soakResult' && message.id === id) {
                    clearTimeout(timer); listener.dispose(); resolve(message);
                }
            });
            panel.webview.postMessage({type: 'soakCommand', id, expected, action, page}).catch(reject);
        });
    }
    async function waitFor(expected, predicate = result => result.matches && result.canvas && result.renderedCurrent, page = 1) {
        let deadline = Date.now() + 30000;
        const visibilityDeadline = Date.now() + 180000;
        let previous = Date.now();
        let wasHidden = false;
        let result;
        while (Date.now() < deadline) {
            result = await inspect(expected, undefined, page);
            latest = result;
            if (predicate(result)) { return result; }
            const now = Date.now();
            if (result.hidden) {
                // PDF.js uses requestAnimationFrame for display rendering.
                // Native window occlusion suspends it; parsing still proceeds.
                if (!wasHidden) { console.log('PDF soak paused: native window hidden; waiting for foreground rendering.'); }
                deadline = Math.min(visibilityDeadline, deadline + now - previous);
            } else if (wasHidden) { console.log('PDF soak resumed: native window visible.'); }
            wasHidden = result.hidden;
            previous = now;
            await new Promise(resolve => setTimeout(resolve, 50));
        }
        throw new Error(`Webview did not reach expected state: ${JSON.stringify(result)}`);
    }
    function update(bytes) {
        document.cache = Uint8Array.from(bytes);
        document._onDidChange.fire({});
    }
    try {
        await open('soak-initial');
        checkpoints.push({phase: 'initial', ...await waitFor('soak-initial')});
        const downloaded = await inspect(undefined, 'download');
        assert(downloaded.downloadedBytes > 0, 'Download should receive real PDF bytes');
        const printed = await inspect(undefined, 'print');
        assert(!printed.failure && printed.printedPages > 0, 'Print should render PDF pages');
        assert.equal(printed.blobUrlsActive, checkpoints[0].blobUrlsActive, 'Print image URLs must be released');
        checkpoints.push({phase: 'download-and-print', ...printed});
        await inspect(undefined, 'zoom');
        for (let index = 0; index < cycles; index++) {
            const label = `soak-${index}`;
            update(createMinimalPdfFixture(label));
            const result = await waitFor(label);
            if (result.unhandled) { console.log(JSON.stringify(result)); }
            assert.equal(result.scripting, false);
            assert.equal(result.eval, false);
            assert.equal(result.unhandled, 0);
            assert(result.peak <= 2, `PDF task peak ${result.peak}`);
            assert.equal(result.themeButtons, 1);
            if (index % 25 === 0) {
                checkpoints.push({phase: `reload-${index}`, ...result});
                console.log(`PDF soak: ${index + 1}/${cycles} rendered`);
            }
            if (index % 20 === 0) {
                update(createCorruptPdfFixture());
                await waitFor(label, state => state.errors > result.errors && state.active === 1);
                update(createMinimalPdfFixture(label));
                await waitFor(label);
            }
            if (interval) { await new Promise(resolve => setTimeout(resolve, interval)); }
        }
        // Bursts must show the latest PDF and release every superseded task.
        for (let index = 0; index < 100; index++) { update(createMinimalPdfFixture(`burst-${index}`)); }
        checkpoints.push({phase: 'burst', ...await waitFor('burst-99')});
        // Load while hidden, then restore the real renderer without forcing a
        // PDF.js redraw. Background render throttling must recover on reveal.
        const hidden = new Promise((resolve, reject) => {
            const timer = setTimeout(() => { listener.dispose(); reject(new Error('PDF panel did not become hidden')); }, 30000);
            const listener = panel.onDidChangeViewState(() => {
                if (!panel.visible) { clearTimeout(timer); listener.dispose(); resolve(); }
            });
        });
        const coveringPanel = vscode.window.createWebviewPanel('overleaf-soak-cover', 'Soak visibility check', vscode.ViewColumn.One, {});
        coveringPanel.webview.html = '<html><body>Disposable visibility check</body></html>';
        await hidden;
        assert.equal(panel.visible, false);
        update(createMinimalPdfFixture('hidden-replacement'));
        await waitFor('hidden-replacement', state => state.matches);
        panel.reveal(vscode.ViewColumn.One);
        checkpoints.push({phase: 'hidden-restored', hostVisibilityVerified: true, ...await waitFor('hidden-replacement')});
        coveringPanel.dispose();
        // Exercise navigation and retained zoom/scroll with a 60-page document.
        update(createMultipagePdfFixture(Array.from({length: 60}, (_value, index) => `multipage-${index}`)));
        await waitFor('multipage-0');
        await inspect(undefined, 'page', 60);
        const lastPage = await waitFor('multipage-59', undefined, 60);
        assert.equal(lastPage.pages, 60);
        assert.equal(lastPage.scale, '1.5');
        update(createMultipagePdfFixture(Array.from({length: 60}, (_value, index) => `multipage-new-${index}`)));
        const retained = await waitFor('multipage-new-59', undefined, 60);
        assert.equal(retained.currentPage, 60);
        assert.equal(retained.scale, '1.5');
        assert(retained.scrollTop > 0);
        checkpoints.push({phase: 'multipage-reload', ...retained});
        const largeDownload = await inspect(undefined, 'download');
        assert(largeDownload.downloadedBytes > downloaded.downloadedBytes);
        await waitFor(undefined, state => state.pagesReady === true);
        const largePrint = await inspect(undefined, 'print');
        assert.equal(largePrint.printedPages, 60);
        assert.equal(largePrint.blobUrlsActive, largeDownload.blobUrlsActive, 'Large print must release all image URLs');
        for (let index = 0; index < 3; index++) {
            const repeated = await inspect(undefined, 'print');
            assert.equal(repeated.printedPages, 60);
            assert.equal(repeated.blobUrlsActive, largeDownload.blobUrlsActive);
        }
        checkpoints.push({phase: 'multipage-download-and-print', ...largePrint});
        const final = await inspect(undefined, 'dispose');
        assert.equal(final.active, 0);
        assert.equal(final.created, final.destroyed);
        assert.equal(final.unhandled, 0);
        checkpoints.push({phase: 'disposed', ...final});
        panel.dispose(); document.dispose();
        // Exercise closure while a replacement is loading, then create a fresh webview.
        await open('soak-close');
        await waitFor('soak-close');
        update(createMinimalPdfFixture('soak-closing'));
        panel.dispose(); document.dispose();
        const report = {status: 'passed', vscode: vscode.version, cycles,
            elapsedMs: Date.now() - start, checkpoints,
            note: 'Actual VS Code webview, vendored PDF.js parser/renderer and production provider; synthetic PDFs only.'};
        fs.mkdirSync(path.dirname(process.env.OVERLEAF_SOAK_REPORT), {recursive: true});
        fs.writeFileSync(process.env.OVERLEAF_SOAK_REPORT, JSON.stringify(report, null, 2));
        console.log(`PDF webview soak passed (${cycles} reloads, failures, burst and teardown)`);
    } catch (error) {
        fs.mkdirSync(path.dirname(process.env.OVERLEAF_SOAK_REPORT), {recursive: true});
        fs.writeFileSync(process.env.OVERLEAF_SOAK_REPORT, JSON.stringify({status: 'failed', vscode: vscode.version,
            cycles, elapsedMs: Date.now() - start, checkpoints, latest, progress, reason: error.message}, null, 2));
        throw error;
    } finally {
        panel?.dispose(); document?.dispose();
    }
};
