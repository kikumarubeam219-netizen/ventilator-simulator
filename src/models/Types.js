export const DEFAULT_PARAMS = {
  mode: 'AC',        // 'AC', 'SIMV', 'PSV'
  ctrlType: 'PCV',   // 'PCV', 'VCV'
  flowPat: 'SQUARE', // 'SQUARE', 'DECEL'
  rrSet: 12,
  ti: 1.0,
  pc: 15,
  vtSet: 450,        // mL
  tPause: 0.0,
  ps: 12,
  peep: 5,
  trig: 2.0,
  fio2: 40,          // % (21〜100)
  sex: 'male',       // 'male' | 'female'
  heightCm: 170,     // cm (140〜200)
  spontRR: 0,
  pmusMax: 6,
  C: 50,             // mL/cmH2O
  R: 10,             // cmH2O / (L/s)
  hr: 75,            // bpm
  effusion: 0,       // 胸水 (%) 0〜100
  atelectasis: 0,    // 無気肺 (%) 0〜100
  edema: 0,          // 肺水腫 (%) 0〜100
  clinicalPreset: 'normal', // 'normal' | 'pneumothorax' | 'copd' | 'ards' | 'one_lung' | 'cs1' | 'rhf'
  pneumothoraxRight: false,
  airwayNarrowing: false,
  ardsMode: false,
  deepIntubationRight: false,
  cs1HeartFailure: false,
  rightHeartFailure: false
};
