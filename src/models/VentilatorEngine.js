export class VentilatorEngine {
  constructor(initialParams) {
    this.params = { ...initialParams };
    
    // 状態管理
    this.phase = 'EXH'; // 'INSP_FLOW', 'INSP_PAUSE', 'EXH'
    this.currentBreathType = 'MAND'; // 'MAND', 'PS'
    this.phaseTime = 0;
    this.mandTimer = 0;
    this.spontTimer = 1.5;
    this.inSpontEffort = false;
    this.spontEffortTime = 0;
    this.triggeredInThisEffort = false;

    // 物理出力変数
    this.V = 0;         // mL
    this.Flow = 0;      // L/s
    this.Paw = this.params.peep;
    this.Palv = this.params.peep;
    this.Pmus = 0;
    this.peakFlow = 0;

    // 測定値
    this.cyclePpeak = 0;
    this.cyclePplat = null;
    this.cycleVstart = 0;
    this.cycleVmax = 0;
    this.currentAutoPeep = 0;

    // コールバック
    this.onCycleFinished = null;
    this.onMistrigger = null;
    this.onTriggered = null;
  }

  updateParams(newParams) {
    this.params = { ...this.params, ...newParams };
  }

  startInspiration(type, isSpontTriggered) {
    this.currentAutoPeep = Math.max(0, this.V / this.params.C);
    this.phase = 'INSP_FLOW';
    this.currentBreathType = type;
    this.phaseTime = 0;
    this.peakFlow = 0;
    this.cyclePpeak = 0;
    this.cyclePplat = null;
    this.cycleVstart = this.V;
    this.cycleVmax = this.V;

    if (type === 'MAND') this.mandTimer = 0;

    if (this.onTriggered) {
      this.onTriggered({ type, isSpontTriggered, autoPeep: this.currentAutoPeep });
    }
  }

  finishInspiration() {
    this.phase = 'EXH';
    this.phaseTime = 0;
    if (this.onCycleFinished) {
      const deliveredVt = Math.max(0, this.cycleVmax - this.cycleVstart);
      this.onCycleFinished({
        ppeak: Math.round(this.cyclePpeak),
        pplat: this.cyclePplat !== null ? Math.round(this.cyclePplat) : null,
        vte: Math.round(deliveredVt)
      });
    }
  }

  update(dt) {
    // フレームレートに依存しない高精度積分のため、最大1ms刻みのサブステップに分割して計算
    const maxSubDt = 0.001;
    const steps = Math.max(1, Math.ceil(dt / maxSubDt));
    const subDt = dt / steps;

    for (let i = 0; i < steps; i++) {
      this._step(subDt);
    }

    return {
      paw: this.Paw,
      palv: this.Palv,
      flow: this.Flow * 60.0, // L/min
      vol: this.V,
      pmus: this.Pmus,
      phase: this.phase,
      currentBreathType: this.currentBreathType
    };
  }

  _step(dt) {
    const eps = 1e-9;
    this.mandTimer += dt;

    // 1. 自発吸気努力（Pmus）の計算
    const spontDur = 0.85;
    if (this.params.spontRR > 0) {
      this.spontTimer += dt;
      const spontCycle = 60.0 / this.params.spontRR;
      if (!this.inSpontEffort && this.spontTimer >= spontCycle - eps) {
        this.inSpontEffort = true;
        this.spontEffortTime = 0;
        this.spontTimer = 0;
        this.triggeredInThisEffort = false;
      }
    } else {
      this.inSpontEffort = false;
      this.Pmus = 0;
    }

    if (this.inSpontEffort) {
      this.spontEffortTime += dt;
      if (this.spontEffortTime <= spontDur + eps) {
        this.Pmus = this.params.pmusMax * Math.sin((Math.PI * Math.min(this.spontEffortTime, spontDur)) / spontDur);
      } else {
        if (!this.triggeredInThisEffort && this.phase === 'EXH') {
          if (this.onMistrigger) this.onMistrigger();
        }
        this.inSpontEffort = false;
        this.Pmus = 0;
      }
    }

    // 2. 呼気相トリガー判定
    const mandCycle = 60.0 / this.params.rrSet;
    if (this.phase === 'EXH') {
      const elasticRecoil = this.V / this.params.C;
      if (this.inSpontEffort && !this.triggeredInThisEffort && this.phaseTime > 0.25) {
        if (this.Pmus - elasticRecoil >= this.params.trig) {
          this.triggeredInThisEffort = true;
          if (this.params.mode === 'AC') {
            this.startInspiration('MAND', true);
          } else if (this.params.mode === 'PSV') {
            this.startInspiration('PS', true);
          } else if (this.params.mode === 'SIMV') {
            if (this.mandTimer >= mandCycle * 0.65) this.startInspiration('MAND', true);
            else this.startInspiration('PS', true);
          }
        }
      }
      if (this.phase === 'EXH' && (this.params.mode === 'AC' || this.params.mode === 'SIMV')) {
        if (this.mandTimer >= mandCycle - eps) this.startInspiration('MAND', false);
      }
    }

    // 3. 運動方程式による圧・流速計算
    const Vt_L = this.params.vtSet / 1000.0;
    const C_L = this.params.C / 1000.0;
    const V_L = this.V / 1000.0;
    this.Palv = (V_L / C_L) + this.params.peep - this.Pmus;

    if (this.phase === 'INSP_FLOW') {
      if (this.currentBreathType === 'PS') {
        this.Paw = this.params.peep + this.params.ps;
        this.Flow = (this.Paw - this.Palv) / this.params.R;
        if (this.Flow > this.peakFlow) this.peakFlow = this.Flow;
      } else {
        if (this.params.ctrlType === 'PCV') {
          this.Paw = this.params.peep + this.params.pc;
          this.Flow = (this.Paw - this.Palv) / this.params.R;
        } else {
          // VCV
          const tFlow = Math.max(0.2, this.params.ti - this.params.tPause);
          if (this.phaseTime < tFlow - eps) {
            if (this.params.flowPat === 'SQUARE') {
              this.Flow = Vt_L / tFlow;
            } else {
              const fPeak = Vt_L / (0.75 * tFlow);
              const tMid = Math.min(tFlow, this.phaseTime + 0.5 * dt);
              this.Flow = fPeak * (1.0 - 0.5 * (tMid / tFlow));
            }
            this.Paw = (this.Flow * this.params.R) + this.Palv;
          } else if (this.params.tPause > 0 && this.phaseTime < this.params.ti - eps) {
            this.phase = 'INSP_PAUSE';
            this.Flow = 0;
            this.Paw = this.Palv;
            this.cyclePplat = this.Paw;
          }
        }
      }
    } else if (this.phase === 'INSP_PAUSE') {
      this.Flow = 0;
      this.Paw = this.Palv;
      this.cyclePplat = this.Paw;
    } else if (this.phase === 'EXH') {
      const circuitDrop = Math.min(this.params.trig, Math.max(0, this.Pmus - (this.V / this.params.C)) * 0.65);
      this.Paw = this.params.peep - circuitDrop;
      this.Flow = (this.Paw - this.Palv) / (this.params.R * 1.25);
    }

    // 4. 換気量積算とフェーズ時間進行
    this.V += (this.Flow * 1000.0) * dt;
    if (this.V < 0) {
      this.V = 0;
      if (this.phase === 'EXH' && this.Flow < 0) this.Flow = 0;
    }

    if (this.Paw > this.cyclePpeak) this.cyclePpeak = this.Paw;
    if (this.V > this.cycleVmax) this.cycleVmax = this.V;

    this.phaseTime += dt;

    // 5. 吸気終了判定（積算後に判定して次ステップから呼気へ移行）
    if (this.phase === 'INSP_FLOW') {
      if (this.currentBreathType === 'PS') {
        if (this.phaseTime > 0.2 && (this.Flow <= this.peakFlow * 0.25 || this.phaseTime >= 2.5 - eps)) {
          this.finishInspiration();
        }
      } else if (this.params.ctrlType === 'PCV') {
        if (this.phaseTime >= this.params.ti - eps) {
          this.finishInspiration();
        }
      } else {
        const tFlow = Math.max(0.2, this.params.ti - this.params.tPause);
        if (this.params.tPause <= 0 && this.phaseTime >= tFlow - eps) {
          this.finishInspiration();
        } else if (this.phaseTime >= this.params.ti - eps) {
          this.finishInspiration();
        }
      }
    } else if (this.phase === 'INSP_PAUSE') {
      if (this.phaseTime >= this.params.ti - eps) {
        this.finishInspiration();
      }
    }
  }
}
