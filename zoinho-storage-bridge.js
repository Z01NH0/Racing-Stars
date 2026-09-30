/* ZOINHO Storage Bridge v2 — Game Shell host support (parent + opener). */
(() => {
  'use strict';

  const PROTOCOL = 'zoinho-storage-v2';
  const BRIDGE_VERSION = 2;
  const READY_RETRY_MS = 900;
  const READY_RETRY_LIMIT = 120;
  const BOOT_TIMEOUT_MS = 18000;
  const ACCOUNT_BACKUP_LIMIT = 3;
  const cfg = window.ZOINHO_STORAGE_CONFIG;

  if (!cfg || !cfg.gameId || !Array.isArray(cfg.portalOrigins) || !Array.isArray(cfg.saveKeys)) {
    console.warn('[ZOINHO Bridge] Configuração ausente ou inválida; bridge desativada.');
    releaseBootGate();
    return;
  }

  const params = new URLSearchParams(location.search);
  const enabled = params.get('zoinhoBridge') === '1';
  const autoSyncRequested = params.get('zoinhoAutoSync') === '1';
  const launchPortalOrigin = normalizeOrigin(params.get('zoinhoPortalOrigin') || '');
  const shellRequested = params.get('zoinhoShell') === '1';
  const portalHostWindow = shellRequested && window.parent && window.parent !== window ? window.parent : window.opener;
  const referrerOrigin = normalizeOrigin(document.referrer || '');
  const META_KEY = `zoinhoBridgeMeta:${cfg.gameId}`;
  const ACCOUNT_BACKUPS_KEY = `zoinhoBridgeAccountBackups:${cfg.gameId}`;
  const RESTORED_KEY = `zoinhoBridgeRestored:${cfg.gameId}`;
  const ACCOUNT_SWITCH_KEY = `zoinhoBridgeAccountSwitch:${cfg.gameId}`;
  const AUTO_PORTAL_SESSION_KEY = `zoinhoBridgeAutoPortalSession:${cfg.gameId}`;
  const staticTrustedOrigins = new Set(cfg.portalOrigins.map(normalizeOrigin).filter(Boolean));

  let portalWindow = null;
  let portalOrigin = null;
  let portalUserId = null;
  let sessionNonce = null;
  let pushTimer = 0;
  let readyTimer = 0;
  let bootTimer = 0;
  let readyAttempts = 0;
  let state = enabled ? 'waiting' : 'disabled';
  let lastAckAt = null;
  let initialSyncResolved = false;
  let initialSyncCompleted = false;
  let initialSnapshotInFlight = false;
  let queuedPushReason = null;
  let offlineMode = false;
  let portalSupportsBootAck = false;

  const bootLocalState = Object.freeze({
    hadSave: cfg.saveKeys.some(key => localStorage.getItem(key) !== null),
    metaUpdatedAt: readMeta().updatedAt || null,
    ownerUserId: readMeta().ownerUserId || null,
    storage: Object.freeze(collectStorageValues())
  });

  function normalizeOrigin(value) {
    try {
      return new URL(String(value)).origin;
    } catch {
      return String(value || '').replace(/\/$/, '');
    }
  }

  function readJsonStorage(key, fallback) {
    try {
      const parsed = JSON.parse(localStorage.getItem(key) || 'null');
      return parsed == null ? fallback : parsed;
    } catch {
      return fallback;
    }
  }

  function writeJsonStorage(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (error) {
      console.warn('[ZOINHO Bridge] Não foi possível gravar metadata local.', error);
      return false;
    }
  }

  function readMeta() {
    const parsed = readJsonStorage(META_KEY, {});
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  }

  function writeMeta(patch = {}) {
    const current = readMeta();
    const next = { ...current, ...patch };
    for (const key of Object.keys(next)) {
      if (next[key] == null || next[key] === '') delete next[key];
    }
    return writeJsonStorage(META_KEY, next);
  }

  function collectStorageValues() {
    const storage = {};
    for (const key of cfg.saveKeys) {
      const value = localStorage.getItem(key);
      if (value !== null) storage[key] = value;
    }
    return storage;
  }

  function hasLocalSave() {
    return cfg.saveKeys.some(key => localStorage.getItem(key) !== null);
  }

  function markLocalSave() {
    const updatedAt = new Date().toISOString();
    const ownerUserId = portalUserId || readMeta().ownerUserId || null;
    writeMeta({ updatedAt, ownerUserId });
    return updatedAt;
  }

  function collectSnapshot() {
    return {
      gameId: cfg.gameId,
      storage: collectStorageValues(),
      clientUpdatedAt: readMeta().updatedAt || null
    };
  }

  function snapshotsEqual(remoteStorage) {
    if (!remoteStorage || typeof remoteStorage !== 'object') return false;
    for (const key of cfg.saveKeys) {
      const remote = Object.prototype.hasOwnProperty.call(remoteStorage, key) ? remoteStorage[key] : null;
      const local = localStorage.getItem(key);
      if (remote !== local) return false;
    }
    return true;
  }

  function snapshotStorageValid(storage) {
    if (!storage || typeof storage !== 'object' || Array.isArray(storage)) return false;
    for (const key of cfg.saveKeys) {
      if (!Object.prototype.hasOwnProperty.call(storage, key)) continue;
      if (typeof storage[key] !== 'string') return false;
    }
    return true;
  }

  function restoreStorageBackup(backup) {
    let ok = true;
    for (const [key, value] of backup.entries()) {
      try {
        if (value === null) localStorage.removeItem(key);
        else localStorage.setItem(key, value);
      } catch (error) {
        ok = false;
        console.error('[ZOINHO Bridge] Falha crítica ao restaurar rollback de storage.', key, error);
      }
    }
    return ok;
  }

  function writeStorageTransaction(storage, updatedAt) {
    if (!snapshotStorageValid(storage)) return { wrote: false, error: 'invalid-storage' };
    const touched = [...cfg.saveKeys.filter(key => Object.prototype.hasOwnProperty.call(storage, key)), META_KEY];
    const backup = new Map();
    try {
      for (const key of touched) backup.set(key, localStorage.getItem(key));
      let wrote = false;
      for (const key of cfg.saveKeys) {
        if (!Object.prototype.hasOwnProperty.call(storage, key)) continue;
        const value = storage[key];
        if (localStorage.getItem(key) !== value) {
          localStorage.setItem(key, value);
          wrote = true;
        }
      }
      if (!wrote) return { wrote: false, error: null };
      const meta = {
        ...readMeta(),
        updatedAt: updatedAt || new Date().toISOString(),
        ownerUserId: portalUserId || readMeta().ownerUserId || null
      };
      for (const key of Object.keys(meta)) if (meta[key] == null || meta[key] === '') delete meta[key];
      localStorage.setItem(META_KEY, JSON.stringify(meta));
      return { wrote: true, error: null };
    } catch (error) {
      const rollbackOk = restoreStorageBackup(backup);
      state = 'storage-error';
      console.error('[ZOINHO Bridge] Snapshot abortado; rollback aplicado.', error);
      return { wrote: false, error: rollbackOk ? 'storage-write-failed' : 'rollback-failed' };
    }
  }

  function mergeStorageSafely(primaryStorage, secondaryStorage) {
    if (typeof cfg.mergeStorage !== 'function') return { ...(primaryStorage || {}) };
    try {
      const merged = cfg.mergeStorage(primaryStorage || {}, secondaryStorage || {});
      return snapshotStorageValid(merged) ? merged : { ...(primaryStorage || {}) };
    } catch (error) {
      console.warn('[ZOINHO Bridge] Merge seguro falhou; mantendo a timeline vencedora.', error);
      return { ...(primaryStorage || {}) };
    }
  }

  function comparePersistentProgress(remoteStorage) {
    try {
      const localStorageForComparison = collectStorageValues();

      if (typeof cfg.compareProgress === 'function') {
        const result = Number(cfg.compareProgress(localStorageForComparison, remoteStorage));
        if (Number.isFinite(result) && result !== 0) return result > 0 ? -1 : 1;
      }

      if (typeof cfg.progressScore !== 'function') return 0;
      const localRaw = cfg.progressScore(localStorageForComparison);
      const remoteRaw = cfg.progressScore(remoteStorage);
      // Number(null) === 0. Score inválido não pode virar zero legítimo por acidente.
      if (localRaw == null || remoteRaw == null) return 0;
      const localScore = Number(localRaw);
      const remoteScore = Number(remoteRaw);
      if (!Number.isFinite(localScore) || !Number.isFinite(remoteScore) || localScore === remoteScore) return 0;
      return remoteScore > localScore ? 1 : -1;
    } catch (error) {
      console.warn('[ZOINHO Bridge] Falha ao comparar progresso semântico; usando timestamps.', error);
      return 0;
    }
  }

  function shouldApplyRemote(payload) {
    if (!payload || !snapshotStorageValid(payload.storage)) return false;
    if (!hasLocalSave()) return true;

    // Se a aba abriu sem save e o jogo criou defaults durante o bootstrap, o Cloud Save
    // legítimo deve ganhar. A captura bootLocalState acontece antes do script principal.
    if (!initialSyncResolved && !bootLocalState.hadSave) return true;

    const progressComparison = comparePersistentProgress(payload.storage);
    if (progressComparison !== 0) return progressComparison > 0;

    const localTime = Date.parse((!initialSyncResolved ? bootLocalState.metaUpdatedAt : readMeta().updatedAt) || '');
    const remoteTime = Date.parse(payload.clientUpdatedAt || payload.portalReceivedAt || '');
    if (!Number.isFinite(remoteTime)) return false;

    // Save legado sem metadata é preservado na primeira adoção do Cloud Save.
    if (!Number.isFinite(localTime)) return false;
    return remoteTime > localTime;
  }

  function applySnapshot(payload) {
    if (!payload || payload.gameId !== cfg.gameId || !snapshotStorageValid(payload.storage)) return false;
    if (snapshotsEqual(payload.storage)) return false;

    setBootStage('applying', 'Alinhando garagem...', 'Aplicando créditos, carros e tuning deste save.');
    try {
      // Marca o reload antes do primeiro write. Se sessionStorage estiver indisponível,
      // abortamos sem trocar a timeline que já está viva em memória.
      sessionStorage.setItem(RESTORED_KEY, '1');
    } catch (error) {
      state = 'storage-error';
      console.error('[ZOINHO Bridge] Não foi possível preparar o reload transacional.', error);
      return false;
    }

    const tx = writeStorageTransaction(
      payload.storage,
      payload.clientUpdatedAt || payload.portalReceivedAt || new Date().toISOString()
    );
    if (!tx.wrote) {
      try { sessionStorage.removeItem(RESTORED_KEY); } catch {}
      return false;
    }

    // O jogo carrega progresso persistente no boot. Um único reload reconstrói o estado
    // em memória usando a timeline escolhida, sem fazer merge parcial de objetos vivos.
    location.reload();
    return true;
  }

  function runtimeIsReady() {
    try { return typeof cfg.runtimeReady !== 'function' || cfg.runtimeReady() === true; }
    catch { return false; }
  }

  function waitForRuntimeReady(timeoutMs = 10000) {
    if (runtimeIsReady()) return Promise.resolve(true);
    state = 'waiting-runtime';
    setBootStage('runtime', 'Preparando o jogo...', 'Preparando as regras de garagem e tuning.');
    return new Promise(resolve => {
      const started = Date.now();
      const check = () => {
        if (runtimeIsReady()) return resolve(true);
        if (Date.now() - started >= timeoutMs) return resolve(false);
        setTimeout(check, 25);
      };
      check();
    });
  }

  function readAutomaticPortalSession() {
    try {
      const raw = sessionStorage.getItem(AUTO_PORTAL_SESSION_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || parsed.version !== 1 || typeof parsed.origin !== 'string') return null;
      const origin = normalizeOrigin(parsed.origin);
      return origin ? { origin, establishedAt: parsed.establishedAt || null } : null;
    } catch {
      return null;
    }
  }

  function rememberAutomaticPortalSession(origin) {
    const normalized = normalizeOrigin(origin);
    if (!normalized) return false;
    try {
      sessionStorage.setItem(AUTO_PORTAL_SESSION_KEY, JSON.stringify({
        version: 1,
        origin: normalized,
        establishedAt: new Date().toISOString()
      }));
      return true;
    } catch (error) {
      console.warn('[ZOINHO Bridge] Não foi possível preservar a confiança automática desta aba.', error);
      return false;
    }
  }

  function isExpectedPortalHost(event) {
    return enabled && Boolean(portalHostWindow) && event.source === portalHostWindow;
  }

  function isSafeAutomaticPortalOrigin(event, message) {
    if (!autoSyncRequested || !isExpectedPortalHost(event)) return false;
    const origin = normalizeOrigin(event.origin);
    if (!origin || !launchPortalOrigin || origin !== launchPortalOrigin) return false;
    if (normalizeOrigin(message?.portalOrigin || '') !== origin) return false;
    if (message?.bootSyncProtocol !== 1) return false;

    // Na primeira navegação, o Referer (quando fornecido) precisa apontar para o portal.
    // Depois de um restore/troca de conta, location.reload() cria um novo Document e alguns
    // navegadores passam a reportar o próprio jogo como Referer. A confiança já validada
    // nesta MESMA aba é preservada em sessionStorage para sobreviver somente ao reload.
    const trustedSession = readAutomaticPortalSession();
    const trustedReload = trustedSession?.origin === origin;
    if (referrerOrigin && referrerOrigin !== origin && !trustedReload) return false;

    try {
      const parsed = new URL(origin);
      const localDev = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
      if (parsed.protocol !== 'https:' && !(localDev && parsed.protocol === 'http:')) return false;
    } catch {
      return false;
    }
    return true;
  }

  function isTrustedOrigin(event, message) {
    const normalized = normalizeOrigin(event.origin);
    return staticTrustedOrigins.has(normalized) || isSafeAutomaticPortalOrigin(event, message);
  }

  function emptyBackups() {
    return { version: 1, order: [], users: {} };
  }

  function readAccountBackups() {
    const raw = readJsonStorage(ACCOUNT_BACKUPS_KEY, null);
    if (!raw || raw.version !== 1 || !Array.isArray(raw.order) || !raw.users || typeof raw.users !== 'object') return emptyBackups();
    return raw;
  }

  function saveAccountBackup(userId) {
    if (!userId || !hasLocalSave()) return false;
    const store = readAccountBackups();
    store.users[userId] = {
      storage: collectStorageValues(),
      updatedAt: readMeta().updatedAt || null,
      savedAt: new Date().toISOString()
    };
    store.order = store.order.filter(id => id !== userId);
    store.order.push(userId);
    while (store.order.length > ACCOUNT_BACKUP_LIMIT) {
      const removed = store.order.shift();
      if (removed) delete store.users[removed];
    }
    return writeJsonStorage(ACCOUNT_BACKUPS_KEY, store);
  }

  function restoreAccountBackup(userId) {
    const store = readAccountBackups();
    const backup = store.users[userId];
    const rollback = new Map();
    try {
      for (const key of [...cfg.saveKeys, META_KEY]) rollback.set(key, localStorage.getItem(key));
      for (const key of cfg.saveKeys) localStorage.removeItem(key);
      if (backup?.storage && typeof backup.storage === 'object') {
        if (!snapshotStorageValid(backup.storage)) throw new Error('invalid-account-backup');
        for (const key of cfg.saveKeys) {
          const value = backup.storage[key];
          if (typeof value === 'string') localStorage.setItem(key, value);
        }
      }
      if (!writeMeta({ ownerUserId: userId, updatedAt: backup?.updatedAt || null })) {
        throw new Error('account-meta-write-failed');
      }
      return Boolean(backup?.storage);
    } catch (error) {
      const rollbackOk = restoreStorageBackup(rollback);
      console.error('[ZOINHO Bridge] Troca de conta abortada; rollback aplicado.', error);
      if (!rollbackOk) state = 'storage-error';
      return false;
    }
  }

  function prepareAccountStorage(userId) {
    if (!userId) return false;
    const meta = readMeta();
    const owner = meta.ownerUserId || null;
    if (!owner || owner === userId) return false;

    // localStorage pertence ao domínio do jogo, não à conta ZOINHO. Antes de trocar de
    // conta, arquivamos o save atual e restauramos o bucket da nova conta (ou limpamos as
    // chaves sincronizadas). Isso impede progresso da conta A de ser enviado para a B.
    if (hasLocalSave() && !saveAccountBackup(owner)) {
      state = 'error';
      showBootError('Não foi possível separar o save da conta anterior neste navegador. O progresso não foi alterado.');
      return true;
    }
    restoreAccountBackup(userId);
    if (readMeta().ownerUserId !== userId) {
      state = 'error';
      showBootError('Não foi possível preparar o armazenamento desta conta. O save anterior continua protegido.');
      return true;
    }
    sessionStorage.setItem(ACCOUNT_SWITCH_KEY, userId);
    setBootStage('account', 'Trocando de piloto...', 'Separando a garagem da conta anterior.');
    location.reload();
    return true;
  }

  async function handleSync(message) {
    const runtimeReady = await waitForRuntimeReady();
    if (!runtimeReady) {
      console.warn('[ZOINHO Bridge] Runtime de progressão não ficou pronto a tempo; comparação semântica limitada.');
    }

    let restoredThisLoad = false;
    try {
      restoredThisLoad = sessionStorage.getItem(RESTORED_KEY) === '1';
      if (restoredThisLoad) sessionStorage.removeItem(RESTORED_KEY);
    } catch {}

    initialSyncResolved = false;
    initialSnapshotInFlight = false;
    const remote = message.snapshot;

    if (!restoredThisLoad && remote && remote.gameId === cfg.gameId && snapshotStorageValid(remote.storage)) {
      const localStorageValues = collectStorageValues();
      const remoteWins = shouldApplyRemote(remote);

      // A timeline econômica da garagem nunca é somada entre dispositivos.
      // Somente merges explicitamente autorizados pela configuração podem atravessar a timeline vencedora.
      const winnerStorage = remoteWins ? remote.storage : localStorageValues;
      const otherStorage = remoteWins ? localStorageValues : remote.storage;
      const mergedStorage = mergeStorageSafely(winnerStorage, otherStorage);
      const mergedPayload = {
        ...remote,
        gameId: cfg.gameId,
        storage: mergedStorage,
        clientUpdatedAt: remoteWins
          ? (remote.clientUpdatedAt || remote.portalReceivedAt || new Date().toISOString())
          : (bootLocalState.metaUpdatedAt || readMeta().updatedAt || new Date().toISOString())
      };
      if (!snapshotsEqual(mergedStorage) && applySnapshot(mergedPayload)) return;
    }

    initialSyncResolved = true;
    initialSnapshotInFlight = true;
    queuedPushReason = null;
    setBootStage(
      remote ? 'finishing' : 'cloud-empty',
      remote ? 'Fechando o grid...' : 'Preparando sua garagem...',
      remote ? 'Confirmando a garagem mais recente.' : 'Nenhuma garagem foi encontrada na nuvem.'
    );

    // Em navegador realmente novo, defaults criados pelo bootstrap não devem virar Cloud
    // Save falso. A bridge capturou a ausência de save antes do runtime do jogo iniciar.
    if (!remote && !bootLocalState.hadSave) {
      post('snapshot', {
        reason: 'initial-empty',
        bootSync: true,
        snapshot: { gameId: cfg.gameId, storage: {}, clientUpdatedAt: null }
      });
    } else {
      pushNow('initial-sync', { bootSync: true });
    }
  }

  function post(type, payload = {}) {
    if (!portalWindow || !portalOrigin || !sessionNonce) return false;
    try {
      portalWindow.postMessage({
        protocol: PROTOCOL,
        bridgeVersion: BRIDGE_VERSION,
        type,
        gameId: cfg.gameId,
        nonce: sessionNonce,
        ...payload
      }, portalOrigin);
      return true;
    } catch (error) {
      console.warn('[ZOINHO Bridge] Falha no postMessage para o portal.', error);
      state = 'error';
      return false;
    }
  }

  function postDiagnostic(event, code, extra = {}) {
    if (!event?.source || !event.origin) return false;
    try {
      event.source.postMessage({
        protocol: PROTOCOL,
        bridgeVersion: BRIDGE_VERSION,
        type: 'diagnostic',
        gameId: cfg.gameId,
        code,
        observedPortalOrigin: normalizeOrigin(event.origin),
        ...extra
      }, event.origin);
      return true;
    } catch (error) {
      console.warn('[ZOINHO Bridge] Falha ao enviar diagnóstico ao portal.', error);
      return false;
    }
  }

  function pushNow(reason = 'save', options = {}) {
    const bootSync = options.bootSync === true;
    if (offlineMode) return false;
    if ((!initialSyncResolved || !initialSyncCompleted) && !bootSync) {
      queuedPushReason = reason;
      return false;
    }
    if (!portalWindow || !portalOrigin || !sessionNonce) return false;
    state = 'sending';
    if (!bootSync) queuedPushReason = null;
    return post('snapshot', { reason, bootSync, snapshot: collectSnapshot() });
  }

  function schedulePush(reason = 'save') {
    markLocalSave();
    queuedPushReason = reason;
    clearTimeout(pushTimer);
    pushTimer = setTimeout(() => pushNow(reason), 120);
  }

  function stopReadyLoop() {
    if (readyTimer) clearInterval(readyTimer);
    readyTimer = 0;
  }

  function sendReady() {
    if (!enabled || !portalHostWindow) return false;
    readyAttempts += 1;
    try {
      portalHostWindow.postMessage({
        protocol: PROTOCOL,
        bridgeVersion: BRIDGE_VERSION,
        type: 'ready',
        gameId: cfg.gameId
      }, '*');
      return true;
    } catch (error) {
      console.warn('[ZOINHO Bridge] Não foi possível anunciar READY.', error);
      return false;
    }
  }

  function startReadyLoop() {
    if (!enabled || !portalHostWindow || readyTimer || sessionNonce || offlineMode) return;
    sendReady();
    readyTimer = setInterval(() => {
      if (sessionNonce || readyAttempts >= READY_RETRY_LIMIT || offlineMode) {
        stopReadyLoop();
        return;
      }
      sendReady();
    }, READY_RETRY_MS);
  }

  function getBootUi() {
    return {
      root: document.getElementById('zoinhoCloudBoot'),
      title: document.getElementById('zoinhoCloudBootTitle'),
      detail: document.getElementById('zoinhoCloudBootDetail'),
      status: document.getElementById('zoinhoCloudBootStatus'),
      retry: document.getElementById('zoinhoCloudRetry'),
      offline: document.getElementById('zoinhoCloudOffline')
    };
  }

  function setBootStage(stage, title, detail = '') {
    if (!enabled || initialSyncCompleted) return;
    const ui = getBootUi();
    if (!ui.root) return;
    ui.root.dataset.stage = stage || 'loading';
    if (ui.title && title) ui.title.textContent = title;
    if (ui.detail) ui.detail.textContent = detail || '';
    if (ui.status) ui.status.textContent = stage === 'error' ? '!' : stage === 'done' ? '✓' : '●';
    if (ui.retry) ui.retry.hidden = stage !== 'error';
    if (ui.offline) ui.offline.hidden = stage !== 'error';
    if (stage !== 'error') resetBootTimeout();
  }

  function resetBootTimeout() {
    if (!enabled || initialSyncCompleted || offlineMode) return;
    clearTimeout(bootTimer);
    bootTimer = setTimeout(() => {
      if (initialSyncCompleted || offlineMode) return;
      state = 'error';
      showBootError('A sincronização está demorando mais que o esperado.');
    }, BOOT_TIMEOUT_MS);
  }

  function showBootError(detail = 'Não foi possível acessar seu progresso na nuvem agora.', options = {}) {
    clearTimeout(bootTimer);
    setBootStage('error', 'Falha no Cloud Grid', detail);
    if (options.retryable === false) {
      const ui = getBootUi();
      if (ui.retry) ui.retry.hidden = true;
    }
  }

  function releaseBootGate(mode = 'synced') {
    clearTimeout(bootTimer);
    const ui = getBootUi();
    if (!ui.root) {
      document.documentElement.classList.remove('zoinho-cloud-booting');
      return;
    }
    ui.root.dataset.stage = mode === 'offline' ? 'offline' : 'done';
    ui.root.setAttribute?.('aria-busy', 'false');
    if (ui.title) ui.title.textContent = mode === 'offline' ? 'Modo local' : 'Grid sincronizado';
    if (ui.detail) ui.detail.textContent = mode === 'offline' ? 'O Cloud Grid ficará pausado nesta sessão.' : 'Garagem, créditos e tuning alinhados.';
    if (ui.status) ui.status.textContent = mode === 'offline' ? '○' : '✓';
    setTimeout(() => {
      ui.root.classList.add('zoinho-cloud-boot-leaving');
      setTimeout(() => {
        document.documentElement.classList.remove('zoinho-cloud-booting');
        ui.root.remove();
      }, 240);
    }, mode === 'offline' ? 180 : 300);
  }

  function installBootInputGuard() {
    const guarded = ['keydown', 'keyup', 'pointerdown', 'pointerup', 'mousedown', 'mouseup', 'touchstart', 'touchend', 'wheel'];
    const block = event => {
      if (!document.documentElement.classList.contains('zoinho-cloud-booting')) return;
      const target = event.target;
      if (target?.closest?.('#zoinhoCloudBoot')) return;
      event.preventDefault?.();
      event.stopImmediatePropagation?.();
      event.stopPropagation?.();
    };
    for (const type of guarded) addEventListener(type, block, { capture: true, passive: false });
  }

  function bindBootActions() {
    const ui = getBootUi();
    if (ui.retry && !ui.retry.dataset.bound) {
      ui.retry.dataset.bound = '1';
      ui.retry.addEventListener('click', () => {
        offlineMode = false;
        initialSyncResolved = false;
        initialSyncCompleted = false;
        initialSnapshotInFlight = false;
        setBootStage('retry', 'Reconectando ao grid...', 'Restabelecendo o uplink com sua garagem.');
        if (portalWindow && portalOrigin && sessionNonce) post('retry-sync');
        else {
          sessionNonce = null;
          readyAttempts = 0;
          startReadyLoop();
        }
      });
    }
    if (ui.offline && !ui.offline.dataset.bound) {
      ui.offline.dataset.bound = '1';
      ui.offline.addEventListener('click', () => {
        offlineMode = true;
        state = 'offline';
        stopReadyLoop();
        clearTimeout(pushTimer);
        queuedPushReason = null;
        initialSyncResolved = true;
        initialSyncCompleted = true;
        releaseBootGate('offline');
        post('offline-continue');
      });
    }
  }

  function acceptHello(event, message) {
    if (!isExpectedPortalHost(event)) return false;
    if (!message?.nonce || typeof message.nonce !== 'string') {
      postDiagnostic(event, 'invalid-handshake', { detail: 'Nonce ausente ou inválido.' });
      return false;
    }
    if (!message.userId || typeof message.userId !== 'string') {
      postDiagnostic(event, 'invalid-handshake', { detail: 'Conta autenticada ausente.' });
      showBootError('A sessão da sua conta não pôde ser confirmada. Reabra o jogo pelo portal.');
      return false;
    }

    portalWindow = event.source;
    portalOrigin = normalizeOrigin(event.origin);
    portalUserId = message.userId;
    // O caller só chega aqui depois de isTrustedOrigin(). Guardamos a origem apenas na
    // sessão da aba, suficiente para reloads controlados sem criar uma aprovação eterna.
    if (autoSyncRequested) rememberAutomaticPortalSession(portalOrigin);
    portalSupportsBootAck = message.bootSyncProtocol === 1;
    sessionNonce = message.nonce;
    state = 'connected';
    stopReadyLoop();

    if (prepareAccountStorage(portalUserId)) return true;

    setBootStage('handshake', 'Piloto identificado', 'Verificando sua garagem salva...');
    post('hello-ack', {
      hasSave: hasLocalSave(),
      saveKeysPresent: cfg.saveKeys.filter(key => localStorage.getItem(key) !== null),
      clientUpdatedAt: readMeta().updatedAt || null,
      ownerUserId: readMeta().ownerUserId || null,
      bootHadLocalSave: bootLocalState.hadSave
    });
    return true;
  }

  function rejectUntrustedOrigin(event) {
    const origin = normalizeOrigin(event.origin);
    state = 'untrusted-origin';
    postDiagnostic(event, 'untrusted-portal-origin', {
      detail: 'A origem que abriu o jogo não corresponde ao lançamento automático da ZOINHO.',
      observedPortalOrigin: origin
    });
    showBootError(
      'A conexão automática com o portal não pôde ser validada. Feche esta aba e abra o jogo novamente pela ZOINHO.',
      { retryable: false }
    );
  }

  function completeInitialSync(message) {
    lastAckAt = new Date().toISOString();
    initialSyncResolved = true;
    initialSyncCompleted = true;
    initialSnapshotInFlight = false;
    state = message.cloudSaved === false ? 'acknowledged-local-only' : 'acknowledged';
    if (portalUserId) writeMeta({ ownerUserId: portalUserId });
    const followUp = queuedPushReason;
    queuedPushReason = null;
    releaseBootGate(message.cloudSaved === false && !hasLocalSave() ? 'synced' : 'synced');
    if (followUp && hasLocalSave()) setTimeout(() => pushNow(followUp), 80);
  }

  window.ZoinhoStorageBridge = Object.freeze({
    enabled,
    bridgeVersion: BRIDGE_VERSION,
    collectSnapshot,
    notifySave: schedulePush,
    pushNow,
    status: () => ({
      state,
      portalOrigin,
      portalUserId,
      lastAckAt,
      readyAttempts,
      hasLocalSave: hasLocalSave(),
      launchPortalOrigin: launchPortalOrigin || null,
      referrerOrigin: referrerOrigin || null,
      hostMode: shellRequested && window.parent !== window ? 'parent' : 'opener',
      shellRequested,
      automaticPortalTrust: Boolean(autoSyncRequested && launchPortalOrigin),
      automaticPortalSessionOrigin: readAutomaticPortalSession()?.origin || null,
      bootHadLocalSave: bootLocalState.hadSave,
      bootMetaUpdatedAt: bootLocalState.metaUpdatedAt,
      ownerUserId: readMeta().ownerUserId || null,
      initialSyncResolved,
      initialSyncCompleted,
      queuedPushReason,
      offlineMode,
      portalSupportsBootAck,
      runtimeReady: runtimeIsReady()
    })
  });

  if (!enabled || !portalHostWindow) {
    releaseBootGate();
    return;
  }

  installBootInputGuard();
  bindBootActions();
  setBootStage('connecting', 'Sincronizando garagem...', 'Conectando o Race Control à sua conta ZOINHO.');

  addEventListener('message', event => {
    const message = event.data;
    if (!message || message.protocol !== PROTOCOL || message.gameId !== cfg.gameId) return;
    if (!isExpectedPortalHost(event)) return;

    if (message.type === 'hello') {
      if (!isTrustedOrigin(event, message)) {
        rejectUntrustedOrigin(event);
        return;
      }
      acceptHello(event, message);
      return;
    }

    if (!portalWindow || event.source !== portalWindow || normalizeOrigin(event.origin) !== portalOrigin) return;
    if (!sessionNonce || message.nonce !== sessionNonce) return;

    if (message.type === 'boot-status') {
      const stages = {
        'checking-cloud': ['Consultando o grid...', 'Buscando a garagem mais recente na nuvem.'],
        'cloud-found': ['Garagem encontrada', 'Comparando com este dispositivo.'],
        'cloud-empty': ['Primeiro uplink', 'Preparando sua garagem para a nuvem.'],
        'saving-cloud': ['Enviando telemetria...', 'Salvando créditos, carros e tuning na sua conta.'],
        'finishing': ['Finalizando...', 'Só mais um instante.']
      };
      const copy = stages[message.stage] || ['Sincronizando garagem...', 'Aguarde um instante.'];
      setBootStage(message.stage || 'loading', copy[0], copy[1]);
      return;
    }

    if (message.type === 'sync') {
      void handleSync(message);
      return;
    }

    if (message.type === 'sync-error') {
      initialSnapshotInFlight = false;
      initialSyncResolved = false;
      state = 'error';
      showBootError(
        message.message || 'Não foi possível acessar seu progresso na nuvem agora.',
        { retryable: message.retryable !== false }
      );
      return;
    }

    if (message.type === 'request-snapshot') {
      pushNow('requested');
      return;
    }

    if (message.type === 'ack') {
      lastAckAt = new Date().toISOString();
      if (message.bootComplete || (initialSnapshotInFlight && !portalSupportsBootAck)) {
        // Compatibilidade de implantação: se o jogo novo for publicado antes do portal
        // v1.9.0, o ACK legado ainda libera o boot em vez de prender o usuário no loading.
        completeInitialSync({ ...message, bootComplete: true });
      } else {
        state = message.cloudSaved === false ? 'acknowledged-local-only' : 'acknowledged';
      }
      return;
    }

    if (message.type === 'account-changed') {
      state = 'account-changed';
      offlineMode = true;
      showBootError('A conta do portal mudou. Feche esta aba e abra o jogo novamente pela ZOINHO.', { retryable: false });
      return;
    }

    if (message.type === 'disconnect') {
      portalWindow = null;
      portalOrigin = null;
      portalUserId = null;
      sessionNonce = null;
      state = 'waiting';
      if (!initialSyncCompleted) {
        setBootStage('connecting', 'Reconectando ao grid...', 'A conexão com o Race Control foi interrompida.');
        startReadyLoop();
      }
    }
  });

  addEventListener('pageshow', () => {
    bindBootActions();
    if (!sessionNonce && !offlineMode) startReadyLoop();
  });

  addEventListener('pagehide', () => {
    if (portalWindow && portalOrigin && sessionNonce && initialSyncCompleted && !offlineMode) pushNow('pagehide');
  });

  if (sessionStorage.getItem(ACCOUNT_SWITCH_KEY)) sessionStorage.removeItem(ACCOUNT_SWITCH_KEY);
  resetBootTimeout();
  startReadyLoop();
})();
