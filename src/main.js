import { DEFAULT_PARAMS } from './models/Types.js';
import { VentilatorEngine } from './models/VentilatorEngine.js';
import { BloodGasEngine } from './models/BloodGasEngine.js';
import { AnatomyRenderer } from './views/AnatomyRenderer.js';
import { AtlasAnatomyRenderer } from './views/AtlasAnatomyRenderer.js';
import { WaveformMonitor } from './views/WaveformMonitor.js';

let simPaused = false;
let anatomyMode = 'atlas'; // 'atlas' | '3d'
let currentLungVentMode = 'both'; // 'both' | 'right' | 'left'
let abgOpen = false;
let latestMeasuredVte = null;
let latestMeasuredRR = null;
let clinicalFlags = {
  clinicalPreset: 'normal',
  pneumothoraxRight: false,
  airwayNarrowing: false,
  ardsMode: false,
  deepIntubationRight: false,
  cs1HeartFailure: false,
  rightHeartFailure: false
};
const engine = new VentilatorEngine(DEFAULT_PARAMS);
const bloodGas = new BloodGasEngine();
const anatomyContainer = document.getElementById('anatomy-3d-container');
const anatomy = new AnatomyRenderer(anatomyContainer);
const atlasAnatomy = new AtlasAnatomyRenderer(document.getElementById('lungCanvas'));
const monitor = new WaveformMonitor(document.getElementById('wave-canvas'));

// アトラス2D ⇔ 3Dホログラム 切替
window.setAnatomyMode = (mode) => {
  anatomyMode = mode;
  const isAtlas = (mode === 'atlas');
  document.getElementById('lungCanvas')?.classList.toggle('hidden', !isAtlas);
  document.getElementById('anatomy-3d-container')?.classList.toggle('hidden', isAtlas);
  document.getElementById('controls-atlas-lung')?.classList.toggle('hidden', !isAtlas);
  document.getElementById('btn-toggle-section')?.classList.toggle('hidden', !isAtlas);
  document.getElementById('controls-3d-view')?.classList.toggle('hidden', isAtlas);
  document.getElementById('legend-atlas')?.classList.toggle('hidden', !isAtlas);
  document.getElementById('legend-3d')?.classList.toggle('hidden', isAtlas);

  const tabAtlas = document.getElementById('tab-atlas');
  const tab3d = document.getElementById('tab-3d');
  if (tabAtlas && tab3d) {
    tabAtlas.className = isAtlas
      ? 'px-2 py-0.5 rounded bg-sky-600 text-white font-bold transition'
      : 'px-2 py-0.5 rounded text-slate-400 hover:text-white font-bold transition';
    tab3d.className = !isAtlas
      ? 'px-2 py-0.5 rounded bg-sky-600 text-white font-bold transition'
      : 'px-2 py-0.5 rounded text-slate-400 hover:text-white font-bold transition';
  }
  if (!isAtlas) {
    requestAnimationFrame(() => anatomy.resize());
  }
};

// 左右肺の個別換気分布制御（片肺挿管などのシナリオ用）
window.setLungVentMode = (mode) => {
  currentLungVentMode = mode;
  if (mode === 'both') atlasAnatomy.setLungVentilationRatio(1.0, 1.0);
  else if (mode === 'right') atlasAnatomy.setLungVentilationRatio(1.0, 0.12);
  else if (mode === 'left') atlasAnatomy.setLungVentilationRatio(0.12, 1.0);

  ['both', 'right', 'left'].forEach((m) => {
    const btn = document.getElementById(`btn-lung-${m}`);
    if (!btn) return;
    const active = (m === mode);
    btn.className = active
      ? (m === 'both'
          ? 'px-2 py-0.5 text-[10px] bg-sky-700 text-white rounded border border-sky-400 font-bold backdrop-blur'
          : 'px-2 py-0.5 text-[10px] bg-rose-700 text-white rounded border border-rose-400 font-bold backdrop-blur')
      : 'px-2 py-0.5 text-[10px] bg-slate-900/80 hover:bg-rose-900 text-slate-300 rounded border border-slate-700 backdrop-blur';
  });
};

// 3Dカメラアングル切り替え＆心臓レイヤー切り替え
window.setAnatomyView = (viewName) => {
  anatomy.setCameraView(viewName);
};

window.toggleHeart3D = () => {
  const visible = anatomy.toggleHeartVisibility();
  atlasAnatomy.setHeartVisibility(visible);
  const btn = document.getElementById('btn-toggle-heart');
  if (btn) {
    btn.textContent = visible ? '心臓: ON' : '心臓: OFF';
    btn.classList.toggle('bg-rose-900/80', visible);
    btn.classList.toggle('text-rose-200', visible);
    btn.classList.toggle('bg-slate-800', !visible);
    btn.classList.toggle('text-slate-400', !visible);
  }
};

window.toggleLungSection = () => {
  const visible = atlasAnatomy.toggleLungSection();
  const btn = document.getElementById('btn-toggle-section');
  if (btn) {
    btn.textContent = visible ? '肺断面 (透過): ON' : '肺断面 (透過): OFF';
    btn.classList.toggle('bg-teal-700', visible);
    btn.classList.toggle('text-white', visible);
    btn.classList.toggle('border-teal-400', visible);
    btn.classList.toggle('bg-slate-900/80', !visible);
    btn.classList.toggle('text-teal-200', !visible);
    btn.classList.toggle('border-teal-700/60', !visible);
  }
};

// 波形フリーズ比較機能
window.freezeWaveform = () => {
  const success = monitor.freezeCurrentWaveform();
  const btnFreeze = document.getElementById('btn-freeze');
  const btnClear = document.getElementById('btn-clear-freeze');
  if (success && btnFreeze && btnClear) {
    btnFreeze.classList.add('bg-sky-600', 'text-white');
    btnFreeze.classList.remove('bg-slate-800', 'text-sky-300');
    btnClear.classList.remove('hidden');
  }
};

window.clearFreezeWaveform = () => {
  monitor.clearFrozenWaveform();
  const btnFreeze = document.getElementById('btn-freeze');
  const btnClear = document.getElementById('btn-clear-freeze');
  if (btnFreeze && btnClear) {
    btnFreeze.classList.remove('bg-sky-600', 'text-white');
    btnFreeze.classList.add('bg-slate-800', 'text-sky-300');
    btnClear.classList.add('hidden');
  }
};

// コールバック接続
engine.onMistrigger = () => {
  const alertEl = document.getElementById('mistrigger-alert');
  if (alertEl) {
    alertEl.classList.remove('hidden');
    setTimeout(() => alertEl.classList.add('hidden'), 1400);
  }
};

engine.onTriggered = ({ isSpontTriggered, autoPeep }) => {
  const elPeep = document.getElementById('val-autopeep');
  if (elPeep) elPeep.textContent = autoPeep.toFixed(1);
  const badge = document.getElementById('trigger-badge');
  if (badge) {
    if (isSpontTriggered) {
      badge.textContent = '自発トリガー成立！';
      badge.className = 'px-2.5 py-0.5 text-xs font-bold rounded bg-rose-500 text-white shadow';
    } else {
      badge.textContent = '時間トリガー (強制)';
      badge.className = 'px-2.5 py-0.5 text-xs font-bold rounded bg-sky-600 text-white';
    }
  }
};

engine.onCycleFinished = ({ ppeak, pplat, vte, rr }) => {
  const elPeak = document.getElementById('val-ppeak');
  const elPlat = document.getElementById('val-pplat');
  const elVte = document.getElementById('val-vte');
  const elMv = document.getElementById('val-mv');
  const safeVte = Number.isFinite(engine.lastVte) ? engine.lastVte : (Number(vte) || 0);
  const safeRr = Number(rr) || engine.measuredRR || engine.params.rrSet || 12;
  latestMeasuredVte = safeVte;
  latestMeasuredRR = safeRr;

  if (elPeak) elPeak.textContent = ppeak;
  if (elPlat) elPlat.textContent = pplat !== null ? pplat : '-';
  if (elVte) elVte.textContent = vte;
  if (elMv) {
    const mv = (safeVte * safeRr) / 1000.0;
    elMv.textContent = Number.isFinite(mv) ? mv.toFixed(2) : '0.00';
  }
  
  const badge = document.getElementById('trigger-badge');
  if (badge) {
    badge.textContent = 'トリガー待機';
    badge.className = 'px-2.5 py-0.5 text-xs font-bold rounded bg-slate-800 text-slate-500';
  }
};

// UIイベント連携
function syncUI() {
  const modeEl = document.querySelector('input[name="mode"]:checked');
  const ctrlTypeEl = document.querySelector('input[name="ctrlType"]:checked');
  const flowPatEl = document.querySelector('input[name="flowPat"]:checked');
  const sexEl = document.querySelector('input[name="sex"]:checked');

  const params = {
    mode: modeEl ? modeEl.value : 'AC',
    ctrlType: ctrlTypeEl ? ctrlTypeEl.value : 'PCV',
    flowPat: flowPatEl ? flowPatEl.value : 'SQUARE',
    sex: sexEl ? sexEl.value : 'male',
    heightCm: parseFloat(document.getElementById('sl-height')?.value ?? 170),
    fio2: parseFloat(document.getElementById('sl-fio2')?.value ?? 40),
    rrSet: parseFloat(document.getElementById('sl-rr').value),
    ti: parseFloat(document.getElementById('sl-ti').value),
    pc: parseFloat(document.getElementById('sl-pc').value),
    vtSet: parseFloat(document.getElementById('sl-vt').value),
    tPause: parseFloat(document.getElementById('sl-tpause').value),
    ps: parseFloat(document.getElementById('sl-ps').value),
    peep: parseFloat(document.getElementById('sl-peep').value),
    trig: parseFloat(document.getElementById('sl-trig').value),
    spontRR: parseFloat(document.getElementById('sl-spont-rr').value),
    pmusMax: parseFloat(document.getElementById('sl-pmus').value),
    C: parseFloat(document.getElementById('sl-comp').value),
    R: parseFloat(document.getElementById('sl-res').value),
    hr: parseFloat(document.getElementById('sl-hr')?.value ?? 75),
    effusion: parseFloat(document.getElementById('sl-effusion')?.value ?? 0),
    atelectasis: parseFloat(document.getElementById('sl-atelectasis')?.value ?? 0),
    edema: parseFloat(document.getElementById('sl-edema')?.value ?? 0),
    ...clinicalFlags
  };

  if (params.tPause >= params.ti - 0.2) {
    params.tPause = Math.max(0, +(params.ti - 0.3).toFixed(1));
    document.getElementById('sl-tpause').value = params.tPause;
  }

  // 表示ラベル更新
  document.getElementById('lbl-rr').textContent = `${params.rrSet} /分`;
  document.getElementById('lbl-ti').textContent = `${params.ti.toFixed(1)} 秒`;
  document.getElementById('lbl-pc').textContent = `+${params.pc} cmH2O`;
  document.getElementById('lbl-vt').textContent = `${params.vtSet} mL`;
  document.getElementById('lbl-tpause').textContent = `${params.tPause.toFixed(1)} 秒`;
  document.getElementById('lbl-ps').textContent = `+${params.ps} cmH2O`;
  document.getElementById('lbl-peep').textContent = `${params.peep} cmH2O`;
  document.getElementById('lbl-trig').textContent = `-${params.trig.toFixed(1)} cmH2O`;
  const lblFio2 = document.getElementById('lbl-fio2');
  if (lblFio2) lblFio2.textContent = `${params.fio2} %`;
  const lblHeight = document.getElementById('lbl-height');
  if (lblHeight) lblHeight.textContent = `${params.heightCm}cm`;
  const pbw = BloodGasEngine.computePBW(params.sex, params.heightCm);
  const lblPbw = document.getElementById('lbl-pbw');
  if (lblPbw) lblPbw.textContent = `${pbw.toFixed(1)} kg`;
  document.getElementById('lbl-spont-rr').textContent = params.spontRR === 0 ? '0 /分 (なし)' : `${params.spontRR} /分`;
  document.getElementById('lbl-pmus').textContent = `${params.pmusMax} cmH2O`;
  document.getElementById('lbl-comp').textContent = `${params.C} mL/cmH2O`;
  document.getElementById('lbl-res').textContent = `${params.R} cmH2O/L/s`;
  const lblHr = document.getElementById('lbl-hr');
  if (lblHr) lblHr.textContent = `${params.hr} bpm`;
  const hdrHr = document.getElementById('hdr-hr');
  if (hdrHr) hdrHr.textContent = `${params.hr}`;

  const lblEff = document.getElementById('lbl-effusion');
  if (lblEff) lblEff.textContent = `${params.effusion}%`;
  const lblAtel = document.getElementById('lbl-atelectasis');
  if (lblAtel) lblAtel.textContent = `${params.atelectasis}%`;
  const lblEdema = document.getElementById('lbl-edema');
  if (lblEdema) lblEdema.textContent = `${params.edema}%`;

  // コントロール活性/非活性
  const isPSV = (params.mode === 'PSV');
  const isVCV = (!isPSV && params.ctrlType === 'VCV');
  const isPCV = (!isPSV && params.ctrlType === 'PCV');

  document.getElementById('ctrl-type-group').classList.toggle('disabled-control', isPSV);
  document.getElementById('flow-pat-group').classList.toggle('disabled-control', !isVCV);
  document.getElementById('wrap-rr').classList.toggle('disabled-control', isPSV);
  document.getElementById('wrap-ti').classList.toggle('disabled-control', isPSV);
  document.getElementById('wrap-pc').classList.toggle('disabled-control', !isPCV);
  document.getElementById('wrap-vt').classList.toggle('disabled-control', !isVCV);
  document.getElementById('wrap-tpause').classList.toggle('disabled-control', !isVCV);
  document.getElementById('wrap-ps').classList.toggle('disabled-control', params.mode === 'AC');

  engine.updateParams(params);

  // 実効コンプライアンス・実効抵抗の表示更新
  const elEffC = document.getElementById('lbl-eff-c');
  const elEffR = document.getElementById('lbl-eff-r');
  if (elEffC) elEffC.textContent = engine.effC.toFixed(1);
  if (elEffR) elEffR.textContent = engine.effR.toFixed(1);

  // PEEPリクルートメントによる実効病変率をスライダー横ラベルに反映（胸水はPEEPで体積不変のため設定値を維持）
  const patho = engine.pathology;
  const effAtelPct = Math.round(patho.effectiveAtel * 100);
  const effEdemaPct = Math.round(patho.effectiveEdema * 100);
  if (lblEff) lblEff.textContent = `${params.effusion}%`;
  if (lblAtel) lblAtel.textContent = (params.atelectasis > 0 && effAtelPct < params.atelectasis) ? `${params.atelectasis}%→${effAtelPct}%` : `${params.atelectasis}%`;
  if (lblEdema) lblEdema.textContent = (params.edema > 0 && effEdemaPct < params.edema) ? `${params.edema}%→${effEdemaPct}%` : `${params.edema}%`;

  // 循環抑制（静脈還流低下）警告バッジのリアルタイム制御
  const preloadAlertEl = document.getElementById('preload-alert');
  if (preloadAlertEl) {
    preloadAlertEl.classList.toggle('hidden', !engine.pathology?.preloadAlert);
  }
}

// 臨床 病態・心疾患プリセット切替 + 正常肺リセット
window.applyClinicalPreset = (preset) => {
  // 共通初期化（既存3病態スライダー・病態/循環フラグ・警告バッジ・換気分布をリセット）
  clinicalFlags = {
    clinicalPreset: preset,
    pneumothoraxRight: false,
    airwayNarrowing: false,
    ardsMode: false,
    deepIntubationRight: false,
    cs1HeartFailure: false,
    rightHeartFailure: false
  };
  document.getElementById('sl-effusion').value = 0;
  document.getElementById('sl-atelectasis').value = 0;
  document.getElementById('sl-edema').value = 0;
  document.getElementById('preload-alert')?.classList.add('hidden');

  if (preset === 'normal') {
    document.getElementById('sl-comp').value = 50;
    document.getElementById('sl-res').value = 10;
    document.getElementById('sl-hr').value = 75;
    window.setLungVentMode('both');
  } else if (preset === 'pneumothorax') {
    document.getElementById('sl-comp').value = 22;
    document.getElementById('sl-res').value = 15;
    clinicalFlags.pneumothoraxRight = true;
    // 右肺の換気寄与を 0.15 に制限（左肺は 1.0）
    window.setLungVentMode('both');
    atlasAnatomy.setLungVentilationRatio(0.15, 1.0);
  } else if (preset === 'copd') {
    document.getElementById('sl-comp').value = 65;
    document.getElementById('sl-res').value = 28;
    clinicalFlags.airwayNarrowing = true;
    window.setLungVentMode('both');
  } else if (preset === 'ards') {
    // base_C=50, base_R=10 を維持し、無気肺75%+肺水腫70%の乗算で eff_C≈19.1, eff_R≈20.6 にする（二重減算を防止しPEEPリクルートメントを明確化）
    document.getElementById('sl-comp').value = 50;
    document.getElementById('sl-res').value = 10;
    document.getElementById('sl-atelectasis').value = 75;
    document.getElementById('sl-edema').value = 70;
    clinicalFlags.ardsMode = true;
    window.setLungVentMode('both');
  } else if (preset === 'one_lung') {
    document.getElementById('sl-comp').value = 28;
    document.getElementById('sl-res').value = 14;
    clinicalFlags.deepIntubationRight = true;
    // 既存の換気分布モードを「右片肺 (right)」へ自動切替
    window.setLungVentMode('right');
  } else if (preset === 'cs1') {
    document.getElementById('sl-comp').value = 32;
    document.getElementById('sl-res').value = 16;
    document.getElementById('sl-edema').value = 75;
    document.getElementById('sl-effusion').value = 30;
    document.getElementById('sl-hr').value = 120;
    clinicalFlags.cs1HeartFailure = true;
    window.setLungVentMode('both');
  } else if (preset === 'rhf') {
    document.getElementById('sl-comp').value = 50;
    document.getElementById('sl-res').value = 10;
    document.getElementById('sl-hr').value = 125;
    clinicalFlags.rightHeartFailure = true;
    window.setLungVentMode('both');
  }

  // 病態プリセットボタンのハイライト更新
  const btnStyles = {
    normal: 'bg-sky-700 text-white border-sky-400 font-bold',
    pneumothorax: 'bg-rose-700 text-white border-rose-400 font-bold',
    copd: 'bg-amber-700 text-white border-amber-400 font-bold',
    ards: 'bg-fuchsia-700 text-white border-fuchsia-400 font-bold',
    one_lung: 'bg-indigo-700 text-white border-indigo-400 font-bold',
    cs1: 'bg-red-700 text-white border-red-400 font-bold',
    rhf: 'bg-cyan-700 text-white border-cyan-400 font-bold'
  };
  ['normal', 'pneumothorax', 'copd', 'ards', 'one_lung', 'cs1', 'rhf'].forEach((key) => {
    const btn = document.getElementById(`btn-cp-${key}`);
    if (!btn) return;
    btn.className = key === preset
      ? `px-2 py-1 rounded border transition ${btnStyles[key]}`
      : 'px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-600 transition';
  });

  syncUI();
};

// プリセット関数
window.applyPreset = (name) => {
  if (name === 'normal_pcv') {
    document.querySelector('input[name="mode"][value="AC"]').checked = true;
    document.querySelector('input[name="ctrlType"][value="PCV"]').checked = true;
    document.getElementById('sl-rr').value = 12;
    document.getElementById('sl-ti').value = 1.0;
    document.getElementById('sl-pc').value = 15;
    document.getElementById('sl-peep').value = 5;
    document.getElementById('sl-trig').value = 2.0;
    document.getElementById('sl-spont-rr').value = 0;
    document.getElementById('sl-comp').value = 50;
    document.getElementById('sl-res').value = 10;
  } else if (name === 'vcv_plateau') {
    document.querySelector('input[name="mode"][value="AC"]').checked = true;
    document.querySelector('input[name="ctrlType"][value="VCV"]').checked = true;
    document.querySelector('input[name="flowPat"][value="SQUARE"]').checked = true;
    document.getElementById('sl-rr').value = 12;
    document.getElementById('sl-ti').value = 1.2;
    document.getElementById('sl-vt').value = 480;
    document.getElementById('sl-tpause').value = 0.4;
    document.getElementById('sl-peep').value = 5;
    document.getElementById('sl-spont-rr').value = 0;
    document.getElementById('sl-comp').value = 45;
    document.getElementById('sl-res').value = 15;
  } else if (name === 'autopeep_mistrig') {
    document.querySelector('input[name="mode"][value="AC"]').checked = true;
    document.querySelector('input[name="ctrlType"][value="PCV"]').checked = true;
    document.getElementById('sl-rr').value = 20;
    document.getElementById('sl-ti').value = 1.6;
    document.getElementById('sl-pc').value = 18;
    document.getElementById('sl-peep').value = 5;
    document.getElementById('sl-trig').value = 2.5;
    document.getElementById('sl-spont-rr').value = 28;
    document.getElementById('sl-pmus').value = 5;
    document.getElementById('sl-comp').value = 60;
    document.getElementById('sl-res').value = 20;
  }
  syncUI();
};

window.togglePauseSim = () => {
  simPaused = !simPaused;
  const btn = document.getElementById('pause-btn');
  btn.textContent = simPaused ? '再開' : '一時停止';
  btn.classList.toggle('bg-emerald-600', simPaused);
  btn.classList.toggle('bg-amber-600', !simPaused);
};

// 血液ガス（ABG）モニター アコーディオン開閉
window.toggleAbgAccordion = () => {
  abgOpen = !abgOpen;
  const body = document.getElementById('abg-accordion-body');
  const icon = document.getElementById('abg-accordion-icon');
  if (body) {
    body.classList.toggle('max-h-0', !abgOpen);
    body.classList.toggle('opacity-0', !abgOpen);
    body.classList.toggle('max-h-[260px]', abgOpen);
    body.classList.toggle('opacity-100', abgOpen);
  }
  if (icon) {
    icon.textContent = abgOpen ? '▲ 閉じる' : '▼ 開く';
  }
};

function updateAbgDisplay(abg) {
  const elPh = document.getElementById('abg-ph');
  const elCo2 = document.getElementById('abg-paco2');
  const elO2 = document.getElementById('abg-pao2');
  const elHco3 = document.getElementById('abg-hco3');
  const elPf = document.getElementById('abg-pf');
  const elVtPbw = document.getElementById('lbl-vt-pbw');

  const setColor = (el, level) => {
    if (!el) return;
    el.classList.remove('text-emerald-400', 'text-amber-300', 'text-rose-400');
    if (level === 'danger') el.classList.add('text-rose-400');
    else if (level === 'warn') el.classList.add('text-amber-300');
    else el.classList.add('text-emerald-400');
  };

  if (elPh) {
    elPh.textContent = abg.pH.toFixed(2);
    setColor(elPh, (abg.pH < 7.25 || abg.pH > 7.55) ? 'danger' : (abg.pH < 7.35 || abg.pH > 7.45) ? 'warn' : 'ok');
  }
  if (elCo2) {
    elCo2.textContent = abg.paCO2.toFixed(1);
    setColor(elCo2, (abg.paCO2 > 55 || abg.paCO2 < 28) ? 'danger' : (abg.paCO2 > 45 || abg.paCO2 < 35) ? 'warn' : 'ok');
  }
  if (elO2) {
    elO2.textContent = Math.round(abg.paO2);
    setColor(elO2, abg.paO2 < 60 ? 'danger' : abg.paO2 < 80 ? 'warn' : 'ok');
  }
  if (elHco3) {
    elHco3.textContent = abg.hco3.toFixed(1);
    setColor(elHco3, (abg.hco3 < 18 || abg.hco3 > 30) ? 'danger' : (abg.hco3 < 22 || abg.hco3 > 26) ? 'warn' : 'ok');
  }
  if (elPf) {
    elPf.textContent = Math.round(abg.pfRatio);
    setColor(elPf, abg.pfRatio < 100 ? 'danger' : abg.pfRatio < 200 ? 'warn' : abg.pfRatio < 300 ? 'warn' : 'ok');
  }
  if (elVtPbw) {
    elVtPbw.textContent = `${abg.vtPerKg.toFixed(1)} mL/kg`;
    elVtPbw.className = abg.vtPerKg > 8.5 ? 'text-amber-300 font-bold' : abg.vtPerKg < 4.5 ? 'text-rose-400 font-bold' : 'text-sky-300 font-bold';
  }
}

document.querySelectorAll('input').forEach(input => {
  input.addEventListener('input', syncUI);
  input.addEventListener('change', syncUI);
});

// メインループ
let lastTime = performance.now();
function loop(now) {
  const dt = Math.min(0.05, (now - lastTime) / 1000.0);
  lastTime = now;

  if (!simPaused) {
    const sample = engine.update(dt);
    const abgVte = Number.isFinite(engine.lastVte) ? engine.lastVte : (latestMeasuredVte ?? engine.params.vtSet);
    const abgRr = Number.isFinite(engine.measuredRR) ? engine.measuredRR : (latestMeasuredRR ?? engine.params.rrSet);
    const abg = bloodGas.update(dt, engine.params, engine.pathology, abgVte, abgRr, currentLungVentMode);
    updateAbgDisplay(abg);
    monitor.pushSample(sample);
    monitor.render(engine.params.peep, false);
    if (anatomyMode === 'atlas') {
      atlasAnatomy.render(engine, engine.params, now);
    } else {
      anatomy.render(engine, engine.params, now);
    }

    // バッジ更新
    const pBadge = document.getElementById('phase-badge');
    if (sample.phase === 'INSP_FLOW') {
      pBadge.textContent = sample.currentBreathType === 'PS' ? '吸気相 (PSV)' : `吸気相 (${engine.params.ctrlType})`;
      pBadge.className = 'px-2.5 py-0.5 text-xs font-bold rounded bg-sky-500 text-slate-950';
    } else if (sample.phase === 'INSP_PAUSE') {
      pBadge.textContent = '吸気ポーズ (プラトー)';
      pBadge.className = 'px-2.5 py-0.5 text-xs font-bold rounded bg-amber-400 text-slate-950';
    } else {
      pBadge.textContent = '呼気相';
      pBadge.className = 'px-2.5 py-0.5 text-xs font-bold rounded bg-slate-700 text-slate-300';
    }
  } else {
    // 一時停止中も波形モニターのカーソル計測＆解剖ビュー描画を継続
    monitor.render(engine.params.peep, true);
    if (anatomyMode === 'atlas') {
      atlasAnatomy.render(engine, engine.params, now);
    } else {
      anatomy.controls.update();
      anatomy.renderer.render(anatomy.scene, anatomy.camera);
    }
  }

  requestAnimationFrame(loop);
}

syncUI();
requestAnimationFrame(loop);
