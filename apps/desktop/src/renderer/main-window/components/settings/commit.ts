import type { WayangConfig } from '@wayang-ai/protocol';

/**
 * 配置提交口：设置卡片 / 分组组件只认这个函数，不管背后是谁——设置页接到
 * 后端保存（pages/settings 的 useConfigCommit：saveConfig + toast），onboard
 * 向导接进本地草稿。两边因此共用同一套卡片，交互也保持一致。
 */
export type ConfigCommit = (next: WayangConfig, nextDesktop?: Record<string, unknown>) => Promise<void>;
