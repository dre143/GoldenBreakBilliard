// Formatted .xlsx report export, built on ExcelJS (loaded from a CDN only the first time a report is
// actually exported, so it never slows down the rest of the app — nothing else here needs it).
// A plain .csv opened in Excel is an unstyled grid with Excel's default column widths, which is why
// headers and hall/date text used to get truncated (see the "Possible data loss" warning Excel shows
// on a .csv too). Reports describe their rows with the small builder below — title/section/header/
// row/total, with money() marking a currency cell — instead of a bare array of values, and get back a
// real .xlsx with bold headers on a green band, a peso number format on money cells, readable column
// widths and a shaded totals row.
const CDN = 'https://cdnjs.cloudflare.com/ajax/libs/exceljs/4.4.0/exceljs.min.js';
let loading = null;

function loadExcelJs() {
  if (window.ExcelJS) return Promise.resolve(window.ExcelJS);
  if (loading) return loading;
  loading = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = CDN;
    s.onload = () => resolve(window.ExcelJS);
    s.onerror = () => {
      loading = null;
      reject(new Error('Could not load the Excel export library — check your internet connection and try again.'));
    };
    document.head.append(s);
  });
  return loading;
}

const GREEN = 'FF1F6B4A';
const CREAM = 'FFF4EFE6';
const WHITE = 'FFFFFFFF';
const MUTED = 'FF6B6B6B';
const PESO_FMT = '"₱"#,##0.00;[RED]-"₱"#,##0.00';

const fill = (argb) => ({ type: 'pattern', pattern: 'solid', fgColor: { argb } });
const thinTop = { top: { style: 'thin', color: { argb: 'FF999999' } } };

/** Marks a cell as a peso amount, regardless of which column it lands in on a given row — sections
 * (the main table, the expense log, the summary strip) don't share one column layout, so formatting
 * by tag beats guessing by column index. */
export const money = (v) => ({ __money: true, v: Number(v) || 0 });
const isMoney = (c) => c != null && typeof c === 'object' && c.__money === true;
const plainValue = (c) => (isMoney(c) ? c.v : c);

/** How wide a cell will actually look once rendered — for a money cell that's the formatted "₱1,234.56"
 * string, not the bare number's digit count, which undersizes the column and shows "####" in Excel. */
function displayWidth(c) {
  if (isMoney(c)) {
    const n = c.v;
    return `${n < 0 ? '-' : ''}₱${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`.length;
  }
  return String(plainValue(c) ?? '').length;
}

/**
 * A report's rows, described by kind rather than as a bare grid. Nothing here touches ExcelJS —
 * downloadReportXlsx() below does the styling — so report code stays free of spreadsheet details.
 */
export function reportSheet() {
  const rows = [];
  let cols = 0;
  const add = (cells, kind) => { rows.push({ cells, kind }); cols = Math.max(cols, cells.length); return api; };
  const api = {
    title: (t) => add([t], 'title'),
    subtitle: (t) => add([t], 'subtitle'),
    meta: (...parts) => add(parts.filter((p) => p !== '' && p != null), 'meta'),
    blank: () => add([], 'blank'),
    section: (t) => add([t], 'section'),
    header: (...cells) => add(cells, 'header'),
    row: (...cells) => add(cells, 'row'),
    total: (...cells) => add(cells, 'total'),
    get rows() { return rows; },
    get colCount() { return cols; },
  };
  return api;
}

/** Render a reportSheet() to a styled worksheet and download it as filename. */
export async function downloadReportXlsx(filename, sheetName, sheet) {
  const ExcelJS = await loadExcelJs();
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(sheetName.slice(0, 31) || 'Report');
  const cols = sheet.colCount;
  const widths = Array.from({ length: cols }, () => 8);

  sheet.rows.forEach((r, ri) => {
    const plainCells = r.cells.map(plainValue);
    const row = ws.addRow(plainCells.length ? plainCells : ['']);
    r.cells.forEach((c, ci) => {
      widths[ci] = Math.min(40, Math.max(widths[ci], displayWidth(c) + 2));
      if (isMoney(c)) row.getCell(ci + 1).numFmt = PESO_FMT;
    });
    switch (r.kind) {
      case 'title':
        row.getCell(1).font = { bold: true, size: 16, color: { argb: GREEN } };
        break;
      case 'subtitle':
        row.getCell(1).font = { bold: true, size: 12 };
        break;
      case 'meta':
        row.eachCell({ includeEmpty: false }, (c) => { c.font = { italic: true, size: 10, color: { argb: MUTED } }; });
        break;
      case 'section':
        row.getCell(1).font = { bold: true, size: 11, color: { argb: WHITE } };
        row.getCell(1).fill = fill(GREEN);
        if (cols > 1) ws.mergeCells(ri + 1, 1, ri + 1, cols);
        break;
      case 'header':
        row.eachCell({ includeEmpty: false }, (c) => {
          c.font = { bold: true, size: 10, color: { argb: WHITE } };
          c.fill = fill(GREEN);
          c.alignment = { vertical: 'middle', wrapText: true };
        });
        row.height = 24;
        break;
      case 'total':
        row.eachCell({ includeEmpty: false }, (c) => { c.font = { bold: true }; c.fill = fill(CREAM); c.border = thinTop; });
        break;
      default:
        break;
    }
    if ((r.kind === 'title' || r.kind === 'subtitle') && cols > 1) ws.mergeCells(ri + 1, 1, ri + 1, cols);
  });

  ws.columns = widths.map((wch) => ({ width: wch }));
  // Freeze everything above (and including) the first header row, so column names stay put while
  // scrolling through a long day's transactions — the reason "Table", "Ref #" etc. keep re-scrolling
  // off-screen in a plain .csv.
  const headerRow = sheet.rows.findIndex((r) => r.kind === 'header');
  if (headerRow >= 0) ws.views = [{ state: 'frozen', ySplit: headerRow + 1 }];

  const buf = await wb.xlsx.writeBuffer();
  const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
