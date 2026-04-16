// ---------------------------------------------------------------------------
// Base tokens — design language primitives
// ---------------------------------------------------------------------------

const baseToken = {
  /** Semantic color palette — named by usage, not by hue. */
  color: {
    /** Strong emphasis — important labels, highlights. */
    textEmphasis: 'yellow',
    /** Default body text — AI responses, general content. */
    textNormal: 'white',
    /** Subtle text — meta entries, dimmed labels, timestamps. */
    textSubtle: 'gray',
    /** Accent — interactive elements, assistant prefix. */
    accent: 'green',
    /** Error / danger states. */
    error: 'red',
    /** Borders and structural lines. */
    border: 'gray',
  },
  /** Background fills (hex). */
  bg: {
    /** Highlighted row surface. */
    surface: '#444444',
  },
  /** Typographic / icon characters. */
  icon: {
    arrowRight: '\u2192',
    arrowLeft: '\u2190',
    /** Status / notification flag. */
    flag: '\u2691',
    /** Decorative dot. */
    dot: '\u00B7',
  },
  /** Numeric spacing scale (terminal rows). */
  space: {
    xs: 0,
    sm: 1,
    md: 2,
  },
  /** Animation timing (ms). */
  timing: {
    slow: 500,
    normal: 300,
    fast: 100,
  },
} as const;

// ---------------------------------------------------------------------------
// Theme — component styles composed from base tokens
// ---------------------------------------------------------------------------

/** UI theme constants for the Wayang CLI. */
export const theme = {
  baseToken,

  user: {
    prefix: '→',
    bgHex: baseToken.bg.surface,
    prefixColor: baseToken.color.textEmphasis,
  },
  assistant: {
    prefix: '→',
    prefixColor: baseToken.color.accent,
  },
  toolUse: {
    callIcon: baseToken.icon.arrowRight,
    resultIcon: baseToken.icon.arrowLeft,
    color: baseToken.color.textSubtle,
  },
  signal: {
    prefix: baseToken.icon.flag,
    color: baseToken.color.textSubtle,
  },
  meta: {
    prefix: baseToken.icon.dot,
    color: baseToken.color.textSubtle,
  },
  spinner: {
    frames: ['\u25CF', '\u25C6', '\u2726', '\u203B'],
    interval: baseToken.timing.normal,
  },
  spacing: {
    blockGap: baseToken.space.sm,
  },
} as const;
