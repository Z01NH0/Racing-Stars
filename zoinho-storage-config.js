/*
 * ZOINHO Storage Bridge v2 — Racing Stars Cloud v1.0.0
 *
 * Cloud: créditos, carros comprados e tuning.
 * Local por dispositivo: seleção de carro, modo/pista/voltas/dificuldade, visual,
 * minimapa, efeitos, teclado, controles e deadzone.
 *
 * Este arquivo também migra o save legado monolítico antes da bridge capturar o
 * estado inicial. Assim preferências locais nunca sobem para a nuvem por acidente.
 */
(() => {
  'use strict';

  const PROGRESS_KEY = 'racingStars3DReborn_v1';
  const SETTINGS_KEY = 'racingStars3DReborn_settings_v1';
  const BACKUP_KEY = `${PROGRESS_KEY}:backup`;
  const PRECLOUD_BACKUP_KEY = `${PROGRESS_KEY}:precloud-v31`;
  const CAR_PRICES = Object.freeze({
    pulse: 0,
    comet: 3200,
    vector: 5800,
    iron: 8500,
    night: 12800,
    apex: 22000,
    phantom: 36000,
    nova: 55000
  });
  const TUNE_KEYS = Object.freeze(['speed', 'accel', 'grip', 'nitro']);

  const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  const nonNegativeInt = value => {
    const n = Number(value);
    return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
  };
  const readJson = key => {
    try { return object(JSON.parse(localStorage.getItem(key) || 'null')); }
    catch { return null; }
  };
  const writeJson = (key, value) => {
    try { localStorage.setItem(key, JSON.stringify(value)); return true; }
    catch { return false; }
  };

  function migrateLegacyStorage() {
    const primaryRaw = localStorage.getItem(PROGRESS_KEY);
    const backupRaw = localStorage.getItem(BACKUP_KEY);
    let source = readJson(PROGRESS_KEY) || readJson(BACKUP_KEY);
    if (!source) return;

    const alreadySplit = !Object.prototype.hasOwnProperty.call(source, 'settings')
      && !Object.prototype.hasOwnProperty.call(source, 'selected')
      && !Object.prototype.hasOwnProperty.call(source, 'mode');
    if (alreadySplit) return;

    try {
      if (!localStorage.getItem(PRECLOUD_BACKUP_KEY)) {
        const legacy = primaryRaw || backupRaw;
        if (legacy) localStorage.setItem(PRECLOUD_BACKUP_KEY, legacy);
      }
    } catch {}

    if (!readJson(SETTINGS_KEY)) {
      writeJson(SETTINGS_KEY, {
        schemaVersion: 1,
        selected: source.selected,
        p2: source.p2,
        mode: source.mode,
        track: source.track,
        laps: source.laps,
        diff: source.diff,
        withBots: source.withBots,
        settings: object(source.settings) || {}
      });
    }

    const progress = {
      schemaVersion: 3,
      credits: source.credits,
      owned: Array.isArray(source.owned) ? source.owned : ['pulse'],
      tuning: object(source.tuning) || {}
    };
    writeJson(PROGRESS_KEY, progress);
    writeJson(BACKUP_KEY, progress);
  }

  migrateLegacyStorage();

  function parseProgress(storage) {
    const raw = storage?.[PROGRESS_KEY];
    if (typeof raw !== 'string' || !raw.trim()) return null;
    const parsed = object(JSON.parse(raw));
    if (!parsed || !Array.isArray(parsed.owned)) return null;
    return parsed;
  }

  function tuneInvestment(carId, rawTuning) {
    const price = CAR_PRICES[carId] || 0;
    const tuning = object(rawTuning) || {};
    const base = 650 + price * .042;
    let spent = 0;
    for (const key of TUNE_KEYS) {
      const level = Math.min(5, nonNegativeInt(tuning[key]));
      for (let lv = 0; lv < level; lv++) {
        spent += Math.round(base * (1 + lv * .72) / 50) * 50;
      }
    }
    return spent;
  }

  function metrics(storage) {
    const progress = parseProgress(storage);
    if (!progress) return null;
    const owned = [...new Set(progress.owned.filter(id => Object.prototype.hasOwnProperty.call(CAR_PRICES, id)))];
    if (!owned.includes('pulse')) owned.unshift('pulse');
    const tuning = object(progress.tuning) || {};
    let invested = 0;
    let tuneLevels = 0;
    for (const id of owned) invested += CAR_PRICES[id] || 0;
    for (const [id, levels] of Object.entries(tuning)) {
      if (!Object.prototype.hasOwnProperty.call(CAR_PRICES, id)) continue;
      invested += tuneInvestment(id, levels);
      for (const key of TUNE_KEYS) tuneLevels += Math.min(5, nonNegativeInt(object(levels)?.[key]));
    }
    const credits = nonNegativeInt(progress.credits);
    return {
      lifetimeValue: credits + invested,
      ownedCars: owned.length,
      tuneLevels,
      credits
    };
  }

  // > 0 = LOCAL mais avançado; < 0 = REMOTO mais avançado.
  // lifetimeValue recompõe créditos atuais + tudo que já foi gasto em garagem/tuning,
  // então comprar um carro não faz um save legítimo parecer regressão.
  function compareProgress(localStorageState, remoteStorageState) {
    try {
      const local = metrics(localStorageState);
      const remote = metrics(remoteStorageState);
      if (!local || !remote) return 0;
      for (const key of ['lifetimeValue', 'ownedCars', 'tuneLevels', 'credits']) {
        if (local[key] === remote[key]) continue;
        return local[key] > remote[key] ? 1 : -1;
      }
      return 0;
    } catch {
      return 0;
    }
  }

  function progressScore(storage) {
    try { return metrics(storage)?.lifetimeValue ?? null; }
    catch { return null; }
  }

  window.ZOINHO_STORAGE_CONFIG = Object.freeze({
    gameId: 'racing-stars',
    displayName: 'Racing Stars',
    bridgeVersion: 2,
    portalOrigins: [
      'http://localhost:3000',
      'http://127.0.0.1:3000'
    ],
    saveKeys: [PROGRESS_KEY],
    compareProgress,
    progressScore
  });
})();
