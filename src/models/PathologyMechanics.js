/**
 * 病態力学エンジン（胸水・無気肺・肺水腫）
 * 基本コンプライアンス (base_C)・基本気道抵抗 (base_R)・PEEP および
 * 3 病態スライダー値 (0〜100%) から実効メカニクスと視覚パラメータを算出する。
 */

export function clamp(val, min, max) {
  return Math.max(min, Math.min(max, val));
}

export function computePathologyMechanics(params, currentPaw = null) {
  const baseC = params.C ?? 50;
  const baseR = params.R ?? 10;
  const peep = params.peep ?? 5;
  const paw = currentPaw !== null ? currentPaw : peep;
  const effusion = params.effusion ?? 0;
  const atelectasis = params.atelectasis ?? 0;
  const edema = params.edema ?? 0;

  const cs1HeartFailure = !!params.cs1HeartFailure;
  const rightHeartFailure = !!params.rightHeartFailure;

  // 1. 胸水 (Pleural Effusion)
  // PEEPを上げても胸水の体積そのものは減少しない。
  // 代わりに高PEEP時に圧迫性無気肺が一部解除される控えめな回復係数 (最大0.18) を適用。
  const effusionRatio = clamp(effusion / 100.0, 0, 1);
  const eff_recruit = clamp((peep - 5.0) / 15.0, 0, 1) * 0.18;
  const eff_c_factor = 1.0 - 0.45 * effusionRatio * (1.0 - eff_recruit);
  const eff_r_add = 2.0 * effusionRatio;

  // Canvas連携用：PEEPおよび現在の気道内圧 (Paw) に応じた「胸水押し返し係数 (0.0〜1.0)」
  const peepPush = clamp((peep - 5.0) / 15.0, 0, 1);
  const inspPush = clamp(Math.max(0, paw - peep) / 25.0, 0, 1);
  const effusionPushRatio = clamp(peepPush * 0.65 + inspPush * 0.35, 0, 1);

  const cs1PeepProgress = cs1HeartFailure ? clamp((peep - 5.0) / 9.0, 0, 1) : 0.0;

  // 2. 無気肺 (Atelectasis) + PEEP によるリクルートメント効果
  const recruit_ratio = clamp((peep - 5.0) / 15.0, 0, 1) * 0.55;
  const effective_atel = clamp(atelectasis / 100.0, 0, 1) * (1.0 - recruit_ratio);
  const atel_c_factor = 1.0 - 0.55 * effective_atel;
  const atel_r_add = 3.0 * effective_atel;

  // 3. 肺水腫 (Pulmonary Edema) + PEEP によるリクルートメント効果
  // CS1心不全ON時は陽圧換気による左室後負荷軽減＋肺胞水分押し戻し効果（PEEP 8〜14 cmH2O域）を顕著に反映
  const edema_recruit = cs1HeartFailure
    ? cs1PeepProgress * 0.80
    : clamp((peep - 5.0) / 15.0, 0, 1) * 0.30;
  const effective_edema = clamp(edema / 100.0, 0, 1) * (1.0 - edema_recruit);
  const edema_c_factor = 1.0 - 0.50 * effective_edema;
  const edema_r_add = 12.0 * clamp(edema / 100.0, 0, 1) * (cs1HeartFailure ? (1.0 - edema_recruit * 0.65) : 1.0);

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

  // 6. 心肺相互作用（Cardiopulmonary Interaction）パラメータ
  // CS1心不全：低PEEPで過負荷(1.0)、PEEP 8〜14 cmH2Oで負荷軽減(0.0)
  const cs1Overload = cs1HeartFailure ? (1.0 - clamp((peep - 5.0) / 9.0, 0, 1)) : 0.0;
  // 右心不全/前負荷低下：高PEEP(10 cmH2O以上)で静脈還流阻害・心臓圧迫が顕著化
  const preloadCompression = rightHeartFailure ? clamp((peep - 6.0) / 10.0, 0, 1) : 0.0;
  const preloadAlert = rightHeartFailure && peep >= 12.0;

  return {
    baseC,
    baseR,
    effC,
    effR,
    complianceRatio,
    effusionRatio,
    effRecruit: eff_recruit,
    effusionPushRatio,
    effectiveAtel: effective_atel,
    effectiveEdema: effective_edema,
    recruitRatio: recruit_ratio,
    edemaRecruit: edema_recruit,
    pneumothoraxRight,
    airwayNarrowing,
    ardsMode,
    deepIntubationRight,
    mediastinalShiftBase,
    cs1HeartFailure,
    rightHeartFailure,
    cs1Overload,
    preloadCompression,
    preloadAlert
  };
}
