// Thermal receipt printer (58mm / 80mm ESC/POS), ported from the Marimar Inn app.
//
// Three ways to reach a printer from the browser:
//   bluetooth — Web Bluetooth (BLE printers; Chrome/Edge on Android, Windows, macOS)
//   serial    — Web Serial (USB or serial-cabled printers; Chrome/Edge on a computer)
//   rawbt     — the free RawBT Android app, for cheap printers that use classic Bluetooth, which no
//               browser can talk to directly. The page hands RawBT the print job; RawBT prints it.
//
// Receipts are built as raw ESC/POS bytes by EscPosBuilder below (not a library), so the same code
// works on cheap no-name clones: plain ASCII, "P" instead of "₱", and the minimum set of commands.
// Every receipt can also be previewed on screen as the exact lines the printer will get.
import { round2, PRICING } from './billing.js';
import { HALL_TZ } from './clock.js';

const STORAGE_KEY = 'goldenbreak:thermal-printer';
const PAPER_KEY = 'goldenbreak:thermal-paper-width';
const SIDE_MARGIN = 3;
const HALL = 'Golden Break Billiard Hall';

/* ---------- ESC/POS bytes ---------- */

const ASCII_MAP = { '₱': 'P', 'ñ': 'n', 'Ñ': 'N', '—': '-', '–': '-', '−': '-', '’': "'", '‘': "'", '“': '"', '”': '"', '·': '-', '×': 'x' };

function toPrinterAscii(value) {
  return String(value ?? '').replace(/[^\x20-\x7E]/g, (ch) => ASCII_MAP[ch] ?? (ch.normalize('NFKD').replace(/[^\x20-\x7E]/g, '') || '?'));
}

/**
 * Builds the byte stream for one print job and, alongside it, the on-screen preview lines.
 * Cheap ESC/POS clones choke on library code-page tables, so only the basic commands are used.
 */
class EscPosBuilder {
  constructor(leftMargin = SIDE_MARGIN) {
    this.bytes = [];
    this.alignment = 'left';
    this.leftMargin = leftMargin;
    this.preview = [];
  }

  push(...b) { this.bytes.push(...b); return this; }

  initialize() {
    this.alignment = 'left';
    this.push(0x1b, 0x40); // reset
    this.push(0x1c, 0x2e); // FS . cancel Chinese mode, or some clones print ASCII blank
    this.push(0x1b, 0x74, 0x00); // code page PC437
    this.push(0x1b, 0x4d, 0x00); // font A
    this.push(0x1b, 0x45, 0x01); // bold (darker on weak print heads)
    return this;
  }

  align(value) {
    this.alignment = value;
    return this.push(0x1b, 0x61, value === 'center' ? 1 : value === 'right' ? 2 : 0);
  }

  bold(on = true) { return this.push(0x1b, 0x45, on ? 1 : 0); }

  text(value) {
    const ascii = toPrinterAscii(value);
    for (let i = 0; i < ascii.length; i++) this.bytes.push(ascii.charCodeAt(i));
    return this;
  }

  line(value) {
    const padded = this.alignment === 'left' && this.leftMargin > 0 ? `${' '.repeat(this.leftMargin)}${value}` : value;
    this.preview.push({ align: this.alignment, text: toPrinterAscii(padded) });
    return this.text(padded).feed();
  }

  newline() {
    this.preview.push({ align: this.alignment, text: '' });
    return this.feed();
  }

  feed() { return this.push(0x0d, 0x0a); }

  /** GS V 65: feed a little, then cut (the "cut now" variant can slice off the last lines on clones). */
  cut() { return this.push(0x0d, 0x0a, 0x0d, 0x0a, 0x1d, 0x56, 0x41, 0x03); }

  finish() { return this.newline().newline().newline().cut(); }

  encode() { return Uint8Array.from(this.bytes); }
}

/* ---------- layout helpers ---------- */

/** Usable characters per line: 58mm paper ≈ 32, 80mm ≈ 48, minus the same margin on each side. */
const layoutWidth = (paperWidth) => Math.max(20, paperWidth - SIDE_MARGIN * 2);

/** Thermal code pages don't have ₱, so money prints as "P123.00". */
const money = (n) => `P${round2(Number(n) || 0).toFixed(2)}`;

/** Label left, amount right. The label is clipped if needed; the amount never is. */
function twoColumn(label, value, width) {
  label = toPrinterAscii(label);
  value = toPrinterAscii(value);
  const maxLabel = Math.max(1, width - value.length - 1);
  const clipped = label.length > maxLabel ? `${label.slice(0, Math.max(0, maxLabel - 3))}...` : label;
  return `${clipped}${' '.repeat(Math.max(1, width - clipped.length - value.length))}${value}`;
}

const clampLine = (text, width) => {
  const t = toPrinterAscii(text);
  return t.length > width ? `${t.slice(0, Math.max(0, width - 3))}...` : t;
};

const refNo = (id) => String(id || '').slice(-6).toUpperCase();
const firstName = (name) => String(name || '').trim().split(/\s+/)[0] || 'Staff';
const when = (ts) => new Date(ts).toLocaleString('en-PH', { timeZone: HALL_TZ, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const clock = (ts) => new Date(ts).toLocaleTimeString('en-PH', { timeZone: HALL_TZ, hour: 'numeric', minute: '2-digit' });
function played(ms) {
  const m = Math.ceil((ms || 0) / 60000);
  return m >= 60 ? `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m` : `${m}m`;
}

/* ---------- printer state ---------- */

const state = { kind: null, name: null, paperWidth: readPaperWidth() };
const listeners = new Set();
const emit = () => listeners.forEach((fn) => fn({ ...state }));

export function subscribePrinter(fn) {
  listeners.add(fn);
  fn({ ...state });
  return () => listeners.delete(fn);
}
export const getPrinterState = () => ({ ...state });

export const supports = {
  bluetooth: () => typeof navigator !== 'undefined' && 'bluetooth' in navigator,
  serial: () => typeof navigator !== 'undefined' && 'serial' in navigator,
  android: () => /Android/i.test(navigator.userAgent || ''),
};

function readPaperWidth() {
  try {
    const raw = localStorage.getItem(PAPER_KEY);
    if (raw === '32' || raw === '48') return Number(raw);
  } catch { /* storage blocked: default to 58mm */ }
  return 32;
}

export function setPaperWidth(width) {
  state.paperWidth = width === 48 ? 48 : 32;
  try { localStorage.setItem(PAPER_KEY, String(state.paperWidth)); } catch { /* ignore */ }
  emit();
}

function loadStored() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) || null; } catch { return null; }
}
function saveStored(device) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(device)); } catch { /* ignore */ }
}

/* ---------- Bluetooth (BLE) ---------- */

// Known BLE thermal printers: branded ones first, then a generic fallback that matches most no-name
// 58/80mm ESC/POS clones by their print service UUID.
const BLE_PROFILES = [
  { filters: [{ namePrefix: 'TM-P' }], service: '49535343-fe7d-4ae5-8fa9-9fafd205e455', characteristic: '49535343-8841-43f4-a8d4-ecbe34729bb3' },
  { filters: [{ namePrefix: 'STAR L' }], service: '49535343-fe7d-4ae5-8fa9-9fafd205e455', characteristic: '49535343-8841-43f4-a8d4-ecbe34729bb3' },
  { filters: [{ name: 'BlueTooth Printer', services: ['000018f0-0000-1000-8000-00805f9b34fb'] }], service: '000018f0-0000-1000-8000-00805f9b34fb', characteristic: '00002af1-0000-1000-8000-00805f9b34fb' },
  { filters: [{ name: 'Printer001', services: ['000018f0-0000-1000-8000-00805f9b34fb'] }], service: '000018f0-0000-1000-8000-00805f9b34fb', characteristic: '00002af1-0000-1000-8000-00805f9b34fb' },
  { filters: [{ name: 'MPT-II', services: ['000018f0-0000-1000-8000-00805f9b34fb'] }], service: '000018f0-0000-1000-8000-00805f9b34fb', characteristic: '00002af1-0000-1000-8000-00805f9b34fb' },
  { filters: [{ services: ['000018f0-0000-1000-8000-00805f9b34fb'] }], service: '000018f0-0000-1000-8000-00805f9b34fb', characteristic: '00002af1-0000-1000-8000-00805f9b34fb' },
];

let ble = null; // { device, characteristic, withoutResponse }

function onDisconnected() {
  ble = null;
  serial = null;
  state.kind = null;
  state.name = null;
  emit();
}

async function connectBle(device) {
  if (!device.gatt) throw new Error('This device has no Bluetooth print service.');
  device.addEventListener('gattserverdisconnected', onDisconnected);
  const server = await device.gatt.connect();
  let lastError;
  for (const profile of BLE_PROFILES) {
    try {
      const service = await server.getPrimaryService(profile.service);
      const characteristic = await service.getCharacteristic(profile.characteristic);
      // Many clones only accept "write without response"; match the write mode to what the
      // characteristic advertises instead of guessing.
      const withoutResponse = characteristic.properties.writeWithoutResponse && !characteristic.properties.write;
      ble = { device, characteristic, withoutResponse };
      state.kind = 'bluetooth';
      state.name = device.name || 'Bluetooth printer';
      saveStored({ kind: 'bluetooth', id: device.id, name: state.name });
      emit();
      return;
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError instanceof Error ? lastError : new Error('No printer service found on this device.');
}

/** Call from a click: the browser only opens its device picker on a user gesture. */
export async function connectBluetooth() {
  if (!supports.bluetooth()) throw new Error('This browser can’t use Bluetooth printers. Use Chrome or Edge.');
  const device = await navigator.bluetooth.requestDevice({
    filters: BLE_PROFILES.flatMap((p) => p.filters),
    optionalServices: [...new Set(BLE_PROFILES.map((p) => p.service))],
  });
  await connectBle(device);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A single BLE write often fails once on cheap printers and works a moment later, so retry. */
async function withRetry(write) {
  let lastError;
  for (let attempt = 0; attempt <= 3; attempt++) {
    try { await write(); return; } catch (err) { lastError = err; if (attempt < 3) await sleep(200 * (attempt + 1)); }
  }
  throw lastError;
}

async function writeBle(printer, data) {
  const c = printer.characteristic;
  for (let offset = 0; offset < data.length; offset += 100) {
    const chunk = data.subarray(offset, offset + 100);
    if (printer.withoutResponse && c.writeValueWithoutResponse) {
      await withRetry(() => c.writeValueWithoutResponse(chunk));
      await sleep(20); // no flow control: pace chunks so the printer's small buffer keeps up
    } else if (!printer.withoutResponse && c.writeValueWithResponse) {
      await withRetry(() => c.writeValueWithResponse(chunk));
    } else if (c.writeValue) {
      await withRetry(() => c.writeValue(chunk));
      await sleep(20);
    } else {
      throw new Error('This browser’s Bluetooth support is too old to print.');
    }
  }
}

/* ---------- USB / Serial ---------- */

let serial = null; // SerialPort

async function openSerial(port) {
  await port.open({ baudRate: 9600 });
  serial = port;
  const info = port.getInfo?.() || {};
  state.kind = 'serial';
  state.name = 'USB printer';
  saveStored({ kind: 'serial', vendorId: info.usbVendorId, productId: info.usbProductId });
  emit();
}

/** Call from a click: the browser only opens its port picker on a user gesture. */
export async function connectSerial() {
  if (!supports.serial()) throw new Error('This browser can’t use USB printers. Use Chrome or Edge on a computer.');
  await openSerial(await navigator.serial.requestPort());
}

async function writeSerial(port, data) {
  const writer = port.writable.getWriter();
  try { await writer.write(data); } finally { writer.releaseLock(); }
}

if (typeof navigator !== 'undefined' && navigator.serial) {
  navigator.serial.addEventListener('disconnect', (e) => { if (e.target === serial) onDisconnected(); });
}

/* ---------- Golden Break tablet app (android-app/) ----------
 * Inside the tablet app, the page gets a native Bluetooth bridge (window.GoldenBreakNativePrinter, see
 * PrinterBridge.kt). It prints over classic Bluetooth, which browsers can't do, so cheap 58mm printers
 * work with no RawBT: pair the printer once in Android Settings, then tap it in the printer panel.
 */

function nativeBridge() {
  const bridge = typeof window !== 'undefined' ? window.GoldenBreakNativePrinter : null;
  try { return bridge && bridge.isNative() ? bridge : null; } catch { return null; }
}

export const isNativeApp = () => Boolean(nativeBridge());

const PRINTER_NAME_HINT = /printer|print|pos|rpp|mtp|xprinter|xp-|zjiang|jp58|jp-|thermal|gp-|58mm|80mm/i;

/** Bluetooth devices paired in Android Settings, printer-looking ones only (or all if none match). */
export function listNativePrinters() {
  const bridge = nativeBridge();
  if (!bridge) return [];
  try {
    const all = JSON.parse(bridge.listPairedJson()).filter((d) => d?.id && d?.name);
    const printers = all.filter((d) => PRINTER_NAME_HINT.test(d.name));
    return printers.length ? printers : all;
  } catch { return []; }
}

export function connectNative(device) {
  const bridge = nativeBridge();
  if (!bridge) throw new Error('Open Golden Break from the tablet app to print over Bluetooth.');
  const result = String(bridge.connect(device.id) ?? '');
  if (result !== 'ok') throw new Error(result || 'Couldn’t connect to the printer.');
  state.kind = 'native';
  state.name = device.name;
  saveStored({ kind: 'native', id: device.id, name: device.name });
  emit();
}

function sendNative(bridge, data) {
  let binary = '';
  for (let i = 0; i < data.length; i++) binary += String.fromCharCode(data[i]);
  const result = String(bridge.writeBase64(btoa(binary)) ?? '').trim();
  if (result !== 'ok') throw new Error(result || 'The printer didn’t accept the job.');
}

/* ---------- RawBT (Android app for classic-Bluetooth printers) ---------- */

/** Nothing to negotiate: RawBT pairs with the printer itself. We only remember to send jobs there. */
export function connectRawBt() {
  state.kind = 'rawbt';
  state.name = 'RawBT app';
  saveStored({ kind: 'rawbt' });
  emit();
}

function sendViaRawBt(data) {
  let binary = '';
  for (let i = 0; i < data.length; i++) binary += String.fromCharCode(data[i]);
  // Android Chrome blocks window.open() of intent: URLs; an iframe src reaches the RawBT handler.
  const iframe = document.createElement('iframe');
  iframe.setAttribute('aria-hidden', 'true');
  iframe.style.display = 'none';
  iframe.src = `intent:base64,${btoa(binary)}#Intent;scheme=rawbt;package=ru.a402d.rawbtprinter;end`;
  document.body.append(iframe);
  setTimeout(() => iframe.remove(), 4000);
}

/* ---------- connection lifecycle ---------- */

let reconnecting = null;

/** Quietly reconnect to the last printer on app load, if the browser kept the permission. */
export function tryReconnect() {
  if (state.kind || reconnecting) return reconnecting;
  reconnecting = (async () => {
    const stored = loadStored();
    // In the tablet app, reconnect to the saved printer (or the only paired printer) over native Bluetooth.
    if (isNativeApp()) {
      const paired = listNativePrinters();
      const pick = paired.find((d) => d.id === stored?.id) || (stored?.kind === 'native' ? null : paired.length === 1 ? paired[0] : null);
      try { if (pick) connectNative(pick); } catch { /* printer off: stay disconnected */ }
      return;
    }
    if (!stored) return;
    try {
      if (stored.kind === 'rawbt') connectRawBt();
      else if (stored.kind === 'bluetooth' && navigator.bluetooth?.getDevices) {
        const device = (await navigator.bluetooth.getDevices()).find((d) => d.id === stored.id);
        if (device) await connectBle(device);
      } else if (stored.kind === 'serial' && navigator.serial?.getPorts) {
        const ports = await navigator.serial.getPorts();
        const port = ports.find((p) => {
          const i = p.getInfo?.() || {};
          return i.usbVendorId === stored.vendorId && i.usbProductId === stored.productId;
        }) || ports[0];
        if (port) await openSerial(port);
      }
    } catch { /* permission not kept or printer off: stay disconnected */ }
  })().finally(() => { reconnecting = null; });
  return reconnecting;
}

export function disconnectPrinter() {
  if (state.kind === 'native') { try { nativeBridge()?.disconnect(); } catch { /* already gone */ } }
  try { if (ble?.device.gatt?.connected) ble.device.gatt.disconnect(); } catch { /* already gone */ }
  try { serial?.close(); } catch { /* already closed */ }
  onDisconnected();
}

/** Disconnect and forget the saved printer so it won't reconnect by itself. */
export async function forgetPrinter() {
  const device = ble?.device;
  disconnectPrinter();
  try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
  try { await device?.forget?.(); } catch { /* browser kept the grant */ }
}

export function printerErrorMessage(err) {
  if (err?.name === 'NotFoundError') return 'No printer was chosen.';
  return err?.message || 'The thermal printer didn’t respond.';
}

async function send(data) {
  const bridge = state.kind === 'native' ? nativeBridge() : null;
  if (bridge) { sendNative(bridge, data); return; }
  if (state.kind === 'rawbt') { sendViaRawBt(data); return; }
  let job;
  if (state.kind === 'bluetooth' && ble) job = writeBle(ble, data);
  else if (state.kind === 'serial' && serial) job = writeSerial(serial, data);
  else throw new Error('No thermal printer connected. Use the printer button in the sidebar.');
  await Promise.race([job, sleep(45000).then(() => { throw new Error('The printer didn’t respond in time.'); })]);
}

/* ---------- receipts ---------- */

/** Customer receipt for one sale (table or walk-in). */
function saleReceipt(tx) {
  const width = layoutWidth(state.paperWidth);
  const e = new EscPosBuilder();
  e.initialize().align('center')
    .line(HALL)
    .line('This is not an official receipt')
    .line(`Ref: ${refNo(tx.id)}`)
    .newline()
    .align('left');

  if (tx.kind === 'prepay') {
    e.line(twoColumn('Table', tx.tableName, width))
      .line(twoColumn('Booking payment', `${played(tx.paidFromMs)} to ${played(tx.paidToMs)}`, width))
      .line(twoColumn('of booked', played(tx.plannedMs), width))
      .newline()
      .line(twoColumn('Amount paid', money(tx.tableFee), width));
  } else if (tx.kind === 'refund') {
    e.line(twoColumn('Table', tx.tableName, width))
      .line(clampLine('Booking cancelled - refund', width))
      .newline()
      .line(twoColumn('Refunded', money(-tx.tableFee), width));
  } else if (tx.tableId) {
    e.line(twoColumn('Table', tx.tableName, width))
      .line(`In:  ${when(tx.startedAt)}`)
      .line(`Out: ${when(tx.endedAt)}`)
      .line(twoColumn('Played', played(tx.durationMs), width));
    if (tx.plannedMs) e.line(twoColumn('Booked', played(tx.plannedMs), width));
    e.newline();
    if (tx.gameCancelled) {
      e.line(twoColumn('Table fee', 'P0.00', width)).line(clampLine('  Game cancelled - no charge', width));
    } else {
      e.line(twoColumn('Table fee', money(tx.tableFee), width));
      if (tx.prepaidAmount) e.line(twoColumn('  Already paid', money(tx.prepaidAmount), width));
    }
  } else {
    e.line(twoColumn('Sale', 'Walk-in', width)).line(when(tx.createdAt)).newline();
  }

  for (const i of tx.items || []) e.line(twoColumn(`${i.qty}x ${i.name}`, money(i.total ?? i.price * i.qty), width));

  const verb = tx.kind === 'refund' ? 'Refunded' : 'Paid';
  e.newline().line(twoColumn('TOTAL', money(tx.total), width));
  if (tx.method === 'split' && tx.payments) {
    e.line(twoColumn(`${verb} (Cash)`, money(tx.payments.cash), width))
      .line(twoColumn(`${verb} (QRPH)`, money(tx.payments.gcash), width));
  } else if (tx.method === 'none') {
    e.line(twoColumn('Paid', 'No charge', width));
  } else {
    e.line(twoColumn(`${verb} (${tx.method === 'gcash' ? 'QRPH' : 'Cash'})`, money(Math.abs(tx.tendered ?? tx.total)), width));
  }
  if (tx.gcashRef) e.line(twoColumn('QRPH ref (last 5)', tx.gcashRef, width));
  if (tx.change > 0) e.line(twoColumn('Change', money(tx.change), width));

  e.newline().align('center')
    .line(`Cashier: ${firstName(tx.cashierName)}`)
    .newline()
    .line('Thank you! Come play again.')
    .finish();
  return e;
}

export const previewSaleReceipt = (tx) => saleReceipt(tx).preview;
export const printSaleReceipt = (tx) => send(saleReceipt(tx).encode());

/**
 * Start ticket for a table just opened: a courtesy slip for the customer to keep and hand back to the
 * cashier at checkout. No charges are known yet, so this is deliberately not a receipt — the actual
 * bill is only ever computed at checkout, from the stored start/end stamps.
 */
function startTicket({ tableName, plannedMs, startedAtMs, cashierName }) {
  const width = layoutWidth(state.paperWidth);
  const e = new EscPosBuilder();
  e.initialize().align('center')
    .line(HALL)
    .line('Start ticket - not a receipt')
    .line('Please keep and show at checkout')
    .newline()
    .align('left')
    .line(twoColumn('Table', tableName, width))
    .line(`In: ${when(startedAtMs)}`)
    .line(twoColumn(plannedMs ? 'Booked' : 'Mode', plannedMs ? played(plannedMs) : 'Open time', width))
    .newline()
    .line(`${money(PRICING.basePrice)} first hour (5-min grace)`)
    .line(`then ${money(PRICING.bracketPrice)} every ${PRICING.bracketMinutes} min`)
    .newline().align('center')
    .line(`Opened by: ${firstName(cashierName)}`)
    .newline()
    .line('Enjoy your game!')
    .finish();
  return e;
}

export const previewStartTicket = (ticket) => startTicket(ticket).preview;
export const printStartTicket = (ticket) => send(startTicket(ticket).encode());

/**
 * The Daily Sales Report on thermal paper. The on-screen sheet has 12 columns, far too wide for
 * 32–48 characters, so this is a compact layout: one short block per sale, then the cash summary.
 * data = { dateLabel, timeLabel, shiftLabel, txs, expenses, totals } (totals from reporting.totals).
 */
function dailySalesReceipt({ dateLabel, timeLabel, shiftLabel, txs, expenses, totals: t }) {
  const width = layoutWidth(state.paperWidth);
  const rule = '-'.repeat(width);
  const e = new EscPosBuilder();
  e.initialize().align('center')
    .line(HALL)
    .line('Daily Sales Report')
    .line(clampLine(dateLabel, width))
    .line(clampLine(`Time: ${timeLabel}`, width));
  if (shiftLabel) e.line(clampLine(shiftLabel, width));
  e.align('left').newline().line(rule);

  if (!txs.length) {
    e.align('center').line('No sales.').align('left');
  } else {
    for (const x of [...txs].sort((a, b) => a.createdAt - b.createdAt)) {
      e.line(twoColumn(`${x.tableId ? x.tableName : 'Walk-in'}  ${refNo(x.id)}`, clock(x.createdAt), width));
      if (x.kind === 'prepay') {
        e.line(twoColumn('  Booking payment', money(x.tableFee), width));
      } else if (x.kind === 'refund') {
        e.line(twoColumn('  Booking refund', money(x.tableFee), width));
      } else if (x.tableId) {
        e.line(twoColumn(`  Table ${played(x.durationMs)}`, x.gameCancelled ? 'cancelled' : money(x.tableFee), width));
      }
      if (x.productTotal) e.line(twoColumn('  Items', money(x.productTotal), width));
      const method = x.method === 'split' ? 'Split' : x.method === 'gcash' ? 'QRPH' : x.method === 'none' ? 'No charge' : 'Cash';
      e.line(twoColumn(`  Paid (${method})`, money(x.total), width));
      if (x.gcashRef) e.line(clampLine(`    QRPH ref: ${x.gcashRef}`, width));
      e.line(clampLine(`    ${firstName(x.cashierName)}`, width));
    }
    e.line(rule);
  }

  e.bold(true)
    .line(twoColumn('Table total', money(t.tableFee), width))
    .line(twoColumn('Items total', money(t.productTotal), width))
    .bold(false).newline()
    .line(twoColumn('Cash collected', money(t.cash), width));

  if (expenses.length) {
    e.newline().line('Expenses');
    for (const x of expenses) {
      e.line(clampLine(`${clock(x.createdAt)} ${firstName(x.cashierName)}`, width))
        .line(twoColumn(`  ${x.description}`, money(x.amount), width));
    }
    e.line(twoColumn('Expenses total', money(t.expenses), width))
      .line(twoColumn('Net cash', money(t.cashToCount), width));
  }

  e.line(twoColumn('QRPH collected', money(t.gcash), width))
    .line(twoColumn('Total collected', money(t.total), width));
  if (t.expenses > 0) e.line(twoColumn('Net (less exp.)', money(t.net), width));

  e.newline().bold(true).line(twoColumn('OVERALL SALE', money(t.total), width));
  if (t.expenses > 0) e.line(twoColumn('NET SALES', money(t.net), width));
  e.bold(false).newline().newline()
    .line('Prepared by: __________').newline()
    .line('Checked by:  __________').newline()
    .line('Noted by:    __________')
    .cut();
  return e;
}

export const previewDailySales = (data) => dailySalesReceipt(data).preview;
export const printDailySales = (data) => send(dailySalesReceipt(data).encode());

/* ---------- cash drawer ----------
 * The drawer is cabled into the printer's RJ11 "DK" port and opens when the printer gets an ESC p pulse.
 * Same kick as Marimar Inn: pin 5 first, then pin 2 as a second job, because different drawers are
 * wired to different pins. Needs a real connection (Bluetooth or USB); RawBT only forwards the bytes.
 */
const DRAWER_KEY = 'goldenbreak:cash-drawer-on-cash';

const drawerPulse = (pin) => [0x07, 0x1b, 0x70, pin, 0x32, 0xfa]; // BEL + ESC p m t1 t2

/** "On cash pay" switch (this device only): open the drawer when a payment includes cash. On by default. */
export function isDrawerEnabled() {
  try { return localStorage.getItem(DRAWER_KEY) !== '0'; } catch { return true; }
}
export function setDrawerEnabled(on) {
  try { localStorage.setItem(DRAWER_KEY, on ? '1' : '0'); } catch { /* ignore */ }
  emit();
}

/** Opens the cash drawer through the connected printer. */
export async function openCashDrawer() {
  if (!state.kind) throw new Error('Connect the thermal printer first. The drawer is wired into it.');
  // The tablet app sends both pulses on one Bluetooth connection (PrinterBridge.kickDrawer).
  const bridge = state.kind === 'native' ? nativeBridge() : null;
  if (bridge?.kickDrawer) {
    const result = String(bridge.kickDrawer() ?? '').trim();
    if (result !== 'ok') throw new Error(result || 'The drawer didn’t open.');
    return;
  }
  await send(Uint8Array.from([0x1b, 0x40, ...drawerPulse(1)]));
  try {
    await sleep(700);
    await send(Uint8Array.from(drawerPulse(0)));
  } catch { /* pin 5 already went out; don't fail the sale if pin 2 is ignored */ }
}

/**
 * After a sale: open the drawer only when cash changed hands (a cash or split payment), the printer is
 * connected, and "On cash pay" is on. QRPH-only payments leave it closed. Never throws; returns an
 * error message for the caller to show, or null.
 */
export async function kickDrawerForCash(cashAmount) {
  if (!(cashAmount > 0) || !state.kind || !isDrawerEnabled()) return null;
  try { await openCashDrawer(); return null; } catch (err) { return printerErrorMessage(err); }
}

function testPage() {
  const e = new EscPosBuilder();
  e.initialize().align('center').line(HALL).line('Printer test').newline()
    .align('left').line(new Date().toLocaleString('en-PH', { timeZone: HALL_TZ }))
    .line(`Paper: ${state.paperWidth === 48 ? '80mm' : '58mm'}`)
    .line(twoColumn('Sample line', money(1234.5), layoutWidth(state.paperWidth)))
    .cut();
  return e;
}

export const previewTestPage = () => testPage().preview;
export const printTestPage = () => send(testPage().encode());
