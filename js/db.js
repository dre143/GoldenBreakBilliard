// Picks the backend: Firestore + Firebase Auth when configured, otherwise the local demo backend.
// Both expose the same adapter API (listen, listenDoc, get, add, set, update, transaction, newId).
import { firebaseConfig } from './firebase-config.js';

export const mode = firebaseConfig.apiKey && firebaseConfig.projectId ? 'firebase' : 'demo';

const backend = mode === 'firebase' ? await import('./db-firebase.js') : await import('./db-demo.js');

export const db = backend.db;
export const auth = backend.auth;
