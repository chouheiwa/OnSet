/**
 * 内置插件「Papercraft 折纸立体书（MIT）」（papercraft-styles）：
 * 登记源自 MIT 许可项目 xikhar/papercraft（v0.7.0）的 2 套离线折纸立体书整片风格
 * （popup-2d 纯 Canvas2D + popup-3d 离线 three@0.187.0 真 3D），通过 runtimeAssets 自动共享到镜头目录。
 */
import type { BuiltinPlugin } from '../../plugin/types';
import { papercraftSource } from './source';

export * from './papercraft';
export { renderAttributionMD, renderSkillMD, renderStyleJSON, renderStyleMD } from './render';
export { papercraftSource } from './source';

export const papercraftStyles: BuiltinPlugin = {
  id: 'papercraft-styles',
  apply(ctx) {
    ctx.filmStyleSource(papercraftSource);
  },
};
