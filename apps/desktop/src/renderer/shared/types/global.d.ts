import type { WayangBridge } from '../../../preload/index';

/**
 * The renderer's view of the preload bridge — typed ONCE by the preload's
 * exported `WayangBridge` (global.d.ts carries zero duplicate
 * declarations; channel shapes live in the shared IPC contract only).
 */
declare global {
  interface Window {
    wayang: WayangBridge;
  }
}

export {};
