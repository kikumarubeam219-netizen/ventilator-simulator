import { clamp, computePathologyMechanics } from '../models/PathologyMechanics.js';

/**
 * 画像診断・EITモニタリング（胸部Xp / 胸部CT / PulmoVista 500風 EIT）統合レンダラー
 * - パフォーマンス保護: アクティブタブの Canvas のみ描画（非表示時・非アクティブタブは完全スキップ）
 * - ベース画像（chest_xp.webp / chest_ct.webp）は初回表示時に遅延ロード・キャッシュ
 * - EIT は 48x40 軽量グリッドで計算し、バイリニア補間で滑らかかつ高速に描画
 */
export class ImagingEitRenderer {
  constructor({ xpCanvas, ctCanvas, eitCanvas }) {
    this.xpCanvas = xpCanvas;
    this.ctCanvas = ctCanvas;
    this.eitCanvas = eitCanvas;

    this.xpCtx = xpCanvas ? xpCanvas.getContext('2d') : null;
    this.ctCtx = ctCanvas ? ctCanvas.getContext('2d') : null;
    this.eitCtx = eitCanvas ? eitCanvas.getContext('2d') : null;

    // ベース画像（遅延ロード）
    this.xpImg = null;
    this.ctImg = null;
    this.xpLoaded = false;
    this.ctLoaded = false;
    this.imagesRequested = false;

    // EIT 軽量グリッド用オフスクリーン Canvas (48x40)
    this.gridW = 48;
    this.gridH = 40;
    this.eitOff = document.createElement('canvas');
    this.eitOff.width = this.gridW;
    this.eitOff.height = this.gridH;
    this.eitOffCtx = this.eitOff.getContext('2d');
    this.eitImageData = this.eitOffCtx.createImageData(this.gridW, this.gridH);

    // EIT 肺野マスク（事前計算で毎フレーム負荷を削減）
    this._initEitLungMask();

    // 滑らかなアニメーション補間値
    this.smoothV = 0;
    this.smoothPaw = 5;
    this.smoothPeep = 5;
    this.smoothAutoPeep = 0;

    // 最新 EIT 数値
    this.lastEitMetrics = {
      roi: [25, 25, 25, 25],
      cov: 50.0,
      rightPct: 50,
      leftPct: 50,
      overdistension: 0
    };
  }

  /**
   * ベース画像の遅延ロード（ポップアップ初回オープン時に一度だけ実行）
   */
  ensureImagesLoaded() {
    if (this.imagesRequested) return;
    this.imagesRequested = true;

    const load = (src, onDone) => {
      const img = new Image();
      img.onload = () => onDone(img);
      img.onerror = (e) => console.error('画像診断ベース読込エラー:', src, e);
      img.src = src;
    };

    load('./assets/chest_xp.webp', (img) => {
      this.xpImg = img;
      this.xpLoaded = true;
    });
    load('./assets/chest_ct.webp', (img) => {
      this.ctImg = img;
      this.ctLoaded = true;
    });
  }

  /**
   * EIT 用：胸郭楕円内の左右肺野マスク（重み 0.0〜1.0）を事前計算
   * 座標系: nx (-1〜+1, 左=右肺, 右=左肺), ny (-1〜+1, 上=腹側, 下=背側)
   */
  _initEitLungMask() {
    const W = this.gridW;
    const H = this.gridH;
    this.maskRight = new Float32Array(W * H);
    this.maskLeft = new Float32Array(W * H);
    this.maskYNorm = new Float32Array(W * H); // 0.0(腹側) ～ 1.0(背側)

    for (let y = 0; y < H; y++) {
      const ny = (y / (H - 1)) * 2 - 1; // -1(上/腹側) ～ +1(下/背側)
      for (let x = 0; x < W; x++) {
        const nx = (x / (W - 1)) * 2 - 1; // -1(左/右肺) ～ +1(右/左肺)
        const idx = y * W + x;

        // 胸郭内楕円境界
        const thoraxDist = (nx * nx) / (0.86 * 0.86) + (ny * ny) / (0.76 * 0.76);
        if (thoraxDist > 1.0) continue;

        // 心臓・縦隔（腹側中央〜やや左寄り）と脊椎（背側中央）の切り欠き
        const heartDist = ((nx - 0.10) * (nx - 0.10)) / (0.28 * 0.28) + ((ny + 0.18) * (ny + 0.18)) / (0.34 * 0.34);
        const spineDist = (nx * nx) / (0.16 * 0.16) + ((ny - 0.56) * (ny - 0.56)) / (0.28 * 0.28);
        const medGap = Math.abs(nx) < 0.07 ? 0 : 1;

        if (heartDist < 0.85 || spineDist < 0.85 || medGap === 0) continue;

        // 左右それぞれの肺野楕円（エッジを滑らかにフェード）
        const edgeFade = clamp((1.0 - thoraxDist) * 4.5, 0, 1);
        const heartFade = clamp((heartDist - 0.85) * 3.0, 0, 1);
        const spineFade = clamp((spineDist - 0.85) * 3.0, 0, 1);
        const midFade = clamp((Math.abs(nx) - 0.07) * 8.0, 0, 1);

        const weight = edgeFade * heartFade * spineFade * midFade;
        if (nx < 0) {
          this.maskRight[idx] = weight;
        } else {
          this.maskLeft[idx] = weight;
        }
        // 肺野内の腹側(0)〜背側(1)正規化座標
        this.maskYNorm[idx] = clamp((ny + 0.72) / 1.44, 0, 1);
      }
    }
  }

  /**
   * 共通の滑らかな状態値更新（アクティブ描画時のみ呼ぶ）
   */
  _updateSmooth(engine, params) {
    const lerp = 0.25;
    this.smoothV += ((engine?.V ?? 0) - this.smoothV) * lerp;
    this.smoothPaw += ((engine?.Paw ?? params?.peep ?? 5) - this.smoothPaw) * lerp;
    this.smoothPeep += ((params?.peep ?? 5) - this.smoothPeep) * lerp;
    this.smoothAutoPeep += ((engine?.currentAutoPeep ?? 0) - this.smoothAutoPeep) * lerp;
  }

  /**
   * メインエントリ：アクティブタブに応じて必要な Canvas だけを描画
   * @param {'xp'|'ct'|'eit'|'compare'} activeTab
   */
  render(activeTab, engine, params, lungVentMode = 'both') {
    this.ensureImagesLoaded();
    this._updateSmooth(engine, params);
    const patho = engine?.pathology || computePathologyMechanics(params, this.smoothPaw);

    if (activeTab === 'xp') {
      this.renderXp(engine, params, patho, lungVentMode);
    } else if (activeTab === 'ct') {
      this.renderCt(engine, params, patho, lungVentMode);
    } else if (activeTab === 'eit') {
      this.renderEit(engine, params, patho, lungVentMode);
    } else if (activeTab === 'compare') {
      this.renderCt(engine, params, patho, lungVentMode);
      this.renderEit(engine, params, patho, lungVentMode);
    }
    return this.lastEitMetrics;
  }

  // =========================================================================
  // 1. 胸部 Xp（正面）リアルタイム病態合成描画
  // =========================================================================
  renderXp(engine, params, patho, lungVentMode) {
    const ctx = this.xpCtx;
    if (!ctx) return;
    const W = this.xpCanvas.width;
    const H = this.xpCanvas.height;

    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#030712';
    ctx.fillRect(0, 0, W, H);

    if (!this.xpLoaded) {
      this._drawLoading(ctx, W, H, '胸部Xp画像を読込中...');
      return;
    }

    const volNorm = clamp(this.smoothV / 600.0, 0, 1.4);
    const peepNorm = clamp(this.smoothPeep / 20.0, 0, 1);

    // 呼吸・PEEP・COPD・胸水による横隔膜のわずかな下方シフト（全体の下半身ストレッチ効果）
    const diaphShift =
      peepNorm * 5 +
      volNorm * 7 * (0.4 + 0.6 * patho.complianceRatio) +
      (patho.airwayNarrowing ? 11 : 0) +
      patho.effusionRatio * (4 + (patho.effusionPushRatio ?? 0) * 6);

    // ベース胸部Xp画像を描画
    ctx.save();
    ctx.drawImage(this.xpImg, 0, 0, W, H);
    ctx.restore();

    // 左右肺野のクリッピングパス定義（chest_xp.webp の解剖位置に精密合わせ）
    const traceRightLung = () => {
      ctx.beginPath();
      ctx.moveTo(W * 0.43, H * 0.14);
      ctx.bezierCurveTo(W * 0.24, H * 0.11, W * 0.11, H * 0.28, W * 0.09, H * 0.56);
      ctx.bezierCurveTo(W * 0.08, H * 0.69, W * 0.09, H * 0.77, W * 0.12, H * 0.78);
      ctx.quadraticCurveTo(W * 0.26, H * 0.64 + diaphShift * 0.4, W * 0.42, H * 0.67 + diaphShift * 0.4);
      ctx.lineTo(W * 0.44, H * 0.34);
      ctx.closePath();
    };
    const traceLeftLung = () => {
      ctx.beginPath();
      ctx.moveTo(W * 0.57, H * 0.14);
      ctx.bezierCurveTo(W * 0.76, H * 0.11, W * 0.89, H * 0.28, W * 0.91, H * 0.56);
      ctx.bezierCurveTo(W * 0.92, H * 0.69, W * 0.91, H * 0.78, W * 0.88, H * 0.79);
      ctx.quadraticCurveTo(W * 0.78, H * 0.68 + diaphShift * 0.4, W * 0.73, H * 0.68 + diaphShift * 0.4);
      ctx.quadraticCurveTo(W * 0.67, H * 0.50, W * 0.57, H * 0.36);
      ctx.closePath();
    };

    // 1. COPD / 喘息：両肺野の透過性亢進（黒化）＋ 横隔膜低位平坦化
    if (patho.airwayNarrowing) {
      [traceRightLung, traceLeftLung].forEach((trace) => {
        ctx.save();
        trace();
        ctx.clip();
        ctx.fillStyle = 'rgba(0, 0, 0, 0.36)';
        ctx.fillRect(0, 0, W, H);
        ctx.restore();
      });
      // 横隔膜低位平坦化の暗い含気拡張帯
      ctx.save();
      ctx.fillStyle = 'rgba(5, 10, 18, 0.42)';
      ctx.fillRect(W * 0.12, H * 0.65, W * 0.29, H * 0.06);
      ctx.fillRect(W * 0.60, H * 0.67, W * 0.28, H * 0.06);
      ctx.restore();
    }

    // 2. 無気肺 / ARDS：下肺野中心の浸潤影（白濁）— PEEP 上昇で effectiveAtel が減り透過性改善
    if (patho.effectiveAtel > 0.01) {
      const a = clamp(patho.effectiveAtel * 0.82 + (patho.ardsMode ? 0.12 : 0), 0, 0.88);
      [traceRightLung, traceLeftLung].forEach((trace) => {
        ctx.save();
        trace();
        ctx.clip();
        const topY = H * (0.68 - patho.effectiveAtel * 0.38);
        const grad = ctx.createLinearGradient(0, H * 0.80, 0, topY);
        grad.addColorStop(0.0, `rgba(232, 238, 245, ${a.toFixed(3)})`);
        grad.addColorStop(0.6, `rgba(218, 228, 238, ${(a * 0.65).toFixed(3)})`);
        grad.addColorStop(1.0, 'rgba(218, 228, 238, 0)');
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, W, H);
        ctx.restore();
      });
    }

    // 3. 肺水腫 / CS1 心不全：両側肺門部からのバタフライシャドウ（PEEP で薄まる）＋ 心陰影拡大
    if (patho.effectiveEdema > 0.01) {
      const a = clamp(Math.pow(patho.effectiveEdema, 1.05) * 0.82, 0, 0.82);
      const drawButterfly = (cx, cy, rx, ry, trace) => {
        ctx.save();
        trace();
        ctx.clip();
        ctx.translate(cx, cy);
        ctx.scale(1, ry / rx);
        const grad = ctx.createRadialGradient(0, 0, rx * 0.08, 0, 0, rx);
        grad.addColorStop(0.0, `rgba(238, 244, 250, ${a.toFixed(3)})`);
        grad.addColorStop(0.55, `rgba(222, 234, 246, ${(a * 0.62).toFixed(3)})`);
        grad.addColorStop(1.0, 'rgba(222, 234, 246, 0)');
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(0, 0, rx, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      };
      const rad = W * (0.16 + 0.14 * patho.effectiveEdema);
      drawButterfly(W * 0.40, H * 0.47, rad, rad * 1.15, traceRightLung);
      drawButterfly(W * 0.60, H * 0.47, rad, rad * 1.15, traceLeftLung);
    }

    // CS1心不全：心陰影拡大（CTR拡大・低PEEPで顕著）
    if (patho.cs1HeartFailure) {
      const expand = 0.25 + patho.cs1Overload * 0.55;
      ctx.save();
      const grad = ctx.createRadialGradient(W * 0.57, H * 0.56, W * 0.04, W * 0.57, H * 0.56, W * 0.23);
      grad.addColorStop(0.0, `rgba(215, 224, 236, ${(0.55 * expand).toFixed(3)})`);
      grad.addColorStop(0.75, `rgba(205, 215, 228, ${(0.38 * expand).toFixed(3)})`);
      grad.addColorStop(1.0, 'rgba(205, 215, 228, 0)');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.ellipse(W * 0.57, H * 0.56, W * (0.19 + expand * 0.05), H * 0.15, 0.18, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    // 4. 胸水：両側下肺野に CPA 鈍化＋外側せり上がりメニスカス状の均一白濁（PEEPでも消えない）
    if (patho.effusionRatio > 0.01) {
      const er = patho.effusionRatio;
      const push = patho.effusionPushRatio ?? 0;
      const baseLineY = H * 0.79 + diaphShift * 0.35;
      const fluidH = H * (0.08 + er * 0.28);
      const lift = H * (0.04 + er * 0.07 + push * 0.03);
      const a = clamp(0.45 + er * 0.42, 0, 0.88);

      const drawXpEffusion = (isRight) => {
        ctx.save();
        (isRight ? traceRightLung : traceLeftLung)();
        ctx.clip();
        const outerX = isRight ? W * 0.06 : W * 0.94;
        const innerX = isRight ? W * 0.45 : W * 0.55;
        const ctrlX = isRight ? W * 0.22 : W * 0.78;
        const topInnerY = baseLineY - fluidH;
        const topOuterY = topInnerY - lift;

        ctx.beginPath();
        ctx.moveTo(innerX, H * 0.86);
        ctx.lineTo(innerX, topInnerY);
        ctx.quadraticCurveTo(ctrlX, topInnerY + H * 0.03, outerX, topOuterY);
        ctx.lineTo(outerX, H * 0.86);
        ctx.closePath();

        const grad = ctx.createLinearGradient(0, topOuterY, 0, baseLineY);
        grad.addColorStop(0.0, `rgba(225, 232, 240, ${(a * 0.85).toFixed(3)})`);
        grad.addColorStop(1.0, `rgba(238, 242, 248, ${a.toFixed(3)})`);
        ctx.fillStyle = grad;
        ctx.fill();
        ctx.restore();
      };
      drawXpEffusion(true);
      drawXpEffusion(false);
    }

    // 5. 緊張性気胸（右）：右肺野を完全に黒く（透過性亢進）、虚脱右肺辺縁、縦隔の左方偏位
    if (patho.pneumothoraxRight) {
      // 右肺野の完全黒化（肺血管影消失）
      ctx.save();
      traceRightLung();
      ctx.clip();
      ctx.fillStyle = 'rgba(2, 5, 12, 0.86)';
      ctx.fillRect(0, 0, W, H);

      // 肺門部へ虚脱した右肺辺縁（Visceral pleural line）
      const collapseGrad = ctx.createRadialGradient(W * 0.42, H * 0.44, W * 0.02, W * 0.42, H * 0.44, W * 0.14);
      collapseGrad.addColorStop(0, 'rgba(205, 214, 224, 0.72)');
      collapseGrad.addColorStop(0.85, 'rgba(180, 192, 206, 0.50)');
      collapseGrad.addColorStop(1, 'rgba(180, 192, 206, 0)');
      ctx.fillStyle = collapseGrad;
      ctx.beginPath();
      ctx.ellipse(W * 0.41, H * 0.45, W * 0.11, H * 0.15, 0, 0, Math.PI * 2);
      ctx.fill();

      ctx.strokeStyle = 'rgba(226, 232, 240, 0.85)';
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.ellipse(W * 0.41, H * 0.45, W * 0.10, H * 0.14, 0, Math.PI * 0.55, Math.PI * 1.45);
      ctx.stroke();
      ctx.restore();

      // 心臓・縦隔の左方偏位（画面右側へシフトした白影）
      const shiftX = W * (0.06 + clamp((this.smoothPaw - 5) / 35, 0, 1) * 0.04);
      ctx.save();
      const medGrad = ctx.createRadialGradient(W * 0.62 + shiftX, H * 0.54, W * 0.03, W * 0.62 + shiftX, H * 0.54, W * 0.19);
      medGrad.addColorStop(0, 'rgba(220, 228, 238, 0.72)');
      medGrad.addColorStop(0.75, 'rgba(200, 212, 224, 0.42)');
      medGrad.addColorStop(1, 'rgba(200, 212, 224, 0)');
      ctx.fillStyle = medGrad;
      ctx.beginPath();
      ctx.ellipse(W * 0.62 + shiftX, H * 0.54, W * 0.16, H * 0.18, 0.15, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    // 6. 片肺挿管（右）：左肺野全体の白色無気肺化 ＋ 右主気管支への気管チューブ（ETT）ライン
    if (patho.deepIntubationRight || lungVentMode === 'right') {
      ctx.save();
      traceLeftLung();
      ctx.clip();
      ctx.fillStyle = 'rgba(224, 232, 242, 0.76)';
      ctx.fillRect(0, 0, W, H);
      ctx.restore();

      // 右肺の過膨張（わずかな透過性亢進）
      ctx.save();
      traceRightLung();
      ctx.clip();
      ctx.fillStyle = 'rgba(0, 0, 0, 0.18)';
      ctx.fillRect(0, 0, W, H);
      ctx.restore();

      // 気管から右主気管支へ伸びる気管チューブ（X線不透過ライン）
      if (patho.deepIntubationRight) {
        ctx.save();
        ctx.strokeStyle = 'rgba(56, 189, 248, 0.92)';
        ctx.lineWidth = 2.4;
        ctx.setLineDash([5, 3]);
        ctx.beginPath();
        ctx.moveTo(W * 0.50, H * 0.04);
        ctx.lineTo(W * 0.50, H * 0.30);
        ctx.quadraticCurveTo(W * 0.49, H * 0.35, W * 0.42, H * 0.41);
        ctx.lineTo(W * 0.37, H * 0.45);
        ctx.stroke();
        ctx.setLineDash([]);

        ctx.fillStyle = '#f43f5e';
        ctx.beginPath();
        ctx.arc(W * 0.37, H * 0.45, 4, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1.2;
        ctx.stroke();
        ctx.restore();
      }
    } else if (lungVentMode === 'left') {
      ctx.save();
      traceRightLung();
      ctx.clip();
      ctx.fillStyle = 'rgba(224, 232, 242, 0.76)';
      ctx.fillRect(0, 0, W, H);
      ctx.restore();
    }

    // 方向マーカー（R / L）とタイトルラベル
    this._drawBadge(ctx, 8, 10, 'R', '#94a3b8');
    this._drawBadge(ctx, W - 24, 10, 'L', '#94a3b8');
    this._drawFindingTag(ctx, W, H, this._getImagingSummary(patho, lungVentMode, 'xp'));
  }

  // =========================================================================
  // 2. 胸部 CT（水平断・肺野条件）リアルタイム病態合成描画
  // =========================================================================
  renderCt(engine, params, patho, lungVentMode) {
    const ctx = this.ctCtx;
    if (!ctx) return;
    const W = this.ctCanvas.width;
    const H = this.ctCanvas.height;

    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#020617';
    ctx.fillRect(0, 0, W, H);

    if (!this.ctLoaded) {
      this._drawLoading(ctx, W, H, '胸部CT画像を読込中...');
      return;
    }

    // ベース胸部CT画像を描画（上が腹側、下が背側）
    ctx.drawImage(this.ctImg, 0, 0, W, H);

    // 左右肺野のクリッピングパス定義（chest_ct.webp の肺野形状に精密合わせ）
    const traceCtRight = () => {
      ctx.beginPath();
      ctx.moveTo(W * 0.48, H * 0.24);
      ctx.bezierCurveTo(W * 0.28, H * 0.19, W * 0.12, H * 0.30, W * 0.13, H * 0.48);
      ctx.bezierCurveTo(W * 0.14, H * 0.67, W * 0.27, H * 0.74, W * 0.43, H * 0.68);
      ctx.bezierCurveTo(W * 0.48, H * 0.62, W * 0.46, H * 0.50, W * 0.38, H * 0.47);
      ctx.bezierCurveTo(W * 0.38, H * 0.36, W * 0.44, H * 0.29, W * 0.48, H * 0.24);
      ctx.closePath();
    };
    const traceCtLeft = () => {
      ctx.beginPath();
      ctx.moveTo(W * 0.54, H * 0.24);
      ctx.bezierCurveTo(W * 0.72, H * 0.19, W * 0.88, H * 0.30, W * 0.87, H * 0.48);
      ctx.bezierCurveTo(W * 0.86, H * 0.67, W * 0.73, H * 0.74, W * 0.57, H * 0.68);
      ctx.bezierCurveTo(W * 0.53, H * 0.61, W * 0.55, H * 0.52, W * 0.62, H * 0.47);
      ctx.bezierCurveTo(W * 0.66, H * 0.37, W * 0.61, H * 0.28, W * 0.54, H * 0.24);
      ctx.closePath();
    };

    // 1. COPD / 喘息：両肺野全体の低吸収域（さらに黒く）
    if (patho.airwayNarrowing) {
      [traceCtRight, traceCtLeft].forEach((trace) => {
        ctx.save();
        trace();
        ctx.clip();
        ctx.fillStyle = 'rgba(0, 0, 0, 0.45)';
        ctx.fillRect(0, 0, W, H);
        ctx.restore();
      });
    }

    // 2. 無気肺 / ARDS：背側（下部）コンソリデーション（高輝度ホワイト＋エアブロンコグラム）vs 腹側 Baby Lung（黒）
    if (patho.effectiveAtel > 0.01) {
      const ea = patho.effectiveAtel;
      const effOffset = patho.effusionRatio > 0.01 ? H * (0.03 + patho.effusionRatio * 0.11) : 0;
      [traceCtRight, traceCtLeft].forEach((trace, idx) => {
        ctx.save();
        trace();
        ctx.clip();
        // 胸水がある場合は胸水層のすぐ腹側（上側）から広がるようオフセット
        const botY = H * 0.74 - effOffset * 0.5;
        const topY = H * (0.66 - ea * 0.36) - effOffset * 0.45;
        const grad = ctx.createLinearGradient(0, botY, 0, topY);
        const aMax = clamp(0.55 + ea * 0.43 + (patho.ardsMode ? 0.06 : 0), 0, 0.98);
        grad.addColorStop(0.0, `rgba(246, 250, 255, ${aMax.toFixed(3)})`);
        grad.addColorStop(0.50, `rgba(226, 234, 244, ${(aMax * 0.80).toFixed(3)})`);
        grad.addColorStop(0.82, `rgba(198, 210, 224, ${(aMax * 0.35).toFixed(3)})`);
        grad.addColorStop(1.0, 'rgba(198, 210, 224, 0)');
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, W, H);

        // 肺実質の虚脱を示す繊細なエアブロンコグラム（気管支透亮像）
        if (ea > 0.20) {
          ctx.strokeStyle = `rgba(15, 23, 42, ${(ea * 0.48).toFixed(3)})`;
          ctx.lineWidth = 1.4;
          ctx.lineCap = 'round';
          const bx = idx === 0 ? W * 0.34 : W * 0.66;
          const dir = idx === 0 ? -1 : 1;
          const by = H * 0.56 - effOffset * 0.3;
          ctx.beginPath();
          ctx.moveTo(bx, by);
          ctx.lineTo(bx + dir * W * 0.07, by + H * 0.06);
          ctx.moveTo(bx + dir * W * 0.03, by + H * 0.025);
          ctx.lineTo(bx + dir * W * 0.09, by + H * 0.03);
          ctx.stroke();
        }
        ctx.restore();
      });
    }

    // 3. 肺水腫 / CS1 心不全：両側肺門〜中心性すりガラス影（GGO）、PEEP 上昇で軽減
    if (patho.effectiveEdema > 0.01) {
      const ee = patho.effectiveEdema;
      const a = clamp(Math.pow(ee, 1.05) * 0.76, 0, 0.78);
      const drawGgo = (cx, cy, trace) => {
        ctx.save();
        trace();
        ctx.clip();
        const rad = W * (0.16 + ee * 0.14);
        const grad = ctx.createRadialGradient(cx, cy, rad * 0.1, cx, cy, rad);
        grad.addColorStop(0.0, `rgba(218, 226, 236, ${a.toFixed(3)})`);
        grad.addColorStop(0.6, `rgba(185, 198, 214, ${(a * 0.55).toFixed(3)})`);
        grad.addColorStop(1.0, 'rgba(185, 198, 214, 0)');
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(cx, cy, rad, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      };
      drawGgo(W * 0.34, H * 0.48, traceCtRight);
      drawGgo(W * 0.66, H * 0.48, traceCtLeft);
    }

    // 4. 胸水：重力のかかる背側（下部）に均一な水濃度グレーの三日月状液体層（白い無気肺と明確なコントラスト＆境界線）
    if (patho.effusionRatio > 0.01) {
      const er = patho.effusionRatio;
      const thickness = H * (0.045 + er * 0.145);
      const a = clamp(0.76 + er * 0.20, 0, 0.95);
      [traceCtRight, traceCtLeft].forEach((trace, idx) => {
        ctx.save();
        trace();
        ctx.clip();
        const yLevel = H * 0.72 - thickness;
        const x1 = idx === 0 ? W * 0.10 : W * 0.50;
        const xc = idx === 0 ? W * 0.30 : W * 0.70;
        const x2 = idx === 0 ? W * 0.50 : W * 0.90;

        // 均一な水濃度（ミディアム・ブルーグレー）で白い無気肺とパキッと区別
        const fluidGrad = ctx.createLinearGradient(0, yLevel, 0, H * 0.76);
        fluidGrad.addColorStop(0.0, `rgba(118, 138, 162, ${a.toFixed(3)})`);
        fluidGrad.addColorStop(1.0, `rgba(92, 112, 136, ${Math.min(0.97, a + 0.04).toFixed(3)})`);
        ctx.fillStyle = fluidGrad;
        ctx.beginPath();
        ctx.moveTo(x1, yLevel);
        ctx.quadraticCurveTo(xc, yLevel + H * 0.048, x2, yLevel);
        ctx.lineTo(x2, H * 0.78);
        ctx.lineTo(x1, H * 0.78);
        ctx.closePath();
        ctx.fill();

        // 胸水と肺実質のくっきりした胸膜境界線（暗線＋淡いハイライト）
        ctx.beginPath();
        ctx.moveTo(x1, yLevel);
        ctx.quadraticCurveTo(xc, yLevel + H * 0.048, x2, yLevel);
        ctx.strokeStyle = 'rgba(15, 23, 42, 0.65)';
        ctx.lineWidth = 2.0;
        ctx.stroke();
        ctx.strokeStyle = 'rgba(186, 212, 238, 0.55)';
        ctx.lineWidth = 0.9;
        ctx.stroke();
        ctx.restore();
      });
    }

    // 5. 緊張性気胸（右）：右胸腔（画面左側）腹側〜全体に真っ黒な空気層、右肺虚脱、縦隔の左（画面右側）圧排
    if (patho.pneumothoraxRight) {
      ctx.save();
      traceCtRight();
      ctx.clip();
      ctx.fillStyle = 'rgba(0, 0, 0, 0.94)';
      ctx.fillRect(0, 0, W, H);

      // 肺門背側へ小さく虚脱した右肺
      ctx.fillStyle = 'rgba(175, 186, 198, 0.85)';
      ctx.beginPath();
      ctx.ellipse(W * 0.39, H * 0.52, W * 0.08, H * 0.09, -0.2, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = 'rgba(226, 232, 240, 0.85)';
      ctx.lineWidth = 1.4;
      ctx.stroke();
      ctx.restore();

      // 縦隔の左（画面右側）への圧排
      const shiftX = W * (0.045 + clamp((this.smoothPaw - 5) / 35, 0, 1) * 0.03);
      ctx.save();
      const grad = ctx.createRadialGradient(W * 0.56 + shiftX, H * 0.42, W * 0.02, W * 0.56 + shiftX, H * 0.42, W * 0.14);
      grad.addColorStop(0, 'rgba(165, 174, 186, 0.78)');
      grad.addColorStop(0.75, 'rgba(148, 158, 170, 0.45)');
      grad.addColorStop(1, 'rgba(148, 158, 170, 0)');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.ellipse(W * 0.56 + shiftX, H * 0.42, W * 0.12, H * 0.14, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    // 6. 片肺挿管（右）：左肺（画面右側）全体を白く虚脱、右肺（画面左側）を過膨張（黒）
    if (patho.deepIntubationRight || lungVentMode === 'right') {
      ctx.save();
      traceCtLeft();
      ctx.clip();
      ctx.fillStyle = 'rgba(218, 226, 236, 0.82)';
      ctx.fillRect(0, 0, W, H);
      ctx.restore();

      ctx.save();
      traceCtRight();
      ctx.clip();
      ctx.fillStyle = 'rgba(0, 0, 0, 0.30)';
      ctx.fillRect(0, 0, W, H);
      ctx.restore();
    } else if (lungVentMode === 'left') {
      ctx.save();
      traceCtRight();
      ctx.clip();
      ctx.fillStyle = 'rgba(218, 226, 236, 0.82)';
      ctx.fillRect(0, 0, W, H);
      ctx.restore();
    }

    // 方向マーカー（腹側 V / 背側 D / R / L）
    this._drawBadge(ctx, W / 2 - 14, 6, '腹側', '#94a3b8');
    this._drawBadge(ctx, W / 2 - 14, H - 30, '背側', '#94a3b8');
    this._drawBadge(ctx, 8, H / 2 - 8, 'R', '#94a3b8');
    this._drawBadge(ctx, W - 22, H / 2 - 8, 'L', '#94a3b8');
    this._drawFindingTag(ctx, W, H, this._getImagingSummary(patho, lungVentMode, 'ct'));
  }

  // =========================================================================
  // 3. PulmoVista 500 風 EIT（換気分布・ROI 1〜4）リアルタイム計算・描画
  // =========================================================================
  renderEit(engine, params, patho, lungVentMode) {
    const ctx = this.eitCtx;
    if (!ctx) return;
    const W = this.eitCanvas.width;
    const H = this.eitCanvas.height;

    const gW = this.gridW;
    const gH = this.gridH;
    const data = this.eitImageData.data;

    // リアルタイム換気強度（吸気〜呼気サイクル）＋ COPD/Auto-PEEP の EELI ベースライン
    const volCycle = clamp(this.smoothV / 520.0, 0, 1.35);
    const eeliBase = patho.airwayNarrowing
      ? clamp(0.14 + (this.smoothAutoPeep / 10.0) * 0.24, 0.12, 0.42)
      : clamp((this.smoothAutoPeep / 12.0) * 0.16, 0, 0.22);

    // 左右肺の換気寄与率
    let rightGain = 1.0;
    let leftGain = 1.0;
    if (patho.pneumothoraxRight) {
      rightGain = 0.04;
      leftGain = 1.15;
    } else if (patho.deepIntubationRight || lungVentMode === 'right') {
      rightGain = 1.22;
      leftGain = 0.02;
    } else if (lungVentMode === 'left') {
      rightGain = 0.02;
      leftGain = 1.22;
    }

    // 重力依存の背側換気低下（無気肺・ARDS・胸水・肺水腫）
    // PEEP を上げると effectiveAtel / effectiveEdema が低下して背側(ROI 3・4)がリクルートメントされる
    const dorsalLoss = clamp(
      patho.effectiveAtel * 0.85 +
      patho.effectiveEdema * 0.55 +
      patho.effusionRatio * 0.72 * (1.0 - (patho.effRecruit ?? 0)),
      0,
      0.95
    );

    // 過大 PEEP (16 cmH2O 以上) による腹側(ROI 1)の過膨張 Silent Space トレードオフ
    const overdistension = clamp((this.smoothPeep - 15.0) / 5.0, 0, 1.0);

    // ROI 1〜4 積分・CoV・左右比の集計用
    const roiSum = [0, 0, 0, 0];
    let totalSum = 0;
    let weightedYSum = 0;
    let rightSum = 0;
    let leftSum = 0;

    for (let y = 0; y < gH; y++) {
      for (let x = 0; x < gW; x++) {
        const idx = y * gW + x;
        const pIdx = idx * 4;
        const wR = this.maskRight[idx];
        const wL = this.maskLeft[idx];
        const mask = wR > 0 ? wR : wL;

        if (mask <= 0.001) {
          data[pIdx] = 0;
          data[pIdx + 1] = 0;
          data[pIdx + 2] = 0;
          data[pIdx + 3] = 0;
          continue;
        }

        const yNorm = this.maskYNorm[idx]; // 0.0(腹側) ～ 1.0(背側)
        const sideGain = wR > 0 ? rightGain : leftGain;

        // 1. 背側虚脱プロファイル（yNorm が大きい背側ほど換気低下）
        const dorsalWeight = Math.pow(yNorm, 1.85);
        const dorsalFactor = clamp(1.0 - dorsalLoss * dorsalWeight * 1.25, 0.03, 1.0);

        // 2. 過大PEEP時の腹側過膨張 Silent Space（yNorm が小さい腹側ほどコンプライアンス低下）
        const ventralWeight = Math.pow(1.0 - yNorm, 2.2);
        const ventralFactor = clamp(1.0 - overdistension * ventralWeight * 0.72, 0.18, 1.0);

        // 3. 腹側への代償性換気シフト（背側が潰れると腹側へエアが回りやすい）
        const ventralComp = 1.0 + dorsalLoss * (1.0 - yNorm) * 0.35;

        // 空間換気ポテンシャル（Tidal Distribution）
        const regionalPotential = mask * sideGain * dorsalFactor * ventralFactor * ventralComp;

        // 数値指標は 1 呼吸分の空間分布ポテンシャルから算出（呼気中も ROI% がガタつかず安定）
        const roiIdx = Math.min(3, Math.floor(yNorm * 4));
        roiSum[roiIdx] += regionalPotential;
        totalSum += regionalPotential;
        weightedYSum += regionalPotential * yNorm;
        if (wR > 0) rightSum += regionalPotential;
        else leftSum += regionalPotential;

        // 描画用のリアルタイム強度（吸気サイクル + EELI ベースライン）
        const val = clamp((eeliBase * mask * sideGain) + regionalPotential * volCycle * 1.15, 0, 1.0);

        // PulmoVista 500 カラースケール：黒 -> 濃青 -> 青 -> 水色 -> 白
        const [r, g, b, a] = this._eitColorMap(val);
        data[pIdx] = r;
        data[pIdx + 1] = g;
        data[pIdx + 2] = b;
        data[pIdx + 3] = a;
      }
    }

    // ROI 1〜4 / CoV / R-L 比率の更新
    if (totalSum > 0.001) {
      const r1 = Math.round((roiSum[0] / totalSum) * 100);
      const r2 = Math.round((roiSum[1] / totalSum) * 100);
      const r3 = Math.round((roiSum[2] / totalSum) * 100);
      const r4 = Math.max(0, 100 - r1 - r2 - r3);
      const cov = clamp((weightedYSum / totalSum) * 100, 15, 85);
      const rPct = Math.round((rightSum / totalSum) * 100);
      this.lastEitMetrics = {
        roi: [r1, r2, r3, r4],
        cov,
        rightPct: rPct,
        leftPct: 100 - rPct,
        overdistension
      };
    }

    // オフスクリーンへ書き込み
    this.eitOffCtx.putImageData(this.eitImageData, 0, 0);

    // メイン EIT Canvas 描画（PulmoVista 500 ダークモニタ背景）
    ctx.fillStyle = '#040814';
    ctx.fillRect(0, 0, W, H);

    // 胸郭楕円輪郭（ガイド枠）
    const cx = W * 0.5;
    const cy = H * 0.50;
    const rx = W * 0.43;
    const ry = H * 0.37;

    ctx.save();
    ctx.fillStyle = '#070d1d';
    ctx.strokeStyle = '#334155';
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    // バイリニア補間で滑らかな Tidal Image を描画
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    const mapW = W * 0.94;
    const mapH = H * 0.90;
    ctx.drawImage(this.eitOff, (W - mapW) / 2, (H - mapH) / 2, mapW, mapH);

    // 過大 PEEP 時の腹側 Silent Space（過膨張警告ガイド）
    if (overdistension > 0.15) {
      ctx.fillStyle = `rgba(245, 158, 11, ${(overdistension * 0.22).toFixed(3)})`;
      ctx.beginPath();
      ctx.ellipse(cx, cy - ry * 0.58, rx * 0.55, ry * 0.24, 0, 0, Math.PI * 2);
      ctx.fill();
    }

    // ROI 1〜4 水平ガイド破線
    const lungTop = cy - ry * 0.88;
    const lungBot = cy + ry * 0.88;
    const lungH = lungBot - lungTop;
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.32)';
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    for (let i = 1; i <= 3; i++) {
      const y = lungTop + (lungH * i) / 4;
      ctx.beginPath();
      ctx.moveTo(cx - rx * 0.95, y);
      ctx.lineTo(cx + rx * 0.95, y);
      ctx.stroke();
    }
    ctx.setLineDash([]);

    // ROI ラベル（右側）
    ctx.fillStyle = '#94a3b8';
    ctx.font = 'bold 9px sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (let i = 0; i < 4; i++) {
      const y = lungTop + (lungH * (i + 0.5)) / 4;
      ctx.fillText(`ROI ${i + 1}`, W - 6, y);
    }

    // 左端カラースケールバー（黒 → 青 → 水色 → 白）
    const barX = 8, barY = H * 0.22, barW = 7, barH = H * 0.56;
    const scaleGrad = ctx.createLinearGradient(0, barY + barH, 0, barY);
    scaleGrad.addColorStop(0.0, '#040814');
    scaleGrad.addColorStop(0.30, '#0b2a8f');
    scaleGrad.addColorStop(0.65, '#38bdf8');
    scaleGrad.addColorStop(1.0, '#f8fafc');
    ctx.fillStyle = scaleGrad;
    ctx.fillRect(barX, barY, barW, barH);
    ctx.strokeStyle = '#475569';
    ctx.strokeRect(barX, barY, barW, barH);

    // 方向ラベル
    this._drawBadge(ctx, cx - 14, 5, '腹側', '#94a3b8');
    this._drawBadge(ctx, cx - 14, H - 19, '背側', '#94a3b8');
    this._drawBadge(ctx, 20, cy - 7, 'R', '#64748b');
    this._drawBadge(ctx, W - 46, cy - 7, 'L', '#64748b');

    // 過膨張警告ミニラベル
    if (overdistension > 0.25) {
      ctx.fillStyle = 'rgba(251, 191, 36, 0.92)';
      ctx.font = 'bold 9.5px "Segoe UI", Meiryo, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('⚠ 過大PEEP: 腹側過膨張 (Silent Space)', cx, 26);
    }
    ctx.restore();
  }

  /**
   * PulmoVista 500 風カラースケール：黒 → 濃青 → 青 → 水色 → 白
   */
  _eitColorMap(v) {
    if (v <= 0.03) return [0, 0, 0, 0];
    let r, g, b;
    if (v < 0.35) {
      const k = v / 0.35;
      r = Math.round(6 + 10 * k);
      g = Math.round(14 + 42 * k);
      b = Math.round(40 + 135 * k);
    } else if (v < 0.72) {
      const k = (v - 0.35) / 0.37;
      r = Math.round(16 + 44 * k);
      g = Math.round(56 + 148 * k);
      b = Math.round(175 + 78 * k);
    } else {
      const k = (v - 0.72) / 0.28;
      r = Math.round(60 + 195 * k);
      g = Math.round(204 + 51 * k);
      b = Math.round(253 + 2 * k);
    }
    const a = Math.round(clamp(v * 2.4, 0, 1) * 245);
    return [r, g, b, a];
  }

  _drawLoading(ctx, W, H, msg) {
    ctx.fillStyle = '#94a3b8';
    ctx.font = '12px "Segoe UI", Meiryo, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(msg, W / 2, H / 2);
  }

  _drawBadge(ctx, x, y, text, color) {
    ctx.save();
    ctx.fillStyle = color;
    ctx.font = 'bold 10px sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(text, x, y);
    ctx.restore();
  }

  _drawFindingTag(ctx, W, H, text) {
    if (!text) return;
    ctx.save();
    ctx.font = 'bold 10px "Segoe UI", Meiryo, sans-serif';
    const tw = Math.min(W - 12, ctx.measureText(text).width + 16);
    ctx.fillStyle = 'rgba(2, 6, 23, 0.82)';
    ctx.strokeStyle = 'rgba(56, 189, 248, 0.55)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect((W - tw) / 2, H - 22, tw, 18, 9);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#e0f2fe';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, W / 2, H - 13);
    ctx.restore();
  }

  _getImagingSummary(patho, lungVentMode, kind) {
    if (patho.pneumothoraxRight) return kind === 'xp' ? '右気胸: 透過性亢進・虚脱肺・縦隔左偏位' : '右気胸: 右胸腔空気層・縦隔左圧排';
    if (patho.deepIntubationRight || lungVentMode === 'right') return '右片肺挿管: 左肺無気肺・右肺過膨張';
    if (lungVentMode === 'left') return '左片肺換気: 右肺無気肺';
    if (patho.ardsMode) return kind === 'xp' ? 'ARDS: 両側下肺野浸潤影 (PEEPで改善)' : 'ARDS: 背側コンソリデーション / 腹側Baby Lung';
    if (patho.cs1HeartFailure) return kind === 'xp' ? 'CS1心不全: バタフライシャドウ・心拡大' : 'CS1心不全: 肺門中心性GGO・背側胸水';
    if (patho.airwayNarrowing) return kind === 'xp' ? 'COPD/喘息: 透過性亢進・横隔膜低位平坦化' : 'COPD/喘息: 両肺野低吸収域(過膨張)';
    if (patho.effusionRatio > 0.05) return kind === 'xp' ? '胸水: CPA鈍化・メニスカスサイン' : '胸水: 背側三日月状高吸収域';
    if (patho.effectiveAtel > 0.05) return '無気肺: 背側・下肺野浸潤影';
    if (patho.effectiveEdema > 0.05) return '肺水腫: 中心性白濁・すりガラス影';
    return '正常所見';
  }
}
