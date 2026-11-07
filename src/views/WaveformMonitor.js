export class WaveformMonitor {
  constructor(canvasElement, maxHistory = 480) {
    this.canvas = canvasElement;
    this.ctx = canvasElement.getContext('2d');
    this.maxHistory = maxHistory;
    this.history = [];

    // 比較用フリーズ（リファレンス）波形データ
    this.freezeHistory = null;
    this.isFrozenOverlay = false;

    // カーソル計測用
    this.cursorX = null;
    this.isPinned = false; // クリックによる位置固定ピン留め

    this.padL = 44;
    this.padR = 54;

    this.resize();
    window.addEventListener('resize', () => this.resize());

    // マウスカーソル計測イベント
    this.canvas.addEventListener('mousemove', (e) => {
      if (!this.isPinned) {
        const rect = this.canvas.getBoundingClientRect();
        this.cursorX = e.clientX - rect.left;
      }
    });

    this.canvas.addEventListener('click', (e) => {
      const rect = this.canvas.getBoundingClientRect();
      const clickX = e.clientX - rect.left;
      if (this.isPinned) {
        this.isPinned = false;
        this.cursorX = clickX;
      } else {
        this.cursorX = clickX;
        this.isPinned = true;
      }
    });

    this.canvas.addEventListener('mouseleave', () => {
      if (!this.isPinned) {
        this.cursorX = null;
      }
    });
  }

  resize() {
    this.canvas.width = this.canvas.clientWidth;
    this.canvas.height = this.canvas.clientHeight;
  }

  pushSample(sample) {
    this.history.push({ ...sample });
    if (this.history.length > this.maxHistory) {
      this.history.shift();
    }
  }

  /**
   * 現在の波形をフリーズ・基準波形（リファレンス）として固定保存
   */
  freezeCurrentWaveform() {
    if (this.history.length > 5) {
      this.freezeHistory = this.history.map(s => ({ ...s }));
      this.isFrozenOverlay = true;
      return true;
    }
    return false;
  }

  /**
   * フリーズ比較波形の解除
   */
  clearFrozenWaveform() {
    this.freezeHistory = null;
    this.isFrozenOverlay = false;
  }

  render(peepSetting, isPaused = false) {
    const w = this.canvas.width;
    const h = this.canvas.height;
    const ctx = this.ctx;
    ctx.clearRect(0, 0, w, h);

    const plotW = w - this.padL - this.padR;

    // スケール座標マッピング
    const pawTop = 14, pawBot = h * 0.31;
    const pawY = (v) => pawBot - (v / 40.0) * (pawBot - pawTop);

    const flowTop = h * 0.36, flowBot = h * 0.65;
    const flowZero = (flowTop + flowBot) / 2;
    const flowY = (v) => flowZero - (v / 80.0) * ((flowBot - flowTop) / 2);

    const volTop = h * 0.70, volBot = h * 0.96;
    const volY = (v) => volBot - (v / 800.0) * (volBot - volTop);

    ctx.font = '10px sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';

    // 1. 目盛り線とグリッド描画
    [0, 10, 20, 30, 40].forEach(val => {
      const y = pawY(val);
      ctx.strokeStyle = val === 0 ? '#475569' : '#1e293b';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(this.padL, y); ctx.lineTo(w - this.padR, y); ctx.stroke();
      ctx.fillStyle = '#fbbf24';
      ctx.fillText(val, this.padL - 6, y);
    });

    // PEEP破線
    const yPeep = pawY(peepSetting);
    ctx.strokeStyle = 'rgba(251, 191, 36, 0.3)';
    ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(this.padL, yPeep); ctx.lineTo(w - this.padR, yPeep); ctx.stroke();
    ctx.setLineDash([]);

    [-80, -40, 0, 40, 80].forEach(val => {
      const y = flowY(val);
      ctx.strokeStyle = val === 0 ? '#475569' : '#1e293b';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(this.padL, y); ctx.lineTo(w - this.padR, y); ctx.stroke();
      ctx.fillStyle = '#38bdf8';
      ctx.fillText(val > 0 ? `+${val}` : val, this.padL - 6, y);
    });

    [0, 200, 400, 600, 800].forEach(val => {
      const y = volY(val);
      ctx.strokeStyle = val === 0 ? '#475569' : '#1e293b';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(this.padL, y); ctx.lineTo(w - this.padR, y); ctx.stroke();
      ctx.fillStyle = '#34d399';
      ctx.fillText(val, this.padL - 6, y);
    });

    // 左境界線
    ctx.strokeStyle = '#334155';
    ctx.beginPath();
    ctx.moveTo(this.padL, pawTop); ctx.lineTo(this.padL, pawBot);
    ctx.moveTo(this.padL, flowTop); ctx.lineTo(this.padL, flowBot);
    ctx.moveTo(this.padL, volTop); ctx.lineTo(this.padL, volBot);
    ctx.stroke();

    const stepX = plotW / this.maxHistory;

    // 2. 比較用フリーズ（リファレンス）波形のオーバーレイ描画
    if (this.freezeHistory && this.freezeHistory.length > 1) {
      const fLen = this.freezeHistory.length;

      ctx.save();
      ctx.setLineDash([4, 3]);

      // Freeze Paw
      ctx.strokeStyle = 'rgba(251, 191, 36, 0.40)';
      ctx.lineWidth = 1.8;
      ctx.beginPath();
      for (let i = 0; i < fLen; i++) {
        const x = this.padL + i * stepX;
        const y = pawY(this.freezeHistory[i].paw);
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();

      // Freeze Flow
      ctx.strokeStyle = 'rgba(56, 189, 248, 0.40)';
      ctx.lineWidth = 1.8;
      ctx.beginPath();
      for (let i = 0; i < fLen; i++) {
        const x = this.padL + i * stepX;
        const y = flowY(this.freezeHistory[i].flow);
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();

      // Freeze Volume
      ctx.strokeStyle = 'rgba(52, 211, 153, 0.40)';
      ctx.lineWidth = 1.8;
      ctx.beginPath();
      for (let i = 0; i < fLen; i++) {
        const x = this.padL + i * stepX;
        const y = volY(this.freezeHistory[i].vol);
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();

      ctx.restore();

      // フリーズ固定中のインジケーターバッジ
      ctx.fillStyle = 'rgba(56, 189, 248, 0.2)';
      ctx.strokeStyle = '#38bdf8';
      ctx.lineWidth = 1;
      ctx.fillRect(w - this.padR - 110, 6, 105, 18);
      ctx.strokeRect(w - this.padR - 110, 6, 105, 18);
      ctx.fillStyle = '#e0f2fe';
      ctx.font = 'bold 9px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('❄ 基準波形 比較中', w - this.padR - 57, 15);
    }

    // 3. リアルタイム波形プロット
    if (this.history.length < 2) return;

    // Palv 点線
    ctx.strokeStyle = 'rgba(251, 191, 36, 0.45)';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    for (let i = 0; i < this.history.length; i++) {
      const x = this.padL + i * stepX;
      const y = pawY(this.history[i].palv);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.setLineDash([]);

    // Paw
    ctx.strokeStyle = '#fbbf24';
    ctx.lineWidth = 2.2;
    ctx.beginPath();
    for (let i = 0; i < this.history.length; i++) {
      const x = this.padL + i * stepX;
      const y = pawY(this.history[i].paw);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Flow
    ctx.strokeStyle = '#38bdf8';
    ctx.lineWidth = 2.2;
    ctx.beginPath();
    for (let i = 0; i < this.history.length; i++) {
      const x = this.padL + i * stepX;
      const y = flowY(this.history[i].flow);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Volume
    ctx.strokeStyle = '#34d399';
    ctx.lineWidth = 2.2;
    ctx.beginPath();
    for (let i = 0; i < this.history.length; i++) {
      const x = this.padL + i * stepX;
      const y = volY(this.history[i].vol);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // 4. 右端現在値バッジ
    const last = this.history[this.history.length - 1];
    const lastX = this.padL + (this.history.length - 1) * stepX;
    this.drawTag(lastX, pawY(last.paw), last.paw.toFixed(1), '#fbbf24');
    this.drawTag(lastX, flowY(last.flow), Math.round(last.flow), '#38bdf8');
    this.drawTag(lastX, volY(last.vol), Math.round(last.vol), '#34d399');

    // 5. 一時停止中の状態インジケーター（画面中央上部）
    if (isPaused) {
      ctx.fillStyle = 'rgba(217, 119, 6, 0.25)';
      ctx.strokeStyle = '#f59e0b';
      ctx.lineWidth = 1;
      ctx.fillRect(this.padL + 10, 6, 140, 18);
      ctx.strokeRect(this.padL + 10, 6, 140, 18);
      ctx.fillStyle = '#fef3c7';
      ctx.font = 'bold 9px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('⏸ 一時停止中 (波形計測可能)', this.padL + 80, 15);
    }

    // 6. マウスホバー位置での縦線計測カーソル ＆ 波形ポイント ＆ 差分ツールチップ
    if (this.cursorX !== null && this.cursorX >= this.padL && this.cursorX <= w - this.padR) {
      const index = Math.round((this.cursorX - this.padL) / stepX);
      const curSample = this.history[index];

      if (curSample) {
        const curPawY = pawY(curSample.paw);
        const curFlowY = flowY(curSample.flow);
        const curVolY = volY(curSample.vol);

        // 縦線カーソル（ピン留め時は明るい破線）
        ctx.strokeStyle = this.isPinned ? '#38bdf8' : 'rgba(255, 255, 255, 0.75)';
        ctx.lineWidth = 1.2;
        ctx.setLineDash([3, 2]);
        ctx.beginPath();
        ctx.moveTo(this.cursorX, 10);
        ctx.lineTo(this.cursorX, h - 10);
        ctx.stroke();
        ctx.setLineDash([]);

        // 各波形上の計測ポイントマーカー（光る丸点）
        const drawMarker = (x, y, color) => {
          ctx.fillStyle = color;
          ctx.beginPath();
          ctx.arc(x, y, 4, 0, Math.PI * 2);
          ctx.fill();
          ctx.strokeStyle = '#ffffff';
          ctx.lineWidth = 1.5;
          ctx.stroke();
        };

        drawMarker(this.cursorX, curPawY, '#fbbf24');
        drawMarker(this.cursorX, curFlowY, '#38bdf8');
        drawMarker(this.cursorX, curVolY, '#34d399');

        // フリーズ波形がある場合のマーカー描画
        const fSample = (this.freezeHistory && this.freezeHistory[index]) ? this.freezeHistory[index] : null;
        if (fSample) {
          const drawGhostMarker = (x, y, color) => {
            ctx.fillStyle = 'rgba(255, 255, 255, 0.8)';
            ctx.strokeStyle = color;
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            ctx.arc(x, y, 3, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();
          };
          drawGhostMarker(this.cursorX, pawY(fSample.paw), '#fbbf24');
          drawGhostMarker(this.cursorX, flowY(fSample.flow), '#38bdf8');
          drawGhostMarker(this.cursorX, volY(fSample.vol), '#34d399');
        }

        // カーソル位置の測定ツールチップテキスト
        let tipText = `Paw: ${curSample.paw.toFixed(1)} cmH2O | Flow: ${Math.round(curSample.flow)} L/min | Vol: ${Math.round(curSample.vol)} mL`;
        if (fSample) {
          const dPaw = (curSample.paw - fSample.paw).toFixed(1);
          const dPawSign = curSample.paw >= fSample.paw ? `+${dPaw}` : dPaw;
          const dVol = Math.round(curSample.vol - fSample.vol);
          const dVolSign = curSample.vol >= fSample.vol ? `+${dVol}` : dVol;
          tipText += ` (基準比 ΔPaw:${dPawSign}, ΔVol:${dVolSign})`;
        }
        if (this.isPinned) {
          tipText = `📌 [固定] ` + tipText;
        }

        ctx.font = 'bold 9.5px sans-serif';
        const textW = ctx.measureText(tipText).width + 18;
        let boxX = this.cursorX - textW / 2;
        if (boxX < this.padL) boxX = this.padL;
        if (boxX + textW > w - this.padR) boxX = w - this.padR - textW;

        ctx.fillStyle = 'rgba(15, 23, 42, 0.94)';
        ctx.strokeStyle = this.isPinned ? '#38bdf8' : '#94a3b8';
        ctx.lineWidth = 1.2;
        ctx.fillRect(boxX, h - 23, textW, 20);
        ctx.strokeRect(boxX, h - 23, textW, 20);

        ctx.fillStyle = '#f8fafc';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(tipText, boxX + textW / 2, h - 13);
      }
    }
  }

  drawTag(x, y, text, color) {
    const ctx = this.ctx;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x, y, 3.5, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = '#0f172a';
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.2;
    ctx.fillRect(x + 6, y - 9, 42, 18);
    ctx.strokeRect(x + 6, y - 9, 42, 18);

    ctx.fillStyle = color;
    ctx.font = 'bold 10px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, x + 27, y);
  }
}
