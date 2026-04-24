const inspect = require('node:util').inspect;

function normalizePrimitive(value) {
    if (value === null) {
        return null;
    }
    switch (typeof value) {
        case 'string':
        case 'number':
        case 'boolean':
            return value;
        default:
            return undefined;
    }
}

function normalizeError(error) {
    if (error === undefined) {
        return undefined;
    }
    if (error instanceof Error) {
        const normalized = {
            errorMessage: error.message,
            errorName: error.name,
        };
        if (error.code) {
            normalized.errorCode = String(error.code);
        }
        return normalized;
    }
    if (typeof error === 'string') {
        return { errorMessage: error };
    }
    if (typeof error === 'object' && error !== null) {
        return normalizeObject(error);
    }
    return { errorMessage: String(error) };
}

function normalizeValue(value) {
    const primitive = normalizePrimitive(value);
    if (primitive !== undefined) {
        return primitive;
    }
    if (Array.isArray(value)) {
        return value
            .map((item) => normalizeValue(item))
            .filter((item) => item !== undefined);
    }
    if (value instanceof Error) {
        return normalizeError(value);
    }
    if (typeof value === 'object' && value !== null) {
        return normalizeObject(value);
    }
    if (value === undefined) {
        return undefined;
    }
    return inspect(value, { breakLength: Infinity, depth: 4 });
}

function normalizeObject(record) {
    return Object.fromEntries(
        Object.entries(record)
            .map(([key, value]) => [key, normalizeValue(value)])
            .filter((entry) => entry[1] !== undefined)
            .sort(([left], [right]) => left.localeCompare(right)),
    );
}

function createStructuredRecorder(scope, options = {}) {
    const mirrorToConsole = options.mirrorToConsole ?? process.env.OVERLEAF_WORKSHOP_TEST_LOGS === '1';
    let sequence = 0;
    const records = [];

    function record(event, fields = {}, error) {
        const entry = {
            event,
            scope,
            sequence: sequence += 1,
            ...normalizeObject(fields),
        };
        const normalizedError = normalizeError(error);
        if (normalizedError) {
            Object.assign(entry, normalizedError);
        }
        records.push(entry);
        if (mirrorToConsole) {
            console.error(`${scope}: ${JSON.stringify(entry)}`);
        }
        return entry;
    }

    return {
        record,
        snapshot() {
            return records.map((entry) => ({ ...entry }));
        },
        clear() {
            records.length = 0;
            sequence = 0;
        },
    };
}

module.exports = {
    createStructuredRecorder,
};
