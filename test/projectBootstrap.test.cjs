const test = require('node:test');
const assert = require('node:assert/strict');

const {
    buildProjectEntityFromFlatEntities,
    inferRootDocPath,
    isSyntheticEntityId,
    SYNTHETIC_ENTITY_PREFIX,
} = require('../out/api/projectBootstrap.js');
const {
    extractHtmlMetaContent,
    extractJsonMetaContent,
} = require('../out/api/htmlMeta.js');

test('extractHtmlMetaContent and extractJsonMetaContent parse escaped page metadata', () => {
    const html = `
        <meta name="ol-projectName" content="Morales Thesis Proposal">
        <meta name="ol-user" data-type="json" content="{&quot;_id&quot;:&quot;u1&quot;,&quot;first_name&quot;:&quot;Julio&quot;,&quot;email&quot;:&quot;julio@example.com&quot;}">
        <meta name="ol-learnedWords" data-type="json" content="[&quot;astrochemistry&quot;]">
    `;

    assert.equal(extractHtmlMetaContent(html, 'ol-projectName'), 'Morales Thesis Proposal');
    assert.deepEqual(
        extractJsonMetaContent(html, 'ol-user'),
        {_id: 'u1', first_name: 'Julio', email: 'julio@example.com'},
    );
    assert.deepEqual(
        extractJsonMetaContent(html, 'ol-learnedWords'),
        ['astrochemistry'],
    );
});

test('inferRootDocPath prioritizes main.tex for fallback bootstrap', () => {
    assert.equal(
        inferRootDocPath([
            {path: 'sections/intro.tex', type: 'doc'},
            {path: 'main.tex', type: 'doc'},
        ]),
        '/main.tex',
    );
});

test('inferRootDocPath returns undefined when no docs are present', () => {
    assert.equal(
        inferRootDocPath([
            {path: 'figures/plot.png', type: 'file'},
        ]),
        undefined,
    );
});

test('buildProjectEntityFromFlatEntities reconstructs nested folders with synthetic ids', () => {
    const project = buildProjectEntityFromFlatEntities(
        'project-1',
        [
            {path: 'main.tex', type: 'doc'},
            {path: 'sections/intro.tex', type: 'doc'},
            {path: 'figures/plot.png', type: 'file'},
        ],
        {
            projectName: 'Thesis',
            user: {_id: 'user-1', first_name: 'Julio', email: 'julio@example.com'},
            settings: {
                learnedWords: ['astrochemistry'],
                languages: [{name: 'Off', code: ''}, {name: 'English', code: 'en'}],
                compilers: [{name: 'pdfLaTex', code: 'pdflatex'}],
            },
        },
        true,
    );

    assert.equal(project.name, 'Thesis');
    assert.equal(project.rootDoc_id, `${SYNTHETIC_ENTITY_PREFIX}doc:${encodeURIComponent('/main.tex')}`);
    assert.equal(project.rootFolder.length, 1);
    assert.equal(project.rootFolder[0].docs.map(doc => doc.name).join(','), 'main.tex');
    assert.equal(project.rootFolder[0].folders.map(folder => folder.name).join(','), 'figures,sections');
    assert.equal(project.rootFolder[0].readonly, true);

    const sections = project.rootFolder[0].folders.find(folder => folder.name === 'sections');
    assert.ok(sections);
    assert.equal(sections.docs.length, 1);
    assert.equal(sections.docs[0].name, 'intro.tex');
    assert.equal(isSyntheticEntityId(sections.docs[0]._id), true);

    const figures = project.rootFolder[0].folders.find(folder => folder.name === 'figures');
    assert.ok(figures);
    assert.equal(figures.fileRefs.length, 1);
    assert.equal(figures.fileRefs[0].name, 'plot.png');
    assert.equal(isSyntheticEntityId(figures.fileRefs[0]._id), true);
});

test('buildProjectEntityFromFlatEntities handles an empty fallback entity list', () => {
    const project = buildProjectEntityFromFlatEntities(
        'project-empty',
        [],
        {
            projectName: 'Empty Project',
            user: {_id: 'user-1', first_name: 'Julio', email: 'julio@example.com'},
            settings: {
                learnedWords: [],
                languages: [{name: 'Off', code: ''}],
                compilers: [{name: 'pdfLaTex', code: 'pdflatex'}],
            },
        },
        true,
    );

    assert.equal(project.name, 'Empty Project');
    assert.equal(project.rootDoc_id, '');
    assert.equal(project.rootFolder.length, 1);
    assert.equal(project.rootFolder[0].docs.length, 0);
    assert.equal(project.rootFolder[0].fileRefs.length, 0);
    assert.equal(project.rootFolder[0].folders.length, 0);
    assert.equal(project.rootFolder[0].readonly, true);
});
