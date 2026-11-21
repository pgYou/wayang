import type { WayangApi } from '../../../preload/index';

declare global {
  interface Window {
    wayang: WayangApi;
  }
}

export {};
