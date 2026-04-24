function escapePdfText(value) {
    return String(value)
        .replace(/\\/g, '\\\\')
        .replace(/\(/g, '\\(')
        .replace(/\)/g, '\\)');
}

function createMinimalPdfFixture(text = 'Hello PDF') {
    const contentStream = `BT /F1 12 Tf 72 120 Td (${escapePdfText(text)}) Tj ET`;
    const objects = [
        '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
        '2 0 obj\n<< /Type /Pages /Count 1 /Kids [3 0 R] >>\nendobj\n',
        '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>\nendobj\n',
        `4 0 obj\n<< /Length ${Buffer.byteLength(contentStream, 'utf8')} >>\nstream\n${contentStream}\nendstream\nendobj\n`,
        '5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n',
    ];

    let pdf = '%PDF-1.4\n';
    const offsets = [0];
    for (const object of objects) {
        offsets.push(Buffer.byteLength(pdf, 'utf8'));
        pdf += object;
    }

    const xrefOffset = Buffer.byteLength(pdf, 'utf8');
    pdf += `xref\n0 ${objects.length + 1}\n`;
    pdf += '0000000000 65535 f \n';
    for (let index = 1; index < offsets.length; index += 1) {
        pdf += `${String(offsets[index]).padStart(10, '0')} 00000 n \n`;
    }
    pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
    return Buffer.from(pdf, 'utf8');
}

function createCorruptPdfFixture() {
    return Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\n', 'utf8');
}

module.exports = {
    createCorruptPdfFixture,
    createMinimalPdfFixture,
};
