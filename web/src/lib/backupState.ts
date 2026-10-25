export type BackupState = Record<string, string>;
export const backupStateKey = (key: string) => /^musike:(cues:v1|loops|cue-bank|midi:[\w:-]+)$/.test(key) || /^ytbm_cues_[\w:.-]+$/.test(key);

function validCues(value: string): boolean {
  try {
    const tracks = JSON.parse(value);
    if (!tracks || typeof tracks !== 'object' || Array.isArray(tracks)) return false;
    return Object.entries(tracks).every(([track, banks]) => !['__proto__','constructor','prototype'].includes(track) && !!banks && typeof banks === 'object' && !Array.isArray(banks) &&
      Object.entries(banks).every(([bank, pads]) => /^[A-J]$/.test(bank) && !!pads && typeof pads === 'object' && !Array.isArray(pads) &&
        Object.entries(pads).every(([pad, time]) => /^(?:[1-9]|1[0-6])$/.test(pad) && typeof time === 'number' && Number.isFinite(time) && time >= 0)));
  } catch { return false; }
}

export function cleanBackupState(value: unknown): BackupState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Invalid cue/settings backup');
  const state: BackupState = {};
  for (const [key, text] of Object.entries(value)) {
    if (!backupStateKey(key)) continue;
    if (typeof text !== 'string' || text.length > 8 * 1024 * 1024) throw Error(`Invalid saved state: ${key}`);
    if (key === 'musike:cues:v1' && !validCues(text)) throw Error('Invalid cue-bank backup');
    if (key === 'musike:loops') {
      let loops;
      try {loops=JSON.parse(text);} catch {throw Error('Invalid loop backup');}
      if (!loops || typeof loops !== 'object' || Array.isArray(loops) || !Object.entries(loops).every(([track, loop]: [string, any]) =>
        !['__proto__','constructor','prototype'].includes(track) && loop && typeof loop === 'object' && !Array.isArray(loop) && typeof loop.on === 'boolean' &&
        [loop.from,loop.to].every(time=>time===null||(typeof time==='number'&&Number.isFinite(time)&&time>=0)))) throw Error('Invalid loop backup');
    }
    if (key === 'musike:cue-bank' && !/^[A-J]$/.test(text)) throw Error('Invalid selected cue bank');
    state[key] = text;
  }
  return state;
}

export function captureBackupState(storage: Storage = localStorage): BackupState {
  return cleanBackupState(Object.fromEntries(Array.from({length: storage.length}, (_, index) => storage.key(index)!)
    .filter(key => key && backupStateKey(key)).map(key => [key, storage.getItem(key)])));
}

export function restoreBackupState(value: unknown, mode: 'merge' | 'replace', storage: Storage = localStorage) {
  const state = cleanBackupState(value); // Validate the entire state before writing anything.
  for (const [key, text] of Object.entries(state)) {
    const previous = storage.getItem(key);
    if (mode === 'merge' && previous !== null) {
      if (key === 'musike:loops') {
        cleanBackupState({[key]:previous});
        storage.setItem(key,JSON.stringify({...JSON.parse(text),...JSON.parse(previous)}));
      }
      if (key === 'musike:cues:v1') {
        if (!validCues(previous)) throw Error('Existing cue data is damaged; export it before replacing');
        const current = JSON.parse(previous), incoming = JSON.parse(text);
        for (const [track, banks] of Object.entries(incoming)) {
          const merged = {...(banks as Record<string, unknown>)};
          for (const [bank, pads] of Object.entries(current[track] || {})) merged[bank] = {...(merged[bank] as object || {}), ...(pads as object)};
          current[track] = merged;
        }
        storage.setItem(key, JSON.stringify(current));
      }
      continue;
    }
    storage.setItem(key, text);
  }
}
