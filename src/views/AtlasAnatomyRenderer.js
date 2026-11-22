import { computePathologyMechanics } from '../models/PathologyMechanics.js';

/**
 * アトラス解剖図透過パーツを用いたリアルタイム呼吸・循環・病態アニメーションレンダラー
 * HTML5 Canvas (#lungCanvas, 500x500 論理座標系)
 *
 * - 胸郭・脊椎・気管支（固定ベース）
 * - 横隔膜（換気量・PEEP・Pmus に連動して下降・平坦化）
 * - 胸水（胸郭と肺の間にメニスカス曲線付きの半透明液体レイヤー）
 * - 右肺・左肺（通常肺 ⇔ 肺断面(透過) 切替、肺門アンカー基準で左右独立制御、
 *   輪郭クリッピングによる無気肺・肺水腫の病変オーバーレイ）
 * - 気道内圧カラーオーバーレイ & 気流矢印パーティクル
 * - 心臓（心拍数 HR に連動した 2峰性拍動アニメーション）
 */
export class AtlasAnatomyRenderer {
  constructor(canvasElement) {
    this.canvas = canvasElement;
    this.ctx = canvasElement.getContext('2d');

    // 論理キャンバスサイズ（500x500px 基準）
    this.logicalSize = 500;
    this.canvas.width = this.logicalSize;
    this.canvas.height = this.logicalSize;

    // パーツ画像キャッシュ（前処理済みオフスクリーン Canvas）
    this.parts = {
      ribcage: null,
      rightLung: null,
      leftLung: null,
      rightLungSection: null,
      leftLungSection: null,
      heart: null,
      diaphragm: null
    };
    this.loaded = false;
    this.loadError = null;

    // 肺病変クリッピング合成用の再利用オフスクリーン Canvas
    this.lungWorkCanvas = document.createElement('canvas');
    this.lungWorkCtx = this.lungWorkCanvas.getContext('2d');

    // 表示・個別制御状態
    this.showHeart = true;
    this.showLungSection = false; // 肺断面（透過）表示 ON/OFF
    this.rightLungRatio = 1.0;    // 右肺の換気寄与率 (0.0〜1.0)
    this.leftLungRatio = 1.0;     // 左肺の換気寄与率 (0.0〜1.0)

    // 滑らかな補間用状態値
    this.smoothV = 0;
    this.smoothPeep = 5;
    this.smoothPaw = 5;
    this.smoothPalv = 5;
    this.smoothPmus = 0;
    this.smoothFlow = 0;

    // 心拍位相（ラジアン・サイクル管理）
    this.heartPhase = 0;
    this.lastTimestamp = null;

    // 気流矢印パーティクル（気管→右/左主気管支）
    this.particles = this._initAirflowParticles();

    // 各パーツの配置レイアウト定義（500x500 論理座標系）
    this.layout = {
      // 胸郭・脊椎・気管支
      ribcage: {
        x: 250, y: 258,
        w: 365, h: 486,
        anchorX: 0.5, anchorY: 0.5
      },
      // 横隔膜（肺底部の下・胸郭下部）
      diaphragm: {
        x: 250, y: 315,
        w: 295, h: 220,
        anchorX: 0.5, anchorY: 0.16
      },
      // 解剖学的右肺（画面左側）：アンカーを肺門（内側やや上）に設定
      rightLung: {
        x: 242, y: 196,
        w: 158, h: 356,
        anchorX: 0.90, anchorY: 0.35
      },
      // 解剖学的左肺（画面右側）：アンカーを肺門（内側やや上）に設定
      leftLung: {
        x: 258, y: 196,
        w: 158, h: 356,
        anchorX: 0.10, anchorY: 0.35
      },
      // 心臓（左肺の心切痕にフィットする位置）
      heart: {
        x: 268, y: 274,
        w: 132, h: 176,
        anchorX: 0.5, anchorY: 0.5
      }
    };

    this._loadAssets();
  }

  /**
   * 病態シナリオ（片肺挿管・気胸・無気肺など）向けに左右の肺の換気比率を個別制御
   * @param {number} rightRatio 右肺の動き倍率 (0.0〜1.2)
   * @param {number} leftRatio  左肺の動き倍率 (0.0〜1.2)
   */
  setLungVentilationRatio(rightRatio, leftRatio) {
    this.rightLungRatio = Math.max(0, Math.min(1.5, rightRatio));
    this.leftLungRatio = Math.max(0, Math.min(1.5, leftRatio));
  }

  setHeartVisibility(visible) {
    this.showHeart = !!visible;
  }

  toggleHeartVisibility() {
    this.showHeart = !this.showHeart;
    return this.showHeart;
  }

  setLungSectionVisibility(visible) {
    this.showLungSection = !!visible;
  }

  toggleLungSection() {
    this.showLungSection = !this.showLungSection;
    return this.showLungSection;
  }

  /**
   * 気流矢印パーティクルの初期化（気管→右/左主気管支の経路）
   */
  _initAirflowParticles() {
    const list = [];
    for (let i = 0; i < 16; i++) {
      list.push({
        branch: i % 2 === 0 ? 'right' : 'left',
        t: (i / 16) // 0.0 (気管上部) ～ 1.0 (肺門末梢)
      });
    }
    return list;
  }

  /**
   * assets/ 配下のアトラス解剖図パーツを非同期ロードし、
   * 左右肺の自動分割および背景白領域の透過キャッシュを実行
   */
  async _loadAssets() {
    const paths = {
      ribcage: './assets/Gemini_Generated_Image_tdhxbetdhxbetdhx.png',
      lungs: './assets/Gemini_Generated_Image_wl7ay7wl7ay7wl7a.png',
      lungsSection: './assets/Gemini_Generated_Image_9kkfsv9kkfsv9kkf.png',
      heart: './assets/Gemini_Generated_Image_3z38bz3z38bz3z38.png',
      diaphragm: './assets/Gemini_Generated_Image_d2uicld2uicld2ui.png'
    };

    const loadImg = (src) => new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error(`画像読み込み失敗: ${src}`));
      img.src = src;
    });

    try {
      const [ribcageImg, lungsImg, sectionImg, heartImg, diaphImg] = await Promise.all([
        loadImg(paths.ribcage),
        loadImg(paths.lungs),
        loadImg(paths.lungsSection),
        loadImg(paths.heart),
        loadImg(paths.diaphragm)
      ]);

      // 胸郭・心臓・横隔膜を適切な解像度へリサイズ＋背景透過処理してキャッシュ
      this.parts.ribcage = this._preparePartCanvas(ribcageImg, 0, 0, ribcageImg.width, ribcageImg.height, 760);
      this.parts.heart = this._preparePartCanvas(heartImg, 0, 0, heartImg.width, heartImg.height, 420);
      this.parts.diaphragm = this._preparePartCanvas(diaphImg, 0, 0, diaphImg.width, diaphImg.height, 640);

      // 左右の通常肺を 1 枚の画像から左右半分ずつ独立して切り出し
      const halfW = Math.floor(lungsImg.width / 2);
      this.parts.rightLung = this._preparePartCanvas(lungsImg, 0, 0, halfW, lungsImg.height, 560);
      this.parts.leftLung = this._preparePartCanvas(lungsImg, halfW, 0, lungsImg.width - halfW, lungsImg.height, 560);

      // 左右の肺断面（内部構造）画像も同様に左右半分ずつ切り出し
      const secHalfW = Math.floor(sectionImg.width / 2);
      this.parts.rightLungSection = this._preparePartCanvas(sectionImg, 0, 0, secHalfW, sectionImg.height, 560);
      this.parts.leftLungSection = this._preparePartCanvas(sectionImg, secHalfW, 0, sectionImg.width - secHalfW, sectionImg.height, 560);

      this.loaded = true;
    } catch (err) {
      console.error(err);
      this.loadError = err.message;
    }
  }

  /**
   * オフスクリーン Canvas に切り出し・リサイズし、
   * 外周に不透明な白背景が残っている場合はフラッドフィルで綺麗に透過化する
   */
  _preparePartCanvas(img, sx, sy, sw, sh, maxDim) {
    const scale = Math.min(1.0, maxDim / Math.max(sw, sh));
    const dw = Math.max(1, Math.round(sw * scale));
    const dh = Math.max(1, Math.round(sh * scale));

    const off = document.createElement('canvas');
    off.width = dw;
    off.height = dh;
    const octx = off.getContext('2d', { willReadFrequently: true });
    octx.drawImage(img, sx, sy, sw, sh, 0, 0, dw, dh);

    // 四隅のピクセルを確認し、白背景が不透明な場合のみ外周フラッドフィル透過を実行
    const imgData = octx.getImageData(0, 0, dw, dh);
    const data = imgData.data;

    const isWhiteBg = (idx) => {
      const a = data[idx + 3];
      if (a < 15) return true;
      const r = data[idx], g = data[idx + 1], b = data[idx + 2];
      return r > 236 && g > 236 && b > 236;
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
      let head = 0, tail = 0;

      const tryPush = (x, y) => {
        const pos = y * dw + x;
        if (visited[pos]) return;
        const idx = pos * 4;
        if (isWhiteBg(idx)) {
          visited[pos] = 1;
          queue[tail++] = pos;
        }
      };

      // 外周4辺をシードとして登録
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

      // 境界の白フチをわずかにフェザリング（アンチエイリアス馴染ませ）
      for (let y = 1; y < dh - 1; y++) {
        for (let x = 1; x < dw - 1; x++) {
          const pos = y * dw + x;
          if (visited[pos]) continue;
          const idx = pos * 4;
          const r = data[idx], g = data[idx + 1], b = data[idx + 2];
          if (r > 215 && g > 215 && b > 215) {
            if (visited[pos - 1] || visited[pos + 1] || visited[pos - dw] || visited[pos + dw]) {
              const lum = (r + g + b) / 3;
              const fade = Math.max(0, Math.min(1, (245 - lum) / 30));
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
   * パーツを指定アンカーポイント基準で変形描画（柔らかなドロップシャドウ付き）
   */
  _drawPart(partCanvas, cfg, offsetX = 0, offsetY = 0, scaleX = 1, scaleY = 1, alpha = 1, useShadow = true) {
    if (!partCanvas) return;
    const ctx = this.ctx;
    ctx.save();
    ctx.globalAlpha = alpha;
    if (useShadow) {
      ctx.shadowColor = 'rgba(2, 6, 23, 0.58)';
      ctx.shadowBlur = 14;
      ctx.shadowOffsetX = 0;
      ctx.shadowOffsetY = 4;
    }
    ctx.translate(cfg.x + offsetX, cfg.y + offsetY);
    ctx.scale(scaleX, scaleY);
    ctx.drawImage(
      partCanvas,
      -cfg.w * cfg.anchorX,
      -cfg.h * cfg.anchorY,
      cfg.w,
      cfg.h
    );
    ctx.restore();
  }

  /**
   * 肺パーツに無気肺（暗赤紫）・肺水腫（白濁グラデーション）・ARDSコントラスト・無換気暗色化を輪郭内クリッピング合成して描画
   */
  _drawLungWithPathology(partCanvas, cfg, side, scaleX, scaleY, effectiveAtel, effectiveEdema, extraOpts = {}) {
    if (!partCanvas) return;
    const { ardsMode = false, unventilatedDarken = false } = extraOpts;

    // 病変オーバーレイがすべて不要ならそのまま高速描画
    if (effectiveAtel <= 0.005 && effectiveEdema <= 0.005 && !ardsMode && !unventilatedDarken) {
      this._drawPart(partCanvas, cfg, 0, 0, scaleX, scaleY);
      return;
    }

    const w = partCanvas.width;
    const h = partCanvas.height;
    if (this.lungWorkCanvas.width !== w || this.lungWorkCanvas.height !== h) {
      this.lungWorkCanvas.width = w;
      this.lungWorkCanvas.height = h;
    }

    const wctx = this.lungWorkCtx;
    wctx.clearRect(0, 0, w, h);
    wctx.globalCompositeOperation = 'source-over';
    wctx.drawImage(partCanvas, 0, 0);

    // 肺の輪郭（不透明領域）内にのみ病変オーバーレイをクリッピング合成
    wctx.globalCompositeOperation = 'source-atop';

    // 1. 無気肺（下肺野を中心に暗赤色〜紫の虚脱シャドウ）
    if (effectiveAtel > 0.005) {
      const topY = h * (0.76 - 0.44 * effectiveAtel);
      const atelGrad = wctx.createLinearGradient(0, h, 0, topY);
      const alphaStrong = Math.min(0.82, 0.22 + 0.58 * effectiveAtel + (ardsMode ? 0.12 : 0));
      atelGrad.addColorStop(0.0, `rgba(52, 10, 44, ${alphaStrong.toFixed(3)})`);
      atelGrad.addColorStop(0.55, `rgba(88, 22, 62, ${(alphaStrong * 0.65).toFixed(3)})`);
      atelGrad.addColorStop(1.0, 'rgba(88, 22, 62, 0)');
      wctx.fillStyle = atelGrad;
      wctx.fillRect(0, 0, w, h);
    }

    // 2. 肺水腫（下肺野から肺門部へ広がる白濁グラデーション：PEEP上昇で薄まる）
    if (effectiveEdema > 0.005) {
      const alphaEdema = Math.min(0.76, 0.14 + 0.58 * effectiveEdema + (ardsMode ? 0.08 : 0));
      // 肺門寄りの中心座標（右肺は右側が肺門、左肺は左側が肺門）
      const hilumX = side === 'right' ? w * 0.78 : w * 0.22;
      const hilumY = h * 0.58;
      const rad = Math.max(w, h) * (0.42 + 0.28 * effectiveEdema);

      const edemaRad = wctx.createRadialGradient(hilumX, hilumY, rad * 0.08, hilumX, hilumY, rad);
      edemaRad.addColorStop(0.0, `rgba(241, 245, 249, ${alphaEdema.toFixed(3)})`);
      edemaRad.addColorStop(0.5, `rgba(219, 234, 254, ${(alphaEdema * 0.68).toFixed(3)})`);
      edemaRad.addColorStop(1.0, 'rgba(219, 234, 254, 0)');
      wctx.fillStyle = edemaRad;
      wctx.fillRect(0, 0, w, h);

      // 下肺野の重力性浸潤（白濁）
      const baseGrad = wctx.createLinearGradient(0, h * 0.96, 0, h * (0.72 - 0.35 * effectiveEdema));
      baseGrad.addColorStop(0.0, `rgba(235, 244, 255, ${(alphaEdema * 0.88).toFixed(3)})`);
      baseGrad.addColorStop(1.0, 'rgba(235, 244, 255, 0)');
      wctx.fillStyle = baseGrad;
      wctx.fillRect(0, 0, w, h);
    }

    // 3. ARDS コントラスト強調（上肺野の相対的な含気ハイライト vs 下肺野の重力性虚脱）
    if (ardsMode) {
      const upperGrad = wctx.createLinearGradient(0, h * 0.06, 0, h * 0.44);
      upperGrad.addColorStop(0.0, 'rgba(224, 242, 254, 0.26)');
      upperGrad.addColorStop(1.0, 'rgba(224, 242, 254, 0)');
      wctx.fillStyle = upperGrad;
      wctx.fillRect(0, 0, w, h * 0.46);
    }

    // 4. 片肺挿管時の非換気側（左肺）の暗色化シャドウ
    if (unventilatedDarken) {
      wctx.fillStyle = 'rgba(24, 32, 52, 0.42)';
      wctx.fillRect(0, 0, w, h);
    }

    wctx.globalCompositeOperation = 'source-over';
    this._drawPart(this.lungWorkCanvas, cfg, 0, 0, scaleX, scaleY);
  }

  /**
   * 緊張性気胸（右）ON時：右胸郭と虚脱右肺の間に半透明の暗い気胸スペース（空気の層）を描画
   */
  _drawTensionPneumothoraxSpace(pawNorm) {
    const ctx = this.ctx;
    ctx.save();

    // 右胸腔（画面左側）の気胸空気スペース
    ctx.beginPath();
    ctx.moveTo(222, 108);
    ctx.bezierCurveTo(148, 106, 100, 178, 102, 272);
    ctx.bezierCurveTo(104, 336, 132, 366, 186, 362);
    ctx.bezierCurveTo(212, 358, 228, 330, 232, 285);
    ctx.lineTo(234, 152);
    ctx.closePath();

    const grad = ctx.createRadialGradient(148, 228, 12, 162, 236, 130);
    const alpha = 0.56 + pawNorm * 0.16;
    grad.addColorStop(0, `rgba(6, 12, 26, ${alpha.toFixed(3)})`);
    grad.addColorStop(0.75, `rgba(12, 22, 42, ${(alpha * 0.85).toFixed(3)})`);
    grad.addColorStop(1, 'rgba(15, 23, 42, 0.15)');
    ctx.fillStyle = grad;
    ctx.fill();

    // 陽圧空気の輪郭を示す繊細な青白い気胸腔ライン
    ctx.strokeStyle = `rgba(125, 211, 252, ${(0.28 + pawNorm * 0.25).toFixed(3)})`;
    ctx.lineWidth = 1.4;
    ctx.setLineDash([4, 3]);
    ctx.stroke();
    ctx.setLineDash([]);

    // 気胸腔の簡易ラベル
    ctx.fillStyle = 'rgba(186, 230, 253, 0.72)';
    ctx.font = 'bold 10px "Segoe UI", Meiryo, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('気胸腔', 138, 206);
    ctx.font = '9px "Segoe UI", Meiryo, sans-serif';
    ctx.fillText('(陽圧空気)', 138, 220);

    ctx.restore();
  }

  /**
   * COPD / 喘息発作 ON時：気管・主気管支領域に赤い腫脹・狭窄ハイライトを重ねる
   */
  _drawAirwayNarrowingHighlight(absFlow) {
    const ctx = this.ctx;
    const pulse = 0.45 + Math.min(0.4, absFlow / 65.0);
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    const drawSwollenPath = (x1, y1, x2, y2, width) => {
      // 外側の赤い炎症グロウ
      ctx.strokeStyle = `rgba(239, 68, 68, ${(0.34 * pulse).toFixed(3)})`;
      ctx.lineWidth = width + 10;
      ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();

      // 内側の濃い赤色腫脹ハイライト
      ctx.strokeStyle = `rgba(220, 38, 38, ${(0.58 * pulse).toFixed(3)})`;
      ctx.lineWidth = width;
      ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
    };

    // 気管〜気管分岐部
    drawSwollenPath(250, 94, 250, 190, 12);
    // 右主気管支（画面左）
    drawSwollenPath(250, 188, 198, 226, 9);
    // 左主気管支（画面右）
    drawSwollenPath(250, 188, 304, 228, 9);

    ctx.restore();
  }

  /**
   * 片肺挿管（右）ON時：気管から右主気管支へ深く伸びる半透明の気管チューブ（ETT）と先端マーカーを描画
   */
  _drawRightMainstemETT() {
    const ctx = this.ctx;
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    // チューブ本体パス（気管上部 -> 分岐部 -> 右主気管支へ深く挿入）
    const traceTube = () => {
      ctx.beginPath();
      ctx.moveTo(250, 56);
      ctx.lineTo(250, 176);
      ctx.quadraticCurveTo(250, 196, 234, 208);
      ctx.lineTo(205, 228);
    };

    // 半透明チューブ外枠
    traceTube();
    ctx.strokeStyle = 'rgba(224, 242, 254, 0.72)';
    ctx.lineWidth = 11;
    ctx.stroke();

    // チューブ内腔
    traceTube();
    ctx.strokeStyle = 'rgba(14, 165, 233, 0.35)';
    ctx.lineWidth = 7;
    ctx.stroke();

    // X線不透過ライン（青い細線）
    traceTube();
    ctx.strokeStyle = 'rgba(56, 189, 248, 0.95)';
    ctx.lineWidth = 1.6;
    ctx.setLineDash([4, 2]);
    ctx.stroke();
    ctx.setLineDash([]);

    // 右主気管支内のカフ（半透明バルーン）
    ctx.save();
    ctx.translate(216, 220);
    ctx.rotate(Math.atan2(228 - 208, 205 - 234));
    ctx.fillStyle = 'rgba(56, 189, 248, 0.36)';
    ctx.strokeStyle = 'rgba(186, 230, 253, 0.85)';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.ellipse(0, 0, 11, 8.5, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.restore();

    // 先端マーカー（ハイライトリング）
    ctx.fillStyle = '#f43f5e';
    ctx.beginPath();
    ctx.arc(204, 229, 3.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.2;
    ctx.stroke();

    ctx.restore();
  }

  /**
   * 胸水オーバーレイ描画（胸郭と肺の間にメニスカス曲線付きの半透明液体レイヤー）
   */
  _drawPleuralEffusion(effusionRatio, diaphShiftY, isFrontTint = false) {
    if (effusionRatio <= 0.005) return;
    const ctx = this.ctx;
    const baseBottom = 362 + diaphShiftY * 0.5;
    const maxHeight = 135;
    const fluidH = maxHeight * effusionRatio;
    const topInnerY = baseBottom - fluidH;
    // 外側（肋骨横隔膜角側）がやや高く反り上がるメニスカス曲線
    const meniscusLift = 14 + 20 * effusionRatio;

    const drawSideFluid = (isRightLung) => {
      // 画面左側＝右胸腔、画面右側＝左胸腔
      const outerX = isRightLung ? 108 : 392;
      const innerX = isRightLung ? 236 : 264;
      const ctrlX = isRightLung ? 155 : 345;
      const ctrlY = topInnerY + 6;
      const topOuterY = topInnerY - meniscusLift;

      ctx.save();
      ctx.beginPath();
      ctx.moveTo(innerX, baseBottom);
      ctx.lineTo(innerX, topInnerY);
      // 内側から外側へメニスカス曲線
      ctx.quadraticCurveTo(ctrlX, ctrlY, outerX, topOuterY);
      // 胸壁（肋骨内側）に沿って下端へ丸く戻る
      ctx.quadraticCurveTo(
        isRightLung ? outerX - 4 : outerX + 4,
        baseBottom - 4,
        isRightLung ? outerX + 34 : outerX - 34,
        baseBottom + 4
      );
      ctx.lineTo(innerX, baseBottom);
      ctx.closePath();

      const grad = ctx.createLinearGradient(0, topOuterY, 0, baseBottom);
      if (isFrontTint) {
        // 肺の前面にうっすら重ねる浸漬ハイライト
        const a = 0.14 + 0.16 * effusionRatio;
        grad.addColorStop(0, `rgba(210, 232, 238, ${(a * 0.7).toFixed(3)})`);
        grad.addColorStop(1, `rgba(218, 214, 168, ${a.toFixed(3)})`);
      } else {
        // 胸郭と肺の間の本体液体レイヤー（淡い黄色〜青白い漿液カラー）
        const a = 0.28 + 0.34 * effusionRatio;
        grad.addColorStop(0, `rgba(186, 226, 238, ${(a * 0.82).toFixed(3)})`);
        grad.addColorStop(0.55, `rgba(214, 224, 186, ${a.toFixed(3)})`);
        grad.addColorStop(1, `rgba(210, 198, 138, ${Math.min(0.75, a * 1.15).toFixed(3)})`);
      }
      ctx.fillStyle = grad;
      ctx.fill();

      // メニスカス液面の繊細なハイライトライン
      ctx.beginPath();
      ctx.moveTo(innerX, topInnerY);
      ctx.quadraticCurveTo(ctrlX, ctrlY, outerX, topOuterY);
      ctx.strokeStyle = `rgba(226, 244, 250, ${(0.35 + 0.35 * effusionRatio).toFixed(3)})`;
      ctx.lineWidth = isFrontTint ? 1.4 : 1.0;
      ctx.stroke();
      ctx.restore();
    };

    drawSideFluid(true);
    drawSideFluid(false);
  }

  /**
   * 気道内圧に応じた肺・気管支カラーオーバーレイの描画
   */
  _drawPressureOverlay(paw, rightScaleX, rightScaleY, leftScaleX, leftScaleY) {
    const ctx = this.ctx;
    // 圧レベルを 0.0 (PEEP 5以下) ～ 1.0 (35 cmH2O以上) に正規化
    const normP = Math.max(0, Math.min(1, (paw - 3) / 30));
    const alpha = Math.max(0.02, Math.min(0.32, normP * 0.30));

    // 低圧: シアンブルー → 中圧: アンバー → 高圧: レッド
    let r, g, b;
    if (normP < 0.5) {
      const k = normP / 0.5;
      r = Math.round(56 + (245 - 56) * k);
      g = Math.round(189 + (158 - 189) * k);
      b = Math.round(248 + (11 - 248) * k);
    } else {
      const k = (normP - 0.5) / 0.5;
      r = Math.round(245 + (239 - 245) * k);
      g = Math.round(158 + (68 - 158) * k);
      b = Math.round(11 + (68 - 11) * k);
    }

    const drawGlow = (cx, cy, rx, ry, ratio) => {
      if (ratio <= 0.02) return;
      ctx.save();
      ctx.globalCompositeOperation = 'screen';
      ctx.globalAlpha = alpha * Math.max(0.25, ratio);
      ctx.translate(cx, cy);
      ctx.scale(1, ry / rx);
      const grad = ctx.createRadialGradient(0, 0, rx * 0.1, 0, 0, rx);
      grad.addColorStop(0, `rgba(${r}, ${g}, ${b}, 0.95)`);
      grad.addColorStop(0.65, `rgba(${r}, ${g}, ${b}, 0.45)`);
      grad.addColorStop(1, `rgba(${r}, ${g}, ${b}, 0)`);
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(0, 0, rx, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    };

    // 右肺・左肺・気管支分岐部への圧連動オーバーレイ
    drawGlow(182, 248, 66 * rightScaleX, 130 * rightScaleY, this.rightLungRatio);
    drawGlow(318, 248, 66 * leftScaleX, 130 * leftScaleY, this.leftLungRatio);
    drawGlow(250, 175, 36, 56, 1.0);
  }

  /**
   * 気管〜主気管支〜肺門を流れる微細な気流矢印パーティクル描画
   */
  _drawAirflowParticles(flowLmin, dtSec) {
    const ctx = this.ctx;
    const absFlow = Math.abs(flowLmin);
    if (absFlow < 1.5) return;

    const isInsp = flowLmin > 0;
    const speed = Math.min(2.2, (absFlow / 50.0) * 1.35);

    // 経路点（気管上部 -> 分岐部 -> 左右主気管支末梢）
    const getPoint = (branch, t) => {
      if (t <= 0.52) {
        const u = t / 0.52;
        return {
          x: 250,
          y: 78 + u * (192 - 78),
          angle: Math.PI / 2
        };
      }
      const u = (t - 0.52) / 0.48;
      const targetX = branch === 'right' ? 182 : 318;
      const targetY = 236;
      const x = 250 + (targetX - 250) * u;
      const y = 192 + (targetY - 192) * u;
      const angle = Math.atan2(targetY - 192, targetX - 250);
      return { x, y, angle };
    };

    ctx.save();
    for (const p of this.particles) {
      const branchRatio = p.branch === 'right' ? this.rightLungRatio : this.leftLungRatio;
      if (branchRatio < 0.05) continue;

      p.t += (isInsp ? 1 : -1) * speed * dtSec * Math.max(0.35, branchRatio);
      if (p.t > 1.0) p.t -= 1.0;
      if (p.t < 0.0) p.t += 1.0;

      const pt = getPoint(p.branch, p.t);
      const drawAngle = isInsp ? pt.angle : pt.angle + Math.PI;
      const edgeFade = Math.sin(p.t * Math.PI);
      const alpha = Math.min(0.85, (absFlow / 45.0) * 0.85) * edgeFade * Math.min(1, branchRatio + 0.2);

      ctx.save();
      ctx.translate(pt.x, pt.y);
      ctx.rotate(drawAngle);
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = isInsp ? '#38bdf8' : '#fbbf24';
      ctx.lineWidth = 2.0;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      ctx.moveTo(-4, -3.5);
      ctx.lineTo(2.5, 0);
      ctx.lineTo(-4, 3.5);
      ctx.stroke();
      ctx.restore();
    }
    ctx.restore();
  }

  /**
   * 毎フレーム描画（main.js の requestAnimationFrame から呼び出し）
   */
  render(engine, params, nowMs) {
    const ctx = this.ctx;
    const S = this.logicalSize;

    // 経過時間 dt
    const dtSec = this.lastTimestamp !== null
      ? Math.min(0.05, (nowMs - this.lastTimestamp) / 1000.0)
      : 1 / 60;
    this.lastTimestamp = nowMs;

    // 背景グラデーション描画（中央をわずかに明るくするスポットライト効果）
    const bgGrad = ctx.createRadialGradient(S * 0.5, S * 0.46, 24, S * 0.5, S * 0.48, S * 0.56);
    bgGrad.addColorStop(0, '#314464');
    bgGrad.addColorStop(0.45, '#1d2b44');
    bgGrad.addColorStop(0.8, '#0f172a');
    bgGrad.addColorStop(1, '#060c18');
    ctx.fillStyle = bgGrad;
    ctx.fillRect(0, 0, S, S);

    if (!this.loaded) {
      ctx.fillStyle = '#94a3b8';
      ctx.font = '13px "Segoe UI", Meiryo, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(this.loadError ? `エラー: ${this.loadError}` : 'アトラス解剖図を読み込み中...', S / 2, S / 2);
      return;
    }

    // 1. 病態力学（実効 C/R および視覚パラメータ）の取得
    const patho = engine.pathology || computePathologyMechanics(params);
    // コンプライアンス低下による「硬くて膨らみにくい」視覚制限係数 (0.35〜1.0)
    const expandStiffness = 0.35 + 0.65 * patho.complianceRatio;

    // 2. 物理パラメータの滑らかな追従（ダンピング）
    const lerp = 0.25;
    this.smoothV += (engine.V - this.smoothV) * lerp;
    this.smoothPeep += (params.peep - this.smoothPeep) * lerp;
    this.smoothPaw += (engine.Paw - this.smoothPaw) * lerp;
    this.smoothPalv += (engine.Palv - this.smoothPalv) * lerp;
    this.smoothPmus += (engine.Pmus - this.smoothPmus) * lerp;
    this.smoothFlow += (engine.Flow * 60.0 - this.smoothFlow) * lerp;

    // 3. PEEP ＆ COPDエアトラッピングによる呼気終末ベースラインスケール
    const peepNorm = Math.max(0, Math.min(1, this.smoothPeep / 20.0));
    const autoPeepNorm = Math.max(0, Math.min(1, (engine.currentAutoPeep || 0) / 10.0));
    const copdTrapBoost = patho.airwayNarrowing ? (0.045 + autoPeepNorm * 0.065) : 0;
    const collapseShrink = patho.effectiveAtel * 0.045 + patho.effusionRatio * 0.035;
    const baseScale = 0.94 + peepNorm * 0.06 + copdTrapBoost - collapseShrink;

    // 4. 換気量 (Volume) による左右肺の個別スケール計算（eff_C/base_C 連動の硬さ制限＋各病態補正）
    const volNorm = Math.max(0, Math.min(1.6, this.smoothV / 600.0));
    const pawNorm = Math.max(0, Math.min(1, (this.smoothPaw - 5) / 30.0));

    let rightScaleX = baseScale + volNorm * 0.11 * this.rightLungRatio * expandStiffness;
    let rightScaleY = baseScale + volNorm * 0.14 * this.rightLungRatio * expandStiffness;
    let leftScaleX = baseScale + volNorm * 0.11 * this.leftLungRatio * expandStiffness;
    let leftScaleY = baseScale + volNorm * 0.14 * this.leftLungRatio * expandStiffness;

    // 緊張性気胸（右）ON時：右肺を肺門側へ大幅に虚脱縮小
    if (patho.pneumothoraxRight) {
      rightScaleX = 0.54 + volNorm * 0.025;
      rightScaleY = 0.60 + volNorm * 0.030;
    }

    // 片肺挿管（右）ON時：右肺は過膨張気味に大きく動き、左肺は膨張せずやや縮小
    if (patho.deepIntubationRight) {
      rightScaleX = baseScale + 0.04 + volNorm * 0.15 * expandStiffness;
      rightScaleY = baseScale + 0.04 + volNorm * 0.18 * expandStiffness;
      leftScaleX = Math.max(0.84, baseScale - 0.08);
      leftScaleY = Math.max(0.84, baseScale - 0.08);
    }

    // 5. 横隔膜の上下動（PEEP + 平均換気量 + 自発努力 Pmus + COPD低位平坦化に連動）
    const avgRatio = (this.rightLungRatio + this.leftLungRatio) * 0.5;
    const pmusNorm = Math.max(0, Math.min(1, this.smoothPmus / 15.0));
    const copdDiaphDrop = patho.airwayNarrowing ? (10 + autoPeepNorm * 12) : 0;
    const copdDiaphFlat = patho.airwayNarrowing ? (0.07 + autoPeepNorm * 0.06) : 0;
    const diaphShiftY = peepNorm * 6 + copdDiaphDrop + volNorm * 22 * avgRatio * expandStiffness + pmusNorm * 8;
    const diaphScaleY = Math.max(0.76, 1.0 - copdDiaphFlat - volNorm * 0.10 * avgRatio * expandStiffness - pmusNorm * 0.05);

    // 6. 心拍数 (HR) に同期した 2 峰性拍動（ドクドク）＋ 緊張性気胸による縦隔左方偏位
    const hr = params.hr || 75;
    this.heartPhase = (this.heartPhase + (hr / 60.0) * dtSec) % 1.0;
    const beat1 = Math.exp(-Math.pow((this.heartPhase - 0.12) / 0.065, 2));
    const beat2 = 0.42 * Math.exp(-Math.pow((this.heartPhase - 0.30) / 0.055, 2));
    const heartScale = 1.0 + (beat1 + beat2) * 0.048;
    // 緊張性気胸（右）時は気道内圧上昇に連動して心臓を左（健側・画面右方向）へ +26〜36px 偏位
    const heartShiftX = patho.pneumothoraxRight ? (patho.mediastinalShiftBase + pawNorm * 10.0) : 0;

    // =========================================================
    // レイヤー描画（背面 -> 前面）
    // =========================================================

    // Layer 1: 胸郭・脊椎・気管支（ベースフレーム）
    this._drawPart(this.parts.ribcage, this.layout.ribcage);

    // Layer 2: 横隔膜（肺底部の下）
    this._drawPart(
      this.parts.diaphragm,
      this.layout.diaphragm,
      0,
      diaphShiftY,
      1.0 + volNorm * 0.03 * avgRatio * expandStiffness,
      diaphScaleY
    );

    // Layer 2.2: 緊張性気胸（右）の暗い気胸スペース（胸郭と虚脱右肺の間）
    if (patho.pneumothoraxRight) {
      this._drawTensionPneumothoraxSpace(pawNorm);
    }

    // Layer 2.5: 胸水（胸郭と肺の間の胸腔下部液体レイヤー・メニスカス曲線）
    this._drawPleuralEffusion(patho.effusionRatio, diaphShiftY, false);

    // Layer 3: 右肺・左肺（通常肺 or 肺断面 + 無気肺/肺水腫/ARDS/無換気クリッピング合成）
    const rightImg = this.showLungSection ? this.parts.rightLungSection : this.parts.rightLung;
    const leftImg = this.showLungSection ? this.parts.leftLungSection : this.parts.leftLung;
    this._drawLungWithPathology(
      rightImg, this.layout.rightLung, 'right',
      rightScaleX, rightScaleY, patho.effectiveAtel, patho.effectiveEdema,
      { ardsMode: patho.ardsMode, unventilatedDarken: false }
    );
    this._drawLungWithPathology(
      leftImg, this.layout.leftLung, 'left',
      leftScaleX, leftScaleY, patho.effectiveAtel, patho.effectiveEdema,
      { ardsMode: patho.ardsMode, unventilatedDarken: patho.deepIntubationRight }
    );

    // Layer 3.5: 胸水の前面浸漬ハイライト（肺下端が胸水に浸かる立体感）
    this._drawPleuralEffusion(patho.effusionRatio, diaphShiftY, true);

    // Layer 3.8: COPD/喘息発作時の気管・気管支 赤色腫脹ハイライト
    if (patho.airwayNarrowing) {
      this._drawAirwayNarrowingHighlight(Math.abs(this.smoothFlow));
    }

    // Layer 4: 気道内圧カラーオーバーレイ & 気流矢印パーティクル
    this._drawPressureOverlay(this.smoothPaw, rightScaleX, rightScaleY, leftScaleX, leftScaleY);
    this._drawAirflowParticles(this.smoothFlow, dtSec);

    // Layer 4.2: 片肺挿管（右）時の気管チューブ先端マーカー
    if (patho.deepIntubationRight) {
      this._drawRightMainstemETT();
    }

    // Layer 5: 心臓（最前面・心切痕位置で拍動・緊張性気胸時は健側へ縦隔偏位）
    if (this.showHeart) {
      this._drawPart(
        this.parts.heart,
        this.layout.heart,
        heartShiftX,
        diaphShiftY * 0.18,
        heartScale,
        heartScale
      );
    }

    // キャンバス下端のソフトビネット（横隔膜下部・胸郭下端を背景へ自然になじませる）
    const bottomFade = ctx.createLinearGradient(0, S - 48, 0, S);
    bottomFade.addColorStop(0, 'rgba(6, 12, 24, 0)');
    bottomFade.addColorStop(1, 'rgba(6, 12, 24, 0.72)');
    ctx.fillStyle = bottomFade;
    ctx.fillRect(0, S - 48, S, 48);

    // 病態プリセット / 片肺換気時の上部ステータスバッジ
    let statusMsg = null;
    if (patho.pneumothoraxRight) statusMsg = '⚠ 緊張性気胸 (右)：右肺虚脱・縦隔左方偏位';
    else if (patho.airwayNarrowing) statusMsg = '⚠ COPD / 喘息発作：気道狭窄・エアトラッピング';
    else if (patho.ardsMode) statusMsg = '⚠ ARDS：下肺野虚脱・白濁（PEEPでリクルート）';
    else if (patho.deepIntubationRight) statusMsg = '⚠ 片肺挿管 (右)：右肺過膨張・左肺無換気';
    else if (this.rightLungRatio < 0.5 || this.leftLungRatio < 0.5) {
      statusMsg = this.leftLungRatio < 0.5 ? '⚠ 右片肺換気 (左肺換気低下)' : '⚠ 左片肺換気 (右肺換気低下)';
    }
    if (statusMsg) {
      ctx.save();
      ctx.font = 'bold 11px "Segoe UI", Meiryo, sans-serif';
      const tw = ctx.measureText(statusMsg).width + 18;
      ctx.fillStyle = 'rgba(15, 23, 42, 0.85)';
      ctx.strokeStyle = 'rgba(244, 63, 94, 0.75)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.roundRect(S / 2 - tw / 2, S - 26, tw, 20, 10);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = '#fda4af';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(statusMsg, S / 2, S - 16);
      ctx.restore();
    }
  }
}
