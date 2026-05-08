import { uid } from './format';

const STORAGE_KEYS = {
  people: 'split-bill-saved-people',
  sessions: 'split-bill-recent-sessions',
  theme: 'split-bill-theme',
  aiSettings: 'split-bill-ai-settings',
  accessSettings: 'split-bill-access-settings',
};

const DEFAULT_AI_SETTINGS = {
  provider: 'custom',
  allowDemoFallback: true,
  prompt:
    'Kamu adalah asisten ekstraksi data resit restoran.\nAnalisis gambar resit ini dan kembalikan JSON valid saja.',
  openrouter: {
    apiKey: '',
    model: 'anthropic/claude-sonnet-4',
    baseUrl: 'https://openrouter.ai/api/v1/chat/completions',
    appName: 'Split Bill App',
    siteUrl: '',
  },
  custom: {
    apiKey: '',
    model: 'gpt-4.1-mini',
    baseUrl: 'https://api.openai.com/v1/chat/completions',
    appName: 'Split Bill App',
    siteUrl: '',
  },
};

const DEFAULT_ACCESS_SETTINGS = {
  role: 'user',
  adminPin: '',
};

function safeRead(key, fallback) {
  if (typeof window === 'undefined') {
    return fallback;
  }

  try {
    const raw = window.localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function safeWrite(key, value) {
  if (typeof window === 'undefined') {
    return;
  }

  window.localStorage.setItem(key, JSON.stringify(value));
}

export function loadSavedPeople() {
  const list = safeRead(STORAGE_KEYS.people, []);
  return Array.isArray(list)
    ? list
        .filter((person) => person?.id && person?.name)
        .sort((a, b) => new Date(b.lastUsed || 0) - new Date(a.lastUsed || 0))
    : [];
}

export function saveSavedPeople(people) {
  const cleaned = people
    .filter((person) => person?.name?.trim())
    .slice(0, 50);

  safeWrite(STORAGE_KEYS.people, cleaned);
  return cleaned;
}

export function addSavedPerson(name, lastUsed = new Date().toISOString()) {
  const normalizedName = name.trim();
  if (!normalizedName) {
    return loadSavedPeople();
  }

  const current = loadSavedPeople();
  const existing = current.find(
    (person) => person.name.toLowerCase() === normalizedName.toLowerCase(),
  );

  const next = existing
    ? current.map((person) =>
        person.id === existing.id ? { ...person, name: normalizedName, lastUsed } : person,
      )
    : [{ id: uid('person'), name: normalizedName, lastUsed }, ...current];

  return saveSavedPeople(
    next
      .sort((a, b) => new Date(b.lastUsed || 0) - new Date(a.lastUsed || 0))
      .slice(0, 50),
  );
}

export function touchSavedPeople(participants) {
  let current = loadSavedPeople();
  const now = new Date().toISOString();

  participants.forEach((participant) => {
    const existing = current.find(
      (person) => person.name.toLowerCase() === participant.name.toLowerCase(),
    );

    if (existing) {
      current = current.map((person) =>
        person.id === existing.id ? { ...person, lastUsed: now } : person,
      );
    } else {
      current.unshift({
        id: participant.id || uid('person'),
        name: participant.name,
        lastUsed: now,
      });
    }
  });

  return saveSavedPeople(
    current
      .sort((a, b) => new Date(b.lastUsed || 0) - new Date(a.lastUsed || 0))
      .slice(0, 50),
  );
}

export function renameSavedPerson(id, name) {
  const current = loadSavedPeople();
  const next = current.map((person) =>
    person.id === id ? { ...person, name: name.trim() || person.name } : person,
  );
  return saveSavedPeople(next);
}

export function removeSavedPerson(id) {
  const current = loadSavedPeople();
  const next = current.filter((person) => person.id !== id);
  return saveSavedPeople(next);
}

export function clearSavedPeople() {
  safeWrite(STORAGE_KEYS.people, []);
  return [];
}

export function loadRecentSessions() {
  const sessions = safeRead(STORAGE_KEYS.sessions, []);
  return Array.isArray(sessions) ? sessions : [];
}

export function saveRecentSession(session) {
  const current = loadRecentSessions();
  const next = [session, ...current.filter((entry) => entry.id !== session.id)].slice(0, 20);
  safeWrite(STORAGE_KEYS.sessions, next);
  return next;
}

export function removeRecentSession(id) {
  const current = loadRecentSessions();
  const next = current.filter((session) => session.id !== id);
  safeWrite(STORAGE_KEYS.sessions, next);
  return next;
}

export function clearRecentSessions() {
  safeWrite(STORAGE_KEYS.sessions, []);
  return [];
}

export function loadTheme() {
  return safeRead(STORAGE_KEYS.theme, null);
}

export function saveTheme(theme) {
  safeWrite(STORAGE_KEYS.theme, theme);
}

export function loadAiSettings() {
  const stored = safeRead(STORAGE_KEYS.aiSettings, null);
  return {
    ...DEFAULT_AI_SETTINGS,
    ...stored,
    openrouter: {
      ...DEFAULT_AI_SETTINGS.openrouter,
      ...(stored?.openrouter || {}),
    },
    custom: {
      ...DEFAULT_AI_SETTINGS.custom,
      ...(stored?.custom || {}),
    },
  };
}

export function saveAiSettings(settings) {
  const merged = {
    ...DEFAULT_AI_SETTINGS,
    ...settings,
    openrouter: {
      ...DEFAULT_AI_SETTINGS.openrouter,
      ...(settings?.openrouter || {}),
    },
    custom: {
      ...DEFAULT_AI_SETTINGS.custom,
      ...(settings?.custom || {}),
    },
  };
  safeWrite(STORAGE_KEYS.aiSettings, merged);
  return merged;
}

export function loadAccessSettings() {
  const stored = safeRead(STORAGE_KEYS.accessSettings, null);
  return {
    ...DEFAULT_ACCESS_SETTINGS,
    ...stored,
  };
}

export function saveAccessSettings(settings) {
  const merged = {
    ...DEFAULT_ACCESS_SETTINGS,
    ...settings,
  };
  safeWrite(STORAGE_KEYS.accessSettings, merged);
  return merged;
}
