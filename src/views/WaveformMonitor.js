export class WaveformMonitor {
  constructor(canvasElement, maxHistory = 480) {
    this.canvas = canvasElement;
    this.ctx = canvasElement.getContext('2d');
    this.maxHistory = maxHistory;
    this.history = [];

    this.padL = 44;
    this.padR = 54;

    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  resize() {
    this.canvas.width = this.canvas.clientWidth;
    this.canvas.height = this.canvas.clientHeight;
  }

  pushSample(sample) {
    this.history.push(sample);
    if (this.history.length > this.maxHistory) {
      this.history.shift();
    }
  }

  render(peepSetting) {
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

    if (this.history.length < 2) return;
    const stepX = plotW / this.maxHistory;

    // 2. 波形プロット
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

    // 3. 右端現在値バッジ
    const last = this.history[this.history.length - 1];
    const lastX = this.padL + (this.history.length - 1) * stepX;
    this.drawTag(lastX, pawY(last.paw), last.paw.toFixed(1), '#fbbf24');
    this.drawTag(lastX, flowY(last.flow), Math.round(last.flow), '#38bdf8');
    this.drawTag(lastX, volY(last.vol), Math.round(last.vol), '#34d399');
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
