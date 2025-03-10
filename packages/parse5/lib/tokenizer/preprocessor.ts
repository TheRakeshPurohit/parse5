import {
    CODE_POINTS as $,
    getSurrogatePairCodePoint,
    isControlCodePoint,
    isSurrogate,
    isSurrogatePair,
    isUndefinedCodePoint,
} from '../common/unicode.js';
import { ERR, ParserError, ParserErrorHandler } from '../common/error-codes.js';

//Const
const DEFAULT_BUFFER_WATERLINE = 1 << 16;

//Preprocessor
//NOTE: HTML input preprocessing
//(see: http://www.whatwg.org/specs/web-apps/current-work/multipage/parsing.html#preprocessing-the-input-stream)
export class Preprocessor {
    public html = '';
    private pos = -1;
    // NOTE: Initial `lastGapPos` is -2, to ensure `col` on initialisation is 0
    private lastGapPos = -2;
    private gapStack: number[] = [];
    private skipNextNewLine = false;
    private lastChunkWritten = false;
    public endOfChunkHit = false;
    public bufferWaterline = DEFAULT_BUFFER_WATERLINE;

    private isEol = false;
    private lineStartPos = 0;
    public droppedBufferSize = 0;
    public line = 1;

    constructor(private handler: { onParseError?: ParserErrorHandler | null }) {}

    /** The column on the current line. If we just saw a gap (eg. a surrogate pair), return the index before. */
    public get col(): number {
        return this.pos - this.lineStartPos + Number(this.lastGapPos !== this.pos);
    }

    public get offset(): number {
        return this.droppedBufferSize + this.pos;
    }

    public getError(code: ERR): ParserError {
        const { line, col, offset } = this;

        return {
            code,
            startLine: line,
            endLine: line,
            startCol: col,
            endCol: col,
            startOffset: offset,
            endOffset: offset,
        };
    }

    //NOTE: avoid reporting errors twice on advance/retreat
    private lastErrOffset = -1;
    private _err(code: ERR): void {
        if (this.handler.onParseError && this.lastErrOffset !== this.offset) {
            this.lastErrOffset = this.offset;
            this.handler.onParseError(this.getError(code));
        }
    }

    private _addGap(): void {
        this.gapStack.push(this.lastGapPos);
        this.lastGapPos = this.pos;
    }

    private _processSurrogate(cp: number): number {
        //NOTE: try to peek a surrogate pair
        if (this.pos !== this.html.length - 1) {
            const nextCp = this.html.charCodeAt(this.pos + 1);

            if (isSurrogatePair(nextCp)) {
                //NOTE: we have a surrogate pair. Peek pair character and recalculate code point.
                this.pos++;

                //NOTE: add a gap that should be avoided during retreat
                this._addGap();

                return getSurrogatePairCodePoint(cp, nextCp);
            }
        }

        //NOTE: we are at the end of a chunk, therefore we can't infer the surrogate pair yet.
        else if (!this.lastChunkWritten) {
            this.endOfChunkHit = true;
            return $.EOF;
        }

        //NOTE: isolated surrogate
        this._err(ERR.surrogateInInputStream);

        return cp;
    }

    public willDropParsedChunk(): boolean {
        return this.pos > this.bufferWaterline;
    }

    public dropParsedChunk(): void {
        if (this.willDropParsedChunk()) {
            this.html = this.html.substring(this.pos);
            this.lineStartPos -= this.pos;
            this.droppedBufferSize += this.pos;
            this.pos = 0;
            this.lastGapPos = -2;
            this.gapStack.length = 0;
        }
    }

    public write(chunk: string, isLastChunk: boolean): void {
        if (this.html.length > 0) {
            this.html += chunk;
        } else {
            this.html = chunk;
        }

        this.endOfChunkHit = false;
        this.lastChunkWritten = isLastChunk;
    }

    public insertHtmlAtCurrentPos(chunk: string): void {
        this.html = this.html.substring(0, this.pos + 1) + chunk + this.html.substring(this.pos + 1);

        this.endOfChunkHit = false;
    }

    public startsWith(pattern: string, caseSensitive: boolean): boolean {
        // Check if our buffer has enough characters
        if (this.pos + pattern.length > this.html.length) {
            this.endOfChunkHit = !this.lastChunkWritten;
            return false;
        }

        if (caseSensitive) {
            return this.html.startsWith(pattern, this.pos);
        }

        for (let i = 0; i < pattern.length; i++) {
            const cp = this.html.charCodeAt(this.pos + i) | 0x20;

            if (cp !== pattern.charCodeAt(i)) {
                return false;
            }
        }

        return true;
    }

    public peek(offset: number): number {
        const pos = this.pos + offset;

        if (pos >= this.html.length) {
            this.endOfChunkHit = !this.lastChunkWritten;
            return $.EOF;
        }

        return this.html.charCodeAt(pos);
    }

    public advance(): number {
        this.pos++;

        //NOTE: LF should be in the last column of the line
        if (this.isEol) {
            this.isEol = false;
            this.line++;
            this.lineStartPos = this.pos;
        }

        if (this.pos >= this.html.length) {
            this.endOfChunkHit = !this.lastChunkWritten;
            return $.EOF;
        }

        let cp = this.html.charCodeAt(this.pos);

        //NOTE: all U+000D CARRIAGE RETURN (CR) characters must be converted to U+000A LINE FEED (LF) characters
        if (cp === $.CARRIAGE_RETURN) {
            this.isEol = true;
            this.skipNextNewLine = true;
            return $.LINE_FEED;
        }

        //NOTE: any U+000A LINE FEED (LF) characters that immediately follow a U+000D CARRIAGE RETURN (CR) character
        //must be ignored.
        if (cp === $.LINE_FEED) {
            this.isEol = true;

            if (this.skipNextNewLine) {
                // `line` will be bumped again in the recursive call.
                this.line--;
                this.skipNextNewLine = false;
                this._addGap();
                return this.advance();
            }
        }

        this.skipNextNewLine = false;

        if (isSurrogate(cp)) {
            cp = this._processSurrogate(cp);
        }

        //OPTIMIZATION: first check if code point is in the common allowed
        //range (ASCII alphanumeric, whitespaces, big chunk of BMP)
        //before going into detailed performance cost validation.
        const isCommonValidRange =
            this.handler.onParseError === null ||
            (cp > 0x1f && cp < 0x7f) ||
            cp === $.LINE_FEED ||
            cp === $.CARRIAGE_RETURN ||
            (cp > 0x9f && cp < 0xfd_d0);

        if (!isCommonValidRange) {
            this._checkForProblematicCharacters(cp);
        }

        return cp;
    }

    private _checkForProblematicCharacters(cp: number): void {
        if (isControlCodePoint(cp)) {
            this._err(ERR.controlCharacterInInputStream);
        } else if (isUndefinedCodePoint(cp)) {
            this._err(ERR.noncharacterInInputStream);
        }
    }

    public retreat(count: number): void {
        this.pos -= count;

        while (this.pos < this.lastGapPos) {
            this.lastGapPos = this.gapStack.pop()!;
            this.pos--;
        }

        this.isEol = false;
    }
}
