import './testsupport';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { installStation, stageStation, writeStationForTest } from '../flow';
import { writeShellFixture } from '../testsupport/windowsfixtures';
import { onStudioEvent } from './events';
import { emitStationHook, pageCSP, tickStationSchedules } from './stations';
import { newSessionFixture, send, startStudio, studioRequest, tempDir, waitStudioTask } from './testsupport';

const fake = path.join(__dirname, '..', 'flow', 'testdata', 'fake-publisher');

describe('stations API', () => {
  it('lists the stations of the project with their prompt, stops and ops', async () => {
    const f = newSessionFixture();
    let { status, body } = await studioRequest(f.s, 'GET', '/api/stations');
    expect(status).toBe(200);
    expect(body.problems).toEqual([]);
    expect(body.stations.map((x: { id: string; builtin: boolean }) => [x.id, x.builtin])).toEqual([
      ['algorithmic-art', true],
      ['anidoodle-styles', true],
      ['beat', true],
      ['cast', true],
      ['huashu-styles', true],
      ['lemo-styles', true],
      ['mg-styles', true],
      ['papercraft-styles', true],
      ['publishing', true],
      ['skins', true],
      ['song', true],
      ['text-to-lottie', true],
    ]);
    // 内置插件常开：没有开关，也没有「因为关掉而藏起来的页面」。
    expect(body).not.toHaveProperty('hidden_pages');
    for (const b of body.stations) expect(b).not.toHaveProperty('enabled');

    installStation(`link:${fake}`);
    const gone = writeStationForTest({
      'onset-station.json': JSON.stringify({ id: 'gone', version: '1', name: '没了' }),
    });
    installStation(`link:${gone}`);
    fs.rmSync(gone, { recursive: true, force: true });
    ({ status, body } = await studioRequest(f.s, 'GET', '/api/stations'));
    expect(status).toBe(200);
    expect(body.problems).toHaveLength(1);
    expect(body.problems[0]).toMatchObject({ id: 'gone', linked: true });
    expect(body.problems[0].message).toContain('第三方插件 gone');
    const station = body.stations.find((x: { id: string }) => x.id === 'fake-publisher');
    expect(station).toMatchObject({ id: 'fake-publisher', name: '假发布', linked: true, after: 'publish' });
    expect(station.experimental).toEqual([
      'hooks',
      'schedules',
      'slots',
      'commands',
      'inserts',
      'flow',
      'provides',
      'renderer_skills',
      'film_styles',
      'ops.project',
      'ops.list',
      'ops.form',
    ]);
    // 内置插件不标实验性。
    for (const b of body.stations.filter((x: { builtin: boolean }) => x.builtin)) expect(b.experimental).toEqual([]);
    expect(station.prompt).toContain('请用户在发布页点');
    expect(station.nodes).toEqual([{ id: 'auto-publish', label: '自动发布', step: 'publish', gate: false }]);
    expect(
      station.ops.map((o: { name: string; trigger: string; tool: string }) => [o.name, o.trigger, o.tool]),
    ).toEqual([
      ['send', 'user', ''],
      ['status', 'agent', 'x_fake_publisher_status'],
      ['on_event', 'agent', 'x_fake_publisher_on_event'],
      ['speak', 'agent', 'x_fake_publisher_speak'],
      ['scribble', 'user', ''],
      ['login', 'user', ''],
      ['accounts', 'user', ''],
      ['logout', 'user', ''],
    ]);
    // 登录这类插件自己的配置不针对项目，界面据此在没打开项目时也给按钮。
    expect(station.ops.filter((o: { project: boolean }) => !o.project).map((o: { name: string }) => o.name)).toEqual([
      'login',
      'accounts',
      'logout',
    ]);
    // 账号列表画成卡片，列表项上的按钮不出表单。
    expect(station.ops.filter((o: { list: boolean }) => o.list).map((o: { name: string }) => o.name)).toEqual([
      'accounts',
    ]);
    expect(station.ops.filter((o: { form: boolean }) => !o.form).map((o: { name: string }) => o.name)).toEqual([
      'logout',
    ]);
  });

  it('runs an op that does not target a project without any project open', async () => {
    const s = startStudio({ configPath: path.join(tempDir(), 'projects.json') });
    installStation(`link:${fake}`);
    const bin = tempDir();
    const log = path.join(bin, 'args.log');
    s.config.executable = writeShellFixture(
      path.join(bin, 'onset'),
      `#!/bin/sh\npwd > '${log}.cwd'\nprintf '%s\\n' "$@" > '${log}'\nprintf '已登录\\n\\000am-result {"ok":true,"exit_code":0}\\n'\n`,
    );
    // 针对项目的操作仍要先打开项目。
    expect(
      (await studioRequest(s, 'POST', '/api/stations/fake-publisher/ops/send', '{"params":{"platform":"douyin"}}'))
        .status,
    ).toBe(404);
    const started = await studioRequest(
      s,
      'POST',
      '/api/stations/fake-publisher/ops/login',
      '{"params":{"name":"小号"}}',
    );
    expect(started.status).toBe(202);
    const task = await waitStudioTask(s, started.body.task_id);
    expect(task).toMatchObject({ status: 'succeeded', type: 'station.run' });
    // 交给执行进程的是空的项目根，工作目录在用户级的插件目录。
    const args = fs.readFileSync(log, 'utf8');
    expect(args).toContain('station_run');
    expect(args).toContain('"project_root":""');
    expect(args).toContain('"op":"login"');
    // 结果不分项目：没打开项目时也看得到上一次执行。
    const { body } = await studioRequest(s, 'GET', '/api/stations');
    const op = body.stations
      .find((x: { id: string }) => x.id === 'fake-publisher')
      .ops.find((o: { name: string }) => o.name === 'login');
    expect(op.last_run).toMatchObject({ ok: true });
  });

  it('runs a list op outside the project even when a project is open', async () => {
    const f = newSessionFixture();
    installStation(`link:${fake}`);
    const bin = tempDir();
    const log = path.join(bin, 'args.log');
    f.s.config.executable = writeShellFixture(
      path.join(bin, 'onset'),
      `#!/bin/sh\nprintf '%s\\n' "$@" > '${log}'\nprintf '\\000am-result {"ok":true,"exit_code":0}\\n'\n`,
    );
    const started = await studioRequest(f.s, 'POST', '/api/stations/fake-publisher/ops/accounts', '{"params":{}}');
    expect(started.status).toBe(202);
    expect(await waitStudioTask(f.s, started.body.task_id)).toMatchObject({ status: 'succeeded' });
    // 不占项目写锁、不交项目根：设置页自动刷新列表时，用户点的项目操作不会被「项目正忙」挡住。
    expect(fs.readFileSync(log, 'utf8')).toContain('"project_root":""');
  });

  it('keeps only the plugin message in task results, and nothing of list results', async () => {
    const f = newSessionFixture();
    installStation(`link:${fake}`);
    const bin = tempDir();
    // 假的 onset：登录回一句说明加账号名，列表回账号卡片（昵称、头像）。
    const data = {
      message: '已登录：小号',
      logged_in: '小号',
      items: [{ title: '小号', image: 'data:image/png;base64,AAAA' }],
    };
    f.s.config.executable = writeShellFixture(
      path.join(bin, 'onset'),
      `#!/bin/sh\nprintf '\\000am-result %s\\n' '${JSON.stringify({ ok: true, exit_code: 0, data })}'\n`,
    );
    // 打开了项目时，不需要项目的登录照常在项目里跑：设置弹窗照样要拿到插件的那句说明。
    const login = await studioRequest(f.s, 'POST', '/api/stations/fake-publisher/ops/login', '{"params":{}}');
    expect(await waitStudioTask(f.s, login.body.task_id)).toMatchObject({
      status: 'succeeded',
      result: { message: '已登录：小号' },
    });
    const list = await studioRequest(f.s, 'POST', '/api/stations/fake-publisher/ops/accounts', '{"params":{}}');
    const listed = await waitStudioTask(f.s, list.body.task_id);
    expect(listed.status).toBe('succeeded');
    expect(listed.result).toBeUndefined();
    // 设置弹窗照样从 last_run 读到卡片（只在内存里）。
    const { body } = await studioRequest(f.s, 'GET', '/api/stations');
    expect(
      body.stations
        .find((x: { id: string }) => x.id === 'fake-publisher')
        .ops.find((o: { name: string }) => o.name === 'accounts').last_run.data.items,
    ).toHaveLength(1);
    // 写进项目的任务记录里只有说明，没有账号卡片、头像与插件的完整结果。
    const saved = fs.readFileSync(path.join(f.root, 'production', 'studio', 'tasks.json'), 'utf8');
    expect(saved).toContain('已登录：小号');
    expect(saved).not.toContain('data:image');
    expect(saved).not.toContain('logged_in');
  });

  it('validates requests before starting a write task', async () => {
    const f = newSessionFixture();
    installStation(`link:${fake}`);
    const post = (url: string, body: unknown) => studioRequest(f.s, 'POST', url, JSON.stringify(body));
    expect((await post('/api/stations', { source: '' })).status).toBe(400);
    expect((await post('/api/stations', { source: 'npm:thing' })).body.message).toContain('认不出来源');
    expect((await post('/api/stations/nope/ops/send', {})).status).toBe(404);
    expect((await post('/api/stations/fake-publisher/ops/nope', {})).status).toBe(404);
    expect((await post('/api/stations/fake-publisher/ops/send', { params: {} })).body.message).toContain(
      '缺参数 platform',
    );
    expect((await post('/api/stations/fake-publisher/ops/send', { params: { platform: 1 } })).body.message).toContain(
      '要是 string',
    );
    expect((await post('/api/stations/nope/remove', {})).status).toBe(404);
    expect((await post('/api/stations/nope/update', {})).status).toBe(404);
    expect((await post('/api/stations/fake-publisher/update', {})).body.message).toContain('不需要更新');
  });

  it('serves plugin pages from the station only, under a CSP that blocks every request', async () => {
    const f = newSessionFixture();
    installStation(`link:${fake}`);
    const { body } = await studioRequest(f.s, 'GET', '/api/stations');
    expect(body.stations.find((x: { id: string }) => x.id === 'fake-publisher').pages).toEqual([
      {
        id: 'dashboard',
        label: '发布看板',
        tab: 'x:fake-publisher:dashboard',
        url: '/station-ui/fake-publisher/ui/index.html',
        reads: ['publish.md'],
      },
      {
        id: 'mini',
        label: '发布小窗',
        tab: 'x:fake-publisher:mini',
        url: '/station-ui/fake-publisher/ui/slot.html',
        reads: ['publish.md'],
      },
    ]);
    expect(body.stations.find((x: { id: string }) => x.id === 'fake-publisher').slots).toEqual([
      {
        at: 'publish',
        page: 'mini',
        height: 140,
        tab: 'x:fake-publisher:mini',
        url: '/station-ui/fake-publisher/ui/slot.html',
      },
    ]);
    expect(body.stations.find((x: { id: string }) => x.id === 'fake-publisher').commands).toEqual([
      { name: 'fabu', description: '打开发布看板', page: 'dashboard', prompt: '', tab: 'x:fake-publisher:dashboard' },
    ]);
    const page = await send(f.s, 'GET', '/station-ui/fake-publisher/ui/index.html');
    expect(page.status).toBe(200);
    const csp = page.headers.get('Content-Security-Policy')!;
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain('script-src onset://app/station-ui/fake-publisher/ onset://app/station-ui/_sdk.js');
    expect(await page.text()).toContain('发布看板');
    expect((await send(f.s, 'GET', '/station-ui/fake-publisher/ui/slot.html')).status).toBe(200);
    expect((await send(f.s, 'GET', '/station-ui/_sdk.js')).headers.get('Content-Type')).toContain('javascript');
    // 只给页面所在目录：清单、命令、站目录外的文件都不给。
    for (const bad of [
      '/station-ui/fake-publisher/onset-station.json',
      '/station-ui/fake-publisher/bin/publish.cjs',
      '/station-ui/fake-publisher/prompt.md',
      '/station-ui/nope/ui/index.html',
    ]) {
      expect((await send(f.s, 'GET', bad)).status, bad).not.toBe(200);
    }
  });

  it('lets a page read only what the station declared', async () => {
    const f = newSessionFixture();
    installStation(`link:${fake}`);
    fs.writeFileSync(path.join(f.root, 'publish.md'), '---\nplatform: douyin\n---\n');
    fs.writeFileSync(path.join(f.root, '.env'), 'SECRET=1\n');
    fs.mkdirSync(path.join(f.root, 'production', 'publish'), { recursive: true });
    fs.writeFileSync(path.join(f.root, 'production', 'publish', 'cover.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const read = (p: string) =>
      studioRequest(f.s, 'GET', `/api/stations/fake-publisher/read?path=${encodeURIComponent(p)}`);
    let r = await read('publish.md');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ path: 'publish.md', size: 25, text: '---\nplatform: douyin\n---\n' });
    r = await read('production/publish/cover.png');
    expect(r.body.data_url).toBe('data:image/png;base64,iVBORw==');
    expect((await read('production/publish/receipts.json')).status).toBe(404);
    for (const bad of [
      '.env',
      'onset.conf',
      '../etc/passwd',
      '/etc/passwd',
      'production/publish/../../.env',
      'production/studio/tasks.json',
    ]) {
      expect((await read(bad)).status, bad).toBe(403);
    }
  });

  it('serves declared project media to pages, and checks what a page may call', async () => {
    const f = newSessionFixture();
    installStation(`link:${fake}`);
    fs.mkdirSync(path.join(f.root, 'production', 'publish'), { recursive: true });
    fs.writeFileSync(path.join(f.root, 'production', 'publish', 'cover.png'), 'png');
    let res = await send(f.s, 'GET', '/station-media/fake-publisher/production/publish/cover.png');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('png');
    for (const bad of [
      '/station-media/fake-publisher/.env',
      '/station-media/fake-publisher/onset.conf',
      '/station-media/nope/publish.md',
    ]) {
      expect((await send(f.s, 'GET', bad)).status, bad).toBe(404);
    }
    // 只能调清单里申请过的 onset 操作。
    res = await send(f.s, 'POST', '/api/stations/fake-publisher/call/scene_run', '{"params":{}}');
    expect(res.status).toBe(403);
    expect(((await res.json()) as { message: string }).message).toContain('没有申请调用 scene_run');
    // 设置：密钥只回「填没填」。
    let r = await studioRequest(
      f.s,
      'POST',
      '/api/stations/fake-publisher/settings',
      JSON.stringify({ key: 'token', value: 'tok-xyz' }),
    );
    expect(r.status).toBe(200);
    expect(r.body.settings.find((x: { key: string }) => x.key === 'token')).toMatchObject({ set: true });
    expect(JSON.stringify(r.body)).not.toContain('tok-xyz');
    r = await studioRequest(
      f.s,
      'POST',
      '/api/stations/fake-publisher/settings',
      JSON.stringify({ key: 'platform', value: 'weibo' }),
    );
    expect(r.status).toBe(400);
    expect(pageCSP('x', ['https://api.example.com'])).toContain('connect-src https://api.example.com');
    expect(pageCSP('x')).toContain("connect-src 'none'");
  });

  it('tells listeners when a gate is confirmed', async () => {
    const f = newSessionFixture();
    const seen: string[] = [];
    onStudioEvent((_s, _p, event, payload) => seen.push(`${event} ${JSON.stringify(payload)}`));
    fs.mkdirSync(path.join(f.root, 'production'), { recursive: true });
    fs.writeFileSync(path.join(f.root, 'production', 'script-final.md'), '# 稿\n正文\n');
    expect((await studioRequest(f.s, 'POST', '/api/progress/gates/gate-script', '{}')).status).toBe(200);
    expect(seen).toContain('gate.confirmed {"gate":"gate-script"}');
  });

  it('starts scheduled ops when they are due, and only then', async () => {
    const f = newSessionFixture();
    installStation(`link:${fake}`);
    const t0 = Date.now();
    expect(tickStationSchedules(f.s, t0)).toEqual(['fake-publisher/on_event']);
    // 等这个任务结束（测试里执行进程起不来，很快失败），放出写权。
    for (
      let i = 0;
      i < 50 && [...f.s.tasks.tasks.values()].some((t) => t.status === 'running' || t.status === 'queued');
      i++
    )
      await new Promise((r) => setTimeout(r, 20));
    expect(tickStationSchedules(f.s, t0 + 10 * 60_000)).toEqual([]);
    expect(tickStationSchedules(f.s, t0 + 31 * 60_000)).toEqual(['fake-publisher/on_event']);
    f.s.shutdown();
  });

  it('shows files an op wrote outside its declared scope, and posts a notice when a hook ran it', async () => {
    const f = newSessionFixture();
    installStation(`link:${fake}`);
    // 测试里没有真的执行进程：换一个假的 onset，像插件那样在项目里顺手写一个没声明的文件。
    const bin = fs.mkdtempSync(path.join(f.root, '..', 'onset-fake-'));
    const fakeOnset = path.join(bin, 'onset');
    f.s.config.executable = writeShellFixture(
      fakeOnset,
      '#!/bin/sh\nmkdir -p notes\necho x > notes/stray.txt\nmkdir -p production/publish\necho y > production/publish/ok.json\nprintf \'写好了\\n\\000am-result {"ok":true,"exit_code":0}\\n\'\n',
    );
    const done = async () => {
      for (
        let i = 0;
        i < 250 && [...f.s.tasks.tasks.values()].some((t) => t.status === 'running' || t.status === 'queued');
        i++
      )
        await new Promise((r) => setTimeout(r, 20));
    };

    expect(
      (await studioRequest(f.s, 'POST', '/api/stations/fake-publisher/ops/scribble', '{"params":{}}')).status,
    ).toBe(202);
    await done();
    const task = [...f.s.tasks.tasks.values()].find((t) => t.type === 'station.run')!;
    expect(task.status).toBe('succeeded');
    expect(task.warning).toBe('插件「假发布」改了它没有声明会写的项目文件：notes/stray.txt。');
    const { body } = await studioRequest(f.s, 'GET', '/api/stations');
    const op = body.stations
      .find((x: { id: string }) => x.id === 'fake-publisher')
      .ops.find((o: { name: string }) => o.name === 'scribble');
    expect(op.last_run).toMatchObject({ ok: true, out_of_scope: ['notes/stray.txt'], out_of_scope_more: 0 });
    expect(op.last_run.reserved).toBeUndefined();

    // 钩子触发：没人在看，另在最近的对话里发一条 notice。
    const created = await studioRequest(f.s, 'POST', '/api/sessions', '{}');
    fs.rmSync(path.join(f.root, 'notes'), { recursive: true });
    emitStationHook(f.s, f.s.currentProject(), 'film.approved');
    await done();
    const hook = [...f.s.tasks.tasks.values()].find((t) => t.type === 'station.hook')!;
    expect(hook.warning).toContain('notes/stray.txt');
    const events = (await send(f.s, 'GET', `/api/sessions/${created.body.session_id}/events?follow=0`)).text();
    expect(await events).toContain('自动执行的插件「假发布」改了它没有声明会写的项目文件：notes/stray.txt。');
    f.s.shutdown();
  });

  it('runs browser ops without the project write lock, so uploads overlap each other and other work', async () => {
    const f = newSessionFixture();
    const manifest = (id: string, dir: string) =>
      JSON.stringify({
        id,
        version: '1',
        name: id,
        browser: { origins: ['https://creator.example.test'] },
        produces: [{ prefix: `production/${dir}/` }],
        ops: [{ name: 'prepare', summary: '上传', trigger: 'user', command: ['{node}', 'x.cjs'], params: {} }],
      });
    installStation(`link:${writeStationForTest({ 'onset-station.json': manifest('upload-a', 'a'), 'x.cjs': '' })}`);
    installStation(`link:${writeStationForTest({ 'onset-station.json': manifest('upload-b', 'b'), 'x.cjs': '' })}`);
    const ordinary = JSON.parse(manifest('ordinary', 'ordinary'));
    delete ordinary.browser;
    installStation(`link:${writeStationForTest({ 'onset-station.json': JSON.stringify(ordinary), 'x.cjs': '' })}`);
    const bin = fs.mkdtempSync(path.join(f.root, '..', 'onset-fake-'));
    const gate = path.join(bin, 'go');
    // 假的执行进程：记下参数，按站写文件，等测试放行再结束（像在等网站传完）。
    f.s.config.executable = writeShellFixture(
      path.join(bin, 'onset'),
      `#!/bin/sh
printf '%s\\n' "$@" >> '${bin}/args.log'
case "$*" in *upload-a*) mkdir -p production/b && echo x > production/b/from-a.json ;; esac
case "$*" in *upload-b*) mkdir -p notes && echo x > notes/stray.txt ;; esac
while [ ! -f '${gate}' ]; do sleep 0.05; done
printf '\\000am-result {"ok":true,"exit_code":0}\\n'
`,
    );
    const start = async (id: string) => {
      const r = await studioRequest(f.s, 'POST', `/api/stations/${id}/ops/prepare`, '{"params":{}}');
      expect(r.status).toBe(202);
      return r.body.task_id as string;
    };
    const a = await start('upload-a');
    const b = await start('upload-b');
    // 两个插件同时在跑，项目写锁空着；重启装更新前照样知道有上传在进行。
    expect(f.s.busyHolder(f.root)).toBe('');
    expect(
      f.s
        .activeWork()
        .map((w) => w.holder)
        .sort(),
    ).toEqual(['upload-a：上传', 'upload-b：上传']);
    const ordinaryTask = await start('ordinary');
    fs.writeFileSync(gate, '');
    expect(await waitStudioTask(f.s, a)).toMatchObject({ status: 'succeeded' });
    expect(await waitStudioTask(f.s, b)).toMatchObject({ status: 'succeeded' });
    expect(await waitStudioTask(f.s, ordinaryTask)).toMatchObject({ status: 'succeeded' });
    expect(f.s.activeWork()).toEqual([]);
    expect(fs.readFileSync(path.join(bin, 'args.log'), 'utf8')).toContain('"host_scope":true');
    const runs = (await studioRequest(f.s, 'GET', '/api/stations')).body.stations;
    const last = (id: string) => runs.find((x: { id: string }) => x.id === id).ops[0].last_run;
    // 两个同时在写：改动分不清是谁写的，都不报越界。
    expect(last('upload-a').out_of_scope).toBeUndefined();
    expect(last('upload-b').out_of_scope).toBeUndefined();
    expect(last('ordinary').out_of_scope).toBeUndefined();

    const solo = async (during?: () => void) => {
      fs.rmSync(gate);
      fs.rmSync(path.join(f.root, 'notes'), { recursive: true, force: true });
      const c = await start('upload-b');
      during?.();
      fs.writeFileSync(gate, '');
      expect(await waitStudioTask(f.s, c)).toMatchObject({ status: 'succeeded' });
      const run = (await studioRequest(f.s, 'GET', '/api/stations')).body.stations.find(
        (x: { id: string }) => x.id === 'upload-b',
      ).ops[0].last_run;
      expect(run.task_id).toBe(c);
      return run.out_of_scope;
    };
    // 只有它一个在写：照常报。
    expect(await solo()).toEqual(['notes/stray.txt']);
    // 期间有人占过写锁（一轮对话、渲染……）：归不到插件头上，这次不报。
    expect(
      await solo(() => {
        f.s.acquire(f.root, '一轮对话');
        f.s.release(f.root);
      }),
    ).toBeUndefined();
    f.s.shutdown();
  });

  it.each([false, true])('still fails a browser op that changed onset files (overlap=%s)', async (overlap) => {
    const f = newSessionFixture();
    installStation(
      `link:${writeStationForTest({
        'onset-station.json': JSON.stringify({
          id: 'upload-c',
          version: '1',
          name: '上传',
          browser: { origins: ['https://creator.example.test'] },
          produces: [{ prefix: 'production/c/' }],
          ops: [{ name: 'prepare', summary: '上传', trigger: 'user', command: ['{node}', 'x.cjs'], params: {} }],
        }),
        'x.cjs': '',
      })}`,
    );
    const bin = fs.mkdtempSync(path.join(f.root, '..', 'onset-fake-'));
    f.s.config.executable = writeShellFixture(
      path.join(bin, 'onset'),
      `#!/bin/sh\nmkdir -p .agents && echo x > .agents/evil.md\nprintf '\\000am-result {"ok":true,"exit_code":0}\\n'\n`,
    );
    if (overlap) f.s.acquire(f.root, '一轮对话');
    const r = await studioRequest(f.s, 'POST', '/api/stations/upload-c/ops/prepare', '{"params":{}}');
    const task = await waitStudioTask(f.s, r.body.task_id);
    if (overlap) f.s.release(f.root);
    expect(task.status).toBe('failed');
    expect(task.message).toContain(
      overlap ? '片场保留文件有改动（.agents/evil.md），并发写入无法判定归属' : '写了片场自己的文件（.agents/evil.md）',
    );
    const run = (await studioRequest(f.s, 'GET', '/api/stations')).body.stations.find(
      (x: { id: string }) => x.id === 'upload-c',
    ).ops[0].last_run;
    expect(run).toMatchObject({ ok: false, reserved: ['.agents/evil.md'] });
    f.s.shutdown();
  });

  it('manages plugins without an open project, and keeps project things behind one', async () => {
    const s = startStudio({ configPath: path.join(tempDir(), 'projects.json') });
    installStation(`link:${fake}`);
    let r = await studioRequest(s, 'GET', '/api/stations');
    expect(r.status).toBe(200);
    expect(r.body.stations.some((x: { id: string }) => x.id === 'fake-publisher')).toBe(true);
    // 设置是用户级的。
    r = await studioRequest(
      s,
      'POST',
      '/api/stations/fake-publisher/settings',
      JSON.stringify({ key: 'token', value: 'tok' }),
    );
    expect(r.status).toBe(200);
    // 装、去掉、更新是不占项目写锁的后台任务。
    r = await studioRequest(s, 'POST', '/api/stations', JSON.stringify({ source: `link:${fake}` }));
    expect(r.status).toBe(202);
    await waitStudioTask(s, r.body.task_id);
    // 取回待装的插件：能再看一次它的实情，取消后就没了，已装的不变。
    const staged = stageStation(`link:${fake}`);
    r = await studioRequest(s, 'GET', `/api/stations/staged/${staged.token}`);
    expect(r.status).toBe(200);
    expect(r.body.preview).toMatchObject({ id: 'fake-publisher', flow: '快剪', after: 'publish' });
    expect(r.body.preview.ops_trust).toContain('它的操作是在你电脑上运行的程序');
    expect((await studioRequest(s, 'POST', `/api/stations/staged/${staged.token}/discard`, '{}')).status).toBe(200);
    expect((await studioRequest(s, 'GET', `/api/stations/staged/${staged.token}`)).status).toBe(404);
    expect((await studioRequest(s, 'POST', '/api/stations/staged/not-a-token/install', '{}')).status).toBe(404);
    expect((await studioRequest(s, 'POST', '/api/stations/nope/remove', '{}')).status).toBe(404);
    expect((await studioRequest(s, 'POST', '/api/stations/fake-publisher/update', '{}')).body.message).toContain(
      '不需要更新',
    );
    // 执行操作、读项目文件要打开项目。
    expect(
      (await studioRequest(s, 'POST', '/api/stations/fake-publisher/ops/status', '{"params":{}}')).status,
    ).not.toBe(202);
    expect((await studioRequest(s, 'GET', '/api/stations/fake-publisher/read?path=publish.md')).status).not.toBe(200);
    s.shutdown();
  });

  it('refuses API calls from a sandboxed page', async () => {
    const f = newSessionFixture();
    const res = await send(f.s, 'GET', '/api/state', undefined, { Origin: 'null' });
    expect(res.status).toBe(403);
    expect((await send(f.s, 'GET', '/api/state')).status).toBe(200);
  });
});
