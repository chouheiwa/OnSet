/**
 * 新增一个内置功能只要写它的 apply：这里登记一个只在测试里存在的假内置插件，证明宿主的
 * flow/builtin.ts、studio/progress.ts、studioview 与客户端后端的路由都不用改就认得它。
 * （工具服务那一侧在 packages/cli/src/plugin_ops.test.ts。）
 */
import '../studio/testsupport';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import * as config from '../config';
import * as flow from '../flow';
import * as memory from '../memory';
import * as prereqs from '../prereqs';
import * as preset from '../preset';
import * as projectinit from '../projectinit';
import * as scene from '../scene';
import { computeStations } from '../studio/progress';
import { discoverScenes } from '../studio/scenes';
import { newSessionFixture, studioRequest } from '../studio/testsupport';
import * as studioview from '../studioview';
import * as plugin from './index';
import { appliedPluginIDs, type BuiltinPlugin, pluginStations, registerBuiltin } from './index';

const cleanups: (() => void)[] = [];
const temps: string[] = [];
afterEach(() => {
  for (const undo of cleanups.splice(0)) undo();
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'onset-plugin-')));
  temps.push(dir);
  return dir;
}

/** 假插件「字幕翻译」：在复查之后加一站，写 production/translate/，有一段提示词、一页、一个接口、一个校验器。 */
function fakePlugin(dir: string): BuiltinPlugin {
  fs.mkdirSync(path.join(dir, 'sections'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'sections', 'stage.md'),
    '## {{STAGE:translate}}：翻译字幕\n\n在{{STAGE:review}}之后把字幕译成英文。\n\n',
  );
  return {
    id: 'fake-translate',
    dir,
    apply(ctx) {
      ctx.station({
        id: 'translate',
        name: '翻译字幕',
        nodes: [
          {
            id: 'translate',
            label: '翻译字幕',
            step: 'final',
            page: 'translate',
            produces: [{ prefix: 'production/translate/' }],
          },
        ],
        flows: ['speech'],
        after: 'review',
        sections: [
          { id: 'stage', file: 'sections/stage.md', after: 'review/stage', stage: 'translate', title: '翻译字幕' },
        ],
        judges: {
          translate: {
            output: (c) => {
              try {
                return fs.statSync(path.join(c.root, 'production', 'translate', 'en.srt')).mtimeMs;
              } catch {
                return 0;
              }
            },
            detail: () => '英文',
            waiting: () => 'user',
          },
        },
      });
      ctx.page({ id: 'translate', label: '翻译', target: '', after: 'review', files: ['production/translate/en.srt'] });
      ctx.route({
        pattern: '/api/translate',
        handle: (host) => {
          const p = host.projectOr404();
          if (p instanceof Response) return p;
          return Response.json({ root: path.basename(p.path) });
        },
      });
      ctx.validator({
        id: 'translate',
        label: '检查译文',
        file: 'production/translate/en.srt',
        op: 'validate_translate',
      });
    },
  };
}

function register(): void {
  cleanups.push(registerBuiltin(fakePlugin(tempDir())));
}

describe('builtin plugin apply', () => {
  it('registers the shipped plugins once', () => {
    expect(appliedPluginIDs()).toEqual([
      'publishing',
      'beat',
      'song',
      'algorithmic-art',
      'text-to-lottie',
      'cast',
      'lemo-styles',
      'anidoodle-styles',
      'huashu-styles',
      'mg-styles',
      'papercraft-styles',
      'skins',
    ]);
    expect(() => registerBuiltin({ id: 'publishing', apply: () => {} })).toThrow('登记了两次');
  });

  it('every applied plugin has a manifest next to its sections', () => {
    const manifests = new Set(flow.builtinPluginIDs());
    for (const id of appliedPluginIDs()) expect(manifests.has(id), id).toBe(true);
  });

  it('puts the station on the route and its files under it', () => {
    register();
    const ids = flow.route('speech', flow.stationExtras()).map((r) => r.node.id);
    expect(ids.slice(ids.indexOf('gate-final'), ids.indexOf('gate-final') + 3)).toEqual([
      'gate-final',
      'translate',
      'publish',
    ]);
    expect(flow.route('beat', flow.stationExtras()).some((r) => r.node.id === 'translate')).toBe(false);
    expect(flow.stationOfPath('production/translate/en.srt', 'speech')).toBe('translate');
  });

  it('judges the station with the registered function', () => {
    register();
    const root = tempDir();
    flow.recordFlow(root, { id: 'speech', canvas: 'vertical-3x4' });
    fs.mkdirSync(path.join(root, 'production', 'translate'), { recursive: true });
    fs.writeFileSync(path.join(root, 'production', 'translate', 'en.srt'), '1\n');
    const got = computeStations(root, discoverScenes(root));
    expect(got.stations.find((s) => s.id === 'translate')).toMatchObject({
      status: 'done',
      detail: '英文',
      page: 'translate',
      step: 'final',
    });
    expect(got.current).toBe('publish');
    expect(got.waiting_on).toBe('ai');
    // 站点自己的 waiting 在它是「现在」时起作用：试听确认过、还没翻译。
    fs.rmSync(path.join(root, 'production', 'translate'), { recursive: true });
    fs.writeFileSync(path.join(root, 'production', 'approval.json'), '{}');
    const next = computeStations(root, discoverScenes(root));
    expect(next.current).toBe('translate');
    expect(next.waiting_on).toBe('user');
  });

  it('composes its prompt section after its anchor and numbers the stages', () => {
    register();
    const order = flow.flowPrompt('speech');
    expect(order.slice(order.indexOf('review/stage'), order.indexOf('review/stage') + 3)).toEqual([
      'review/stage',
      'translate/stage',
      'publish/stage',
    ]);
    expect(flow.allStageTitles().translate).toBe('翻译字幕');
    const composed = flow.composeFlowPrompt({ flow: 'speech', stations: [], canvas: (t) => t });
    expect(composed).toContain('## 第十二阶段：翻译字幕\n\n在第十一阶段之后把字幕译成英文。');
    expect(composed).toContain('## 第十三阶段：刷新发布配置');
  });

  it('adds its page, dedicated file, route and validator command to the client', async () => {
    register();
    expect(studioview.viewPage('translate')).toEqual({ id: 'translate', label: '翻译', target: '' });
    const ids = studioview.viewPages().map((p) => p.id);
    expect(ids.slice(ids.indexOf('review'), ids.indexOf('review') + 3)).toEqual(['review', 'translate', 'publish']);
    expect(studioview.dedicatedPage('', 'production/translate/en.srt')).toEqual({ page: 'translate' });
    const f = newSessionFixture();
    let r = await studioRequest(f.s, 'GET', '/api/translate');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ root: path.basename(f.root) });
    r = await studioRequest(f.s, 'POST', '/api/commands/translate.check', '{}');
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('translate_missing');
    expect(r.body.message).toBe('找不到 production/translate/en.srt');
  });

  it("is on every project's route and goes away with its registration", () => {
    register();
    expect(flow.route('speech', flow.stationExtras()).some((r) => r.node.id === 'translate')).toBe(true);
    expect(flow.route('speech', flow.stationExtras()).some((r) => r.node.id === 'publish')).toBe(true);
    cleanups.pop()!();
    expect(pluginStations().some((s) => s.value.id === 'translate')).toBe(false);
    expect(flow.route('speech').some((r) => r.node.id === 'translate')).toBe(false);
  });

  it('rejects a station without a judge, a duplicate station and an unknown anchor', () => {
    const base = { id: 'x', name: 'x', flows: ['speech'], after: 'review' } as const;
    expect(() =>
      registerBuiltin({
        id: 'bad-judge',
        apply: (ctx) => ctx.station({ ...base, nodes: [{ id: 'x', label: 'x', step: 'final' }] }),
      }),
    ).toThrow('没有判断函数');
    expect(() =>
      registerBuiltin({ id: 'bad-dup', apply: (ctx) => ctx.station({ ...base, id: 'publish', nodes: [] }) }),
    ).toThrow('站 publish 已经有了');
    const undo = registerBuiltin({
      id: 'bad-anchor',
      apply: (ctx) => ctx.station({ ...base, nodes: [], sections: [{ id: 's', file: 's.md', after: 'nope/stage' }] }),
    });
    try {
      expect(() => flow.flowPrompt('speech')).toThrow('要接在 nope/stage 后面');
    } finally {
      undo();
    }
    expect(appliedPluginIDs()).toEqual([
      'publishing',
      'beat',
      'song',
      'algorithmic-art',
      'text-to-lottie',
      'cast',
      'lemo-styles',
      'anidoodle-styles',
      'huashu-styles',
      'mg-styles',
      'papercraft-styles',
      'skins',
    ]);
  });
});

describe('the shipped prompt sections of builtin plugins', () => {
  it('exist, carry their stage title and no hard-coded stage numbers, and leave no orphan files', () => {
    // 一个插件可以登记几个站：段落文件按插件合起来核对。
    const owners = [...new Set(pluginStations().map((x) => x.owner))];
    for (const owner of owners) {
      const dir = path.join(flow.builtinPluginsDir(), owner);
      const sections = pluginStations()
        .filter((x) => x.owner === owner)
        .flatMap((x) => x.value.sections ?? []);
      // 段落文件都放在 sections/ 里。
      const declared = [...new Set(sections.map((sec) => sec.file).filter((f) => f.startsWith('sections/')))].sort();
      const files = fs.existsSync(path.join(dir, 'sections'))
        ? fs
            .readdirSync(path.join(dir, 'sections'))
            .map((f) => 'sections/' + f)
            .sort()
        : [];
      expect(files, owner).toEqual(declared);
      for (const sec of sections) {
        const body = fs.readFileSync(path.join(dir, sec.file), 'utf8');
        expect(body, sec.file).not.toMatch(/第[一二三四五六七八九十]+阶段/);
        if (sec.stage) expect(body.split('\n')[0], sec.file).toBe(`## {{STAGE:${sec.stage}}}：${sec.title}`);
      }
    }
  });
});

/**
 * 假插件「合唱」：一条渲染技能、一个镜头扩展块、一种叙事模式（新建时写 chorus.yaml）、一个新建选项与在用判断。
 * 证明新增这样一个内置功能不用改 scene/、projectinit/、studio/ 的任何文件（工具那一侧见 cli 的 plugin_ops.test.ts）。
 */
function chorusPlugin(): BuiltinPlugin {
  return {
    id: 'fake-chorus',
    apply(ctx) {
      ctx.skill({
        name: 'chorus-kit',
        source: scene.SourceEmbedded,
        requiredFiles: ['SKILL.md'],
        promptSection: (dir) => `合唱技能：${dir === '' ? 'chorus-kit' : path.join(dir, 'chorus-kit')}\n`,
      });
      ctx.sceneBlock<{ voices: number }>({
        key: 'chorus',
        order: 40,
        type: { kind: 'struct', goName: 'scene.Chorus', name: 'Chorus', fields: [['voices', 'int']] },
        toJSON: (v) => ({ voices: v.voices }),
        promptSection: (s) =>
          `\n合唱（强制）：${(s as unknown as { chorus: { voices: number } }).chorus.voices} 个声部。\n`,
        fingerprintParts: (_s, v) => ({ 'chorus:voices': String(v.voices) }),
        feature: { name: 'chorus', description: '合唱镜头' },
      });
      ctx.narration({
        id: 'chorus',
        name: '合唱',
        hint: '大家一起唱',
        init: (target) => fs.writeFileSync(path.join(target, 'chorus.yaml'), 'voices: 4\n'),
      });
      ctx.preset({ id: 'chorus', label: '合唱', hint: '大家一起唱', delivery: 'speech', narration: 'chorus' });
      ctx.presentIn((root) => (fs.existsSync(path.join(root, 'chorus.yaml')) ? 'chorus.yaml' : ''));
    },
  };
}

describe('a builtin plugin with a skill, a scene block and a narration', () => {
  it('reaches the renderer, the scene, project creation and the switch without kernel changes', async () => {
    cleanups.push(registerBuiltin(chorusPlugin()));
    const root = tempDir();
    fs.mkdirSync(path.join(root, '.agents', 'skills', 'chorus-kit'), { recursive: true });
    fs.writeFileSync(path.join(root, '.agents', 'skills', 'chorus-kit', 'SKILL.md'), 'x');
    const dir = path.join(root, 'scenes', 'scene-001');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'voice.srt'), '1\n00:00:00,000 --> 00:00:01,000\nhello\n');
    fs.writeFileSync(path.join(dir, 'frame.md'), '---\ncanvas: {width_px: 1080, height_px: 1440, fps: 30}\n---\n');
    fs.writeFileSync(
      path.join(dir, 'scene.json'),
      JSON.stringify({
        id: 'scene-001',
        duration_seconds: 1,
        output: 'out.mp4',
        transcript: 'voice.srt',
        text: 'hello',
        chorus: { voices: 4 },
      }),
    );
    const s = scene.load(dir);
    const resolved = scene.resolveAllSkills('claude', dir, {}, s);
    expect(resolved['chorus-kit']).toBe(path.join(root, '.agents', 'skills'));
    const prompt = scene.buildPrompt(s, resolved);
    expect(prompt).toContain('合唱技能：' + path.join(root, '.agents', 'skills', 'chorus-kit'));
    expect(prompt).toContain('合唱（强制）：4 个声部。');
    expect(scene.fingerprint(s, 'claude', resolved).parts?.['chorus:voices']).toBe('4');
    expect(scene.sceneToJSON(s)).toMatchObject({ chorus: { voices: 4 } });
    expect(memory.features(s)).toContain('chorus');

    // 新建项目：叙事模式与新建选项来自登记表，选中时写出它的初始文件，之后算项目在用它（新建时的互斥据此判断）。
    expect(projectinit.narrations().some((n) => n.id === 'chorus' && n.owner === 'fake-chorus')).toBe(true);
    expect(projectinit.presets().some((p) => p.id === 'chorus')).toBe(true);
    const created = path.join(tempDir(), 'p');
    projectinit.create({ target: created, canvas: preset.defaultPreset().id, delivery: 'speech', narration: 'chorus' });
    expect(fs.readFileSync(path.join(created, 'chorus.yaml'), 'utf8')).toBe('voices: 4\n');
    expect(plugin.pluginPresentIn('fake-chorus', created)).toBe('chorus.yaml');
    const f = newSessionFixture();
    const styles = await studioRequest(f.s, 'GET', '/api/styles');
    expect((styles.body.modes as { id: string }[]).map((m) => m.id)).toContain('chorus');
  });
});

/**
 * 假插件「节拍器」：一项前置资源、一个要传给子进程的变量、一个顶栏步骤与一条网页命令（卡点就是这样登记的）。
 * 证明它们经登记表进宿主的 prereqs、config、studioview 与客户端后端，撤销登记就都不在。
 */
describe('a builtin plugin with a prerequisite, a child variable, a step and a page command', () => {
  it('reaches setup, child processes, the top bar and the command API, and goes away with its registration', async () => {
    const undo = registerBuiltin({
      id: 'fake-metronome',
      apply(ctx) {
        ctx.prereq({
          group: 'metronome',
          id: 'metronome',
          name: '节拍器',
          version: '1',
          required: false,
          later: { title: '节拍器', desc: '测试用' },
          ready: () => [false, '/nowhere'],
          prepare: async () => {},
        });
        ctx.childEnv({ key: 'METRONOME_DIR', value: (env) => (env.HOME ?? '') + '/metronome' });
        ctx.step({ id: 'tick', label: '节拍器', hint: '节拍器：数拍子', before: 'storyboard', flow: '节拍器' });
        ctx.command({
          id: 'metronome.tick',
          label: '数一拍',
          op: 'studio_step',
          params: () => ({ error: { code: 'not_now', message: '现在不数' } }),
        });
      },
    });
    cleanups.push(undo);
    const f = newSessionFixture();
    const env = { HOME: '/home/u' };
    expect(prereqs.check(env, { tts: '', align: '' }).find((x) => x.id === 'metronome')).toMatchObject({
      group: 'metronome',
      ready: false,
      later: { title: '节拍器' },
    });
    const cfg = config.load(f.root, env);
    expect(config.childEnvironment(cfg, env).METRONOME_DIR).toBe('/home/u/metronome');
    expect(studioview.stepIDs()).toContain('tick');
    expect(studioview.stepIDs().indexOf('tick')).toBe(studioview.stepIDs().indexOf('storyboard') - 1);
    expect(studioview.viewInteraction()).toContain('节拍器项目的第一步是 tick（节拍器：数拍子）');
    const r = await studioRequest(f.s, 'POST', '/api/commands/metronome.tick', '{}');
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('not_now');

    undo();
    expect(prereqs.check(env, { tts: '', align: '' }).some((x) => x.id === 'metronome')).toBe(false);
    expect(config.childEnvironment(config.load(f.root, env), env).METRONOME_DIR).toBeUndefined();
    expect(studioview.stepIDs()).not.toContain('tick');
    expect((await studioRequest(f.s, 'POST', '/api/commands/metronome.tick', '{}')).body.code).toBe('unknown_command');
  });
});
