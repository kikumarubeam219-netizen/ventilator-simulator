import { clamp } from './PathologyMechanics.js';

/**
 * 血液ガス分析（ABG）リアルタイム生理学計算エンジン
 * - Severinghaus 酸素解離曲線 + シャント方程式 (Qs/Qt: Nunn のイソシャントモデル)
 * - 解剖学的死腔 (2.2 mL/kg) + 病態別肺胞死腔 (VD_alv), 安静時 VCO2 (3.4 mL/kg/min)
 * - 指数移動平均（ローパスフィルタ）による滑らかなリアルタイム追従
 */
export class BloodGasEngine {
  constructor() {
    this.hb = 13.5;       // g/dL (ICU患者想定)
    this.baseAvDiff = 4.5; // mL/dL (標準動静脈酸素含量較差 CaO2 - CvO2)

    // 初期状態（正常値）
    this.paCO2 = 40.0;
    this.paO2 = 185.0;
    this.hco3 = 24.0;
    this.pH = 7.40;
    this.pfRatio = 463;
    this.pbw = 66.0;
    this.vtPerKg = 6.8;

    // 追従時定数（秒）：PaO2はやや速く、PaCO2はゆっくり追従
    this.tauPaO2 = 4.5;
    this.tauPaCO2 = 8.0;
  }

  /**
   * 予測体重（PBW）算出
   * 男性：50 + 0.91 * (身長cm - 152.4)
   * 女性：45.5 + 0.91 * (身長cm - 152.4)
   */
  static computePBW(sex, heightCm) {
    const base = sex === 'female' ? 45.5 : 50.0;
    return Math.max(30.0, base + 0.91 * (heightCm - 152.4));
  }

  /**
   * Severinghaus 近似式による酸素飽和度 (0〜1)
   */
  static sao2FromPo2(po2) {
    const p = Math.max(1.0, po2);
    return 1.0 / (1.0 + 23400.0 / (p * p * p + 150.0 * p));
  }

  /**
   * 血液酸素含量 (mL/dL)
   */
  o2Content(po2) {
    return 1.34 * this.hb * BloodGasEngine.sao2FromPo2(po2) + 0.0031 * po2;
  }

  /**
   * 二分法で目標酸素含量 CaO2 に対応する PaO2 (mmHg) を逆算
   */
  po2FromContent(targetContent) {
    let lo = 10.0;
    let hi = 680.0;
    for (let i = 0; i < 32; i++) {
      const mid = 0.5 * (lo + hi);
      if (this.o2Content(mid) < targetContent) {
        lo = mid;
      } else {
        hi = mid;
      }
    }
    return 0.5 * (lo + hi);
  }

  /**
   * 目標血液ガス値を算出（厳密な生理学モデル）
   */
  computeTargets(params, pathology, vte, measuredRR, lungVentMode = 'both') {
    const pbw = BloodGasEngine.computePBW(params.sex || 'male', params.heightCm || 170);
    // 解剖学的死腔 (2.2 mL/kg)
    const vdAnat = 2.2 * pbw;
    // 安静時 CO2 産生量 (3.4 mL/kg/min)
    const vco2 = 3.4 * pbw;

    const fio2 = clamp(params.fio2 ?? 40, 21, 100);
    const peep = params.peep ?? 5;
    const effVte = Math.max(100, vte || 450);
    const effRR = Math.max(4, measuredRR || params.rrSet || 12);

    // 1. 病態による肺胞死腔（VD_alv）の加算
    let vdAlvRatio = 0.02;
    if (pathology.airwayNarrowing) vdAlvRatio += 0.16;       // COPD/喘息
    if (pathology.ardsMode) vdAlvRatio += 0.08;              // ARDS
    if (pathology.pneumothoraxRight) vdAlvRatio += 0.13;     // 緊張性気胸
    if (pathology.deepIntubationRight || lungVentMode !== 'both') {
      vdAlvRatio += 0.10;                                    // 片肺挿管・片肺換気
    }
    if (peep > 14) {
      vdAlvRatio += clamp((peep - 14) / 6.0, 0, 1) * 0.07;   // 高PEEP過膨張による死腔増大
    }
    if (pathology.rightHeartFailure) {
      vdAlvRatio += pathology.preloadCompression * 0.12;     // 肺血流低下による死腔増大
    }
    vdAlvRatio += pathology.effectiveAtel * 0.04 + pathology.effectiveEdema * 0.04 + pathology.effusionRatio * 0.03;

    const vdAlv = effVte * clamp(vdAlvRatio, 0, 0.45);
    const vdTotal = vdAnat + vdAlv;

    // 2. 有効肺胞換気量 VA (L/min) と目標 PaCO2 / HCO3- / pH
    const vaL = Math.max(0.6, ((effVte - vdTotal) * effRR) / 1000.0);
    const targetPaCO2 = clamp(0.863 * (vco2 / vaL), 15.0, 110.0);
    const targetHCO3 = clamp(24.0 + (targetPaCO2 - 40.0) * 0.1, 16.0, 34.0);

    // 3. 肺胞気酸素分圧 PAO2 とシャント方程式 (Qs/Qt) による目標 PaO2
    const pao2Alv = Math.max(40.0, (fio2 / 100.0) * 713.0 - (targetPaCO2 / 0.8));

    // 生理的シャント (4%) + 病態シャント
    let qs = 0.04;
    qs += pathology.effectiveAtel * 0.26;
    qs += pathology.effectiveEdema * 0.27;
    qs += pathology.effusionRatio * 0.12 * (1.0 - (pathology.effRecruit ?? 0));
    if (pathology.pneumothoraxRight) qs += 0.36;
    if (pathology.deepIntubationRight || lungVentMode !== 'both') qs += 0.25;
    if (pathology.airwayNarrowing) qs += 0.11;
    qs = clamp(qs, 0.02, 0.62);

    // 右心不全高PEEP時は低心拍出により動静脈酸素較差 (CaO2 - CvO2) が拡大
    const avDiff = this.baseAvDiff + (pathology.rightHeartFailure ? pathology.preloadCompression * 2.5 : 0.0);

    // シャント方程式: CaO2 = Cc'O2 - (Qs / (1 - Qs)) * (CaO2 - CvO2)
    const ccO2 = this.o2Content(pao2Alv);
    const caO2 = Math.max(5.5, ccO2 - (qs / (1.0 - qs)) * avDiff);
    const targetPaO2 = clamp(this.po2FromContent(caO2), 25.0, 620.0);

    return {
      pbw,
      vtPerKg: effVte / pbw,
      targetPaCO2,
      targetHCO3,
      targetPaO2,
      shunt: qs,
      va: vaL * 1000.0
    };
  }

  /**
   * 毎フレーム更新（指数移動平均による滑らかな追従）
   */
  update(dt, params, pathology, vte, measuredRR, lungVentMode = 'both') {
    const t = this.computeTargets(params, pathology, vte, measuredRR, lungVentMode);
    this.pbw = t.pbw;
    this.vtPerKg = t.vtPerKg;

    const alphaO2 = 1.0 - Math.exp(-dt / this.tauPaO2);
    const alphaCO2 = 1.0 - Math.exp(-dt / this.tauPaCO2);

    this.paO2 += (t.targetPaO2 - this.paO2) * alphaO2;
    this.paCO2 += (t.targetPaCO2 - this.paCO2) * alphaCO2;
    this.hco3 += (t.targetHCO3 - this.hco3) * alphaCO2;
    this.pH = 6.1 + Math.log10(Math.max(1.0, this.hco3) / (0.03 * Math.max(10.0, this.paCO2)));

    const fio2Frac = clamp(params.fio2 ?? 40, 21, 100) / 100.0;
    this.pfRatio = this.paO2 / fio2Frac;

    return {
      pH: this.pH,
      paCO2: this.paCO2,
      paO2: this.paO2,
      hco3: this.hco3,
      pfRatio: this.pfRatio,
      pbw: this.pbw,
      vtPerKg: this.vtPerKg
    };
  }
}
