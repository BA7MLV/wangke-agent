import commonZh from './locales/zh-CN/common.json';
import settingsZh from './locales/zh-CN/settings.json';
import commonEn from './locales/en-US/common.json';
import settingsEn from './locales/en-US/settings.json';
import gatewayZh from './locales/zh-CN/gateway.json';
import gatewayEn from './locales/en-US/gateway.json';

/** 首阶段随 JS 打包，切换语言不依赖网络，也可由 PWA 预缓存。 */
export const resources = {
  'zh-CN': { common: commonZh, settings: settingsZh, gateway: gatewayZh },
  'en-US': { common: commonEn, settings: settingsEn, gateway: gatewayEn },
} as const;
