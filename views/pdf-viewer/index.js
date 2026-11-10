/* eslint-disable @typescript-eslint/naming-convention */
"use strict";

// Reference: https://github.com/tomoki1207/vscode-pdfviewer/blob/main/lib/main.js
(function(){
    const CursorTool = { SELECT:0, HAND:1, ZOOM:2 };
    const SpreadMode = { UNKNOWN:-1, NONE:0, ODD:1, EVEN:2 };
    const ScrollMode = { UNKNOWN:-1, VERTICAL:0, HORIZONTAL:1, WRAPPED:2, PAGE:3 };
    const SidebarView = { UNKNOWN:-1, NONE:0, THUMBS:1, OUTLINE:2, ATTACHMENTS:3, LAYERS:4 };
    const ScrollModeMap = {
        vertical: ScrollMode.VERTICAL,
        horizontal: ScrollMode.HORIZONTAL,
        wrapped: ScrollMode.WRAPPED,
        page: ScrollMode.PAGE,
    };
    const SpreadModeMap = {
        none: SpreadMode.NONE,
        odd: SpreadMode.ODD,
        even: SpreadMode.EVEN,
    };
    let ColorThemes = {
        'default': {fontColor:'black', bgColor:'white'},
        'light': {fontColor:'black', bgColor:'#F5F5DC'},
        'dark': {fontColor:'#FBF0D9', bgColor:'#4B4B4B'}
    };

    // @ts-ignore
    const vscode = acquireVsCodeApi();
    // Configure the viewer before DOMContentLoaded constructs its scripting
    // manager. Passing enableScripting to getDocument does not control it.
    PDFViewerApplicationOptions.set('enableScripting', false);
    PDFViewerApplicationOptions.set('isEvalSupported', false);
    PDFViewerApplicationOptions.set('disablePreferences', true);
    // The extension supplies bytes. The generic viewer's demo URL otherwise
    // starts an unrelated load that races our preview and rejects unhandled.
    PDFViewerApplicationOptions.set('defaultUrl', '');
    let globalPdfViewerState = {
        colorTheme: 'default',
        containerScrollLeft: 0,
        containerScrollTop:  0,
        currentScaleValue: 'auto',
        pdfCursorTools: CursorTool.SELECT,
        pdfViewerScrollMode: ScrollMode.VERTICAL,
        pdfViewerSpreadMode: SpreadMode.NONE,
        pdfSidebarView: SidebarView.NONE,
    };
    let firstLoaded = true;
    let syncHighlightTimer;
    const pdfSyncHighlight = globalThis.OverleafPdfSyncHighlight;
    let pdfViewerConfig = {
        cMapUrl: '',
    };
    const pdfDocumentLoader = new globalThis.OverleafPdfDocumentLoader(
        options => pdfjsLib.getDocument(options),
        doc => {
            if (firstLoaded) { firstLoaded = false; }
            else { backupPdfViewerState(); }
            PDFViewerApplication.isViewerEmbedded = true;
            PDFViewerApplication.load(doc);
        },
        () => showPdfError('Unable to render the PDF. Check the compilation diagnostics and compile again.'),
    );
    function showPdfError(message) {
        let banner = document.getElementById('overleaf-pdf-error');
        if (!banner) {
            banner = document.createElement('div');
            banner.id = 'overleaf-pdf-error';
            banner.setAttribute('role', 'alert');
            document.body.appendChild(banner);
        }
        banner.textContent = message;
        banner.hidden = false;
    }
    window.addEventListener('pagehide', () => {
        clearSyncHighlight();
        void pdfDocumentLoader.dispose();
    }, {once:true});

    function updatePdfViewerState() {
        const pdfViewerState = vscode.getState() || globalPdfViewerState;

        if (ColorThemes[pdfViewerState.colorTheme] === undefined) {
            pdfViewerState.colorTheme = Object.keys(ColorThemes)[0];
        }
        pdfjsLib.ViewerFontColor = ColorThemes[pdfViewerState.colorTheme].fontColor;
        pdfjsLib.ViewerBgColor = ColorThemes[pdfViewerState.colorTheme].bgColor;

        PDFViewerApplication.pdfViewer.currentScaleValue = pdfViewerState.currentScaleValue;
        PDFViewerApplication.pdfCursorTools.switchTool( pdfViewerState.pdfCursorTools );
        PDFViewerApplication.pdfViewer.scrollMode = pdfViewerState.pdfViewerScrollMode;
        PDFViewerApplication.pdfViewer.spreadMode = pdfViewerState.pdfViewerSpreadMode;
        PDFViewerApplication.pdfSidebar.setInitialView( pdfViewerState.pdfSidebarView );
        PDFViewerApplication.pdfSidebar.switchView( pdfViewerState.pdfSidebarView );
        document.getElementById('viewerContainer').scrollLeft = pdfViewerState.containerScrollLeft;
        document.getElementById('viewerContainer').scrollTop = pdfViewerState.containerScrollTop;
        PDFViewerApplication.pdfViewer.refresh();
    }

    function backupPdfViewerState() {
        if (PDFViewerApplication.pdfViewer.currentScaleValue !== null) {
            globalPdfViewerState.currentScaleValue = PDFViewerApplication.pdfViewer.currentScaleValue;
        }
        globalPdfViewerState.pdfViewerScrollMode = PDFViewerApplication.pdfViewer.scrollMode;
        globalPdfViewerState.pdfViewerSpreadMode = PDFViewerApplication.pdfViewer.spreadMode;
        globalPdfViewerState.pdfSidebarView = PDFViewerApplication.pdfSidebar.visibleView;
        globalPdfViewerState.containerScrollLeft = document.getElementById('viewerContainer').scrollLeft || 0;
        globalPdfViewerState.containerScrollTop = document.getElementById('viewerContainer').scrollTop || 0;
        vscode.setState(globalPdfViewerState);
        vscode.postMessage({
            type: 'saveState',
            content: globalPdfViewerState,
        });
    }

    function isPlainObject(value) {
        return value !== null && typeof value === 'object' && Array.isArray(value) === false;
    }

    function isValidThemeName(theme) {
        return typeof theme === 'string' && theme.match(/^[a-zA-Z0-9-_]+$/) !== null;
    }

    function isValidColor(value) {
        return typeof value === 'string' && value.match(/^#[0-9a-fA-F]{6}$/) !== null;
    }

    function normalizeColorThemes(themes) {
        if (!isPlainObject(themes)) {
            return ColorThemes;
        }
        const normalized = {};
        for (const [theme, value] of Object.entries(themes)) {
            if (
                isValidThemeName(theme)
                && isPlainObject(value)
                && isValidColor(value.fontColor)
                && isValidColor(value.bgColor)
            ) {
                normalized[theme] = {
                    fontColor: value.fontColor,
                    bgColor: value.bgColor,
                };
            }
        }
        return Object.keys(normalized).length > 0 ? normalized : ColorThemes;
    }

    function updateColorThemes(themes) {
        ColorThemes = normalizeColorThemes(themes);
        // set global css
        const style = document.createElement('style');
        style.id = 'overleaf-workshop-theme-styles';
        const rules = [];
        for (const theme in ColorThemes) {
            // update css
            rules.push(
                `#theme-${theme}::before {`,
                `  background-color: ${ColorThemes[theme].bgColor};`,
                '}',
            );
        }
        style.textContent = rules.join('\n');
        document.getElementById(style.id)?.remove();
        document.head.appendChild(style);
    }

    function clearSyncHighlight() {
        syncHighlightTimer && clearTimeout(syncHighlightTimer);
        syncHighlightTimer = undefined;
        document.getElementById('overleaf-workshop-sync-highlight')?.remove();
    }

    function showSyncHighlight(page, layout) {
        clearSyncHighlight();
        const highlight = document.createElement('div');
        highlight.id = 'overleaf-workshop-sync-highlight';
        highlight.className = 'overleaf-workshop-sync-highlight';
        highlight.setAttribute('aria-hidden', 'true');
        highlight.style.left = `${layout.highlightLeft}px`;
        highlight.style.top = `${layout.highlightTop}px`;
        page.appendChild(highlight);
        syncHighlightTimer = setTimeout(() => {
            if (highlight.parentElement) {
                highlight.remove();
            }
            syncHighlightTimer = undefined;
        }, 1600);
    }

    function updatePdfViewerDefaults(defaults) {
        if (defaults === undefined || defaults === null) {
            return;
        }
        if (typeof defaults.scrollMode === 'string') {
            const scrollMode = ScrollModeMap[defaults.scrollMode.toLowerCase()];
            if (scrollMode !== undefined) {
                globalPdfViewerState.pdfViewerScrollMode = scrollMode;
            }
        }
        if (typeof defaults.spreadMode === 'string') {
            const spreadMode = SpreadModeMap[defaults.spreadMode.toLowerCase()];
            if (spreadMode !== undefined) {
                globalPdfViewerState.pdfViewerSpreadMode = spreadMode;
            }
        }
    }

    function enableThemeToggleButton(initIndex = 0){
        // create toggle theme button
        const button = document.createElement('button');
        button.setAttribute('class', 'toolbarButton hiddenMediumView');
        button.setAttribute('theme-index', initIndex);
        button.setAttribute('tabindex', '30');
        // set button theme attribute
        const setAttribute = (index) => {
            const theme = Object.keys(ColorThemes)[index];
            globalPdfViewerState.colorTheme = theme;
            const label = document.createElement('span');
            label.textContent = theme;
            button.replaceChildren(label);
            button.setAttribute('title', `Theme: ${theme}`);
            button.setAttribute('id', `theme-${theme}`);
        };
        button.addEventListener('click', () => {
            const index = Number(button.getAttribute('theme-index'));
            const next = (index + 1) % Object.keys(ColorThemes).length;
            button.setAttribute('theme-index', next);
            setAttribute(next);
            backupPdfViewerState();
            updatePdfViewerState();
        });
        setAttribute(initIndex);
        //
        const container = document.getElementById('toolbarViewerRight');
        const firstChild = document.getElementById('openFile');
        container.insertBefore(button, firstChild);
    }

    async function updatePdf(pdf) {
        if (!(pdf instanceof ArrayBuffer) && !(pdf instanceof Uint8Array)) {
            return;
        }
        clearSyncHighlight();
        const options = {
            data: pdf,
            cMapPacked: true,
            isEvalSupported: false
        };
        if (typeof pdfViewerConfig.cMapUrl === 'string' && pdfViewerConfig.cMapUrl.length > 0) {
            options.cMapUrl = pdfViewerConfig.cMapUrl;
        }
        await pdfDocumentLoader.update(options);
    }

    // Reference: https://github.com/James-Yu/LaTeX-Workshop/blob/master/viewer/latexworkshop.ts#L306
    function syncCode(pdf) {
        const target = pdfSyncHighlight?.getSyncTarget(pdf);
        if (target === undefined) {
            return;
        }
        const container = document.getElementById('viewerContainer');
        const pageNum = target.page;
        const h = target.h;
        const v = target.v;
        const page = document.getElementsByClassName('page')[pageNum - 1];
        if (page === null || page === undefined) {
            return;
        }
        const {viewport} = PDFViewerApplication.pdfViewer.getPageView(pageNum - 1);
        let [left, top] = viewport.convertToPdfPoint(h , v);
        const layout = pdfSyncHighlight?.getHighlightLayout({
            left,
            top,
            pageWidth: page.offsetWidth,
            pageHeight: page.offsetHeight,
            pageOffsetLeft: page.offsetLeft,
            pageOffsetTop: page.offsetTop,
            bodyHeight: document.body.offsetHeight,
            scrollMode: PDFViewerApplication.pdfViewer.scrollMode,
        });
        if (layout === undefined) {
            return;
        }
        if (PDFViewerApplication.pdfViewer.scrollMode === 1) {
            // horizontal scrolling
            container.scrollLeft = layout.containerScrollLeft;
        } else {
            // vertical scrolling
            container.scrollTop = layout.containerScrollTop;
        }
        showSyncHighlight(page, layout);
        backupPdfViewerState();
    }

    //Reference: https://github.com/overleaf/overleaf/blob/main/services/web/frontend/js/features/pdf-preview/util/pdf-js-wrapper.js#L163
    function syncPdf(pageElem, pageNum, clientX, clientY, innerText) {
        const pageCanvas = pageElem.querySelector('canvas');
        if (pageCanvas === null) {
            return;
        }
        const pageRect = pageCanvas.getBoundingClientRect();
        const {viewport} = PDFViewerApplication.pdfViewer.getPageView(pageNum - 1);
        const dx = clientX - pageRect.left;
        const dy = clientY - pageRect.top;
        let [left, top] = viewport.convertToPdfPoint(dx, dy);
        top = viewport.viewBox[3] - top;
        vscode.postMessage({
            type: 'syncPdf',
            content: { page: Number(pageNum), h: left, v: top, identifier: String(innerText ?? '').slice(0, 256)},
        });
        backupPdfViewerState();
    }

    window.addEventListener('load', async () => {
        // init pdf.js configuration
        PDFViewerApplication.initializedPromise
        .then(() => {
            const {eventBus} = PDFViewerApplication;
            eventBus.on('documentloaded', updatePdfViewerState);
            // backup scale
            eventBus._on('scalechanged', backupPdfViewerState);
            eventBus._on("zoomin", backupPdfViewerState);
            eventBus._on("zoomout", backupPdfViewerState);
            eventBus._on("zoomreset", backupPdfViewerState);
            // backup scroll/spread mode
            eventBus._on("switchscrollmode", backupPdfViewerState);
            eventBus._on("scrollmodechanged", backupPdfViewerState);
            eventBus._on("switchspreadmode", backupPdfViewerState);
            vscode.postMessage({type: 'ready'});
        });

        // add message listener
        window.addEventListener('message', async (e) => {
            const message = e.data;
            if (!isPlainObject(message) || typeof message.type !== 'string') {
                return;
            }
            switch (message.type) {
                case 'update':
                    document.getElementById('overleaf-pdf-error')?.setAttribute('hidden', '');
                    await updatePdf(message.content);
                    break;
                case 'loadError':
                    if (typeof message.content==='string' && message.content.length<=512) {
                        showPdfError(message.content);
                    }
                    break;
                case 'syncCode':
                    if (isPlainObject(message.content)) {
                        syncCode(message.content);
                    }
                    break;
                case 'configure':
                    if (typeof message.cMapUrl === 'string' && message.cMapUrl.length <= 2_048) {
                        pdfViewerConfig = {
                            ...pdfViewerConfig,
                            cMapUrl: message.cMapUrl,
                        };
                    }
                    break;
                case 'initState':
                    updatePdfViewerDefaults(message.defaults);
                    if (isPlainObject(message.content)) {
                        Object.assign(globalPdfViewerState, message.content);
                    }
                    if (isPlainObject(message.colorThemes)) {
                        updateColorThemes(message.colorThemes);
                    }
                    updatePdfViewerState();
                    enableThemeToggleButton( Object.keys(ColorThemes).indexOf(globalPdfViewerState.colorTheme) );
                    break;
                default:
                    break;
            }
        });

        // add mouse double click listener
        window.addEventListener('dblclick', (e) => {
            if (!(e.target instanceof HTMLElement)) {
                return;
            }
            const pageElem = e.target.closest('.page');
            if (pageElem === null) {
                return;
            }
            const pageNum = pageElem.getAttribute('data-page-number');
            if (pageNum === null || pageNum === undefined) {
                return;
            }
            syncPdf(pageElem, pageNum, e.clientX, e.clientY, e.target.innerText);
        });

        // Display Error Message
        window.onerror = () => {
            const msg = document.createElement('body');
            msg.innerText = 'An error occurred while loading the file. Please open it again.';
            document.body = msg;
        };
    }, { once : true });

}());
