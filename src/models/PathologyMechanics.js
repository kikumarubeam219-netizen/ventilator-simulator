/**
 * 病態力学エンジン（胸水・無気肺・肺水腫）
 * 基本コンプライアンス (base_C)・基本気道抵抗 (base_R)・PEEP および
 * 3 病態スライダー値 (0〜100%) から実効メカニクスと視覚パラメータを算出する。
 */

export function clamp(val, min, max) {
  return Math.max(min, Math.min(max, val));
}

export function computePathologyMechanics(params) {
  const baseC = params.C ?? 50;
  const baseR = params.R ?? 10;
  const peep = params.peep ?? 5;
  const effusion = params.effusion ?? 0;
  const atelectasis = params.atelectasis ?? 0;
  const edema = params.edema ?? 0;

  // 1. 胸水 (Pleural Effusion)
  const effusionRatio = clamp(effusion / 100.0, 0, 1);
  const eff_c_factor = 1.0 - 0.45 * effusionRatio;
  const eff_r_add = 2.0 * effusionRatio;

  // 2. 無気肺 (Atelectasis) + PEEP によるリクルートメント効果
  const recruit_ratio = clamp((peep - 5.0) / 15.0, 0, 1) * 0.55;
  const effective_atel = clamp(atelectasis / 100.0, 0, 1) * (1.0 - recruit_ratio);
  const atel_c_factor = 1.0 - 0.55 * effective_atel;
  const atel_r_add = 3.0 * effective_atel;

  // 3. 肺水腫 (Pulmonary Edema) + PEEP によるリクルートメント効果
  const edema_recruit = clamp((peep - 5.0) / 15.0, 0, 1) * 0.30;
  const effective_edema = clamp(edema / 100.0, 0, 1) * (1.0 - edema_recruit);
  const edema_c_factor = 1.0 - 0.50 * effective_edema;
  const edema_r_add = 12.0 * clamp(edema / 100.0, 0, 1);

  // 4. 合成実効コンプライアンス・実効抵抗
  const effC = Math.max(12.0, baseC * eff_c_factor * atel_c_factor * edema_c_factor);
  const effR = Math.min(50.0, baseR + eff_r_add + atel_r_add + edema_r_add);
  const complianceRatio = baseC > 0 ? clamp(effC / baseC, 0.1, 1.0) : 1.0;

  // 5. 臨床病態プリセット専用フラグ（既存3病態と非競合）
  const pneumothoraxRight = !!params.pneumothoraxRight;
  const airwayNarrowing = !!params.airwayNarrowing;
  const ardsMode = !!params.ardsMode;
  const deepIntubationRight = !!params.deepIntubationRight;

  // 緊張性気胸（右）による縦隔偏位基準量（胸腔内圧上昇に応じた基準シフトpx）
  const mediastinalShiftBase = pneumothoraxRight ? 26.0 : 0.0;

  return {
    baseC,
    baseR,
    effC,
    effR,
    complianceRatio,
    effusionRatio,
    effectiveAtel: effective_atel,
    effectiveEdema: effective_edema,
    recruitRatio: recruit_ratio,
    edemaRecruit: edema_recruit,
    pneumothoraxRight,
    airwayNarrowing,
    ardsMode,
    deepIntubationRight,
    mediastinalShiftBase
  };
}
