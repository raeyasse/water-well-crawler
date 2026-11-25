/** Streaming RFC 4180 CSV reader: yields one object per row, keyed by the header row. */
export async function* parseCsv(chunks: AsyncIterable<Uint8Array | string>): AsyncGenerator<Record<string, string>> {
  const decoder = new TextDecoder("utf-8"); // drops a leading BOM
  let header: string[] | undefined;
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let afterQuote = false; // just saw a quote inside a quoted field: escaped quote or end of field
  let started = false;

  const endRow = (): Record<string, string> | undefined => {
    row.push(field);
    field = "";
    const cells = row;
    row = [];
    started = false;
    if (cells.length === 1 && cells[0] === "") return undefined;
    if (!header) {
      header = cells.map((c) => (c.charCodeAt(0) === 0xfeff ? c.slice(1) : c).trim());
      return undefined;
    }
    return Object.fromEntries(header.map((h, i) => [h, cells[i] ?? ""]));
  };

  for await (const chunk of chunks) {
    const text = typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
    for (const c of text) {
      if (afterQuote) {
        afterQuote = false;
        if (c === '"') {
          field += c;
          continue;
        }
        quoted = false;
      }
      if (quoted) {
        if (c === '"') afterQuote = true;
        else field += c;
      } else if (c === '"' && field === "") {
        quoted = true;
        started = true;
      } else if (c === ",") {
        row.push(field);
        field = "";
        started = true;
      } else if (c === "\n") {
        const r = endRow();
        if (r) yield r;
      } else if (c !== "\r") {
        field += c;
        started = true;
      }
    }
  }
  if (started) {
    const r = endRow();
    if (r) yield r;
  }
}
