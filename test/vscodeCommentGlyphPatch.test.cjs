const assert = require('node:assert/strict');
const test = require('node:test');
const {replaceGlyphOption} = require('../scripts/vscode-comment-glyph-patch.cjs');
const glyph = 'collapseOnReplaceEdit:!0,linesDecorationsClassName:e};return tn.createDynamic(t)}setThreadState';

test('native glyph patch changes only the verified comment decoration property', () => {
    const source = `unrelated={linesDecorationsClassName:e};${glyph}(e,t=!1)`;
    const patched = replaceGlyphOption(source);
    assert.equal(patched, `unrelated={linesDecorationsClassName:e};${glyph.replace('linesDecorationsClassName', 'firstLineDecorationClassName')}(e,t=!1)`);
});
test('native glyph patch refuses an unrecognized definition', () => {
    assert.throws(() => replaceGlyphOption('another host build'), /exactly one/);
});
test('native glyph patch refuses duplicate definitions or a second application', () => {
    assert.throws(() => replaceGlyphOption(glyph + glyph), /exactly one/);
    assert.throws(() => replaceGlyphOption(replaceGlyphOption(glyph)), /exactly one/);
});
