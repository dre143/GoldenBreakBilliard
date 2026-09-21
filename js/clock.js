// Server-synced "now" for display (timers, countdowns). Billing never trusts this value:
// the stored start/end times are stamped by the server and the fee is re-checked by security rules.
let offsetMs = 0;

/**
 * Write placeholder meaning "the database server's current time". Firestore stores serverTimestamp();
 * the demo backend stores Date.now(). Reads always come back as epoch milliseconds.
 */
export const SERVER_TIME = Object.freeze({ __serverTime: true });
export const isServerTime = (v) => v === SERVER_TIME;

export const setServerOffset = (ms) => { offsetMs = Number.isFinite(ms) ? ms : 0; };
export const serverOffset = () => offsetMs;
export const serverNow = () => Date.now() + offsetMs;

/**
 * The hall's own time: Philippines, UTC+8, no daylight saving. Business days, shifts and every displayed
 * time use this instead of the device's time zone, so a tablet, a phone abroad and a laptop set to another
 * zone all file the same sale under the same day and shift.
 */
export const HALL_TZ = 'Asia/Manila';
export const HALL_OFFSET_MS = 8 * 60 * 60 * 1000;
