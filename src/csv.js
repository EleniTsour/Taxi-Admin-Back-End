const FORMULA_PREFIX = /^[=+\-@]/;
const PLAIN_NUMBER = /^-?\d+(?:\.\d+)?$/;

export function csvCell(value) {
  const raw = String(value ?? "");
  const trimmed = raw.trim();
  const safeValue = FORMULA_PREFIX.test(raw.trimStart()) && !PLAIN_NUMBER.test(trimmed) ? `'${raw}` : raw;
  const escaped = safeValue
    .replace(/"/g, '""')
    .replace(/\r?\n/g, " ");
  return `"${escaped}"`;
}

export function toCsv(rows, columnNames) {
  const header = columnNames.map((column) => csvCell(column)).join(",");
  const lines = rows.map((row) => columnNames.map((column) => csvCell(row[column])).join(","));
  return [header, ...lines].join("\r\n");
}
