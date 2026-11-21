// Fast csv-reader: the same reading of {text, header} -> {columns, rows, errors} as
// csv-reader 1.0.0, but built on slices and indexOf instead of one character at a time.
//
// Policy (from the bounty rules):
//   - a U+FEFF at the very start of the text is dropped;
//   - a record ends at LF or CRLF, and a line left with no characters is no record;
//   - outside a quoted field a CR not followed by LF is dropped (stray_cr);
//   - a field that opens with a quote runs to the next quote that is not doubled, "" inside
//     it one quote and each CRLF or lone CR inside it read as LF; what follows its closing
//     quote, up to the next comma or line break, is appended as it stands (quote_junk, when
//     the field ends); a quote that never closes is a literal character, and the text after
//     it is read again as unquoted (unterminated_quote);
//   - a quote inside an unquoted field is a literal character; fields stay strings, never
//     trimmed or converted;
//   - columns is the first record when header is true, else null; rows holds the records
//     after it (every record when header is false), each padded with "" (short_row, with
//     fields: its count) or cut (long_row, with extra: the cut fields) to the first record's
//     width;
//   - each error is {code, line, row}: line the 1-based line its record starts on (every LF,
//     CRLF and lone CR inside a quoted field counted), row its record's index in rows (null
//     for the header), in the order met, a field's quote_junk when the field ends and a
//     record's short_row or long_row when the record ends.
//
// Speed: an unquoted field is one slice between the nearest comma and the next line break,
// with stray CRs dropped from the slice in a single pass; a quoted field is one slice up to
// its closing quote, transformed only when doubled quotes or line breaks are present. Field
// results travel in closure variables (fv/fe/fa) instead of a fresh object per field, and the
// next line break is cached per record (nl) so it is not re-scanned for every field.
//
// Pure: no clock, no randomness, no locale, nothing kept from one call to the next.

/** How a field ended: at a comma (the record goes on), at a line break or at the end of the text. */
const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

/** The answer for one case's input, {text, header}: {columns, rows, errors}. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const len = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  let pos = 0; // the next character to read
  let line = 1; // the line that character is on
  if (text.charCodeAt(0) === 0xfeff) pos = 1;

  // The record being read: the line it starts on and the index in rows it takes (null: the header).
  let recordLine = 1;
  let recordRow = null;

  // The field just read: its value, how it ended, and the characters kept by readUnquoted.
  let fv;
  let fe;
  let fa;

  // Cache of the next '\n' in the text, the first one at or after the pos it was read from.
  // It stays valid while pos < nl (nl === -1 means no line break is left at all); once pos
  // reaches or passes it -- a quoted field may have swallowed it -- it is read again.
  // -2 means not read yet.
  let nl = -2;

  function error(code) {
    errors.push({ code, line: recordLine, row: recordRow });
  }

  // Reads unquoted characters onto `value` up to the next comma or line break. The field is
  // found in one slice: the nearest comma, or the cached next line break, ends it, and a `\r`
  // inside the slice is dropped -- a trailing one before a `\n` delimiter is the CRLF line
  // break, every other one is a stray_cr. Sets fv, fe and fa (the characters kept).
  function readUnquoted(value) {
    if (nl === -2 || (nl !== -1 && pos >= nl)) nl = text.indexOf('\n', pos);
    const comma = text.indexOf(',', pos);
    let end;
    let ended;
    if (comma === -1 && nl === -1) {
      end = len;
      ended = END;
    } else if (nl === -1 || (comma !== -1 && comma < nl)) {
      end = comma;
      ended = COMMA;
    } else {
      end = nl;
      ended = LINE_BREAK;
    }
    const raw = text.slice(pos, end);
    const cr = raw.indexOf('\r');
    if (cr === -1) {
      fv = value + raw;
      fa = raw.length;
    } else {
      // All stray CRs in the field are handled in the slice at once.
      let out = '';
      let start = 0;
      let i = cr;
      while (i !== -1) {
        out += raw.slice(start, i);
        if (!(i === raw.length - 1 && ended === LINE_BREAK)) error('stray_cr');
        start = i + 1;
        i = raw.indexOf('\r', start);
      }
      out += raw.slice(start);
      fv = value + out;
      fa = out.length;
    }
    if (ended === COMMA) {
      pos = end + 1;
    } else if (ended === LINE_BREAK) {
      pos = end + 1;
      line += 1;
    } else {
      pos = end;
    }
    fe = ended;
  }

  // Reads a quoted field whose opening quote is at pos. Sets fv and fe.
  function readQuoted() {
    const open = pos;
    const openLine = line;
    pos += 1;
    // The closing quote is the next `"` that is not doubled: skip each `""` pair.
    let scan = pos;
    let closedAt = -1;
    while (true) {
      const q = text.indexOf('"', scan);
      if (q === -1) break;
      if (text[q + 1] === '"') {
        scan = q + 2;
        continue;
      }
      closedAt = q;
      break;
    }
    if (closedAt === -1) {
      // The quote never closes: it is a literal character, and the text after it is read
      // again as unquoted.
      pos = open + 1;
      line = openLine;
      error('unterminated_quote');
      readUnquoted('"');
      return;
    }
    const raw = text.slice(pos, closedAt);
    let value;
    if (raw.indexOf('\r') === -1 && raw.indexOf('\n') === -1) {
      // No line breaks inside: only doubled quotes need turning into one.
      value = raw.indexOf('"') === -1 ? raw : raw.replace(/""/g, '"');
    } else {
      // CRLF counts once, a lone CR once, an LF once.
      const breaks = raw.match(/\r\n?|\n/g);
      line += breaks.length;
      value = raw.replace(/\r\n?/g, '\n');
      if (value.indexOf('"') !== -1) value = value.replace(/""/g, '"');
    }
    pos = closedAt + 1;
    if (pos >= len) {
      fv = value;
      fe = END;
      return;
    }
    const c = text[pos];
    if (c === ',') {
      pos += 1;
      fv = value;
      fe = COMMA;
      return;
    }
    if (c === '\n') {
      pos += 1;
      line += 1;
      fv = value;
      fe = LINE_BREAK;
      return;
    }
    if (c === '\r' && text[pos + 1] === '\n') {
      pos += 2;
      line += 1;
      fv = value;
      fe = LINE_BREAK;
      return;
    }
    // What follows the closing quote is appended as it stands, up to the next comma or line break.
    readUnquoted(value);
    if (fa > 0) error('quote_junk');
  }

  while (true) {
    // Lines with no characters are no records.
    while (pos < len) {
      if (text[pos] === '\n') {
        pos += 1;
        line += 1;
      } else if (text[pos] === '\r' && text[pos + 1] === '\n') {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= len) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;
    const fields = [];
    let quoted;
    do {
      quoted = text[pos] === '"';
      if (quoted) readQuoted();
      else readUnquoted('');
      fields.push(fv);
    } while (fe === COMMA);

    // A line that held only stray CRs is left with no characters: no record (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !quoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
