import { createState, parseBackup, STORAGE_KEY } from './domain.js';

export function loadState(storage = localStorage) {
  try {
    const raw = storage.getItem(STORAGE_KEY);
    return { state: raw ? parseBackup(raw) : createState(), error: null };
  } catch (error) {
    return { state: createState(), error: `Saved data could not be loaded: ${error.message} Import a backup or reset to begin again.` };
  }
}

export function saveState(state, storage = localStorage) {
  try { storage.setItem(STORAGE_KEY, JSON.stringify(state)); }
  catch { throw new Error('Browser storage is unavailable or full. Export a backup before clearing storage. Your last saved state is unchanged.'); }
}
