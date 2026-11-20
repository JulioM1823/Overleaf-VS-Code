// This worker receives only rendered pixel snapshots, never PDF source or code.
'use strict';
let canvas;
self.onmessage = async event => {
    const {id, bitmap} = event.data;
    try {
        canvas ||= new OffscreenCanvas(bitmap.width, bitmap.height);
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        canvas.getContext('2d').drawImage(bitmap, 0, 0);
        const blob = await canvas.convertToBlob({type: 'image/png'});
        self.postMessage({id, blob});
    } catch (_) {
        self.postMessage({id, error: true});
    } finally { bitmap.close(); }
};
