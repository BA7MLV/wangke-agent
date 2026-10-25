import { Renderer, type MarkedExtension, type Token, type Tokens } from 'marked';

/** Only the trailing table can still grow; finished tables stay usable during the rest of an answer. */
function trailingTable(tokens: Token[]): Tokens.Table | undefined {
  let last: Token | undefined;
  for (let i = tokens.length - 1; i >= 0; i--) {
    if (tokens[i].type !== 'space') { last = tokens[i]; break; }
  }
  if (!last || /\n[ \t]*\n$/.test(last.raw)) return;
  if (last.type === 'table') return last as Tokens.Table;
  if (last.type === 'blockquote') return trailingTable((last as Tokens.Blockquote).tokens);
  if (last.type === 'list') return trailingTable((last as Tokens.List).items.at(-1)?.tokens ?? []);
}

export function tableExtension(streaming: boolean): MarkedExtension {
  let active: Tokens.Table | undefined;
  return {
    hooks: {
      processAllTokens(tokens) {
        active = streaming ? trailingTable(tokens) : undefined;
        return tokens;
      },
    },
    renderer: {
      table(token) {
        const loading = token === active;
        // Marked pads short rows with empty cells. Cell counts therefore cannot tell us
        // whether the last row has actually arrived; a newline (or stream end) can.
        const pending = loading && token.rows.length > 0 && !token.raw.endsWith('\n');
        return Renderer.prototype.table.call(this, token).replace('<table>',
          `<table data-state="${loading ? 'loading' : 'done'}" data-pending="${pending}">`);
      },
    },
  };
}
