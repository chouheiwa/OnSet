import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { api, desktopDir, expect, installedPlugins, installPlugin, openPage, openProject, test } from './fixtures.mjs';

// 测试用的假发布站：只写回执，不联网（packages/engine/src/flow/testdata/fake-publisher）。
const fake = path.resolve(desktopDir, '..', '..', 'packages', 'engine', 'src', 'flow', 'testdata', 'fake-publisher');

test('a git plugin can be previewed, cancelled, installed and updated using the client runtime', async ({
  page,
  sandbox,
}) => {
  test.skip(spawnSync('git', ['--version']).status !== 0, 'requires git');
  const repo = path.join(sandbox.root, 'plugin-repo');
  fs.cpSync(fake, repo, { recursive: true });
  const git = (...args) => {
    const result = spawnSync('git', ['-c', 'core.hooksPath=', '-c', 'commit.gpgsign=false', ...args], {
      cwd: repo,
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'test',
        GIT_AUTHOR_EMAIL: 'test@example.invalid',
        GIT_COMMITTER_NAME: 'test',
        GIT_COMMITTER_EMAIL: 'test@example.invalid',
      },
    });
    expect(result.status, result.stderr).toBe(0);
  };
  git('init', '-q', '-b', 'main');
  git('add', '.');
  git('commit', '-qm', 'v1');

  await page.locator('#settings-trigger').click();
  const stations = page.locator('#settings-dialog section.stations[aria-label="我的插件"]');
  const confirm = stations.getByRole('alertdialog', { name: '确认添加插件' });
  const add = async () => {
    await stations.getByLabel('插件来源').fill(pathToFileURL(repo).href);
    await stations.getByRole('button', { name: '添加', exact: true }).click();
    await expect(confirm).toContainText('假发布');
    const staged = fs.readdirSync(path.join(sandbox.stations, '.staging'));
    expect(staged).toHaveLength(1);
    expect(fs.existsSync(path.join(sandbox.stations, '.staging', staged[0], 'src', '.git'))).toBe(false);
  };

  await add();
  expect(installedPlugins(sandbox)).toEqual([]);
  await confirm.getByRole('button', { name: '取消' }).click();
  await expect(confirm).toHaveCount(0);
  await expect.poll(() => fs.readdirSync(path.join(sandbox.stations, '.staging'))).toEqual([]);

  await add();
  await confirm.getByRole('button', { name: '装上', exact: true }).click();
  await expect.poll(() => installedPlugins(sandbox)).toEqual(['fake-publisher']);
  const card = stations.locator('li[data-station="fake-publisher"]');
  await expect(card).toContainText('假发布');

  const file = path.join(repo, 'onset-station.json');
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  manifest.version = '0.2.0';
  fs.writeFileSync(file, JSON.stringify(manifest));
  git('commit', '-qam', 'v2');
  await card.getByRole('button', { name: '更新', exact: true }).click();
  await expect(confirm).toContainText('0.2.0');
  await confirm.getByRole('button', { name: '换上', exact: true }).click();
  await expect(confirm).toHaveCount(0);
  await expect
    .poll(async () => (await api(page, '/api/stations')).body.stations.find((s) => s.id === 'fake-publisher')?.version)
    .toBe('0.2.0');
  expect(fs.readdirSync(path.join(sandbox.stations, '.staging'))).toEqual([]);

  // 清单校验失败时 .git 还在：仍要清掉只读对象，并显示校验错误而不是清理错误。
  manifest.unknown_field = true;
  fs.writeFileSync(file, JSON.stringify(manifest));
  git('commit', '-qam', 'invalid manifest');
  await card.getByRole('button', { name: '更新', exact: true }).click();
  await expect(stations).toContainText('不认识的字段');
  expect(fs.readdirSync(path.join(sandbox.stations, '.staging'))).toEqual([]);
  expect(installedPlugins(sandbox)).toEqual(['fake-publisher']);
});

test('a plugin from the plugin center goes through the same preview, and so does its update', async ({
  page,
  sandbox,
}) => {
  test.skip(spawnSync('git', ['--version']).status !== 0, 'requires git');
  const repo = path.join(sandbox.root, 'market-repo');
  fs.cpSync(fake, repo, { recursive: true });
  const git = (...args) => {
    const result = spawnSync('git', ['-c', 'core.hooksPath=', '-c', 'commit.gpgsign=false', ...args], {
      cwd: repo,
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'test',
        GIT_AUTHOR_EMAIL: 'test@example.invalid',
        GIT_COMMITTER_NAME: 'test',
        GIT_COMMITTER_EMAIL: 'test@example.invalid',
      },
    });
    expect(result.status, result.stderr).toBe(0);
    return result.stdout.trim();
  };
  git('init', '-q', '-b', 'main');
  git('add', '.');
  git('commit', '-qm', 'v1');
  const v1 = git('rev-parse', 'HEAD');
  const writeCatalog = (versions) =>
    fs.writeFileSync(
      sandbox.catalog,
      JSON.stringify({
        schema: 1,
        plugins: [
          {
            id: 'fake-publisher',
            name: '假发布',
            description: '只写回执，不联网',
            tags: ['发布'],
            source: pathToFileURL(repo).href,
            versions,
          },
        ],
      }),
    );
  writeCatalog([{ version: '0.1.0', commit: v1 }]);

  await page.locator('#settings-trigger').click();
  const market = page.locator('#settings-dialog section.stations[aria-label="插件中心"]');
  const mine = page.locator('#settings-dialog section.stations[aria-label="我的插件"]');
  const confirm = mine.getByRole('alertdialog', { name: '确认添加插件' });
  const card = market.locator('li[data-market="fake-publisher"]');
  await expect(card).toContainText('假发布');
  await card.getByRole('button', { name: '安装' }).click();
  await expect(confirm).toContainText(v1.slice(0, 12));
  // 看过之前不装。
  expect(installedPlugins(sandbox)).toEqual([]);
  await confirm.getByRole('button', { name: '装上', exact: true }).click();
  await expect.poll(() => installedPlugins(sandbox)).toEqual(['fake-publisher']);
  await expect(card).toContainText('已装 0.1.0');

  const file = path.join(repo, 'onset-station.json');
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  manifest.version = '0.2.0';
  fs.writeFileSync(file, JSON.stringify(manifest));
  git('commit', '-qam', 'v2');
  const v2 = git('rev-parse', 'HEAD');
  writeCatalog([
    { version: '0.1.0', commit: v1 },
    { version: '0.2.0', commit: v2 },
  ]);
  await market.getByRole('button', { name: '刷新' }).click();
  const update = mine.locator('li[data-station="fake-publisher"]').getByRole('button', { name: '更新到 0.2.0' });
  await update.click();
  await expect(confirm).toContainText('0.2.0');
  await confirm.getByRole('button', { name: '换上', exact: true }).click();
  await expect(confirm).toHaveCount(0);
  await expect
    .poll(async () => (await api(page, '/api/stations')).body.stations.find((s) => s.id === 'fake-publisher')?.commit)
    .toBe(v2);
  await expect(card).toContainText('已装 0.2.0');
});

/**
 * 点插件页面里的按钮，直到宿主有反应。Chromium 按合成器的命中数据把点击转进进程外的 iframe，后台运行的测试窗口里
 * 这份数据会落后于布局：iframe 刚挂上、刚挪过位置（面板滑入）时，Playwright 在 iframe 里算好的坐标点下去，事件落在
 * 宿主的 iframe 元素上，页面根本没收到（实测偶发，日志里宿主收到 mousedown、页面一个事件都没有）。没送到的点击什么都
 * 不会发生，所以按「宿主有没有反应」重点即可；reacted 用短超时断言那个反应。
 */
// 片场里刚有过一次点击或按键：这时插件页面的请求分不清是不是用户点的，宿主照旧弹确认（Stations.tsx 的 clickedInPluginPage）。
// 测确认条的用例先调它，免得点按钮之前片场里有没有操作取决于机器快慢。
async function touchHost(page) {
  await page.evaluate(() => window.dispatchEvent(new PointerEvent('pointerdown')));
}

// 点插件页面里的执行按钮、等宿主弹确认：每次点之前先 touchHost，让这次请求一定走确认。
async function clickForConfirm(page, target, confirm) {
  await expect(async () => {
    await touchHost(page);
    await target.click();
    await expect(confirm).toBeVisible({ timeout: 2000 });
  }).toPass({ timeout: 20_000 });
}

async function clickInPage(target, reacted) {
  await expect(async () => {
    await target.click();
    await reacted();
  }).toPass({ timeout: 20_000 });
}

test('a plugin is added in settings without a project, every project gets it, and its action in settings runs only when the user clicks', async ({
  page,
  project,
  sandbox,
  electronApp,
}) => {
  fs.writeFileSync(
    path.join(project.path, 'publish.md'),
    '---\nplatform: douyin\npublish_status: draft\ncopy:\n  primary_title: 测试标题\n---\n',
  );
  // 还没打开任何项目：首页。
  await expect(page.locator('.home-hero h1')).toContainText('今天想做一条');

  // 设置页「我的插件」：装在这台电脑上，对所有项目生效（写用户级的 installed.json，不碰项目文件）。
  await page.locator('#settings-trigger').click();
  const stations = page.locator('#settings-dialog section.stations[aria-label="我的插件"]');
  // 本地文件夹经系统的文件夹选择器（主进程的 dialog，测试里换成直接返回）选，路径带空格与 #，不要 Git 仓库。
  // 选错目录、取消选择与预览里的说法在 Stations.test.tsx。
  const folder = path.join(sandbox.root, '本地插件 #1');
  fs.cpSync(fake, folder, { recursive: true });
  await electronApp.evaluate(({ dialog }, selected) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] });
  }, folder);
  await stations.getByRole('button', { name: '选择本地文件夹' }).click();
  await expect(stations.getByLabel('插件来源')).toHaveValue(`link:${folder}`);
  await stations.getByRole('button', { name: '添加' }).click();
  // 第一步：取回、给你看这个插件自己的实情，还没装上——任何项目都看不到它。
  const confirmAdd = stations.getByRole('alertdialog', { name: '确认添加插件' });
  await expect(confirmAdd).toContainText('假发布');
  await expect(confirmAdd).toContainText('把成片发到平台');
  await expect(confirmAdd).toContainText('能读写你的文件、能联网');
  await expect(confirmAdd.locator('.staged-page-perms')).toContainText('镜头、制作进度、发布信息的概况');
  await expect(confirmAdd.locator('.staged-page-perms')).toContainText('整片复查');
  await expect(confirmAdd).toContainText('你确认一个审核关卡后');
  await expect(confirmAdd).toContainText('快剪（新建项目时在「做法」里选）');
  await expect(confirmAdd).toContainText('假风格库');
  await expect(confirmAdd).toContainText('接在「发布」后面');
  await expect(confirmAdd).toContainText('用到了实验性能力：hooks');
  await expect(confirmAdd).toContainText('对这台电脑上的所有项目生效');
  await expect(confirmAdd).toContainText('改动立即生效');
  expect(installedPlugins(sandbox)).toEqual([]);
  expect((await api(page, '/api/stations')).body.stations.some((x) => x.id === 'fake-publisher')).toBe(false);
  await stations.scrollIntoViewIfNeeded();
  await page.screenshot({ path: test.info().outputPath('stations-staged.png') });
  // 第二步：点「装上」才写进已装插件清单。
  await confirmAdd.getByRole('button', { name: '装上' }).click();
  await expect.poll(() => installedPlugins(sandbox)).toEqual(['fake-publisher']);
  await expect(confirmAdd).toHaveCount(0);
  const lock = path.join(project.path, 'onset.flow.json');
  expect(JSON.parse(fs.readFileSync(lock, 'utf8'))).toEqual({
    version: 1,
    production: { id: 'speech', canvas: 'vertical-3x4' },
  });
  const card = stations.locator('li[data-station="fake-publisher"]');
  await expect(card).toContainText('假发布');
  await expect(card).toContainText('第三方');
  // 直接用那个文件夹，不拷、不建 Git 仓库；改了清单立即生效。
  expect(fs.existsSync(path.join(folder, '.git'))).toBe(false);
  const manifestPath = path.join(folder, 'onset-station.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.description = '本地修改已经生效';
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  expect((await api(page, '/api/stations')).body.stations.find((s) => s.id === 'fake-publisher')?.description).toBe(
    manifest.description,
  );
  // 「详情与设置」是盖在设置上的弹窗。
  await card.getByRole('button', { name: '详情与设置' }).click();
  const detail = page.getByRole('dialog', { name: '假发布 详情与设置' });
  await expect(detail).toBeVisible();
  await expect(detail.locator('.station-prompt')).toContainText('请用户在发布页点');
  // 没打开项目：登录这类插件自己的配置照样能点；针对项目的操作要先打开项目。
  await expect(detail).toContainText('「把成片发到平台」「顺手记一笔」针对项目执行，打开一个项目后在这里点');
  await expect(detail.locator('.station-op')).toHaveCount(1);
  const login = detail.locator('.station-op[data-op="login"]');
  await login.getByLabel('账号备注名').fill('小号');
  await login.getByRole('button', { name: '登录平台账号' }).click();
  await expect(login.locator('.station-last')).toHaveText('上次执行成功');
  await expect(login.locator('.station-output')).toContainText('已登录：小号');
  expect(
    JSON.parse(fs.readFileSync(path.join(sandbox.stations, 'fake-publisher', 'data', 'login.json'), 'utf8')),
  ).toEqual({ name: '小号' });
  // 插件收到的是「没有项目」，片场也没把插件目录当成项目去扫。
  const loginRun = (await api(page, '/api/stations')).body.stations
    .find((x) => x.id === 'fake-publisher')
    .ops.find((o) => o.name === 'login').last_run;
  expect(loginRun.data).toMatchObject({ in_project: false });
  expect(loginRun.out_of_scope).toBeUndefined();
  expect(fs.existsSync(path.join(sandbox.stations, 'production'))).toBe(false);
  // 登录完，账号列表（清单 list: true）自动刷新成卡片：头像、名字与卡片上的按钮。
  await expect(detail.locator('.stations-result')).toHaveText('已登录：小号');
  const account = detail.locator('.plugin-list[data-op="accounts"] .plugin-item');
  await expect(account).toHaveCount(1);
  await expect(account).toContainText('小号');
  await expect(account.locator('img')).toHaveAttribute('src', /^data:image\/png;base64,/);
  // 只在卡片上的按钮（form: false）不出表单；点了先问一句。
  await expect(detail.locator('.station-op[data-op="logout"]')).toHaveCount(0);
  await account.getByRole('button', { name: '退出' }).click();
  await expect(account).toContainText('退出后要重新登录，确定吗？');
  await account.getByRole('button', { name: '退出' }).click();
  await expect(detail.locator('.plugin-list[data-op="accounts"] .plugin-item')).toHaveCount(0);
  await expect(detail.locator('.plugin-list[data-op="accounts"]')).toContainText('还没有。');
  await login.getByLabel('账号备注名').fill('小号');
  await login.getByRole('button', { name: '登录平台账号' }).click();
  await expect(account).toContainText('小号');
  await expect(detail).toContainText('要你点的');
  await expect(detail.locator('.station-trust')).toContainText('它的操作是在你电脑上运行的程序');
  await expect(detail.locator('.station-experimental')).toContainText('用到了实验性能力：hooks');
  await expect(detail.locator('.station-perms:not(.station-page-perms)')).toContainText('新建项目时在「做法」里选');
  await page.screenshot({ path: test.info().outputPath('stations-settings.png') });
  // Esc 只关这一层弹窗，设置还开着。
  await page.keyboard.press('Escape');
  await expect(detail).toHaveCount(0);
  await expect(page.locator('#settings-dialog')).toBeVisible();
  // 本机目录的站改动立即生效，没有「更新」。
  await expect(card.getByRole('button', { name: '更新' })).toHaveCount(0);

  // 内置功能也是插件：同在设置里列出，常开、照实列出带了什么，没有开关。
  const builtin = page.locator('#settings-dialog section[aria-label="内置功能"]');
  const song = builtin.locator('li[data-builtin="song"]');
  await expect(song).toContainText('歌曲讲解');
  // 内置功能常开：没有开关，也不提醒重新渲染。
  await expect(builtin.getByRole('switch')).toHaveCount(0);
  await expect(builtin).not.toContainText('重新渲染');
  // 内置的不算第三方，也不能去掉。
  await expect(song).not.toContainText('第三方');
  await expect(song.getByRole('button', { name: '去掉' })).toHaveCount(0);
  await builtin.scrollIntoViewIfNeeded();
  await page.screenshot({ path: test.info().outputPath('builtin-features.png') });
  await expect(builtin.locator('li[data-builtin]')).toHaveCount(12);
  await expect(builtin.locator('li[data-builtin="lemo-styles"]')).toContainText('LemoLab 风格库');
  await expect(builtin.locator('li[data-builtin="anidoodle-styles"]')).toContainText('anidoodle 代码绘画');
  await expect(builtin.locator('li[data-builtin="huashu-styles"]')).toContainText('花叔艺术动画');
  await expect(builtin.locator('li[data-builtin="mg-styles"]')).toContainText('MG 动效风格库（MIT）');
  await expect(builtin.locator('li[data-builtin="papercraft-styles"]')).toContainText('Papercraft 折纸立体书（MIT）');
  await expect(builtin.locator('li[data-builtin="cast"]')).toContainText('多角色对话');
  // 「详情」照实列出这个功能在片场里登记了什么。
  const cast = builtin.locator('li[data-builtin="cast"]');
  await cast.getByRole('button', { name: '详情' }).click();
  await expect(cast.locator('.builtin-detail')).toContainText('character-rig');
  await expect(cast.locator('.builtin-detail')).toContainText('校验多角色项目');
  await cast.getByRole('button', { name: '收起' }).click();
  // 带风格库的功能，详情里写明它带了哪个库。
  const lemo = builtin.locator('li[data-builtin="lemo-styles"]');
  await lemo.getByRole('button', { name: '详情' }).click();
  await expect(lemo.locator('.builtin-detail')).toContainText('整片风格库');
  await lemo.getByRole('button', { name: '收起' }).click();
  await page.locator('#settings-dialog').getByRole('button', { name: '关闭' }).click();

  // 首页新建时能选到它带来的做法，标明来自哪个插件。
  await page.locator('#home-mode').click();
  const mode = page.locator('.menu-item', { hasText: '快剪' });
  await expect(mode).toContainText('来自插件「假发布」');
  await page.keyboard.press('Escape');

  // 已有的项目不用再加，打开就有。
  await openProject(page, project);
  // 制作路线上多了一站，排在发布后面。
  const progress = await api(page, '/api/progress');
  expect(progress.body.stations.map((s) => s.id).slice(-2)).toEqual(['publish', 'auto-publish']);
  // 口播项目的顶栏有发布这一步（内置的发布插件常开）。
  await expect(page.locator('.steps [data-tab="publish"]')).toBeAttached();

  // 插件的配置不在发布页，在设置的「详情与设置」里：只有用户点了才发。
  await page.locator('[data-tab="publish"]').click();
  await expect(page.locator('.publish-tab')).toBeVisible();
  await expect(page.locator('.publish-tab .station-op')).toHaveCount(0);
  await page.locator('#settings-trigger').click();
  await page
    .locator('#settings-dialog li[data-station="fake-publisher"]')
    .getByRole('button', { name: '详情与设置' })
    .click();
  const pluginCard = page.getByRole('dialog', { name: '假发布 详情与设置' });
  await expect(pluginCard.locator('[data-setting="token"]')).toContainText('未填写');
  const action = pluginCard.locator('.station-op[data-op="send"]');
  await expect(action).toBeVisible();
  const send = action.getByRole('button', { name: '把成片发到平台' });
  await expect(send).toBeDisabled();
  await action.getByLabel('平台，例如 douyin').fill('douyin');
  await send.click();
  const receipt = path.join(project.path, 'production', 'publish', 'receipts.json');
  await expect.poll(() => fs.existsSync(receipt)).toBe(true);
  expect(JSON.parse(fs.readFileSync(receipt, 'utf8')).platform).toBe('douyin');
  await expect
    .poll(
      async () =>
        (await api(page, '/api/stations')).body.stations.find((x) => x.id === 'fake-publisher').ops[0].last_run?.ok,
    )
    .toBe(true);
  await expect
    .poll(async () => (await api(page, '/api/progress')).body.stations.find((s) => s.id === 'auto-publish').status)
    .toBe('done');
  await page.screenshot({ path: test.info().outputPath('stations-publish.png') });
  // 它的页面从这里打开：关掉弹窗与设置，在画面面板里打开。
  await pluginCard.getByRole('button', { name: '打开「发布看板」' }).click();
  await expect(page.locator('#settings-dialog')).toHaveCount(0);
  await expect(pluginCard).toHaveCount(0);
  await expect(page.locator('.station-page:not(.station-slot) .station-page-bar')).toContainText('发布看板');
  // 回到首页再从设置里打开：页面要真的出来，不能还停在首页（app 里的接线；弹窗里的按钮在 Stations.test.tsx）。
  await page.locator('.brand').click();
  await expect(page.locator('.home-hero h1')).toBeVisible();
  await page.locator('#settings-trigger').click();
  await page
    .locator('#settings-dialog li[data-station="fake-publisher"]')
    .getByRole('button', { name: '详情与设置' })
    .click();
  await page
    .getByRole('dialog', { name: '假发布 详情与设置' })
    .getByRole('button', { name: '打开「发布看板」' })
    .click();
  await expect(page.locator('.home-hero h1')).toHaveCount(0);
  await expect(page.locator('.station-page:not(.station-slot) .station-page-bar')).toContainText('发布看板');

  // 去掉：所有项目都不再有它；项目的锁文件始终只有新建时记下的流程。
  await page.locator('#settings-trigger').click();
  await page
    .locator('#settings-dialog li[data-station="fake-publisher"]')
    .getByRole('button', { name: '去掉' })
    .click();
  await expect.poll(() => installedPlugins(sandbox)).toEqual([]);
  await expect
    .poll(async () => (await api(page, '/api/progress')).body.stations.some((s) => s.id === 'auto-publish'))
    .toBe(false);
  expect(JSON.parse(fs.readFileSync(lock, 'utf8'))).toEqual({
    version: 1,
    production: { id: 'speech', canvas: 'vertical-3x4' },
  });
  // 去掉只是不用了，本地文件夹留着。
  expect(fs.existsSync(manifestPath)).toBe(true);
});

test('a plugin page runs sandboxed and gets everything through the host', async ({ page, project, sandbox }) => {
  fs.writeFileSync(path.join(project.path, 'publish.md'), '---\nplatform: douyin\npublish_status: draft\n---\n');
  fs.writeFileSync(path.join(project.path, '.env'), 'MINIMAX_VOICE_ID=do-not-leak\n');
  installPlugin(sandbox, fake);
  await openProject(page, project);
  // 插件不把顶栏撑出窗口（原来就有的 2px 是右上角的连接状态点）。
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth),
  ).toBeLessThanOrEqual(2);

  // 插件页面收在顶栏「页面」菜单里自己的一组（只用来嵌小窗的页面不列）。
  await page.locator('#page-menu-trigger').click();
  await expect(page.locator('.page-menu-list .station-icon')).toHaveCount(1);
  await page.locator('.page-menu-list [data-tab="x:fake-publisher:dashboard"]').click();
  await expect(page.locator('#page-menu-trigger')).toHaveText('发布看板');
  const host = page.locator('.station-page');
  await expect(host).toContainText('第三方插件 · 假发布');
  const frame = page.frameLocator('.station-frame');
  await expect(frame.locator('#title')).toHaveText(`假发布 · ${project.name}`);
  // 沙箱：直接调接口被拦下，.env 读不到，只能读清单里声明过的文件。
  await expect(frame.locator('#probe')).toHaveText('直接调接口被拦下');
  await expect(frame.locator('#secret')).toHaveText('.env 被拒绝');
  await expect(frame.locator('#publish')).toContainText('发布信息');
  await expect(frame.locator('#receipt')).toHaveText('还没有回执');
  // 页面里的 SDK 拿到项目概况，并跟随宿主的配色（宿主一侧给什么在 Stations.test.tsx）。
  await expect(frame.locator('#project')).toHaveText(/项目有 1 个镜头/);
  await expect(frame.locator('#theme')).toHaveText('强调色 #d9a35f');

  // 页面里的按钮不算用户同意：宿主先弹确认。
  // 只比纵向：面板滑入的动画可能还在走，横向会差一两个像素。
  const vertical = async () => {
    const box = await host.locator('.station-frame').boundingBox();
    return { y: box?.y, height: box?.height };
  };
  const before = await vertical();
  const confirm = host.locator('.station-confirm');
  await clickForConfirm(page, frame.locator('#send'), confirm);
  await expect(confirm).toContainText('「假发布」请求执行：把成片发到平台');
  // 确认条盖在页面上，不把页面往下推：页面一挪，紧跟着的点击会按旧位置命中、落不进页面。
  expect(await vertical()).toEqual(before);
  await expect(confirm).toContainText('platform=douyin');
  await page.screenshot({ path: test.info().outputPath('station-page-confirm.png') });
  const receipt = path.join(project.path, 'production', 'publish', 'receipts.json');
  expect(fs.existsSync(receipt)).toBe(false);
  await confirm.getByRole('button', { name: '执行', exact: true }).click();
  await expect.poll(() => fs.existsSync(receipt)).toBe(true);
  // 任务跑完，宿主让页面重读。
  await expect(frame.locator('#receipt')).toHaveText('回执：https://example.invalid/douyin/1');

  // 拒绝：页面拿到「没有同意」。
  await clickForConfirm(page, frame.locator('#send'), confirm);
  await confirm.getByRole('button', { name: '不执行' }).click();
  await expect(frame.locator('#result')).toHaveText('没执行：用户没有同意');

  // 交给 AI：只填进对话框，不发送。
  await clickInPage(frame.locator('#ask'), () =>
    expect(page.locator('#prompt')).toHaveValue(/帮我写一句抖音的发布语/, { timeout: 2000 }),
  );
  await expect(page.locator('#prompt')).toHaveValue(/来自插件「假发布」的页面/);
  await page.screenshot({ path: test.info().outputPath('station-page.png') });
  expect(await page.content()).not.toContain('do-not-leak');

  // 切走再切回来（iframe 重新挂载）：页面一加载就发的请求照样有回应，执行请求照样弹确认。
  await page.locator('#prompt').fill('');
  await page.locator('.steps [data-tab="script"]').click();
  await expect(page.locator('.station-frame')).toHaveCount(0);
  await openPage(page, 'x:fake-publisher:dashboard');
  await expect(frame.locator('#title')).toHaveText(`假发布 · ${project.name}`);
  await expect(frame.locator('#receipt')).toHaveText('回执：https://example.invalid/douyin/1');
  await clickForConfirm(page, frame.locator('#send'), confirm);
  await confirm.getByRole('button', { name: '不执行' }).click();
  await expect(frame.locator('#result')).toHaveText('没执行：用户没有同意');

  // 嵌进发布页的小窗：经 onset.list 现读插件的账号列表，不用用户确认。
  await page.locator('[data-tab="publish"]').click();
  const slot = page.frameLocator('.station-slots[data-slot="publish"] .station-frame');
  await expect(slot.locator('#where')).toContainText('嵌在 publish');
  await expect(slot.locator('#accounts')).toHaveText('还没有账号');
  await expect(page.locator('.station-confirm')).toHaveCount(0);
  // 小窗排在发布页下面，不盖住发布页的内容（发布页曾被压扁、内容溢出到小窗上）。
  const overlap = await page.evaluate(() => {
    const tab = document.querySelector('.publish-tab');
    const slots = document.querySelector('.station-slots[data-slot="publish"]');
    if (!tab || !slots) return null;
    const contentBottom = Math.max(...[...tab.querySelectorAll('*')].map((el) => el.getBoundingClientRect().bottom));
    return contentBottom - slots.getBoundingClientRect().top;
  });
  expect(overlap).not.toBeNull();
  expect(overlap).toBeLessThanOrEqual(0);

  // 事件钩子：确认稿件审核关卡后自动跑插件的操作，设置里的密钥经 stdin 交给它。
  const json = { 'Content-Type': 'application/json' };
  await api(page, '/api/stations/fake-publisher/settings', {
    method: 'POST',
    body: JSON.stringify({ key: 'token', value: 'tok-e2e-secret' }),
    headers: json,
  });
  fs.writeFileSync(path.join(project.path, 'production', 'script-final.md'), '# 稿\n正文\n');
  await api(page, '/api/progress/gates/gate-script', { method: 'POST', body: '{}', headers: json });
  const log = path.join(project.path, 'production', 'publish', 'hooks.log');
  await expect.poll(() => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '')).toBe('gate.confirmed token=set\n');
  expect(await page.content()).not.toContain('tok-e2e-secret');

  // 斜杠命令：/fabu 打开插件页面（插件命令登记进补全在 Stations.test.tsx）。
  await page.locator('[data-tab="script"]').click();
  await page.locator('#prompt').fill('/fabu');
  await page.locator('#prompt').press('Enter');
  await expect(page.locator('.station-page:not(.station-slot) .station-page-bar')).toContainText('发布看板');
});

test('a plugin brings a new kind of project, a voice and a style library, and sends a message for the user', async ({
  page,
  project,
  sandbox,
}) => {
  installPlugin(sandbox, fake);
  // 先打开一个项目，让「保存到」默认落在测试用的临时 HOME 里。
  await openProject(page, project);

  // 设置页：它带来的东西都列出来。
  await page.locator('#settings-trigger').click();
  const dialog = page.locator('#settings-dialog');
  const card = dialog.locator('li[data-station="fake-publisher"]');
  await card.getByRole('button', { name: '详情与设置' }).click();
  const detail = page.getByRole('dialog', { name: '假发布 详情与设置' });
  const perms = detail.locator('.station-perms:not(.station-page-perms)');
  await expect(perms).toContainText('假配音');
  await expect(perms).toContainText('caption-kit');
  await expect(perms).toContainText('假风格库');
  await expect(perms).toContainText('往这几个阶段里加了说明：render');
  await expect(perms).toContainText('客户端开着时每 30 分钟');
  await expect(perms).toContainText('快剪');
  // 流程只在新建时定：已有项目没有「改用」的入口。
  await expect(detail.getByRole('button', { name: '这个项目改用它' })).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath('station-flow.png') });
  await detail.getByRole('button', { name: '关闭' }).click();
  // 插件的配音出现在「配音」的可选项里。
  await expect(
    dialog
      .locator('.settings-row[data-key="TTS_PROVIDER"]')
      .getByLabel('全局配音')
      .locator('option[value="x:fake-publisher"]'),
  ).toHaveCount(1);
  await dialog.getByRole('button', { name: '关闭' }).click();

  // 首页：选它带来的做法新建一个项目。
  await page.locator('.brand').click();
  await page.locator('#home-mode').click();
  await page.locator('.menu-item', { hasText: '快剪' }).click();
  await expect(page.locator('#home-mode')).toContainText('快剪');
  // 它的风格库在首页的整片风格里就能选到（还没有项目）。
  await page.locator('#home-style').click();
  await page.locator('.film-styles .fs-search').fill('水墨');
  await expect(page.locator('.film-styles .fs-item[data-style="x-fake-publisher/ink"]')).toBeVisible();
  await page.keyboard.press('Escape');
  await page.locator('#home-prompt').fill('插件做法的端到端测试');
  await page.locator('#home-send').click();
  await expect(page.locator('.creation')).toHaveCount(0, { timeout: 15_000 });
  await expect(page.locator('#title')).toContainText('插件做法的端到端测试');
  const created = (await api(page, '/api/projects')).body.projects.find((p) =>
    p.name.startsWith('插件做法的端到端测试'),
  );
  expect(JSON.parse(fs.readFileSync(path.join(created.path, 'onset.flow.json'), 'utf8')).production.id).toBe(
    'x:fake-publisher',
  );

  // 顶栏第一步是它的页面，路线是它的。
  await expect(page.locator('.steps [data-tab="x:fake-publisher:dashboard"]')).toBeVisible();
  await expect(page.locator('.steps [data-tab="script"]')).toHaveCount(0);
  const progress = await api(page, '/api/progress');
  expect(progress.body.mode).toBe('x:fake-publisher');
  expect(progress.body.stations.map((s) => s.id)).toEqual([
    'intake',
    'render',
    'assemble',
    'review',
    'gate-final',
    'auto-publish',
  ]);

  // 页面替用户发消息：先确认，确认后才进对话。
  await page.locator('.steps [data-tab="x:fake-publisher:dashboard"]').click();
  const frame = page.frameLocator('.station-page:not(.station-slot) .station-frame');
  await expect(frame.locator('#title')).toHaveText(/^假发布 · /);
  const confirm = page.locator('.station-confirm');
  await clickInPage(frame.locator('#send-msg'), () => expect(confirm).toBeVisible({ timeout: 2000 }));
  await expect(confirm).toContainText('「假发布」想替你发一条消息给 AI');
  await expect(confirm).toContainText('帮我把发布标题改短一点');
  await confirm.getByRole('button', { name: '执行', exact: true }).click();
  await expect(page.locator('#messages')).toContainText('帮我把发布标题改短一点');
});

// 顺带核对成片页的播放器地址只随成片文件自己变：插件操作写了别的文件、项目随之刷新，正在看的成片不能重新加载。
test('files a plugin op writes outside what it declared are shown as a warning', async ({ page, project, sandbox }) => {
  fs.writeFileSync(path.join(project.path, 'publish.md'), '---\nplatform: douyin\npublish_status: draft\n---\n');
  const film = path.join(project.path, 'final.mp4');
  execFileSync('ffmpeg', [
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    'color=c=gray:s=320x180:r=30:d=1',
    '-pix_fmt',
    'yuv420p',
    film,
  ]);
  installPlugin(sandbox, fake);
  await openProject(page, project);
  await page.locator('[data-tab="final"]').click();
  const video = page.locator('#panel .final-tab video');
  await expect(video).toHaveCount(1);
  const before = await video.getAttribute('src');

  // 在设置里点「顺手记一笔」：客户端等任务跑完后整个刷新项目（以前每次刷新都让成片重新加载）。
  const scribble = async (check) => {
    await page.locator('#settings-trigger').click();
    await page.locator('#settings-dialog').getByText('功能与插件').first().click();
    await page
      .locator('#settings-dialog li[data-station="fake-publisher"]')
      .getByRole('button', { name: '详情与设置' })
      .click();
    const detail = page.getByRole('dialog', { name: '假发布 详情与设置' });
    await expect(detail.locator('.plugin-list[data-op="accounts"]')).toContainText('还没有。');
    const done = (await api(page, '/api/tasks')).body.tasks.filter((t) => t.status === 'succeeded').length;
    const action = detail.locator('.station-op[data-op="scribble"]');
    await action.getByRole('button', { name: '顺手记一笔' }).click();
    // 等全部任务跑完（打开弹窗时自动刷新的账号列表也算一个），且成功的比点之前多。
    await expect
      .poll(
        async () => {
          const tasks = (await api(page, '/api/tasks')).body.tasks;
          return (
            !tasks.some((t) => t.status === 'running' || t.status === 'queued') &&
            tasks.filter((t) => t.status === 'succeeded').length > done
          );
        },
        { timeout: 15000 },
      )
      .toBe(true);
    if (check) await check(action);
    await detail.getByRole('button', { name: '关闭' }).click();
    await page.locator('#settings-dialog').getByRole('button', { name: '关闭' }).click();
    // 任务结束后的那次刷新要先落下来：客户端每两秒查一次任务，看到结束就刷新项目。
    await page.waitForTimeout(4000);
  };

  // 假发布顺手写了 notes/scribble.txt（清单只声明了 production/publish/）。
  await scribble(async (action) => {
    const warning = action.locator('.station-scope');
    await expect(warning).toContainText('它改了 1 个没声明会写的文件');
    await expect(warning).toContainText('notes/scribble.txt');
    await expect(warning).not.toContainText('production/publish/scribble.json');
    await expect(action.locator('.station-last')).toHaveText('上次执行成功');
    await page.screenshot({ path: test.info().outputPath('station-scope-settings.png') });
  });
  expect(fs.existsSync(path.join(project.path, 'notes', 'scribble.txt'))).toBe(true);
  expect(await video.getAttribute('src')).toBe(before);
  // 任务列表里同样标出来。
  await page.locator('#tasks-toggle').click();
  await expect(page.locator('#tasks .task-warning').first()).toContainText(
    '插件「假发布」改了它没有声明会写的项目文件：notes/scribble.txt',
  );
  await page.locator('#tasks-toggle').click();
  await page.screenshot({ path: test.info().outputPath('station-scope-publish.png') });

  // 成片真的换了：地址跟着变。
  const later = new Date(Date.now() + 60_000);
  fs.utimesSync(film, later, later);
  await scribble();
  await expect.poll(() => video.getAttribute('src')).not.toBe(before);

  // 插件页面的 onset.run()：用户点「执行」后，回执处（宿主那一侧）标出越界的文件。
  fs.rmSync(path.join(project.path, 'notes'), { recursive: true, force: true });
  await openPage(page, 'x:fake-publisher:dashboard');
  const host = page.locator('.station-page');
  const frame = page.frameLocator('.station-frame');
  await expect(frame.locator('#title')).toHaveText(`假发布 · ${project.name}`);
  await expect(host.locator('.station-scope')).toHaveCount(0);
  // 用户在插件页面里亲手点的执行按钮：那一下就是同意，不再弹确认条，直接执行。
  // 先等过 5 秒：刚在片场里点过（上面切页）时分不清点在哪，会照旧确认。
  await page.waitForTimeout(5500);
  await expect(async () => {
    await frame.locator('#scribble').click();
    await expect(frame.locator('#result')).toHaveText('已开始', { timeout: 2000 });
  }).toPass({ timeout: 20_000 });
  await expect(host.locator('.station-confirm')).toHaveCount(0);
  await expect(host.locator('.station-scope')).toContainText('「假发布」执行「顺手记一笔」');
  await expect(host.locator('.station-scope')).toContainText('notes/scribble.txt');
  await page.screenshot({ path: test.info().outputPath('station-scope-page.png') });
});
