import { startTransition, useDeferredValue, useEffect, useReducer, useRef, useState } from 'react';
import { buildShareText, calculateSummary, createEmptyAssignments, isDiscountItem, normalizeReceipt } from './lib/bill';
import { clamp, formatCurrency, formatDate, formatRelativeDate, toPositiveInt, toRate, uid } from './lib/format';
import { createManualReceipt, DEFAULT_AI_SETTINGS, scanReceiptWithAI, testAiConnection } from './lib/receipt';
import { filterPeople } from './lib/search';
import {
  addSavedPerson,
  clearRecentSessions,
  clearSavedPeople,
  loadAccessSettings,
  loadAiSettings,
  loadRecentSessions,
  loadSavedPeople,
  loadTheme,
  removeRecentSession,
  removeSavedPerson,
  renameSavedPerson,
  saveAccessSettings,
  saveAiSettings,
  saveRecentSession,
  saveTheme,
  touchSavedPeople,
} from './lib/storage';

const steps = [
  { id: 1, title: 'Resit', caption: 'Scan atau input manual' },
  { id: 2, title: 'Peserta', caption: 'Pilih siapa yang ikut' },
  { id: 3, title: 'Assign', caption: 'Tentukan item per orang' },
  { id: 4, title: 'Rekap', caption: 'Copy, share, simpan' },
];

const pages = [
  { id: 'session', title: 'Sesi Aktif', caption: 'Scan, assign, dan rekap tagihan' },
  { id: 'history', title: 'Riwayat', caption: 'Buka ulang sesi yang sudah disimpan' },
  { id: 'contacts', title: 'Kontak', caption: 'Kelola daftar peserta tersimpan' },
  { id: 'user-settings', title: 'Pengaturan', caption: 'Tema, bahasa, preferensi' },
  { id: 'admin-settings', title: 'API & Admin', caption: 'Konfigurasi AI dan akses', adminOnly: true },
];

function sanitizeParticipantName(name) {
  return name.trim().slice(0, 30);
}

function syncAssignments(items, participants, previousAssignments) {
  const validParticipantIds = new Set(participants.map((participant) => participant.id));

  return items.reduce((accumulator, item) => {
    const next = (previousAssignments[item.id] || []).filter((participantId) =>
      validParticipantIds.has(participantId),
    );
    accumulator[item.id] = next;
    return accumulator;
  }, {});
}

function createInitialState() {
  const receipt = createManualReceipt();

  return {
    currentStep: 1,
    receiptData: receipt,
    participants: [],
    assignments: createEmptyAssignments(receipt.items),
  };
}

function appReducer(state, action) {
  switch (action.type) {
    case 'setStep':
      return {
        ...state,
        currentStep: clamp(action.step, 1, 4),
      };

    case 'replaceReceipt': {
      const receipt = normalizeReceipt(action.receipt);
      return {
        ...state,
        receiptData: receipt,
        assignments: syncAssignments(receipt.items, state.participants, state.assignments),
      };
    }

    case 'patchReceipt': {
      const receipt = normalizeReceipt({
        ...state.receiptData,
        ...action.patch,
      });

      return {
        ...state,
        receiptData: receipt,
        assignments: syncAssignments(receipt.items, state.participants, state.assignments),
      };
    }

    case 'updateItem': {
      const nextItems = state.receiptData.items.map((item) =>
        item.id === action.itemId ? { ...item, ...action.patch } : item,
      );

      const receipt = normalizeReceipt({
        ...state.receiptData,
        items: nextItems,
      });

      return {
        ...state,
        receiptData: receipt,
        assignments: syncAssignments(receipt.items, state.participants, state.assignments),
      };
    }

    case 'addItem': {
      const nextItems = [
        ...state.receiptData.items,
        { id: uid('item'), name: '', price: 0, quantity: 1 },
      ];
      const receipt = normalizeReceipt({
        ...state.receiptData,
        items: nextItems,
      });

      return {
        ...state,
        receiptData: receipt,
        assignments: syncAssignments(receipt.items, state.participants, state.assignments),
      };
    }

    case 'removeItem': {
      const nextItems = state.receiptData.items.filter((item) => item.id !== action.itemId);
      const receipt = normalizeReceipt({
        ...state.receiptData,
        items: nextItems.length
          ? nextItems
          : [{ id: uid('item'), name: '', price: 0, quantity: 1 }],
      });

      return {
        ...state,
        receiptData: receipt,
        assignments: syncAssignments(receipt.items, state.participants, state.assignments),
      };
    }

    case 'setParticipants': {
      const participants = action.participants;
      return {
        ...state,
        participants,
        assignments: syncAssignments(state.receiptData.items, participants, state.assignments),
      };
    }

    case 'toggleParticipant': {
      const exists = state.participants.some((participant) => participant.id === action.participant.id);
      const participants = exists
        ? state.participants.filter((participant) => participant.id !== action.participant.id)
        : [...state.participants, action.participant];

      return {
        ...state,
        participants,
        assignments: syncAssignments(state.receiptData.items, participants, state.assignments),
      };
    }

    case 'toggleAssignment': {
      const current = state.assignments[action.itemId] || [];
      const hasAssignee = current.includes(action.participantId);
      const nextAssignees = hasAssignee
        ? current.filter((participantId) => participantId !== action.participantId)
        : [...current, action.participantId];

      return {
        ...state,
        assignments: {
          ...state.assignments,
          [action.itemId]: nextAssignees,
        },
      };
    }

    case 'assignItemToAll': {
      return {
        ...state,
        assignments: {
          ...state.assignments,
          [action.itemId]: state.participants.map((participant) => participant.id),
        },
      };
    }

    case 'toggleAllItemsForPerson': {
      const allAssigned = state.receiptData.items.every((item) =>
        (state.assignments[item.id] || []).includes(action.participantId),
      );

      const assignments = state.receiptData.items.reduce((accumulator, item) => {
        const current = state.assignments[item.id] || [];
        accumulator[item.id] = allAssigned
          ? current.filter((participantId) => participantId !== action.participantId)
          : Array.from(new Set([...current, action.participantId]));
        return accumulator;
      }, {});

      return {
        ...state,
        assignments,
      };
    }

    case 'resetAssignments':
      return {
        ...state,
        assignments: createEmptyAssignments(state.receiptData.items),
      };

    case 'hydrateSession': {
      const receipt = normalizeReceipt(action.session.receipt);
      const participants = action.session.participantsData || [];
      return {
        currentStep: 4,
        receiptData: receipt,
        participants,
        assignments: syncAssignments(receipt.items, participants, action.session.assignments || {}),
      };
    }

    case 'newSession': {
      return createInitialState();
    }

    default:
      return state;
  }
}

function App() {
  const [state, dispatch] = useReducer(appReducer, undefined, createInitialState);
  const [savedPeople, setSavedPeople] = useState(() => loadSavedPeople());
  const [recentSessions, setRecentSessions] = useState(() => loadRecentSessions());
  const [aiSettings, setAiSettings] = useState(() => loadAiSettings());
  const [accessSettings, setAccessSettings] = useState(() => loadAccessSettings());
  const [theme, setTheme] = useState(() => {
    const stored = loadTheme();
    if (stored) {
      return stored;
    }

    if (typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches) {
      return 'dark';
    }

    return 'light';
  });
  const [searchQuery, setSearchQuery] = useState('');
  const [newPersonName, setNewPersonName] = useState('');
  const [persistNewPerson, setPersistNewPerson] = useState(true);
  const [scanState, setScanState] = useState({
    loading: false,
    error: '',
    mode: '',
  });
  const [connectionState, setConnectionState] = useState({
    loading: false,
    message: '',
    error: '',
  });
  const [shareState, setShareState] = useState('');
  const [activePage, setActivePage] = useState('session');
  const [editingContactId, setEditingContactId] = useState('');
  const [editingContactName, setEditingContactName] = useState('');
  const [adminPinInput, setAdminPinInput] = useState('');
  const [showMobileMenu, setShowMobileMenu] = useState(false);
  const [apiSettingsDraft, setApiSettingsDraft] = useState(null);
  const [lastApiSettingsSaveTime, setLastApiSettingsSaveTime] = useState(null);
  const [apiSettingsSaveMessage, setApiSettingsSaveMessage] = useState('');
  const cameraInputRef = useRef(null);
  const galleryInputRef = useRef(null);

  const deferredSearch = useDeferredValue(searchQuery);
  const isAdmin = accessSettings.role === 'admin';
  const currentProviderLabel = 'Custom API';
  const activeProviderConfig = aiSettings.custom;
  const currentEditingSettings = apiSettingsDraft || aiSettings;
  const currentEditingProviderConfig = currentEditingSettings.custom;
  const hasUnsavedApiChanges = apiSettingsDraft !== null;
  const filteredPeople = filterPeople(savedPeople, deferredSearch);
  const summary = calculateSummary({
    receipt: state.receiptData,
    participants: state.participants,
    assignments: state.assignments,
  });
  const assignableItems = summary.receipt.items.filter((item) => !isDiscountItem(item));
  const discountItems = summary.receipt.items.filter((item) => isDiscountItem(item));
  const validItems = state.receiptData.items.filter((item) => item.name.trim());
  const canContinueReceipt = validItems.length > 0;
  const canContinueParticipants = state.participants.length > 0;
  const canContinueAssignments = state.participants.length > 0 && !summary.hasUnassignedItems;

  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark');
    saveTheme(theme);
  }, [theme]);

  function persistAiSettings(nextSettings) {
    const merged = saveAiSettings({
      ...aiSettings,
      ...nextSettings,
      custom: {
        ...aiSettings.custom,
        ...(nextSettings.custom || {}),
      },
    });
    setAiSettings(merged);
  }

  function updateApiSettingsDraft(updates) {
    setApiSettingsDraft((prev) => ({
      ...prev || aiSettings,
      ...updates,
      custom: {
        ...(prev || aiSettings).custom,
        ...(updates.custom || {}),
      },
    }));
  }

  function handleSaveApiSettings() {
    if (!apiSettingsDraft) return;
    
    persistAiSettings(apiSettingsDraft);
    setApiSettingsDraft(null);
    
    const now = new Date();
    const timeStr = now.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    setLastApiSettingsSaveTime(timeStr);
    setApiSettingsSaveMessage(`✓ Pengaturan API tersimpan pada ${timeStr}`);
    
    setTimeout(() => setApiSettingsSaveMessage(''), 4000);
  }

  function persistAccess(nextAccess) {
    const merged = saveAccessSettings({
      ...accessSettings,
      ...nextAccess,
    });
    setAccessSettings(merged);
  }

  async function handleScan(event) {
    const file = event.target.files?.[0];
    event.target.value = '';

    if (!file) {
      return;
    }

    setScanState({ loading: true, error: '', mode: '' });

    try {
      const result = await scanReceiptWithAI(file, aiSettings);
      startTransition(() => {
        dispatch({ type: 'replaceReceipt', receipt: result.receipt });
        dispatch({ type: 'setStep', step: 1 });
      });
      setScanState({
        loading: false,
        error: '',
        mode:
          result.mode === 'demo'
            ? 'Mode demo aktif karena provider AI belum dikonfigurasi. Kamu tetap bisa edit hasil scan.'
            : `Scan berhasil diproses via ${currentProviderLabel}.`,
      });
    } catch (error) {
      setScanState({
        loading: false,
        error: error.message || 'Gagal memproses resit.',
        mode: '',
      });
    }
  }

  function handleManualMode() {
    dispatch({ type: 'replaceReceipt', receipt: createManualReceipt() });
    setScanState({
      loading: false,
      error: '',
      mode: 'Mode input manual aktif. Tambahkan item di bawah.',
    });
  }

  function updateReceiptCharge(field, rawValue) {
    const amount = toPositiveInt(rawValue);
    const subtotal = summary.receipt.subtotal;
    const rateField = field === 'tax' ? 'taxRate' : 'serviceRate';
    dispatch({
      type: 'patchReceipt',
      patch: {
        [field === 'tax' ? 'tax' : 'serviceCharge']: amount,
        [rateField]: subtotal > 0 ? amount / subtotal : 0,
      },
    });
  }

  function updateReceiptRate(field, rawPercent) {
    const rate = toRate(Number(rawPercent) / 100, 0, field === 'taxRate' ? 0.5 : 0.3, 0);
    const subtotal = summary.receipt.subtotal;
    const amountField = field === 'taxRate' ? 'tax' : 'serviceCharge';

    dispatch({
      type: 'patchReceipt',
      patch: {
        [field]: rate,
        [amountField]: Math.round(subtotal * rate),
      },
    });
  }

  function updateItem(itemId, field, value) {
    const patch =
      field === 'name'
        ? { name: value.slice(0, 60) }
        : field === 'quantity'
          ? { quantity: Math.max(1, toPositiveInt(value, 1)) }
          : { price: toPositiveInt(value) };

    dispatch({ type: 'updateItem', itemId, patch });
  }

  function toggleParticipant(person) {
    dispatch({
      type: 'toggleParticipant',
      participant: { id: person.id, name: sanitizeParticipantName(person.name) },
    });
  }

  function addParticipantFromInput() {
    const nextName = sanitizeParticipantName(newPersonName);
    if (!nextName) {
      return;
    }

    const duplicateSelected = state.participants.some(
      (participant) => participant.name.toLowerCase() === nextName.toLowerCase(),
    );
    if (duplicateSelected) {
      setShareState('Nama itu sudah dipilih di sesi ini.');
      return;
    }

    const existingSaved = savedPeople.find(
      (person) => person.name.toLowerCase() === nextName.toLowerCase(),
    );
    const participant = existingSaved || { id: uid('person'), name: nextName };

    dispatch({ type: 'toggleParticipant', participant });

    if (persistNewPerson) {
      setSavedPeople(addSavedPerson(nextName));
    }

    setNewPersonName('');
    setShareState('');
  }

  function continueFromStep(step) {
    if (step === 1 && canContinueReceipt) {
      dispatch({ type: 'setStep', step: 2 });
      return;
    }

    if (step === 2 && canContinueParticipants) {
      dispatch({ type: 'setStep', step: 3 });
      return;
    }

    if (step === 3 && canContinueAssignments) {
      dispatch({ type: 'setStep', step: 4 });
    }
  }

  async function copySummary() {
    const text = buildShareText(summary);

    try {
      await navigator.clipboard.writeText(text);
      setShareState('Rekap berhasil dicopy ke clipboard.');
    } catch {
      setShareState('Clipboard tidak tersedia di browser ini.');
    }
  }

  async function shareSummary() {
    const text = buildShareText(summary);

    try {
      if (navigator.share) {
        await navigator.share({
          title: 'Split Bill App',
          text,
        });
      } else {
        window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, '_blank', 'noopener,noreferrer');
      }
      setShareState('Ringkasan siap dibagikan.');
    } catch {
      setShareState('Share dibatalkan atau tidak tersedia.');
    }
  }

  function persistSession() {
    const session = {
      id: uid('session'),
      date: new Date().toISOString(),
      restaurant: summary.receipt.restaurantName || 'Tanpa Nama Restoran',
      totalAmount: summary.totals.grandTotal,
      participants: state.participants.map((participant) => participant.name),
      summary: Object.fromEntries(summary.people.map((person) => [person.name, person.total])),
      receipt: summary.receipt,
      participantsData: state.participants,
      assignments: state.assignments,
    };

    setRecentSessions(saveRecentSession(session));
    setSavedPeople(touchSavedPeople(state.participants));
    setShareState('Sesi berhasil disimpan ke riwayat.');
  }

  function loadSession(session) {
    dispatch({ type: 'hydrateSession', session });
    setActivePage('session');
    setShareState(`Riwayat ${session.restaurant} dibuka kembali.`);
  }

  function resetSession() {
    dispatch({ type: 'newSession' });
    setActivePage('session');
    setScanState({ loading: false, error: '', mode: '' });
    setShareState('');
    setNewPersonName('');
  }

  function removeHistory(id) {
    setRecentSessions(removeRecentSession(id));
  }

  function toggleAllForPerson(participantId) {
    dispatch({ type: 'toggleAllItemsForPerson', participantId });
  }

  function isSelected(personId) {
    return state.participants.some((participant) => participant.id === personId);
  }

  function beginEditContact(person) {
    setEditingContactId(person.id);
    setEditingContactName(person.name);
  }

  function commitEditContact() {
    if (!editingContactId) {
      return;
    }

    const nextName = sanitizeParticipantName(editingContactName);
    if (!nextName) {
      setEditingContactId('');
      setEditingContactName('');
      return;
    }

    setSavedPeople(renameSavedPerson(editingContactId, nextName));
    setEditingContactId('');
    setEditingContactName('');
  }

  function enterAdminMode() {
    if (accessSettings.adminPin && adminPinInput !== accessSettings.adminPin) {
      setShareState('PIN admin salah.');
      return;
    }

    persistAccess({ role: 'admin' });
    setAdminPinInput('');
    setShareState('Mode admin aktif.');
  }

  function requestAdminAccess() {
    if (isAdmin) {
      return;
    }

    setActivePage('settings');

    if (!accessSettings.adminPin) {
      enterAdminMode();
      return;
    }

    setShareState('Masukkan PIN admin di panel Settings untuk masuk sebagai admin.');
  }

  function exitAdminMode() {
    persistAccess({ role: 'user' });
    setShareState('Mode user aktif.');
  }

  async function handleTestConnection() {
    setConnectionState({
      loading: true,
      message: '',
      error: '',
    });

    try {
      const result = await testAiConnection(aiSettings);
      setConnectionState({
        loading: false,
        message: result.message,
        error: '',
      });
    } catch (error) {
      setConnectionState({
        loading: false,
        message: '',
        error: error.message || 'Koneksi API gagal dites.',
      });
    }
  }

  return (
    <div className="mx-auto flex min-h-screen w-full max-w-7xl flex-col gap-3 px-3 py-3 sm:gap-4 sm:px-4 sm:py-4 md:gap-6 md:px-6 md:py-6 lg:px-8">
      <header className="glass-card soft-grid overflow-hidden p-3 sm:p-4 md:p-6">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div className="space-y-2 md:space-y-3">
            <div className="pill w-fit bg-brand/10 text-brand text-xs md:text-sm">Split Bill App</div>
            <div className="space-y-1 md:space-y-2">
              <h1 className="text-xl font-extrabold tracking-tight text-ink dark:text-white sm:text-2xl md:text-4xl">
                Split Bill jadi mudah
              </h1>
              <p className="max-w-2xl text-xs leading-5 text-muted dark:text-slate-300 sm:text-sm md:leading-6">
                Scan, bagi item, share hasil—tanpa ribet.
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <div className={`pill text-xs md:text-sm ${isAdmin ? 'bg-brand/10 text-brand' : 'bg-aqua/10 text-aqua'}`}>
              {isAdmin ? 'Admin' : 'User'}
            </div>
            <button
              className="btn-secondary text-xs md:text-sm px-2 md:px-3 py-1.5 md:py-2"
              onClick={() => setTheme((current) => (current === 'dark' ? 'light' : 'dark'))}
              title={theme === 'dark' ? 'Terang' : 'Gelap'}
            >
              {theme === 'dark' ? '☀️' : '🌙'}
            </button>
            <button className="btn-primary text-xs md:text-sm px-2 md:px-3 py-1.5 md:py-2" onClick={resetSession}>
              + Baru
            </button>
          </div>
        </div>
      </header>

      <PageTabs activePage={activePage} onSelect={(page) => {
        setActivePage(page);
        setShowMobileMenu(false);
      }} isAdmin={isAdmin} />

      {shareState ? <Message tone="info">{shareState}</Message> : null}

      {activePage === 'session' ? <Stepper currentStep={state.currentStep} /> : null}

      {activePage === 'user-settings' ? (
        <SectionCard>
          <div className="space-y-5">
            <div>
              <h2 className="section-title">Pengaturan Pengguna</h2>
              <p className="text-sm text-muted dark:text-slate-300">
                Atur preferensi aplikasi kamu.
              </p>
            </div>

            <div className="space-y-4 max-w-2xl">
              <div className="rounded-[28px] border border-slate-200 bg-white/80 p-4 dark:border-slate-800 dark:bg-slate-900/70">
                <h3 className="text-base font-semibold text-ink dark:text-white">Tampilan</h3>
                <div className="mt-4 space-y-3">
                  <label className="flex items-center gap-3 text-sm">
                    <input
                      type="radio"
                      name="theme"
                      value="light"
                      checked={theme === 'light'}
                      onChange={() => setTheme('light')}
                      className="h-4 w-4 rounded border-slate-300 text-brand focus:ring-brand"
                    />
                    <span className="text-ink dark:text-white">Mode Terang ☀️</span>
                  </label>
                  <label className="flex items-center gap-3 text-sm">
                    <input
                      type="radio"
                      name="theme"
                      value="dark"
                      checked={theme === 'dark'}
                      onChange={() => setTheme('dark')}
                      className="h-4 w-4 rounded border-slate-300 text-brand focus:ring-brand"
                    />
                    <span className="text-ink dark:text-white">Mode Gelap 🌙</span>
                  </label>
                </div>
              </div>

              <div className="rounded-[28px] border border-slate-200 bg-white/80 p-4 dark:border-slate-800 dark:bg-slate-900/70">
                <h3 className="text-base font-semibold text-ink dark:text-white">Akses Admin</h3>
                <div className="mt-4 space-y-3">
                  {!isAdmin ? (
                    <>
                      <p className="text-sm text-muted dark:text-slate-300">
                        {accessSettings.adminPin ? 'Masukkan PIN untuk masuk sebagai admin' : 'Tidak ada PIN yang diatur'}
                      </p>
                      <Field
                        label="PIN Admin"
                        placeholder={accessSettings.adminPin ? 'Masukkan PIN' : 'Tidak ada PIN'}
                        type="password"
                        value={adminPinInput}
                        onChange={(event) => setAdminPinInput(event.target.value.slice(0, 24))}
                      />
                      <button className="btn-primary w-full" onClick={enterAdminMode}>
                        {accessSettings.adminPin ? 'Masuk sebagai Admin' : 'Masuk Admin Tanpa PIN'}
                      </button>
                    </>
                  ) : (
                    <>
                      <p className="text-sm text-muted dark:text-slate-300">
                        Anda saat ini adalah <strong>Admin</strong>. Untuk mengubah PIN admin, buka tab <strong>API & Admin</strong>.
                      </p>
                      <button className="btn-secondary w-full" onClick={exitAdminMode}>
                        Kembali ke Mode User
                      </button>
                    </>
                  )}
                </div>
              </div>

              <div className="rounded-[28px] bg-slate-100/80 p-4 text-sm text-muted dark:bg-slate-800/70 dark:text-slate-300">
                <p className="font-semibold text-ink dark:text-white">📌 Panduan Hak Akses</p>
                <ul className="mt-2 space-y-2 text-xs md:text-sm">
                  <li><strong>User:</strong> Scan resit, kelola sesi, lihat riwayat & kontak.</li>
                  <li><strong>Admin:</strong> Semua fitur user + edit AI settings, hapus/edit data.</li>
                </ul>
              </div>
            </div>
          </div>
        </SectionCard>
      ) : null}

      {activePage === 'admin-settings' ? (
        !isAdmin ? (
          <SectionCard>
            <div className="text-center space-y-4 py-8">
              <p className="text-lg font-semibold text-ink dark:text-white">🔒 Akses Admin Diperlukan</p>
              <p className="text-sm text-muted dark:text-slate-300">Silakan masuk sebagai admin di tab <strong>Pengaturan</strong> untuk mengakses halaman ini.</p>
              <button className="btn-primary" onClick={() => setActivePage('user-settings')}>
                Ke Tab Pengaturan
              </button>
            </div>
          </SectionCard>
        ) : (
          <SectionCard>
            <div className="space-y-5">
              <div>
                <h2 className="section-title">Konfigurasi AI & Admin</h2>
                <p className="text-sm text-muted dark:text-slate-300">
                  Kelola provider AI, API key, dan akses admin.
                </p>
              </div>

              <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_360px]">
                <div className="space-y-4">
                  <div className="block">
                    <label className="block">
                      <span className="mb-2 block text-sm font-medium text-ink dark:text-white">
                        Fallback demo
                      </span>
                      <div className="field flex items-center gap-3">
                        <input
                          checked={currentEditingSettings.allowDemoFallback}
                          className="h-4 w-4 rounded border-slate-300 text-brand focus:ring-brand"
                          type="checkbox"
                          onChange={(event) =>
                            updateApiSettingsDraft({ allowDemoFallback: event.target.checked })
                          }
                        />
                        <span className="text-sm text-muted dark:text-slate-300">
                          Jika API key kosong atau provider gagal, pakai mode demo
                        </span>
                      </div>
                    </label>
                  </div>

                  <div className="rounded-[28px] border border-slate-200 bg-white/80 p-4 dark:border-slate-800 dark:bg-slate-900/70">
                    <div className="mb-4 flex items-center justify-between gap-3">
                      <div>
                        <h3 className="text-base font-semibold text-ink dark:text-white">
                          Custom API Settings
                        </h3>
                        <p className="text-sm text-muted dark:text-slate-300">
                          Gunakan endpoint OpenAI-compatible yang mendukung input vision berbentuk
                          `image_url`. Sumopod bisa dipakai lewat Custom API.
                        </p>
                      </div>
                      <span className="pill">{currentProviderLabel}</span>
                    </div>

                    <div className="grid gap-4 sm:grid-cols-2">
                      <Field
                        label="Custom API Key"
                        placeholder="API key dari provider Anda"
                        type="password"
                        value={currentEditingProviderConfig.apiKey}
                        onChange={(event) =>
                          updateApiSettingsDraft({
                            custom: { apiKey: event.target.value.trim() },
                          })
                        }
                      />
                      <Field
                        label="Model"
                        placeholder="gpt-4o-mini atau model lainnya"
                        value={currentEditingProviderConfig.model}
                        onChange={(event) =>
                          updateApiSettingsDraft({
                            custom: { model: event.target.value.slice(0, 120) },
                          })
                        }
                      />
                      <Field
                        label="Endpoint"
                        placeholder="https://your-api-host/v1/chat/completions"
                        value={currentEditingProviderConfig.baseUrl}
                        onChange={(event) =>
                          updateApiSettingsDraft({
                            custom: { baseUrl: event.target.value.slice(0, 200) },
                          })
                        }
                      />
                      <Field
                        label="App Name"
                        placeholder="Split Bill App"
                        value={currentEditingProviderConfig.appName}
                        onChange={(event) =>
                          updateApiSettingsDraft({
                            custom: { appName: event.target.value.slice(0, 80) },
                          })
                        }
                      />
                    </div>

                    <div className="mt-4">
                      <Field
                        label="Site URL"
                        placeholder="https://your-app.example.com"
                        value={currentEditingProviderConfig.siteUrl}
                        onChange={(event) =>
                          updateApiSettingsDraft({
                            custom: { siteUrl: event.target.value.slice(0, 160) },
                          })
                        }
                      />
                    </div>
                  </div>

                  <TextAreaField
                    label="Prompt Ekstraksi Resit"
                    rows={11}
                    value={currentEditingSettings.prompt}
                    onChange={(event) =>
                      updateApiSettingsDraft({
                        prompt: event.target.value,
                      })
                    }
                  />

                  <div className="space-y-3">
                    <div className="flex flex-wrap gap-3">
                      <button
                        className={`btn-primary ${hasUnsavedApiChanges ? 'ring-2 ring-yellow-400 dark:ring-yellow-500' : ''}`}
                        onClick={handleSaveApiSettings}
                        disabled={!hasUnsavedApiChanges}
                      >
                        {hasUnsavedApiChanges ? '💾 Simpan Pengaturan API' : '✓ Pengaturan Tersimpan'}
                      </button>
                      <button
                        className="btn-primary"
                        onClick={handleTestConnection}
                      >
                        {connectionState.loading ? 'Testing...' : 'Test API Connection'}
                      </button>
                      <button
                        className="btn-secondary"
                        onClick={() => {
                          setAiSettings(saveAiSettings(DEFAULT_AI_SETTINGS));
                          setApiSettingsDraft(null);
                          setShareState('AI settings dikembalikan ke default Custom API.');
                        }}
                      >
                        Reset AI Default
                      </button>
                    </div>
                    
                    {apiSettingsSaveMessage && (
                      <div className="rounded-lg bg-green-50 p-3 text-sm text-green-700 dark:bg-green-900/20 dark:text-green-400">
                        {apiSettingsSaveMessage}
                      </div>
                    )}
                    
                    {lastApiSettingsSaveTime && !apiSettingsSaveMessage && (
                      <div className="text-xs text-muted dark:text-slate-400">
                        Last saved: {lastApiSettingsSaveTime}
                      </div>
                    )}
                  </div>
                </div>

                <div className="space-y-4">
                  <div className="rounded-[28px] border border-slate-200 bg-white/80 p-4 dark:border-slate-800 dark:bg-slate-900/70">
                    <h3 className="text-base font-semibold text-ink dark:text-white">PIN Admin</h3>
                    <div className="mt-4 space-y-3">
                      <Field
                        label="Set / Ubah PIN Admin"
                        placeholder="Contoh: 123456"
                        type="password"
                        value={accessSettings.adminPin}
                        onChange={(event) =>
                          persistAccess({
                            adminPin: event.target.value.slice(0, 24),
                          })
                        }
                      />
                      <button className="btn-secondary w-full" onClick={exitAdminMode}>
                        Simpan dan Kembali ke User
                      </button>
                    </div>
                  </div>

                  <div className="rounded-[28px] bg-slate-100/80 p-4 text-sm text-muted dark:bg-slate-800/70 dark:text-slate-300">
                    <p className="font-semibold text-ink dark:text-white">📌 Informasi</p>
                    <ul className="mt-2 space-y-2">
                      <li>Admin: edit AI settings, hapus/edit data, kelola akses.</li>
                      <li>UI role ini adalah pembatas lokal perangkat.</li>
                      <li>Provider aktif: <strong>{currentProviderLabel}</strong></li>
                    </ul>
                  </div>

                  {connectionState.message ? <Message tone="info">{connectionState.message}</Message> : null}
                  {connectionState.error ? <Message tone="error">{connectionState.error}</Message> : null}
                </div>
              </div>
            </div>
          </SectionCard>
        )
      ) : null}

      {activePage === 'history' ? (
        <SectionCard>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="section-title">Riwayat Tagihan</h2>
              <p className="text-sm text-muted dark:text-slate-300">
                Maksimum 20 sesi terakhir disimpan di perangkat ini.
              </p>
            </div>
            {recentSessions.length > 0 && isAdmin ? (
              <button
                className="btn-secondary"
                onClick={() => setRecentSessions(clearRecentSessions())}
              >
                Hapus Semua Riwayat
              </button>
            ) : null}
          </div>

          <div className="mt-5 space-y-3">
            {recentSessions.length === 0 ? (
              <EmptyState
                title="Belum ada riwayat"
                body="Simpan sesi selesai di Step 4 agar muncul di sini."
              />
            ) : (
              recentSessions.map((session) => (
                <div
                  key={session.id}
                  className="rounded-3xl border border-slate-200/80 bg-white/80 p-4 dark:border-slate-800 dark:bg-slate-900/70"
                >
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div className="space-y-1">
                      <p className="text-base font-semibold text-ink dark:text-white">
                        {session.restaurant}
                      </p>
                      <p className="text-sm text-muted dark:text-slate-300">
                        {formatDate(session.date)} • {session.participants.length} orang
                      </p>
                      <p className="text-sm font-semibold text-brand">
                        {formatCurrency(session.totalAmount)}
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <button className="btn-secondary" onClick={() => loadSession(session)}>
                        Lihat Detail
                      </button>
                      {isAdmin ? (
                        <button className="btn-secondary" onClick={() => removeHistory(session.id)}>
                          Hapus
                        </button>
                      ) : null}
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        </SectionCard>
      ) : null}

      {activePage === 'contacts' ? (
        <SectionCard>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="section-title">Daftar Kontak</h2>
              <p className="text-sm text-muted dark:text-slate-300">
                Kontak disortir berdasarkan terakhir dipakai.
              </p>
            </div>
            {savedPeople.length > 0 && isAdmin ? (
              <button className="btn-secondary" onClick={() => setSavedPeople(clearSavedPeople())}>
                Hapus Semua Kontak
              </button>
            ) : null}
          </div>

          <div className="mt-5 space-y-3">
            {savedPeople.length === 0 ? (
              <EmptyState
                title="Kontak masih kosong"
                body="Tambah peserta baru dan aktifkan simpan otomatis agar daftar ini terisi."
              />
            ) : (
              savedPeople.map((person) => (
                <div
                  key={person.id}
                  className="flex flex-col gap-3 rounded-3xl border border-slate-200/80 bg-white/80 p-4 dark:border-slate-800 dark:bg-slate-900/70 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="min-w-0 flex-1">
                    {editingContactId === person.id ? (
                      <input
                        className="field"
                        value={editingContactName}
                        maxLength={30}
                        onChange={(event) => setEditingContactName(event.target.value)}
                        onBlur={commitEditContact}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') {
                            commitEditContact();
                          }
                        }}
                      />
                    ) : (
                      <>
                        <p className="truncate text-base font-semibold text-ink dark:text-white">
                          {person.name}
                        </p>
                        <p className="text-sm text-muted dark:text-slate-300">
                          Terakhir dipakai {formatRelativeDate(person.lastUsed)}
                        </p>
                      </>
                    )}
                  </div>
                  {isAdmin ? (
                    <div className="flex gap-2">
                      <button className="btn-secondary" onClick={() => beginEditContact(person)}>
                        Edit
                      </button>
                      <button
                        className="btn-secondary"
                        onClick={() => setSavedPeople(removeSavedPerson(person.id))}
                      >
                        Hapus
                      </button>
                    </div>
                  ) : null}
                </div>
              ))
            )}
          </div>
        </SectionCard>
      ) : null}

      {activePage === 'session' ? (
      <main className="grid gap-6 lg:grid-cols-[minmax(0,1.4fr)_380px]">
        <div className="space-y-6">
          {state.currentStep === 1 ? (
            <SectionCard>
              <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
                <div>
                  <h2 className="section-title">Step 1 — Scan / Upload Resit</h2>
                  <p className="mt-1 text-sm text-muted dark:text-slate-300">
                    Ambil foto, upload dari galeri, atau lanjut lewat input manual.
                  </p>
                </div>
                <div className="pill w-fit">
                  AI: {currentProviderLabel} • {isAdmin ? 'Admin' : 'User'}
                </div>
                <div className="flex flex-wrap gap-2">
                  <button
                    className="btn-primary"
                    type="button"
                    onClick={() => cameraInputRef.current?.click()}
                  >
                    Ambil Foto
                  </button>
                  <button
                    className="btn-secondary"
                    type="button"
                    onClick={() => galleryInputRef.current?.click()}
                  >
                    Upload Galeri
                  </button>
                  <button className="btn-secondary" onClick={handleManualMode}>
                    Input Manual
                  </button>
                </div>
              </div>

              <input
                ref={cameraInputRef}
                accept="image/*"
                capture="environment"
                className="sr-only"
                type="file"
                onChange={handleScan}
              />
              <input
                ref={galleryInputRef}
                accept="image/*"
                className="sr-only"
                type="file"
                onChange={handleScan}
              />

              {scanState.loading ? (
                <div className="mt-5 rounded-[28px] border border-brand/20 bg-brand/10 p-5 text-sm text-ink dark:border-brand/30 dark:bg-brand/10 dark:text-slate-100">
                  <div className="flex items-center gap-3">
                    <span className="h-3 w-3 animate-pulse rounded-full bg-brand" />
                    Sedang membaca resit kamu...
                  </div>
                </div>
              ) : null}

              {scanState.error ? <Message tone="error">{scanState.error}</Message> : null}
              {scanState.mode ? <Message tone="info">{scanState.mode}</Message> : null}

          <div className="mt-5 grid gap-4 xl:grid-cols-[320px_minmax(0,1fr)]">
            <div className="space-y-4">
              <div className="rounded-[28px] border border-dashed border-slate-300 bg-white/70 p-3 dark:border-slate-700 dark:bg-slate-900/60">
                    {state.receiptData.rawImage ? (
                      <img
                        alt="Pratinjau resit"
                        className="aspect-[4/5] w-full rounded-3xl object-cover"
                        src={state.receiptData.rawImage}
                      />
                    ) : (
                      <div className="flex aspect-[4/5] items-center justify-center rounded-3xl bg-slate-100 text-center text-sm text-muted dark:bg-slate-800 dark:text-slate-300">
                        Foto resit akan muncul di sini.
                      </div>
                    )}
                  </div>

                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <StatCard label="Subtotal" value={formatCurrency(summary.receipt.subtotal)} />
                    <StatCard label="Grand Total" value={formatCurrency(summary.receipt.grandTotal)} />
                  </div>
                </div>

                <div className="space-y-5">
                  <div className="grid gap-4 sm:grid-cols-2">
                    <Field
                      label="Nama Restoran"
                      value={state.receiptData.restaurantName}
                      onChange={(event) =>
                        dispatch({
                          type: 'patchReceipt',
                          patch: { restaurantName: event.target.value.slice(0, 60) },
                        })
                      }
                      placeholder="Contoh: Restoran ABC"
                    />
                    <Field
                      label="Grand Total"
                      inputMode="numeric"
                      value={state.receiptData.grandTotal}
                      onChange={(event) =>
                        dispatch({
                          type: 'patchReceipt',
                          patch: { grandTotal: toPositiveInt(event.target.value) },
                        })
                      }
                    />
                  </div>

                  <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                    <Field
                      label="Tax (%)"
                      inputMode="decimal"
                      value={Math.round((state.receiptData.taxRate || 0) * 100)}
                      onChange={(event) => updateReceiptRate('taxRate', event.target.value)}
                    />
                    <Field
                      label="Tax (Rp)"
                      inputMode="numeric"
                      value={state.receiptData.tax}
                      onChange={(event) => updateReceiptCharge('tax', event.target.value)}
                    />
                    <Field
                      label="Service (%)"
                      inputMode="decimal"
                      value={Math.round((state.receiptData.serviceRate || 0) * 100)}
                      onChange={(event) => updateReceiptRate('serviceRate', event.target.value)}
                    />
                    <Field
                      label="Service (Rp)"
                      inputMode="numeric"
                      value={state.receiptData.serviceCharge}
                      onChange={(event) => updateReceiptCharge('serviceCharge', event.target.value)}
                    />
                  </div>

                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <h3 className="text-base font-semibold text-ink dark:text-white">
                        Hasil Scan / Edit Manual
                      </h3>
                    </div>

                    <div className="space-y-3">
                      {state.receiptData.items.map((item) => (
                        <div
                          key={item.id}
                          className="rounded-[28px] border border-slate-200 bg-white/80 p-4 dark:border-slate-800 dark:bg-slate-900/70"
                        >
                          <div className="space-y-3">
                            <Field
                              label="Nama Item"
                              value={item.name}
                              onChange={(event) => updateItem(item.id, 'name', event.target.value)}
                              placeholder="Contoh: Nasi Goreng"
                            />
                            <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_120px_auto]">
                              <Field
                                label="Harga"
                                inputMode="numeric"
                                value={item.price}
                                onChange={(event) => updateItem(item.id, 'price', event.target.value)}
                              />
                              <Field
                                label="Qty"
                                inputMode="numeric"
                                value={item.quantity}
                                onChange={(event) => updateItem(item.id, 'quantity', event.target.value)}
                              />
                              <div className="flex items-end">
                                <button
                                  className="btn-secondary w-full"
                                  onClick={() => dispatch({ type: 'removeItem', itemId: item.id })}
                                >
                                  Hapus
                                </button>
                              </div>
                            </div>
                          </div>
                          <p className="mt-3 text-sm font-medium text-muted dark:text-slate-300">
                            Total item: {formatCurrency(item.price * item.quantity)}
                          </p>
                        </div>
                      ))}

                      <div className="pt-2">
                        <button className="btn-secondary w-full" onClick={() => dispatch({ type: 'addItem' })}>
                          + Tambah Item
                        </button>
                      </div>
                    </div>
                  </div>

                  <div className="flex flex-col gap-3 rounded-[28px] bg-slate-100/70 p-4 dark:bg-slate-800/60 sm:flex-row sm:items-center sm:justify-between">
                    <div className="text-sm text-muted dark:text-slate-300">
                      {canContinueReceipt
                        ? `${validItems.length} item siap dipakai untuk lanjut ke peserta.`
                        : 'Isi minimal satu item bernama agar bisa lanjut.'}
                    </div>
                    <div className="flex gap-2">
                      <button className="btn-primary w-full sm:w-auto" disabled={!canContinueReceipt} onClick={() => continueFromStep(1)}>
                        Lanjut ke Peserta
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            </SectionCard>
          ) : null}

          {state.currentStep === 2 ? (
            <SectionCard>
              <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
                <div>
                  <h2 className="section-title">Step 2 — Pilih Peserta</h2>
                  <p className="mt-1 text-sm text-muted dark:text-slate-300">
                    Cari dari daftar tersimpan atau tambahkan nama baru. Mode solo tetap didukung
                    bila hanya satu orang makan.
                  </p>
                </div>
                <div className="pill w-fit text-aqua">Tersimpan hingga 50 orang</div>
              </div>

              <div className="mt-5 grid gap-4 xl:grid-cols-[minmax(0,1.2fr)_360px]">
                <div className="space-y-5">
                  <Field
                    label="Cari nama"
                    value={searchQuery}
                    onChange={(event) => setSearchQuery(event.target.value)}
                    placeholder="Ketik: bud, sar, and..."
                  />

                  <div>
                    <p className="mb-3 text-sm font-semibold text-ink dark:text-white">
                      Terakhir dipakai
                    </p>
                    <div className="flex flex-wrap gap-2">
                      {savedPeople.slice(0, 6).map((person) => (
                        <button
                          key={person.id}
                          className={`${isSelected(person.id) ? 'btn-primary' : 'btn-secondary'} w-full sm:w-auto`}
                          onClick={() => toggleParticipant(person)}
                        >
                          {person.name}
                        </button>
                      ))}
                      {savedPeople.length === 0 ? (
                        <p className="text-sm text-muted dark:text-slate-300">
                          Belum ada kontak tersimpan.
                        </p>
                      ) : null}
                    </div>
                  </div>

                  <div>
                    <div className="mb-3 flex items-center justify-between">
                      <p className="text-sm font-semibold text-ink dark:text-white">
                        Semua kontak
                      </p>
                      <p className="text-xs text-muted dark:text-slate-400">
                        Pencarian case-insensitive + fuzzy
                      </p>
                    </div>
                    <div className="space-y-3">
                      {filteredPeople.length === 0 ? (
                        <EmptyState
                          title="Tidak ada nama yang cocok"
                          body="Tambah peserta baru dari panel kanan bila nama yang kamu cari belum ada."
                        />
                      ) : (
                        filteredPeople.map((person) => (
                          <button
                            key={person.id}
                            className={`flex w-full items-center justify-between rounded-3xl border px-4 py-3 text-left transition ${
                              isSelected(person.id)
                                ? 'border-brand bg-brand/10 text-ink dark:bg-brand/15 dark:text-white'
                                : 'border-slate-200 bg-white/80 text-ink dark:border-slate-800 dark:bg-slate-900/70 dark:text-white'
                            }`}
                            onClick={() => toggleParticipant(person)}
                          >
                            <span className="font-medium">{person.name}</span>
                            <span className="text-sm text-muted dark:text-slate-300">
                              {formatRelativeDate(person.lastUsed)}
                            </span>
                          </button>
                        ))
                      )}
                    </div>
                  </div>
                </div>

                <div className="space-y-5">
                  <div className="rounded-[28px] border border-slate-200 bg-white/80 p-4 dark:border-slate-800 dark:bg-slate-900/70">
                    <h3 className="text-base font-semibold text-ink dark:text-white">
                      Tambah orang baru
                    </h3>
                    <div className="mt-4 space-y-3">
                      <Field
                        label="Nama baru"
                        value={newPersonName}
                        maxLength={30}
                        onChange={(event) => setNewPersonName(event.target.value)}
                        placeholder="Contoh: Budi"
                      />
                      <label className="flex items-center gap-3 text-sm text-muted dark:text-slate-300">
                        <input
                          checked={persistNewPerson}
                          className="h-4 w-4 rounded border-slate-300 text-brand focus:ring-brand"
                          type="checkbox"
                          onChange={(event) => setPersistNewPerson(event.target.checked)}
                        />
                        Simpan ke daftar
                      </label>
                      <button className="btn-primary w-full" onClick={addParticipantFromInput}>
                        Tambah dan Pilih
                      </button>
                    </div>
                  </div>

                  <div className="rounded-[28px] border border-slate-200 bg-white/80 p-4 dark:border-slate-800 dark:bg-slate-900/70">
                    <div className="flex items-center justify-between">
                      <h3 className="text-base font-semibold text-ink dark:text-white">
                        Dipilih
                      </h3>
                      <p className="text-sm text-muted dark:text-slate-300">
                        {state.participants.length} orang
                      </p>
                    </div>

                    <div className="mt-4 flex flex-wrap gap-2">
                      {state.participants.length === 0 ? (
                        <p className="text-sm text-muted dark:text-slate-300">
                          Pilih minimal satu orang untuk lanjut.
                        </p>
                      ) : (
                        state.participants.map((participant) => (
                          <button
                            key={participant.id}
                            className="pill"
                            onClick={() => toggleParticipant(participant)}
                          >
                            {participant.name}
                            <span className="text-muted dark:text-slate-400">×</span>
                          </button>
                        ))
                      )}
                    </div>
                  </div>

                  <div className="flex flex-col gap-3 rounded-[28px] bg-slate-100/70 p-4 dark:bg-slate-800/60 sm:flex-row sm:items-center sm:justify-between">
                    <button className="btn-secondary w-full sm:w-auto" onClick={() => dispatch({ type: 'setStep', step: 1 })}>
                      Kembali
                    </button>
                    <button
                      className="btn-primary w-full sm:w-auto"
                      disabled={!canContinueParticipants}
                      onClick={() => continueFromStep(2)}
                    >
                      Lanjut ke Assign
                    </button>
                  </div>
                </div>
              </div>
            </SectionCard>
          ) : null}

          {state.currentStep === 3 ? (
            <SectionCard>
              <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
                <div>
                  <h2 className="section-title">Step 3 — Assign Makanan ke Orang</h2>
                  <p className="mt-1 text-sm text-muted dark:text-slate-300">
                    Semua item harus dipilih minimal oleh satu orang. Item shared otomatis dibagi
                    rata saat rekap.
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <button className="btn-secondary" onClick={() => dispatch({ type: 'resetAssignments' })}>
                    Reset Semua
                  </button>
                </div>
              </div>

              <div className="mt-5 rounded-[28px] border border-slate-200 bg-white/80 p-4 dark:border-slate-800 dark:bg-slate-900/70">
                <div className="flex items-center justify-between text-sm font-medium text-ink dark:text-white">
                  <span>
                    Progress: {summary.receipt.items.length - summary.unassignedItemIds.length}/
                    {summary.receipt.items.length} item ter-assign
                  </span>
                  <span>{Math.round(summary.progress * 100)}%</span>
                </div>
                <div className="mt-3 h-3 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800">
                  <div
                    className="h-full rounded-full bg-brand transition-all"
                    style={{ width: `${Math.round(summary.progress * 100)}%` }}
                  />
                </div>
              </div>

              {summary.hasUnassignedItems ? (
                <Message tone="warning">
                  {summary.unassignedItemIds.length} item belum di-assign. Lanjut ke rekap akan
                  terbuka setelah semuanya terpilih.
                </Message>
              ) : null}

              {discountItems.length ? (
                <Message tone="info">
                  {discountItems.length} item diskon akan dibagi otomatis ke semua orang sesuai porsi belanja masing-masing.
                </Message>
              ) : null}

              <div className="mt-5 grid gap-4 xl:grid-cols-[320px_minmax(0,1fr)]">
                <div className="space-y-3">
                  <h3 className="text-base font-semibold text-ink dark:text-white">
                    Pintasan per item
                  </h3>
                  {assignableItems.map((item) => {
                    const assignedCount = summary.shareMap[item.id] || 0;
                    const isUnassigned = summary.unassignedItemIds.includes(item.id);

                    return (
                      <div
                        key={item.id}
                        className={`rounded-[28px] border p-4 ${
                          isUnassigned
                            ? 'border-warn bg-amber-50 dark:border-warn/70 dark:bg-amber-500/10'
                            : 'border-slate-200 bg-white/80 dark:border-slate-800 dark:bg-slate-900/70'
                        }`}
                      >
                        <div className="space-y-2">
                          <p className="text-sm font-semibold text-ink dark:text-white">
                            {item.name || 'Item tanpa nama'}
                          </p>
                          <p className="text-sm text-muted dark:text-slate-300">
                            {item.quantity}x • {formatCurrency(item.price * item.quantity)}
                          </p>
                          <div className="flex flex-wrap gap-2">
                            <span className="pill">
                              {assignedCount > 1 ? `Split ${assignedCount} org` : `${assignedCount} org`}
                            </span>
                            <button
                              className="btn-secondary"
                              onClick={() => dispatch({ type: 'assignItemToAll', itemId: item.id })}
                            >
                              Assign ke semua
                            </button>
                          </div>
                        </div>
                      </div>
                    );
                  })}

                  {discountItems.length ? (
                    <div className="space-y-2 rounded-[28px] border border-dashed border-brand/40 bg-brand/5 p-4 dark:border-brand/30 dark:bg-brand/10">
                      <p className="text-sm font-semibold text-ink dark:text-white">Diskon otomatis</p>
                      {discountItems.map((item) => (
                        <div key={item.id} className="rounded-2xl bg-white/80 p-3 text-sm dark:bg-slate-900/70">
                          <p className="font-medium text-ink dark:text-white">{item.name || 'Diskon'}</p>
                          <p className="text-muted dark:text-slate-300">
                            {formatCurrency(item.price * item.quantity)} dibagi proporsional ke semua peserta
                          </p>
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>

                <div className="space-y-4">
                  {state.participants.map((participant) => (
                    <div
                      key={participant.id}
                      className="rounded-[30px] border border-slate-200 bg-white/80 p-4 dark:border-slate-800 dark:bg-slate-900/70"
                    >
                      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                        <div>
                          <h3 className="text-lg font-bold text-ink dark:text-white">
                            {participant.name}
                          </h3>
                          <p className="text-sm text-muted dark:text-slate-300">
                            Tap item untuk toggle assignment.
                          </p>
                        </div>
                        <button
                          className="btn-secondary w-full sm:w-auto"
                          onClick={() => toggleAllForPerson(participant.id)}
                        >
                          Pilih semua / lepas semua
                        </button>
                      </div>

                      <div className="mt-4 space-y-3">
                        {assignableItems.map((item) => {
                          const assignedToPerson = (state.assignments[item.id] || []).includes(participant.id);
                          const assignedCount = (state.assignments[item.id] || []).length;
                          const isUnassigned = summary.unassignedItemIds.includes(item.id);

                          return (
                            <button
                              key={item.id}
                              className={`flex w-full items-center justify-between rounded-3xl border px-4 py-3 text-left transition ${
                                assignedToPerson
                                  ? 'border-brand bg-brand/10 text-ink dark:bg-brand/15 dark:text-white'
                                  : isUnassigned
                                    ? 'border-warn bg-amber-50 text-ink dark:border-warn/70 dark:bg-amber-500/10 dark:text-white'
                                    : 'border-slate-200 bg-white text-ink dark:border-slate-800 dark:bg-slate-950 dark:text-white'
                              }`}
                              onClick={() =>
                                dispatch({
                                  type: 'toggleAssignment',
                                  itemId: item.id,
                                  participantId: participant.id,
                                })
                              }
                            >
                              <span className="flex flex-col">
                                <span className="font-medium">
                                  {assignedToPerson ? '☑' : '☐'} {item.name || 'Item tanpa nama'}
                                </span>
                                <span className="text-sm text-muted dark:text-slate-300">
                                  {formatCurrency(item.price * item.quantity)}
                                </span>
                              </span>
                              {assignedCount > 1 ? <span className="pill">Shared {assignedCount}</span> : null}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <div className="mt-5 flex flex-col gap-3 rounded-[28px] bg-slate-100/70 p-4 dark:bg-slate-800/60 sm:flex-row sm:items-center sm:justify-between">
                <button className="btn-secondary w-full sm:w-auto" onClick={() => dispatch({ type: 'setStep', step: 2 })}>
                  Kembali
                </button>
                <button
                  className="btn-primary w-full sm:w-auto"
                  disabled={!canContinueAssignments}
                  onClick={() => continueFromStep(3)}
                >
                  Lanjut ke Rekap
                </button>
              </div>
            </SectionCard>
          ) : null}

          {state.currentStep === 4 ? (
            <SectionCard>
              <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
                <div>
                  <h2 className="section-title">Step 4 — Rekap & Perhitungan</h2>
                  <p className="mt-1 text-sm text-muted dark:text-slate-300">
                    Semua tax dan service dibagi proporsional berdasarkan subtotal item tiap orang.
                  </p>
                </div>
                <div className="pill w-fit text-brand">
                  {summary.receipt.restaurantName || 'Tanpa Nama Restoran'} • {formatDate(new Date())}
                </div>
              </div>

              <div className="mt-5 grid gap-4 xl:grid-cols-2">
                {summary.people.map((person) => (
                  <div
                    key={person.id}
                    className="rounded-[30px] border border-slate-200 bg-white/80 p-5 dark:border-slate-800 dark:bg-slate-900/70"
                  >
                    <div className="flex items-start justify-between gap-4">
                      <div>
                        <h3 className="text-xl font-bold text-ink dark:text-white">{person.name}</h3>
                        <p className="text-sm text-muted dark:text-slate-300">
                          {person.lineItems.length} item terhitung
                        </p>
                      </div>
                      <div className="rounded-2xl bg-brand px-4 py-2 text-right text-white">
                        <div className="text-xs uppercase tracking-[0.2em] text-white/80">Total</div>
                        <div className="text-lg font-bold">{formatCurrency(person.total)}</div>
                      </div>
                    </div>

                    <div className="mt-4 space-y-3">
                      {person.lineItems.map((lineItem) => (
                        <div
                          key={`${person.id}-${lineItem.itemId}`}
                          className="flex items-center justify-between gap-4 rounded-2xl bg-slate-100/80 px-4 py-3 dark:bg-slate-800/70"
                        >
                          <div className="min-w-0">
                            <p className="truncate text-sm font-medium text-ink dark:text-white">
                              {lineItem.name}
                            </p>
                            <p className="text-xs text-muted dark:text-slate-300">
                              {lineItem.splitCount > 1
                                ? `dibagi ${lineItem.splitCount} orang`
                                : `${lineItem.quantity}x penuh`}
                            </p>
                          </div>
                          <p className="shrink-0 text-sm font-semibold text-ink dark:text-white">
                            {formatCurrency(lineItem.share)}
                          </p>
                        </div>
                      ))}
                    </div>

                    <div className="mt-4 space-y-2 border-t border-dashed border-slate-200 pt-4 text-sm dark:border-slate-700">
                      <LineRow label="Subtotal" value={formatCurrency(person.subtotal)} />
                      <LineRow label={`Tax ${Math.round(summary.receipt.taxRate * 100)}%`} value={formatCurrency(person.tax)} />
                      <LineRow
                        label={`Service ${Math.round(summary.receipt.serviceRate * 100)}%`}
                        value={formatCurrency(person.service)}
                      />
                      <div className="mt-3 border-t border-slate-200 pt-3 dark:border-slate-700">
                        <LineRow
                          label={`TOTAL ${person.name.toUpperCase()}`}
                          value={formatCurrency(person.total)}
                          strong
                        />
                      </div>
                    </div>
                  </div>
                ))}
              </div>

              <div className="mt-5 rounded-[30px] border border-slate-200 bg-white/80 p-5 dark:border-slate-800 dark:bg-slate-900/70">
                <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                  <StatCard label="Subtotal" value={formatCurrency(summary.totals.subtotal)} />
                  <StatCard label="Tax" value={formatCurrency(summary.totals.tax)} />
                  <StatCard label="Service" value={formatCurrency(summary.totals.service)} />
                  <StatCard label="Grand Total" value={formatCurrency(summary.totals.grandTotal)} emphasis />
                </div>

                <div className="mt-5 grid gap-3 sm:flex sm:flex-row sm:flex-wrap">
                  <button className="btn-primary w-full sm:w-auto" onClick={copySummary}>
                    Copy Teks
                  </button>
                  <button className="btn-secondary w-full sm:w-auto" onClick={shareSummary}>
                    Share ke WhatsApp
                  </button>
                  <button className="btn-secondary w-full sm:w-auto" onClick={persistSession}>
                    Simpan Sesi
                  </button>
                  <button className="btn-secondary w-full sm:w-auto" onClick={resetSession}>
                    Mulai Sesi Baru
                  </button>
                </div>
              </div>

              <div className="mt-5 flex flex-col gap-3 rounded-[28px] bg-slate-100/70 p-4 dark:bg-slate-800/60 sm:flex-row sm:items-center sm:justify-between">
                <button className="btn-secondary w-full sm:w-auto" onClick={() => dispatch({ type: 'setStep', step: 3 })}>
                  Kembali
                </button>
                <div className="text-sm text-muted dark:text-slate-300">
                  Total semua orang selalu diselaraskan ke grand total resit.
                </div>
              </div>
            </SectionCard>
          ) : null}
        </div>

        <aside className="space-y-6">
          <SectionCard className="lg:sticky lg:top-6">
            <h2 className="section-title">Snapshot Sesi</h2>
            <div className="mt-4 grid gap-3">
              <StatCard label="Restoran" value={summary.receipt.restaurantName || 'Belum diisi'} />
              <StatCard label="Peserta" value={`${state.participants.length} orang`} />
              <StatCard label="Item" value={`${summary.receipt.items.length} item`} />
              <StatCard
                label="Assign"
                value={
                  summary.hasUnassignedItems
                    ? `${summary.unassignedItemIds.length} belum`
                    : 'Semua lengkap'
                }
              />
            </div>

            <div className="mt-5 rounded-[28px] bg-slate-100/80 p-4 text-sm text-muted dark:bg-slate-800/70 dark:text-slate-300">
              <p className="font-semibold text-ink dark:text-white">Catatan implementasi</p>
              <ul className="mt-2 space-y-2">
                <li>Provider AI adalah Custom API saja. Semua pengaturan disimpan permanen kecuali API key.</li>
                <li>Tanpa API key, app bisa masuk mode demo bila fallback diaktifkan.</li>
                <li>Riwayat dan kontak disimpan penuh di `localStorage` perangkat.</li>
              </ul>
            </div>
          </SectionCard>
        </aside>
      </main>
      ) : null}
    </div>
  );
}

function Stepper({ currentStep }) {
  return (
    <section className="glass-card p-2 sm:p-3 md:p-5">
      <div className="mobile-scroller sm:grid sm:gap-2 sm:gap-3 sm:overflow-visible sm:px-0 sm:pb-0 sm:[scrollbar-width:auto] sm:grid-cols-4">
        {steps.map((step) => {
          const active = step.id === currentStep;
          const completed = step.id < currentStep;

          return (
            <div
              key={step.id}
              className={`rounded-[26px] border p-3 sm:p-4 transition ${
                active
                  ? 'border-brand bg-brand text-white'
                  : completed
                    ? 'border-aqua/40 bg-aqua/10 text-ink dark:text-white'
                    : 'border-slate-200 bg-white/70 text-muted dark:border-slate-800 dark:bg-slate-900/70 dark:text-slate-300'
              } min-w-[200px] sm:min-w-0 snap-start`}
            >
              <div className="flex items-center gap-2 sm:gap-3">
                <div
                  className={`flex h-8 w-8 sm:h-10 sm:w-10 items-center justify-center rounded-2xl text-xs sm:text-sm font-bold ${
                    active
                      ? 'bg-white/20 text-white'
                      : completed
                        ? 'bg-aqua text-white'
                        : 'bg-slate-100 text-ink dark:bg-slate-800 dark:text-white'
                  }`}
                >
                  {completed ? '✓' : step.id}
                </div>
                <div className="min-w-0">
                  <p className="text-xs sm:text-sm font-semibold truncate">{step.title}</p>
                  <p className={`text-xs truncate ${active ? 'text-white/80' : 'text-muted dark:text-slate-400'}`}>
                    {step.caption}
                  </p>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function PageTabs({ activePage, onSelect, isAdmin }) {
  const visiblePages = pages.filter(page => !page.adminOnly || isAdmin);
  
  return (
    <section className="grid grid-cols-2 gap-2 sm:gap-3 md:grid-cols-3 lg:grid-cols-5">
      {visiblePages.map((page) => {
        const active = page.id === activePage;

        return (
          <button
            key={page.id}
            className={`glass-card p-2.5 sm:p-3 md:p-4 text-left transition ${
              active
                ? 'border-brand bg-brand text-white'
                : 'hover:border-brand/30 hover:bg-white dark:hover:bg-slate-900'
            }`}
            onClick={() => onSelect(page.id)}
            title={page.title}
          >
            <p
              className={`text-xs sm:text-sm font-semibold truncate ${
                active ? 'text-white' : 'text-ink dark:text-white'
              }`}
            >
              {page.title}
            </p>
            <p className={`mt-0.5 sm:mt-1 text-xs leading-4 truncate ${active ? 'text-white/80' : 'text-muted dark:text-slate-300'}`}>
              {page.caption}
            </p>
          </button>
        );
      })}
    </section>
  );
}

function SectionCard({ children, className = '' }) {
  return <section className={`glass-card p-4 sm:p-6 ${className}`.trim()}>{children}</section>;
}

function Field({ label, ...props }) {
  return (
    <label className="block">
      <span className="mb-2 block text-sm font-medium text-ink dark:text-white">{label}</span>
      <input className="field" {...props} />
    </label>
  );
}

function SelectField({ label, children, ...props }) {
  return (
    <label className="block">
      <span className="mb-2 block text-sm font-medium text-ink dark:text-white">{label}</span>
      <select className="field" {...props}>
        {children}
      </select>
    </label>
  );
}

function TextAreaField({ label, ...props }) {
  return (
    <label className="block">
      <span className="mb-2 block text-sm font-medium text-ink dark:text-white">{label}</span>
      <textarea className="field min-h-[180px] resize-y" {...props} />
    </label>
  );
}

function StatCard({ label, value, emphasis = false }) {
  return (
    <div
      className={`rounded-[24px] border p-4 ${
        emphasis
          ? 'border-brand bg-brand text-white'
          : 'border-slate-200 bg-white/80 dark:border-slate-800 dark:bg-slate-900/70'
      }`}
    >
      <p className={`text-xs uppercase tracking-[0.2em] ${emphasis ? 'text-white/80' : 'text-muted dark:text-slate-400'}`}>
        {label}
      </p>
      <p className={`mt-2 text-lg font-bold ${emphasis ? 'text-white' : 'text-ink dark:text-white'}`}>
        {value}
      </p>
    </div>
  );
}

function Message({ children, tone }) {
  const tones = {
    info: 'border-aqua/30 bg-aqua/10 text-ink dark:text-white',
    warning: 'border-warn/40 bg-amber-50 text-ink dark:bg-amber-500/10 dark:text-white',
    error: 'border-danger/30 bg-red-50 text-ink dark:bg-red-500/10 dark:text-white',
  };

  return <div className={`mt-4 rounded-[24px] border p-4 text-sm ${tones[tone]}`}>{children}</div>;
}

function EmptyState({ title, body }) {
  return (
    <div className="rounded-[28px] border border-dashed border-slate-300 p-5 text-sm text-muted dark:border-slate-700 dark:text-slate-300">
      <p className="font-semibold text-ink dark:text-white">{title}</p>
      <p className="mt-1">{body}</p>
    </div>
  );
}

function LineRow({ label, value, strong = false }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className={strong ? 'font-bold text-ink dark:text-white' : 'text-muted dark:text-slate-300'}>
        {label}
      </span>
      <span className={strong ? 'font-bold text-ink dark:text-white' : 'font-medium text-ink dark:text-white'}>
        {value}
      </span>
    </div>
  );
}

export default App;
