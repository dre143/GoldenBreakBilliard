// Tiny shared store for live collections. Views subscribe with on(key, fn).
export const state = {
  user: null,
  tables: [],
  products: [],
  users: [],
  restocks: [],
  loaded: {},
};

const subs = {};

export function on(key, fn) {
  (subs[key] ||= new Set()).add(fn);
  return () => subs[key].delete(fn);
}

export function emit(key) {
  subs[key]?.forEach((fn) => {
    try { fn(state[key]); } catch (err) { console.error(err); }
  });
}

export function set(key, value) {
  state[key] = value;
  state.loaded[key] = true;
  emit(key);
}

export function reset() {
  state.user = null;
  state.tables = [];
  state.products = [];
  state.users = [];
  state.restocks = [];
  state.loaded = {};
}
