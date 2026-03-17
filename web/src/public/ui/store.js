import { debugRender } from './debug.js';

export function createStore(initialState) {
  const state = initialState;
  const subscribers = new Set();
  let pendingPatch = null;
  let pendingChangedKeys = new Set();
  let scheduled = false;

  function flush() {
    scheduled = false;
    if (!pendingPatch) return;
    const changedKeys = pendingChangedKeys;
    pendingPatch = null;
    pendingChangedKeys = new Set();
    debugRender('store-flush', {
      changedKeys: Array.from(changedKeys)
    });
    subscribers.forEach((subscriber) => {
      if (!subscriber.keys || subscriber.keys.some((key) => changedKeys.has(key))) {
        subscriber.listener(state, changedKeys);
      }
    });
  }

  return {
    state,
    getState() {
      return state;
    },
    setState(partial = {}) {
      if (!partial || typeof partial !== 'object') return;
      Object.assign(state, partial);
      pendingPatch = { ...(pendingPatch || {}), ...partial };
      Object.keys(partial).forEach((key) => pendingChangedKeys.add(key));
      if (scheduled) return;
      scheduled = true;
      queueMicrotask(flush);
    },
    subscribe(keys, listener) {
      const subscriber = {
        keys: Array.isArray(keys) && keys.length ? keys : null,
        listener
      };
      subscribers.add(subscriber);
      return () => subscribers.delete(subscriber);
    }
  };
}
