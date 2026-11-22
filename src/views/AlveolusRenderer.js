import { clamp } from '../models/PathologyMechanics.js';
import { BloodGasEngine } from '../models/BloodGasEngine.js';

/**
 * 肺胞ズーム（ミクロ動態・ガス交換）リアルタイム HTML5 Canvas レンダラー
 * - 対象 Canvas: #alveolusCanvas (360x320)
 * - パフォーマンス保護: ポップアップ非表示時は render() が呼ばれず CPU/GPU 負荷ゼロ
 * - 初回表示時に肺胞アトラス断面画像を遅延ロードし、白背景を外周フラッドフィル透過キャッシュ
 */
export class AlveolusRenderer {
  constructor(canvasElement, imagePath = './assets/Gemini_Generated_Image_26gyzs26gyzs26gy.png') {
    this.canvas = canvasElement;
    this.ctx = canvasElement.getContext('2d');
    this.width = canvasElement.width || 360;
    this.height = canvasElement.height || 320;
    this.imagePath = imagePath;

    // 遅延ロード＆透過済みオフスクリーンキャッシュ
    this.alveolusPart = null;
    this.loading = false;
    this.loaded = false;
    this.loadError = null;

    // 滑らかな補間用状態値
    this.smoothPalv = 5.0;
    this.smoothPeep = 5.0;
    this.smoothFlow = 0.0;
    this.smoothAtel = 0.0;
    this.smoothEdema = 0.0;
    this.smoothShunt = 0.04;
    this.smoothPaO2 = 175.0;
    this.smoothPaCO2 = 40.0;

    // 継続アニメーション用タイマー
    this.simClock = 0;
    this.heartPhase = 0;

    // 肺胞画像の描画基準サイズ（ローカル座標中心 0,0 / 4:3比率）
    this.imgW = 308;
    this.imgH = 231;

    // 毛細血管の外周円弧パス（左上の肺動脈入口 → 左外周 → 下部 → 右外周 → 右上の肺静脈出口）
    this.capillaryPaths = [
      this._buildSmoothPath([
        { x: -58, y: -112 },
        { x: -72, y: -84 },
        { x: -102, y: -46 },
        { x: -112, y: 8 },
        { x: -94, y: 64 },
        { x: -46, y: 98 },
        { x: 6, y: 108 },
        { x: 62, y: 98 },
        { x: 102, y: 58 },
        { x: 112, y: 4 },
        { x: 96, y: -52 },
        { x: 66, y: -86 },
        { x: 36, y: -112 }
      ], 140),
      // やや内側を走るサブ毛細血管ループ
      this._buildSmoothPath([
        { x: -52, y: -108 },
        { x: -64, y: -76 },
        { x: -92, y: -38 },
        { x: -100, y: 12 },
        { x: -80, y: 58 },
        { x: -34, y: 90 },
        { x: 12, y: 98 },
        { x: 56, y: 86 },
        { x: 92, y: 46 },
        { x: 100, y: -6 },
        { x: 84, y: -56 },
        { x: 56, y: -84 },
        { x: 32, y: -108 }
      ], 140)
    ];

    // 5つの肺胞内腔（浸出液クリップ＆ガスパーティクル滞留エリア）
    this.cavities = [
      { x: -50, y: -30, rx: 28, ry: 28 }, // 左上
      { x: -54, y: 26, rx: 27, ry: 27 },  // 左下
      { x: -2, y: 52, rx: 35, ry: 31 },   // 中央下
      { x: 56, y: 34, rx: 29, ry: 27 },   // 右下
      { x: 46, y: -28, rx: 29, ry: 25 },  // 右上
      { x: 2, y: -18, rx: 24, ry: 36 }    // 中央肺胞管
    ];

    // 赤血球パーティクル初期化
    this.rbcs = this._initRBCs();
    // 浸出液の気泡パーティクル初期化
    this.bubbles = this._initBubbles();
    // O2・CO2 ガス拡散パーティクル初期化
    this.o2Particles = this._initO2Particles();
    this.co2Particles = this._initCO2Particles();
  }

  /**
   * ポップアップ初回オープン時にのみ画像を遅延ロード
   */
  ensureLoaded() {
    if (this.loaded || this.loading) return;
    this.loading = true;
    const img = new Image();
    img.onload = () => {
      try {
        this.alveolusPart = this._prepareTransparentCanvas(img, 580);
        this.loaded = true;
      } catch (err) {
        console.error('肺胞画像の前処理失敗:', err);
        this.alveolusPart = img;
        this.loaded = true;
      } finally {
        this.loading = false;
      }
    };
    img.onerror = () => {
      this.loadError = `画像読み込み失敗: ${this.imagePath}`;
      this.loading = false;
      console.error(this.loadError);
    };
    img.src = this.imagePath;
  }

  /**
   * 白背景を外周フラッドフィルで綺麗に透過化したオフスクリーン Canvas を 1 回だけ生成
   */
  _prepareTransparentCanvas(img, maxDim) {
    const scale = Math.min(1.0, maxDim / Math.max(img.width, img.height));
    const dw = Math.max(1, Math.round(img.width * scale));
    const dh = Math.max(1, Math.round(img.height * scale));

    const off = document.createElement('canvas');
    off.width = dw;
    off.height = dh;
    const octx = off.getContext('2d', { willReadFrequently: true });
    octx.drawImage(img, 0, 0, dw, dh);

    const imgData = octx.getImageData(0, 0, dw, dh);
    const data = imgData.data;

    const isWhiteBg = (idx) => {
      if (data[idx + 3] < 15) return true;
      return data[idx] > 236 && data[idx + 1] > 236 && data[idx + 2] > 236;
    };

    const corners = [
      0,
      (dw - 1) * 4,
      ((dh - 1) * dw) * 4,
      ((dh - 1) * dw + (dw - 1)) * 4
    ];
    const needsRemoval = corners.some((idx) => data[idx + 3] > 20 && isWhiteBg(idx));

    if (needsRemoval) {
      const visited = new Uint8Array(dw * dh);
      const queue = new Int32Array(dw * dh);
      let head = 0;
      let tail = 0;

      const tryPush = (x, y) => {
        const pos = y * dw + x;
        if (visited[pos]) return;
        if (isWhiteBg(pos * 4)) {
          visited[pos] = 1;
          queue[tail++] = pos;
        }
      };

      for (let x = 0; x < dw; x++) {
        tryPush(x, 0);
        tryPush(x, dh - 1);
      }
      for (let y = 0; y < dh; y++) {
        tryPush(0, y);
        tryPush(dw - 1, y);
      }

      while (head < tail) {
        const pos = queue[head++];
        const x = pos % dw;
        const y = (pos - x) / dw;
        data[pos * 4 + 3] = 0;

        if (x > 0) tryPush(x - 1, y);
        if (x < dw - 1) tryPush(x + 1, y);
        if (y > 0) tryPush(x, y - 1);
        if (y < dh - 1) tryPush(x, y + 1);
      }

      // 外周フチの軽いアンチエイリアス馴染ませ
      for (let y = 1; y < dh - 1; y++) {
        for (let x = 1; x < dw - 1; x++) {
          const pos = y * dw + x;
          if (visited[pos]) continue;
          const idx = pos * 4;
          const r = data[idx];
          const g = data[idx + 1];
          const b = data[idx + 2];
          if (r > 215 && g > 215 && b > 215) {
            if (visited[pos - 1] || visited[pos + 1] || visited[pos - dw] || visited[pos + dw]) {
              const lum = (r + g + b) / 3;
              const fade = clamp((245 - lum) / 30, 0, 1);
              data[idx + 3] = Math.round(data[idx + 3] * fade);
            }
          }
        }
      }

      octx.putImageData(imgData, 0, 0);
    }

    return off;
  }

  /**
   * 制御点列から等距離サンプリング済みの滑らかなパスを生成
   */
  _buildSmoothPath(ctrlPts, samples = 120) {
    const raw = [];
    const n = ctrlPts.length;
    const stepsPerSeg = Math.max(4, Math.ceil(samples / (n - 1)));

    for (let i = 0; i < n - 1; i++) {
      const p0 = ctrlPts[Math.max(0, i - 1)];
      const p1 = ctrlPts[i];
      const p2 = ctrlPts[i + 1];
      const p3 = ctrlPts[Math.min(n - 1, i + 2)];
      for (let s = 0; s < stepsPerSeg; s++) {
        const t = s / stepsPerSeg;
        const t2 = t * t;
        const t3 = t2 * t;
        const x = 0.5 * (
          (2 * p1.x) +
          (-p0.x + p2.x) * t +
          (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 +
          (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3
        );
        const y = 0.5 * (
          (2 * p1.y) +
          (-p0.y + p2.y) * t +
          (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 +
          (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3
        );
        raw.push({ x, y });
      }
    }
    raw.push(ctrlPts[n - 1]);

    // 累積弧長で等速サンプリングできるよう距離テーブルを付与
    let totalLen = 0;
    const lengths = [0];
    for (let i = 1; i < raw.length; i++) {
      const dx = raw[i].x - raw[i - 1].x;
      const dy = raw[i].y - raw[i - 1].y;
      totalLen += Math.hypot(dx, dy);
      lengths.push(totalLen);
    }

    const res = [];
    for (let k = 0; k <= samples; k++) {
      const target = (k / samples) * totalLen;
      let idx = 0;
      while (idx < lengths.length - 2 && lengths[idx + 1] < target) idx++;
      const segLen = Math.max(0.0001, lengths[idx + 1] - lengths[idx]);
      const frac = (target - lengths[idx]) / segLen;
      const x = raw[idx].x + (raw[idx + 1].x - raw[idx].x) * frac;
      const y = raw[idx].y + (raw[idx + 1].y - raw[idx].y) * frac;
      const angle = Math.atan2(raw[idx + 1].y - raw[idx].y, raw[idx + 1].x - raw[idx].x);
      res.push({ x, y, angle });
    }
    return res;
  }

  _samplePath(path, u) {
    const clamped = clamp(u, 0, 1);
    const f = clamped * (path.length - 1);
    const i = Math.min(path.length - 2, Math.floor(f));
    const frac = f - i;
    const a = path[i];
    const b = path[i + 1];
    return {
      x: a.x + (b.x - a.x) * frac,
      y: a.y + (b.y - a.y) * frac,
      angle: a.angle
    };
  }

  _initRBCs() {
    const list = [];
    const total = 18;
    for (let i = 0; i < total; i++) {
      list.push({
        pathIdx: i % 2,
        t: i / total,
        speedMul: 0.90 + (i % 5) * 0.05,
        sizeMul: 0.92 + (i % 3) * 0.08
      });
    }
    return list;
  }

  _initBubbles() {
    const list = [];
    for (let i = 0; i < 24; i++) {
      list.push({
        x: -74 + (i * 37) % 148,
        yFrac: ((i * 29) % 100) / 100,
        r: 1.8 + (i % 4) * 0.9,
        phase: i * 1.13,
        speed: 0.55 + (i % 5) * 0.14
      });
    }
    return list;
  }

  _initO2Particles() {
    const list = [];
    const maxCount = 46;
    for (let i = 0; i < maxCount; i++) {
      const isDiffusing = i % 3 === 0;
      const cav = this.cavities[i % 5];
      const ang = (i * 2.39996) % (Math.PI * 2);
      list.push({
        mode: isDiffusing ? 'diffuse' : 'float',
        cavityIdx: i % 5,
        x: cav.x + Math.cos(ang) * (cav.rx * 0.5),
        y: cav.y + Math.sin(ang) * (cav.ry * 0.5),
        vx: (Math.cos(ang * 1.7) * 18),
        vy: (Math.sin(ang * 1.3) * 18),
        diffProg: (i / maxCount),
        targetU: 0.22 + ((i * 0.17) % 0.62), // 毛細血管のガス交換帯 (0.22〜0.84)
        phase: i * 0.77
      });
    }
    return list;
  }

  _initCO2Particles() {
    const list = [];
    const maxCount = 24;
    for (let i = 0; i < maxCount; i++) {
      list.push({
        u: 0.18 + ((i * 0.13) % 0.62),
        prog: (i / maxCount),
        drift: ((i % 7) - 3) * 4.5,
        phase: i * 1.31
      });
    }
    return list;
  }

  /**
   * 静脈血(暗赤紫) → 動脈血(鮮紅) の色補間（シャント率・酸素化効率を反映）
   */
  _lerpBloodColor(progress, oxyEfficiency) {
    // ガス交換帯 (0.20〜0.82) で酸素化が進む
    const exchange = clamp((progress - 0.20) / 0.62, 0, 1);
    // シャントが高いほど酸素化上限が抑えられ、暗い色のまま通過する
    const oxyLevel = exchange * oxyEfficiency;

    // 静脈血 (#6b21a8〜#7f1d1d の中間: rgb(118, 28, 92)) → 暗赤 (#991b1b) → 鮮動脈血 (#ef4444)
    let r, g, b;
    if (oxyLevel < 0.45) {
      const k = oxyLevel / 0.45;
      r = Math.round(112 + (158 - 112) * k);
      g = Math.round(29 + (32 - 29) * k);
      b = Math.round(126 + (54 - 126) * k);
    } else {
      const k = (oxyLevel - 0.45) / 0.55;
      r = Math.round(158 + (242 - 158) * k);
      g = Math.round(32 + (72 - 32) * k);
      b = Math.round(54 + (72 - 54) * k);
    }
    return `rgb(${r}, ${g}, ${b})`;
  }

  /**
   * 現在のミクロ生理状態を評価し、ミニバー用のステータス情報を返す
   */
  evaluateStatus(engine, params, abg) {
    const palv = engine?.Palv ?? params?.peep ?? 5;
    const peep = params?.peep ?? 5;
    const effAtel = engine?.pathology?.effectiveAtel ?? 0;
    const effEdema = engine?.pathology?.effectiveEdema ?? 0;
    const paO2 = abg?.paO2 ?? 100;

    if (palv >= 30.0) {
      return { text: '過膨張 (VILIリスク)', level: 'danger' };
    }
    if (effAtel >= 0.26 && peep <= 9) {
      return { text: '虚脱リスク (無気肺)', level: 'warn' };
    }
    if (effAtel >= 0.38) {
      return { text: '無気肺・シャント増加', level: 'warn' };
    }
    if (effEdema >= 0.30) {
      return { text: '浸出液貯留 (拡散障害)', level: 'info' };
    }
    if (paO2 < 60) {
      return { text: '低酸素血症リスク', level: 'danger' };
    }
    return { text: '正常', level: 'ok' };
  }

  /**
   * 1フレーム描画（ポップアップが開いているときのみ main.js から呼び出される）
   */
  render(engine, params, abg, now, dt, paused = false) {
    this.ensureLoaded();

    const safeDt = paused ? 0 : clamp(dt || 0.016, 0.001, 0.05);
    this.simClock += safeDt;

    const palv = engine?.Palv ?? params?.peep ?? 5;
    const peep = params?.peep ?? 5;
    const fio2 = clamp(params?.fio2 ?? 40, 21, 100);
    const hr = clamp(params?.hr ?? 75, 40, 140);
    const flow = engine?.Flow ?? 0; // L/s
    const effAtel = engine?.pathology?.effectiveAtel ?? 0;
    const effEdema = engine?.pathology?.effectiveEdema ?? 0;
    const paO2 = abg?.paO2 ?? 175;
    const paCO2 = abg?.paCO2 ?? 40;
    const shunt = abg?.shunt ?? (0.04 + effAtel * 0.26 + effEdema * 0.27);

    // 滑らか補間（一時停止中でもスライダー変更は即反映されるようにする）
    const lerpRate = paused ? 0.25 : clamp(safeDt * 12, 0.08, 0.35);
    this.smoothPalv += (palv - this.smoothPalv) * lerpRate;
    this.smoothPeep += (peep - this.smoothPeep) * lerpRate;
    this.smoothFlow += (flow - this.smoothFlow) * lerpRate;
    this.smoothAtel += (effAtel - this.smoothAtel) * lerpRate;
    this.smoothEdema += (effEdema - this.smoothEdema) * lerpRate;
    this.smoothShunt += (shunt - this.smoothShunt) * lerpRate;
    this.smoothPaO2 += (paO2 - this.smoothPaO2) * lerpRate;
    this.smoothPaCO2 += (paCO2 - this.smoothPaCO2) * lerpRate;

    // 心拍位相（HR 連動）
    this.heartPhase += safeDt * (hr / 60.0) * Math.PI * 2;

    const ctx = this.ctx;
    const W = this.width;
    const H = this.height;
    const cx = W * 0.5;
    const cy = H * 0.52;

    // 1. 背景（ダーク・マイクロスコープ背景）
    ctx.clearRect(0, 0, W, H);
    const bgGrad = ctx.createRadialGradient(cx, cy - 12, 18, cx, cy, W * 0.65);
    bgGrad.addColorStop(0, '#132036');
    bgGrad.addColorStop(0.6, '#0a1222');
    bgGrad.addColorStop(1, '#040812');
    ctx.fillStyle = bgGrad;
    ctx.fillRect(0, 0, W, H);

    // 薄い顕微鏡スケールグリッド
    ctx.save();
    ctx.strokeStyle = 'rgba(56, 189, 248, 0.06)';
    ctx.lineWidth = 1;
    for (let gx = 30; gx < W; gx += 30) {
      ctx.beginPath();
      ctx.moveTo(gx, 0);
      ctx.lineTo(gx, H);
      ctx.stroke();
    }
    for (let gy = 30; gy < H; gy += 30) {
      ctx.beginPath();
      ctx.moveTo(0, gy);
      ctx.lineTo(W, gy);
      ctx.stroke();
    }
    ctx.restore();

    // 2. 肺胞の膨張・虚脱・過膨張スケール計算
    // 基準(Palv=5)→0.92、吸気(Palv=20)→1.03、高圧(Palv=35)→1.13
    const pressureNorm = clamp((this.smoothPalv - 5.0) / 28.0, -0.10, 0.24);
    let scaleX = 0.93 + pressureNorm * 0.85;
    let scaleY = 0.93 + pressureNorm * 0.85;

    // 無気肺（effectiveAtel 高）かつ低PEEP・呼気終末時の虚脱（縦横比を潰す＆吸気時の引き剥がし開口）
    const lowPeepFactor = clamp((13.0 - this.smoothPeep) / 9.0, 0.15, 1.0);
    const endExpFactor = clamp((15.0 - this.smoothPalv) / 11.0, 0.0, 1.0);
    // 非線形カーブで「呼気終末にペシャンコ→吸気時にグッと引き剥がされる」動きを強調
    const collapseAmount = this.smoothAtel * lowPeepFactor * Math.pow(endExpFactor, 1.35);
    scaleY *= (1.0 - collapseAmount * 0.34);
    scaleX *= (1.0 - collapseAmount * 0.10);

    const isOverdistended = this.smoothPalv >= 30.0;
    const pulse = 0.5 + 0.5 * Math.sin((now || 0) * 0.011);

    // 3. 肺胞ローカル座標系へ変換して描画（全ミクロ演出が膨張・虚脱に完全追従）
    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(scaleX, scaleY);

    // 3-a. 過膨張時の赤いパルス警告グロー（肺胞輪郭の背後＆周囲）
    if (isOverdistended) {
      const overSeverity = clamp((this.smoothPalv - 30.0) / 15.0, 0.35, 1.0);
      const glowAlpha = (0.34 + pulse * 0.38) * overSeverity;
      const rad = ctx.createRadialGradient(0, 6, 72, 0, 6, 156);
      rad.addColorStop(0, `rgba(239, 68, 68, ${glowAlpha * 0.35})`);
      rad.addColorStop(0.68, `rgba(239, 68, 68, ${glowAlpha})`);
      rad.addColorStop(1, 'rgba(239, 68, 68, 0)');
      ctx.fillStyle = rad;
      ctx.beginPath();
      ctx.arc(0, 6, 156, 0, Math.PI * 2);
      ctx.fill();
    }

    // 3-b. 肺胞・毛細血管断面画像（透過済み）
    if (this.alveolusPart) {
      ctx.save();
      ctx.shadowColor = isOverdistended
        ? `rgba(239, 68, 68, ${0.55 + pulse * 0.35})`
        : 'rgba(2, 6, 23, 0.72)';
      ctx.shadowBlur = isOverdistended ? 22 : 14;
      ctx.drawImage(this.alveolusPart, -this.imgW / 2, -this.imgH / 2, this.imgW, this.imgH);
      ctx.restore();
    } else {
      // ロード中の仮プレースホルダ
      ctx.fillStyle = 'rgba(148, 163, 184, 0.25)';
      ctx.beginPath();
      ctx.arc(0, 12, 92, 0, Math.PI * 2);
      ctx.fill();
    }

    // 3-c. 無気肺による虚脱陰影（内腔の虚脱・換気低下の視覚化）
    if (collapseAmount > 0.06) {
      ctx.save();
      this._traceAlveolarCavities(ctx);
      ctx.clip();
      ctx.fillStyle = `rgba(76, 29, 149, ${clamp(collapseAmount * 0.42, 0, 0.38)})`;
      ctx.fillRect(-130, -110, 260, 220);
      ctx.restore();
    }

    // 3-d. 肺胞内浸出液（肺水腫・ARDS 連動：effectiveEdema に応じて水位＆泡を描画）
    if (this.smoothEdema > 0.02) {
      this._drawEdemaFluid(ctx, this.smoothEdema, safeDt);
    }

    // 3-e. O2（水色）および CO2（黄色）のガス拡散パーティクル
    this._drawGasParticles(ctx, fio2, safeDt);

    // 3-f. 毛細血管の赤血球フロー（HR連動の拍動流＆シャント・酸素化カラー変化）
    this._drawCapillaryRBCs(ctx, hr, safeDt);

    // 3-g. 過膨張時の輪郭パルス警告リング（前面ハイライト）
    if (isOverdistended) {
      ctx.save();
      ctx.strokeStyle = `rgba(248, 113, 113, ${0.48 + pulse * 0.45})`;
      ctx.lineWidth = 2.6 + pulse * 1.4;
      ctx.setLineDash([7, 5]);
      ctx.beginPath();
      ctx.ellipse(0, 8, 116, 102, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }

    ctx.restore();

    // 4. HUD ラベル（静脈血→動脈血の方向ガイド・顕微鏡倍率・警告バッジ）
    this._drawOverlayHUD(ctx, W, H, isOverdistended, collapseAmount, pulse);
  }

  /**
   * 5つの肺胞内腔を合わせたクリッピングパスを作成
   */
  _traceAlveolarCavities(ctx) {
    ctx.beginPath();
    for (let i = 0; i < this.cavities.length; i++) {
      const c = this.cavities[i];
      ctx.moveTo(c.x + c.rx, c.y);
      ctx.ellipse(c.x, c.y, c.rx, c.ry, 0, 0, Math.PI * 2);
    }
  }

  /**
   * 肺胞内腔の浸出液レイヤー＋揺れるメニスカス＋微細な泡
   */
  _drawEdemaFluid(ctx, effEdema, dt) {
    ctx.save();
    this._traceAlveolarCavities(ctx);
    ctx.clip();

    // 肺胞内腔の下端 (+86) から上端 (-60) までの水位
    const bottomY = 88;
    const topY = -54;
    const fillRatio = clamp(effEdema * 0.92, 0, 0.92);
    const surfaceY = bottomY - (bottomY - topY) * fillRatio;

    // 揺れる水面（メニスカス曲線）
    ctx.beginPath();
    ctx.moveTo(-115, bottomY + 12);
    ctx.lineTo(-115, surfaceY);
    for (let x = -115; x <= 115; x += 10) {
      const wave =
        Math.sin(x * 0.075 + this.simClock * 2.8) * 2.6 +
        Math.cos(x * 0.045 - this.simClock * 1.9) * 1.4;
      ctx.lineTo(x, surfaceY + wave);
    }
    ctx.lineTo(115, bottomY + 12);
    ctx.closePath();

    const fluidGrad = ctx.createLinearGradient(0, surfaceY - 4, 0, bottomY);
    fluidGrad.addColorStop(0, `rgba(186, 230, 253, ${0.46 + fillRatio * 0.20})`);
    fluidGrad.addColorStop(0.35, `rgba(125, 211, 252, ${0.52 + fillRatio * 0.22})`);
    fluidGrad.addColorStop(1, `rgba(14, 116, 144, ${0.68 + fillRatio * 0.18})`);
    ctx.fillStyle = fluidGrad;
    ctx.fill();

    // 水面の明るいハイライトライン
    ctx.strokeStyle = 'rgba(224, 242, 254, 0.82)';
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    for (let x = -110; x <= 110; x += 10) {
      const wave =
        Math.sin(x * 0.075 + this.simClock * 2.8) * 2.6 +
        Math.cos(x * 0.045 - this.simClock * 1.9) * 1.4;
      if (x === -110) ctx.moveTo(x, surfaceY + wave);
      else ctx.lineTo(x, surfaceY + wave);
    }
    ctx.stroke();

    // 微細な泡（気泡パーティクル）
    const activeBubbles = Math.max(4, Math.round(this.bubbles.length * fillRatio));
    for (let i = 0; i < activeBubbles; i++) {
      const b = this.bubbles[i];
      if (dt > 0) {
        b.yFrac -= dt * b.speed * 0.28;
        if (b.yFrac < 0.03) b.yFrac = 0.96;
      }
      const bx = b.x + Math.sin(this.simClock * 2.4 + b.phase) * 3.5;
      const by = surfaceY + 4 + b.yFrac * Math.max(8, bottomY - surfaceY - 6);
      ctx.beginPath();
      ctx.arc(bx, by, b.r, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(240, 249, 255, 0.45)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.78)';
      ctx.lineWidth = 0.8;
      ctx.stroke();
    }

    ctx.restore();
  }

  /**
   * 毛細血管の赤血球フローと酸素化グラデーション（HR・シャント率連動）
   */
  _drawCapillaryRBCs(ctx, hr, dt) {
    // 心拍数に連動した基本速度＋心拍拍動パルス
    const beatPulse = 0.78 + 0.44 * Math.pow(Math.max(0, Math.sin(this.heartPhase)), 2);
    const baseSpeed = (hr / 75.0) * 0.145 * beatPulse;

    // 酸素化達成効率：シャント率が高い・PaO2(SaO2)が低いほど暗い色のまま通過
    const sao2 = BloodGasEngine.sao2FromPo2(this.smoothPaO2);
    const shuntPenalty = clamp(this.smoothShunt * 1.35, 0.04, 0.82);
    const oxyEfficiency = clamp(sao2 * (1.0 - shuntPenalty * 0.75), 0.12, 1.0);

    for (let i = 0; i < this.rbcs.length; i++) {
      const rbc = this.rbcs[i];
      if (dt > 0) {
        rbc.t = (rbc.t + dt * baseSpeed * rbc.speedMul) % 1.0;
      }
      const path = this.capillaryPaths[rbc.pathIdx];
      const pt = this._samplePath(path, rbc.t);
      const color = this._lerpBloodColor(rbc.t, oxyEfficiency);

      ctx.save();
      ctx.translate(pt.x, pt.y);
      ctx.rotate(pt.angle);

      const rx = 5.4 * rbc.sizeMul;
      const ry = 3.2 * rbc.sizeMul;

      // 赤血球本体（楕円ディスク）
      ctx.beginPath();
      ctx.ellipse(0, 0, rx, ry, 0, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.shadowColor = 'rgba(0, 0, 0, 0.55)';
      ctx.shadowBlur = 3;
      ctx.fill();

      // 赤血球の縁取りと中央の両凹ハイライト
      ctx.lineWidth = 0.8;
      ctx.strokeStyle = 'rgba(255, 228, 230, 0.45)';
      ctx.stroke();

      ctx.beginPath();
      ctx.ellipse(0, 0, rx * 0.48, ry * 0.42, 0, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255, 255, 255, 0.24)';
      ctx.fill();

      ctx.restore();
    }
  }

  /**
   * O2（水色：FiO2連動）と CO2（黄色：換気量・PaCO2連動）のガス拡散パーティクル
   */
  _drawGasParticles(ctx, fio2, dt) {
    // 1. O2 分子（水色）：FiO2 21%→12個、100%→46個
    const o2Count = Math.round(12 + ((fio2 - 21) / 79) * (this.o2Particles.length - 12));
    // 浸出液や無気肺が強いと拡散速度が低下（拡散障害）
    const diffusionEase = clamp(1.0 - this.smoothEdema * 0.65 - this.smoothAtel * 0.45, 0.18, 1.0);
    const inspPush = clamp(this.smoothFlow * 26, -12, 22);

    for (let i = 0; i < o2Count; i++) {
      const p = this.o2Particles[i];
      if (p.mode === 'diffuse') {
        // 肺胞内腔から外周毛細血管への拡散移動
        if (dt > 0) {
          p.diffProg += dt * (0.28 + 0.34 * diffusionEase);
          if (p.diffProg >= 1.0) {
            p.diffProg -= 1.0;
          }
        }
        const target = this._samplePath(this.capillaryPaths[1], p.targetU);
        const startX = target.x * 0.42;
        const startY = target.y * 0.42 + 6;
        const px = startX + (target.x - startX) * p.diffProg;
        const py = startY + (target.y - startY) * p.diffProg;
        const alpha = Math.sin(p.diffProg * Math.PI) * (0.45 + 0.50 * diffusionEase);

        ctx.beginPath();
        ctx.arc(px, py, 2.4, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(56, 189, 248, ${alpha.toFixed(2)})`;
        ctx.fill();
      } else {
        // 肺胞内腔を漂う O2 粒子
        const cav = this.cavities[p.cavityIdx];
        if (dt > 0) {
          p.x += (p.vx + Math.sin(this.simClock * 2.2 + p.phase) * 10) * dt;
          p.y += (p.vy + inspPush * 0.45) * dt;
          const dx = p.x - cav.x;
          const dy = p.y - cav.y;
          const norm = Math.hypot(dx / (cav.rx * 0.78), dy / (cav.ry * 0.78));
          if (norm > 1.0) {
            p.x = cav.x + (dx / norm) * 0.96;
            p.y = cav.y + (dy / norm) * 0.96;
            p.vx = -p.vx * 0.85;
            p.vy = -p.vy * 0.85;
          }
        }
        ctx.beginPath();
        ctx.arc(p.x, p.y, 2.2, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(125, 211, 252, 0.88)';
        ctx.fill();
        ctx.beginPath();
        ctx.arc(p.x - 0.6, p.y - 0.6, 0.8, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
        ctx.fill();
      }
    }

    // 2. CO2 分子（黄色）：毛細血管側から肺胞内へ排出→呼気相で上部気道へ洗い流される
    // PaCO2 が高いほど滞留個数が増え、呼気フローが強いほど排出速度が上がる
    const co2Ratio = clamp((this.smoothPaCO2 - 22) / 52, 0.25, 1.0);
    const co2Count = Math.round(6 + co2Ratio * (this.co2Particles.length - 6));
    const exhWashout = this.smoothFlow < -0.05 ? clamp(-this.smoothFlow * 0.9, 0.2, 1.2) : 0.18;

    for (let i = 0; i < co2Count; i++) {
      const c = this.co2Particles[i];
      if (dt > 0) {
        c.prog += dt * (0.22 + exhWashout * 0.36);
        if (c.prog >= 1.0) c.prog -= 1.0;
      }

      const startPt = this._samplePath(this.capillaryPaths[1], c.u);
      const midX = startPt.x * 0.35 + c.drift;
      const midY = startPt.y * 0.35 + 4;
      const exitX = 4 + c.drift * 0.6;
      const exitY = -108;

      let cxPos, cyPos;
      if (c.prog < 0.55) {
        // 毛細血管 → 肺胞内腔へ拡散排出
        const k = c.prog / 0.55;
        cxPos = startPt.x + (midX - startPt.x) * k;
        cyPos = startPt.y + (midY - startPt.y) * k;
      } else {
        // 肺胞内腔 → 上部の細気管支（呼気出口）へ上昇
        const k = (c.prog - 0.55) / 0.45;
        cxPos = midX + (exitX - midX) * k;
        cyPos = midY + (exitY - midY) * k;
      }

      const alpha = Math.sin(c.prog * Math.PI) * 0.90;
      ctx.beginPath();
      ctx.arc(cxPos, cyPos, 2.3, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(250, 204, 21, ${alpha.toFixed(2)})`;
      ctx.fill();
    }
  }

  /**
   * Canvas 四隅のコンパクトなマイクロHUDガイド
   */
  _drawOverlayHUD(ctx, W, H, isOverdistended, collapseAmount, pulse) {
    ctx.save();
    ctx.font = 'bold 10px "Segoe UI", Meiryo, sans-serif';

    // 左上：静脈血（肺動脈）ラベル
    ctx.fillStyle = 'rgba(168, 85, 247, 0.90)';
    ctx.fillText('↓ 静脈血 (肺動脈)', 10, 18);

    // 右上：動脈血（肺静脈）ラベル
    ctx.textAlign = 'right';
    ctx.fillStyle = 'rgba(248, 113, 113, 0.92)';
    ctx.fillText('↑ 動脈血 (肺静脈)', W - 10, 18);

    // 左下：マイクロ倍率
    ctx.textAlign = 'left';
    ctx.fillStyle = 'rgba(148, 163, 184, 0.72)';
    ctx.fillText('MICRO VIEW ×400', 10, H - 9);

    // 右下：動的警告インジケーター
    ctx.textAlign = 'right';
    if (isOverdistended) {
      ctx.fillStyle = `rgba(252, 165, 165, ${(0.72 + pulse * 0.28).toFixed(2)})`;
      ctx.fillText('⚠ 過膨張警告 (Palv ≥ 30)', W - 10, H - 9);
    } else if (collapseAmount > 0.16) {
      ctx.fillStyle = 'rgba(251, 191, 36, 0.92)';
      ctx.fillText('⚠ 呼気終末虚脱 (低PEEP)', W - 10, H - 9);
    } else if (this.smoothEdema > 0.22) {
      ctx.fillStyle = 'rgba(125, 211, 252, 0.92)';
      ctx.fillText('💧 浸出液による拡散障害', W - 10, H - 9);
    }

    ctx.restore();
  }
}
