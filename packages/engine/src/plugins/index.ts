/**
 * 全部内置插件的登记处（进程内 apply）。新增一个内置功能：在 plugins/<id>/ 写它的 apply，在这里加一行登记，
 * 在 assets/plugins/<id>/onset-station.json 写清单（名字、说明）。宿主的 flow、scene、progress、projectinit、
 * 工具服务都不用改。
 *
 * 由 plugin 包的入口导入（登记靠这里的副作用，集中在一处才不会漏）。插件排队，第一次取登记表时才 apply
 * （见 registry.ts 的 deferBuiltin）。登记顺序就是镜头提示词里插件技能段的先后。
 */
import { deferBuiltin } from '../plugin/registry';
import { algorithmicArt } from './algorithmic-art';
import { anidoodleStyles } from './anidoodle-styles';
import { beatPlugin } from './beat';
import { castPlugin } from './cast';
import { huashuStyles } from './huashu-styles';
import { lemoStyles } from './lemo-styles';
import { mgStyles } from './mg-styles';
import { papercraftStyles } from './papercraft-styles';
import { publishing } from './publishing';
import { skinsPlugin } from './skins';
import { songPlugin } from './song';
import { textToLottie } from './text-to-lottie';

deferBuiltin(publishing);
// 卡点排在歌曲讲解前面：新建选项与流程的先后（口播、卡点、歌曲讲解）跟着登记顺序。
deferBuiltin(beatPlugin);
deferBuiltin(songPlugin);
deferBuiltin(algorithmicArt);
deferBuiltin(textToLottie);
deferBuiltin(castPlugin);
deferBuiltin(lemoStyles);
deferBuiltin(anidoodleStyles);
deferBuiltin(huashuStyles);
deferBuiltin(mgStyles);
deferBuiltin(papercraftStyles);
deferBuiltin(skinsPlugin);
