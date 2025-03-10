import { Writable } from 'node:stream';
import * as assert from 'node:assert';
import type { TreeAdapter } from 'parse5/dist/tree-adapters/interface.js';
import * as defaultTreeAdapter from 'parse5/dist/tree-adapters/default.js';
import * as htmlTreeAdapter from 'parse5-htmlparser2-tree-adapter';
import type { Location } from 'parse5/dist/common/token.js';

const defaultAdapter: TreeAdapter<defaultTreeAdapter.DefaultTreeAdapterMap> = defaultTreeAdapter;
const htmlparser2Adapter: TreeAdapter<htmlTreeAdapter.Htmlparser2TreeAdapterMap> = htmlTreeAdapter;

// Ensure the default tree adapter matches the expected type.
export const treeAdapters = {
    default: defaultAdapter,
    htmlparser2: htmlparser2Adapter,
} as const;

export function addSlashes(str: string): string {
    return str
        .replace(/\t/g, '\\t')
        .replace(/\n/g, '\\n')
        .replace(/\f/g, '\\f')
        .replace(/\r/g, '\\r')
        .replace(/\0/g, '\\u0000');
}

function createDiffMarker(markerPosition: number): string {
    return '^\n'.padStart(markerPosition + 1, ' ');
}

function getRandomChunkSize(min = 1, max = 10): number {
    return min + Math.floor(Math.random() * (max - min + 1));
}

export function makeChunks(str: string, minSize?: number, maxSize?: number): string[] {
    if (str.length === 0) {
        return [''];
    }

    const chunks = [];
    let start = 0;

    // NOTE: add 1 as well, so we avoid situation when we have just one huge chunk
    let end = Math.min(getRandomChunkSize(minSize, maxSize), str.length, 1);

    while (start < str.length) {
        chunks.push(str.substring(start, end));
        start = end;
        end = Math.min(end + getRandomChunkSize(minSize, maxSize), str.length);
    }

    return chunks;
}

export class WritableStreamStub extends Writable {
    writtenData = '';

    constructor() {
        super({ decodeStrings: false });
    }

    override _write(chunk: string, _encoding: string, callback: () => void): void {
        assert.strictEqual(typeof chunk, 'string', 'Expected output to be a string stream');
        this.writtenData += chunk;
        callback();
    }
}

export function normalizeNewLine(str: string): string {
    return str.replace(/\r\n/g, '\n');
}

export function removeNewLines(str: string): string {
    return str.replace(/\r/g, '').replace(/\n/g, '');
}

export function writeChunkedToStream(str: string, stream: Writable): void {
    const chunks = makeChunks(str);
    const lastChunkIdx = chunks.length - 1;

    for (const [idx, chunk] of chunks.entries()) {
        if (idx === lastChunkIdx) {
            stream.end(chunk);
        } else {
            stream.write(chunk);
        }
    }
}

export function generateTestsForEachTreeAdapter(name: string, ctor: (adapter: TreeAdapter) => void): void {
    describe(name, () => {
        for (const adapterName of Object.keys(treeAdapters)) {
            const adapter = treeAdapters[adapterName as keyof typeof treeAdapters] as TreeAdapter;

            describe(`Tree adapter: ${adapterName}`, () => {
                ctor(adapter);
            });
        }
    });
}

export function getStringDiffMsg(actual: string, expected: string): string {
    for (let i = 0; i < expected.length; i++) {
        if (actual[i] !== expected[i]) {
            let diffMsg = `\nString differ at index ${i}\n`;

            const expectedStr = `Expected: ${addSlashes(expected.substring(i - 100, i + 1))}`;
            const expectedDiffMarker = createDiffMarker(expectedStr.length);

            diffMsg += `${expectedStr}${addSlashes(expected.substring(i + 1, i + 20))}\n${expectedDiffMarker}`;

            const actualStr = `Actual:   ${addSlashes(actual.substring(i - 100, i + 1))}`;
            const actualDiffMarker = createDiffMarker(actualStr.length);

            diffMsg += `${actualStr}${addSlashes(actual.substring(i + 1, i + 20))}\n${actualDiffMarker}`;

            return diffMsg;
        }
    }

    return '';
}

export function getSubstringByLineCol(lines: string[], loc: Location): string {
    lines = lines.slice(loc.startLine - 1, loc.endLine);

    const last = lines.length - 1;

    lines[last] = lines[last].substring(0, loc.endCol - 1);
    lines[0] = lines[0].substring(loc.startCol - 1);

    return lines.join('\n');
}
