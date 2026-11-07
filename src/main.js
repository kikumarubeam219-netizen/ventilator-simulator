import { DEFAULT_PARAMS } from './models/Types.js';
import { VentilatorEngine } from './models/VentilatorEngine.js';
import { AnatomyRenderer } from './views/AnatomyRenderer.js';
import { WaveformMonitor } from './views/WaveformMonitor.js';

let simPaused = false;
const engine = new VentilatorEngine(DEFAULT_PARAMS);
const anatomyContainer = document.getElementById('anatomy-3d-container');
const anatomy = new AnatomyRenderer(anatomyContainer);
const monitor = new WaveformMonitor(document.getElementById('wave-canvas'));

// 3Dカメラアングル切り替え＆心臓レイヤー切り替え
window.setAnatomyView = (viewName) => {
  anatomy.setCameraView(viewName);
};

window.toggleHeart3D = () => {
  const visible = anatomy.toggleHeartVisibility();
  const btn = document.getElementById('btn-toggle-heart');
  if (btn) {
    btn.textContent = visible ? '心臓: ON' : '心臓: OFF';
    btn.classList.toggle('bg-rose-900/80', visible);
    btn.classList.toggle('text-rose-200', visible);
    btn.classList.toggle('bg-slate-800', !visible);
    btn.classList.toggle('text-slate-400', !visible);
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

engine.onCycleFinished = ({ ppeak, pplat, vte }) => {
  const elPeak = document.getElementById('val-ppeak');
  const elPlat = document.getElementById('val-pplat');
  const elVte = document.getElementById('val-vte');
  if (elPeak) elPeak.textContent = ppeak;
  if (elPlat) elPlat.textContent = pplat !== null ? pplat : '-';
  if (elVte) elVte.textContent = vte;
  
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

  const params = {
    mode: modeEl ? modeEl.value : 'AC',
    ctrlType: ctrlTypeEl ? ctrlTypeEl.value : 'PCV',
    flowPat: flowPatEl ? flowPatEl.value : 'SQUARE',
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
    R: parseFloat(document.getElementById('sl-res').value)
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
  document.getElementById('lbl-spont-rr').textContent = params.spontRR === 0 ? '0 /分 (なし)' : `${params.spontRR} /分`;
  document.getElementById('lbl-pmus').textContent = `${params.pmusMax} cmH2O`;
  document.getElementById('lbl-comp').textContent = `${params.C} mL/cmH2O`;
  document.getElementById('lbl-res').textContent = `${params.R} cmH2O/L/s`;

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
}

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
    monitor.pushSample(sample);
    monitor.render(engine.params.peep, false);
    anatomy.render(engine, engine.params, now);

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
    // 一時停止中も波形モニターのカーソル計測＆3Dカメラ操作（マウス回転・ズーム）を継続描画
    monitor.render(engine.params.peep, true);
    anatomy.controls.update();
    anatomy.renderer.render(anatomy.scene, anatomy.camera);
  }

  requestAnimationFrame(loop);
}

syncUI();
requestAnimationFrame(loop);
