/**
 * 实验功能「目录名末尾补【RJ号】」（server/refill-rj.mjs）。
 *
 * 覆盖：
 *   1) planRefill 的裁决：精确命中 / 宽松命中 / 同名多义 / 社团消歧 / 各种如实跳过
 *   2) applyRefill 的端到端：真实重命名 → 旧记录删除 → 按新路径重扫入库，
 *      并且主链路（locateRelease → dlsite 补齐）自动把 rj_code / 社团 / 声优填回来
 * 索引用与真实文件同构的小库，音乐库与数据目录都是临时目录。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lam-refill-'));
const dataDir = path.join(root, 'data');
const asmrLib = path.join(root, 'Music', 'ASMR');
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(asmrLib, { recursive: true });

/* 造一份与真实索引同构的小库 */
const indexFile = path.join(root, 'rj_index.sqlite3');
{
  const db = new DatabaseSync(indexFile);
  db.exec(`
    CREATE TABLE works (
      rj TEXT PRIMARY KEY,
      circle TEXT,
      voice_actors TEXT,
      voice_actor_text TEXT,
      title TEXT,
      release_date TEXT,
      updated_at TEXT
    );
  `);
  const ins = db.prepare('INSERT INTO works (rj, circle, voice_actors, title, release_date) VALUES (?, ?, ?, ?, ?)');
  ins.run('RJ01010101', '唯一社', '["声优甲"]', '唯一命中作品', '2024-01-01');
  ins.run('RJ02020202', '甲社团', '["声优乙"]', '重名作品', '');
  ins.run('RJ03030303', '乙社团', '["声优丙"]', '重名作品', '');
  ins.run('RJ04040404', '标点社', '[]', '带【装饰】作品（バイノーラル）', '');
  ins.run('RJ05050505', '已存在社', '[]', '撞名作品', '');
  db.close();
}

process.env.LAM_DATA_DIR = dataDir;
process.env.LUNA_DLSITE_INDEX = indexFile;

const store = await import('../server/db.mjs');
const dlsite = await import('../server/dlsite.mjs');
const refill = await import('../server/refill-rj.mjs');

// plan 只认「已注册音乐库之下」的目录，先把 ASMR 库注册上
store.addLibrary(asmrLib);

/** 造一个发行目录 + 对应专辑行；withAudio 用于要真正重扫入库的端到端用例 */
function makeAlbum({ folder, title = null, circle = null, withAudio = false }) {
  const dir = path.join(asmrLib, folder);
  fs.mkdirSync(dir, { recursive: true });
  if (withAudio) fs.writeFileSync(path.join(dir, '01 本篇.mp3'), Buffer.from('fake-audio'.repeat(30)));
  const id = store.upsertVoiceAlbum({ releaseRoot: dir, title });
  if (circle) store.setAlbumCircle(id, circle);
  return { id, dir };
}

/* ------------------------------------------------------------------ plan */

test('plan：专辑标题精确命中唯一作品 → 生成候选（原名 + 【RJ号】）', () => {
  const { id, dir } = makeAlbum({ folder: '目录一号', title: '唯一命中作品' });
  const item = refill.planRefill().items.find((it) => it.album_id === id);
  assert.ok(item, '精确命中的专辑必须进候选');
  assert.equal(item.rj, 'RJ01010101');
  assert.equal(item.old_path, dir);
  assert.equal(item.new_path, `${dir}【RJ01010101】`);
  assert.match(item.how, /^按标题/);
});

test('plan：同名多作品且没填社团 → 进人工确认区，候选给全（不只挑一个）', () => {
  const { id } = makeAlbum({ folder: '目录二号', title: '重名作品' });
  const rv = refill.planRefill().review.find((it) => it.album_id === id);
  assert.ok(rv, '歧义必须进确认区而不是丢弃');
  assert.equal(rv.candidates.length, 2);
  assert.deepEqual(rv.candidates.map((c) => c.rj).sort(), ['RJ02020202', 'RJ03030303']);
  assert.ok(!refill.planRefill().skipped.some((it) => it.album_id === id));
});

test('plan：同名多作品 + 社团消歧成功 → 候选并标注命中方式', () => {
  const { id } = makeAlbum({ folder: '目录三号', title: '重名作品', circle: '乙社团' });
  const item = refill.planRefill().items.find((it) => it.album_id === id);
  assert.ok(item);
  assert.equal(item.rj, 'RJ03030303');
  assert.match(item.how, /社团/);
});

test('plan：括号标点差异走宽松键命中', () => {
  // 索引标题「带【装饰】作品（バイノーラル）」：精确键不等（括号内容还在），宽松键相等
  const { id } = makeAlbum({ folder: '目录四号', title: '带【装饰】作品-バイノーラル' });
  const item = refill.planRefill().items.find((it) => it.album_id === id);
  assert.ok(item, '宽松键应当命中');
  assert.equal(item.rj, 'RJ04040404');
  assert.match(item.how, /宽松/);
});

test('plan：目录名已有 RJ / 虚拟路径 / 目录不存在 / 库根 / 目标撞名 → 各按原因跳过', () => {
  const inName = makeAlbum({ folder: '作品 RJ123218', title: '唯一命中作品' });
  // 虚拟路径（压缩包成员形态）：分隔符 0x01
  const virtualId = store.upsertVoiceAlbum({
    releaseRoot: `${path.join(asmrLib, '包.zip')}\u0001sub`, title: '唯一命中作品',
  });
  const goneId = store.upsertVoiceAlbum({
    releaseRoot: path.join(asmrLib, '已经不存在的目录'), title: '唯一命中作品',
  });
  const libRootId = store.upsertVoiceAlbum({ releaseRoot: asmrLib, title: '唯一命中作品' });
  const clash = makeAlbum({ folder: '撞名作品', title: '撞名作品' });
  fs.mkdirSync(`${clash.dir}【RJ05050505】`, { recursive: true });

  const reasons = new Map(refill.planRefill().skipped.map((it) => [it.album_id, it.reason]));
  assert.match(reasons.get(inName.id), /已经有 RJ 号/);
  assert.match(reasons.get(virtualId), /压缩包|虚拟路径/);
  assert.match(reasons.get(goneId), /目录已不存在/);
  assert.ok(reasons.has(libRootId), '库根本身不许动');
  assert.match(reasons.get(clash.id), /目标目录名已存在/);
});

test('plan：不在已注册音乐库之下的目录不许动', () => {
  const dir = path.join(root, 'Music', 'Elsewhere', '散养作品');
  fs.mkdirSync(dir, { recursive: true });
  const id = store.upsertVoiceAlbum({ releaseRoot: dir, title: '唯一命中作品' });
  const skipped = refill.planRefill().skipped.find((it) => it.album_id === id);
  assert.ok(skipped, '库外目录必须被拦下');
  assert.match(skipped.reason, /音乐库/);
});

test('plan：标题差几个字符 → 进确认区给近似候选（前几名，按相似度）', () => {
  // 索引里是「带【装饰】作品（バイノーラル）」，这里少了尾缀、括号也不同 → 精确/宽松都不等
  const { id } = makeAlbum({ folder: '近似作品', title: '带装饰作品バイノー' });
  const rv = refill.planRefill().review.find((it) => it.album_id === id);
  assert.ok(rv, '查不到精确名但应有近似候选，进确认区');
  assert.ok(rv.candidates.length >= 1);
  assert.equal(rv.candidates[0].rj, 'RJ04040404');
  assert.ok(rv.candidates[0].score < 1, '近似的相似度应小于 1');
  assert.ok(!refill.planRefill().items.some((it) => it.album_id === id), '近似绝不自动进 items');
});

test('apply：只点选确认区里的合法候选才改名；不在最新候选里的选择被拒', async () => {
  const { id, dir } = makeAlbum({ folder: '点选作品', title: '带装饰作品バイノー', withAudio: true });
  const rv = refill.planRefill().review.find((it) => it.album_id === id);
  assert.ok(rv);

  // 先试一个不在候选里的 RJ（模拟陈旧/篡改）→ 应落空，不动盘
  const bad = await refill.applyRefill([id], { choices: { [id]: 'RJ99999999' } });
  assert.equal(bad.queued, 1);
  await refill.awaitRefillIdle();
  const badJob = store.db.prepare('SELECT * FROM write_jobs WHERE id = ?').get(bad.jobId);
  assert.equal(badJob.succeeded, 0);
  assert.equal(badJob.failed, 1);
  const badItem = store.db.prepare('SELECT * FROM write_job_items WHERE job_id = ?').get(bad.jobId);
  assert.match(badItem.error, /不在最新候选/);
  assert.ok(fs.existsSync(dir), '非法选择不能改名');

  // 用候选里真实的第一名 → 成功，payload 的 how 标注人工确认
  const chosen = rv.candidates[0].rj;
  const ok = await refill.applyRefill([id], { choices: { [id]: chosen } });
  assert.equal(ok.queued, 1);
  await refill.awaitRefillIdle();
  const okJob = store.db.prepare('SELECT * FROM write_jobs WHERE id = ?').get(ok.jobId);
  assert.equal(okJob.succeeded, 1);
  assert.match(JSON.parse(okJob.payload_json).items[0].how, /人工确认/);
  assert.ok(fs.existsSync(`${dir}【${chosen}】`));
});

test('apply：后台任务可观察——返回即执行中，awaitRefillIdle 后完成', async () => {
  const { id } = makeAlbum({ folder: '进度作品', title: '唯一命中作品', withAudio: true });
  assert.equal(refill.isApplying(), false);
  const res = await refill.applyRefill([id]);
  assert.ok(Number.isInteger(res.jobId));
  assert.equal(res.queued, 1);
  assert.equal(refill.isApplying(), true, '返回后任务应在后台继续执行');
  await refill.awaitRefillIdle();
  assert.equal(refill.isApplying(), false);
  const job = store.db.prepare('SELECT * FROM write_jobs WHERE id = ?').get(res.jobId);
  assert.equal(job.status, 'done');
  assert.equal(job.succeeded, 1);
});

test('索引缺失时 plan 如实报告、不抛错', () => {
  const saved = process.env.LUNA_DLSITE_INDEX;
  process.env.LUNA_DLSITE_INDEX = path.join(root, '没有这个文件.sqlite3');
  dlsite.resetIndexCache();
  try {
    const plan = refill.planRefill();
    assert.equal(plan.index.available, false);
    assert.equal(plan.items.length, 0);
  } finally {
    process.env.LUNA_DLSITE_INDEX = saved;
    dlsite.resetIndexCache();
  }
});

/* ----------------------------------------------------------------- apply */

test('plan：可按音乐库过滤——只列所选库之下的发行', () => {
  const lib2 = path.join(root, 'Music', 'ASMR2');
  fs.mkdirSync(lib2, { recursive: true });
  store.addLibrary(lib2);
  const inLib2 = path.join(lib2, '选库作品');
  fs.mkdirSync(inLib2, { recursive: true });
  const otherId = store.upsertVoiceAlbum({ releaseRoot: inLib2, title: '唯一命中作品' });
  const lib1Id = store.findLibraryByPath(asmrLib).id;

  const all = refill.planRefill();
  assert.ok(all.items.some((it) => it.album_id === otherId), '全选时应包含两个库的候选');

  const only1 = refill.planRefill({ libraryId: lib1Id });
  assert.ok(!only1.items.some((it) => it.album_id === otherId), '选库一不该看到库二的候选');
  const only2 = refill.planRefill({ libraryId: store.findLibraryByPath(lib2).id });
  assert.ok(only2.items.some((it) => it.album_id === otherId), '选库二应看到自己的候选');
});

test('apply：重命名目录 → 旧记录删除 → 重扫后按路径识别出 RJ 并由索引补齐社团/声优', async () => {
  const { id, dir } = makeAlbum({ folder: '端到端作品', title: '唯一命中作品', withAudio: true });
  const item = refill.planRefill().items.find((it) => it.album_id === id);
  assert.ok(item);

  const res = await refill.applyRefill([id]);
  assert.equal(res.queued, 1);
  await refill.awaitRefillIdle();
  const job = store.db.prepare('SELECT * FROM write_jobs WHERE id = ?').get(res.jobId);
  assert.equal(job.status, 'done');
  assert.equal(job.succeeded, 1);
  assert.equal(job.failed, 0);
  assert.ok(Number.isInteger(res.jobId), '应登记写任务');

  // 磁盘：旧名消失、新名存在
  assert.ok(!fs.existsSync(dir), '旧目录名应当不存在了');
  const newPath = `${dir}【RJ01010101】`;
  assert.ok(fs.existsSync(newPath), '新目录名应当存在');

  // 库：旧专辑行整块删除（用户拍板的破坏性语义）
  assert.equal(store.getAlbumById(id), null, '旧记录应当被删除');

  // 主链路重建：新路径里有 RJ → locateRelease 认出 → dlsite 按索引补齐
  const rebuilt = store.findVoiceAlbum(newPath);
  assert.ok(rebuilt, '重扫后应当按新路径重建专辑');
  assert.equal(rebuilt.rj_code, 'RJ01010101');
  assert.equal(rebuilt.circle, '唯一社');
  assert.equal(rebuilt.album_artist, '声优甲');
  assert.equal(rebuilt.kind, 'voice');
});

test('apply：写任务落进 write_jobs，撤销后目录名还原、索引重建、状态 undone', async () => {
  const { id, dir } = makeAlbum({ folder: '可撤销作品', title: '带【装饰】作品-バイノーラル', withAudio: true });
  const res = await refill.applyRefill([id]);
  assert.equal(res.queued, 1);
  await refill.awaitRefillIdle();
  const newPath = `${dir}【RJ04040404】`;

  // 写操作记录：type、状态、条目「新路径 + backup_file=旧路径」
  const job = store.db.prepare('SELECT * FROM write_jobs WHERE id = ?').get(res.jobId);
  assert.equal(job.type, 'rj_refill');
  assert.equal(job.status, 'done');
  assert.equal(job.succeeded, 1);
  const jobItem = store.db.prepare('SELECT * FROM write_job_items WHERE job_id = ?').get(res.jobId);
  assert.equal(jobItem.path, newPath);
  assert.equal(jobItem.backup_file, dir);
  assert.equal(jobItem.status, 'done');

  // 撤销：目录名还原 + 按原路径重建（原路径没有 RJ → rj_code 回到空，功能可再跑）
  const undo = await refill.undoRefillJob(res.jobId);
  assert.equal(undo.restored, 1, `撤销应成功：${JSON.stringify(undo)}`);
  assert.ok(!fs.existsSync(newPath), '新目录名应当改回去了');
  assert.ok(fs.existsSync(dir), '原目录名应当恢复');
  const undoneAlbum = store.findVoiceAlbum(dir);
  assert.ok(undoneAlbum, '撤销后应按原路径重建索引');
  assert.equal(undoneAlbum.rj_code, null, '原目录名没有 RJ，识别回到原点');
  assert.equal(store.db.prepare('SELECT status FROM write_jobs WHERE id = ?').get(res.jobId).status, 'undone');

  // 已撤销的任务不能二次撤销
  await assert.rejects(() => refill.undoRefillJob(res.jobId), /已撤销/);
});

test('apply：不在候选里的 id 不会被动盘', async () => {
  const { dir } = makeAlbum({ folder: '没在候选里', title: '索引里没有这个标题' });
  const plan = refill.planRefill();
  const notPlanned = plan.skipped.find((it) => it.folder === '没在候选里');
  assert.ok(notPlanned, '查不到的应当只进 skipped');
  const res = await refill.applyRefill([notPlanned.album_id]);
  assert.equal(res.jobId, null, '没做任何事就不该登记写任务');
  assert.equal(res.queued, 0);
  assert.ok(fs.existsSync(dir), '磁盘目录必须原样保留');
});

test('撤销落空：原路径已有同名目录时绝不覆盖', async () => {
  const { id, dir } = makeAlbum({ folder: '撞车作品', title: '唯一命中作品', withAudio: true });
  const res = await refill.applyRefill([id]);
  assert.equal(res.queued, 1);
  await refill.awaitRefillIdle();
  const newPath = `${dir}【RJ01010101】`;
  // 用户在原路径放了新东西（比如手工解包了另一份）
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '别人的文件.mp3'), Buffer.from('keep-me'));

  const undo = refill.undoRefillJob(res.jobId);
  await assert.rejects(() => undo, /没有可还原/);
  assert.ok(fs.existsSync(newPath), '新目录不该被动');
  assert.equal(fs.readFileSync(path.join(dir, '别人的文件.mp3'), 'utf8'), 'keep-me', '用户的东西不许碰');
  assert.equal(store.db.prepare('SELECT status FROM write_jobs WHERE id = ?').get(res.jobId).status, 'done',
    '全部落空时任务保持可撤销，清障后还能再试');
  assert.match(store.db.prepare("SELECT error FROM write_job_items WHERE job_id = ?").get(res.jobId).error, /原路径已有同名目录/);
});
