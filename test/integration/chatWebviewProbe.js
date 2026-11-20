// Test-only observer injected with the production nonce. CSP stays unchanged.
(function () {
    'use strict';
    const acquire = window.acquireVsCodeApi;
    let api;
    const metrics = {readyMessages: 0, sendMessages: 0, errors: [], rejections: []};
    window.acquireVsCodeApi = () => {
        api = acquire();
        return {
            getState: () => api.getState(),
            setState: state => api.setState(state),
            postMessage: message => {
                if (message?.type==='chat-ready') { metrics.readyMessages++; }
                if (message?.type==='send-message') { metrics.sendMessages++; }
                return api.postMessage(message);
            },
        };
    };
    window.addEventListener('error', event => metrics.errors.push(String(event.message || 'error')));
    window.addEventListener('unhandledrejection', event => metrics.rejections.push(String(event.reason?.message || event.reason)));
    window.addEventListener('message', event => {
        const command = event.data;
        if (command?.type!=='chatSmokeCommand' || !api) { return; }
        try {
            const host = document.querySelector('vscode-text-area');
            const composer = host?.control;
            if (command.action==='enter') {
                composer.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', bubbles: true, composed: true}));
            }
            const contents = [...document.querySelectorAll('.message-item_content')];
            api.postMessage({
                type: 'chatSmokeResult', id: command.id,
                metrics: {...metrics},
                composer: composer?.value,
                composerFocused: host?.shadowRoot?.activeElement===composer,
                contents: contents.map(element => element.textContent),
                authors: [...document.querySelectorAll('.message-item_author')].map(element => element.textContent),
                contentChildElements: contents.reduce((count, element) => count + element.children.length, 0),
                authorChildElements: [...document.querySelectorAll('.message-item_author')].reduce((count, element) => count + element.children.length, 0),
                deliveryLabels: [...document.querySelectorAll('.message-item_delivery_state')].map(element => element.textContent),
                ownActionButtons: document.querySelectorAll('.message-item_actions vscode-button').length,
                injectedElements: document.querySelectorAll('#chat-smoke-injected, .message-item_content script, .message-item_content img').length,
                injectedScriptRan: Boolean(globalThis.__chatSmokeInjected),
                hidden: document.hidden,
            });
        } catch (error) {
            api.postMessage({type: 'chatSmokeResult', id: command.id, failure: String(error?.message || error)});
        }
    });
}());
