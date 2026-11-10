const test = require('node:test');
const assert = require('node:assert/strict');

for (const location of ['../node_modules/braces', '../views/chat-view/node_modules/braces']) {
    const braces = require(location);
    test(`build brace patterns reject excessive nesting (${location})`, () => {
        const deepBrace = '{'.repeat(3000) + 'a,b' + '}'.repeat(3000);
        const deepParentheses = '('.repeat(3000) + 'a' + ')'.repeat(3000);
        for (const pattern of [deepBrace, deepParentheses]) {
            for (const action of ['parse', 'compile', 'expand', 'stringify']) {
                assert.throws(() => braces[action](pattern), error => error instanceof SyntaxError && /safe depth limit/.test(error.message));
            }
        }
        assert.deepEqual(braces.expand('file-{a,b}-{1..3}'), ['file-a-1','file-a-2','file-a-3','file-b-1','file-b-2','file-b-3']);
        assert.equal(braces.compile('*.{js,css}'), '*.(js|css)');
        assert.equal(braces.stringify(braces.parse('a/{b,c}/d')), 'a/{b,c}/d');
    });
    test(`build brace AST walkers bound direct input (${location})`, () => {
        const deep={type:'root',nodes:[]};let next=deep;
        for (let i=0;i<500;i++) {const child={type:'root',nodes:[]};next.nodes.push(child);next=child;}
        for (const action of ['compile','expand','stringify']) {
            assert.throws(()=>braces[action](deep), /safe depth limit/);
        }
    });
}
