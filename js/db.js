// Picks the backend: Firestore + Firebase Auth when configured, otherwise the local demo backend.
// Both expose the same adapter API (listen, listenDoc, get, add, set, update, transaction, newId).
import { firebaseConfig } from './firebase-config.js';

// Add ?demo to the URL (e.g. http://localhost:5173/?demo) to force the local demo backend even when a
// real Firebase config is present, so local testing never writes to the live database.
const forceDemo = new URLSearchParams(location.search).has('demo');
export const mode = firebaseConfig.apiKey && firebaseConfig.projectId && !forceDemo ? 'firebase' : 'demo';

const backend = mode === 'firebase' ? await import('./db-firebase.js') : await import('./db-demo.js');

export const db = backend.db;
export const auth = backend.auth;
