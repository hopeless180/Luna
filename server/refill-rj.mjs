/**
 * 实验功能：给缺 RJ 号的音声目录在**目录名末尾**补【RJ号】。
 * 入口在「统计 → 数据安全」的按钮行（public/app.js 的 refillRjBtn），可按库选择。
 *
 * 流程（两步，先只读预览、再写盘）：
 *   1. planRefill({libraryId}) —— 遍历库里「rj_code 为空」的音声发行（可按库过滤），
 *      拿**专辑标题**与**目录名**去 DLsite 索引反查（dlsite.findWorksByTitle：精确→宽松）。
 *      唯一命中、或多命中里能用社团消歧到唯一的才进候选；
 *      查不到 / 无法唯一定 / 重名 / 过长，一律带原因进 skipped，**不猜**。
 *   2. applyRefill(ids) —— 按用户拍板的「破坏性」语义执行：
 *      目录 `原名` 重命名为 `原名【RJxxxxxxx】` → 旧专辑的入库记录**直接删除**
 *      （标签、收藏不迁移，这是本实验功能明示的代价）→ 用新路径走现成的
 *      rescanReleaseRoot 重新入库。新目录名里有 RJ，locateRelease 主链路照常识别，
 *      applyDlsiteMetadata 随即按索引补社团/声优/标签 —— 主流程代码零改动。
 *
 * 全程登记为一条 `write_jobs`（type='rj_refill'）：`write_job_items.path` 存**新路径**、
 * `backup_file` 存**旧路径**（与文件写回的「目标/备份」语义同形），统计页
 * 「写操作记录」里给出「撤销」按钮；撤销 = 反向改名 + 删新记录 + 按原路径重建
 * （undoRefillJob，由 /api/jobs/:id/undo 按类型分流）。撤销只能还原**目录名**，
 * apply 时删掉的标签/收藏不会回来 —— 这本来就是该实验功能声明的代价。
 *
 * 边界：只动**目录型**发行根（压缩包/虚拟路径跳过）；只动注册音乐库之下、
 * 不碰库根本身；单条失败如实报告，不影响其它条目。
 */
import fs from 'node:fs';
import path from 'node:path';

import { db } from './db.mjs';
import * as store from './db.mjs';
import * as dlsite from './dlsite.mjs';
import { isWriting } from './write-jobs.mjs';
import { isScanning, rescanReleaseRoot } from './scanner.mjs';

export const JOB_TYPE = 'rj_refill';

const RJ_IN_NAME = /RJ\s*\d{6,8}/i;
/** Windows MAX_PATH=260，重命名会追加约 12 个字符，给长路径留出安全余量 */
const MAX_NEW_PATH = 250;

const now = () => Date.now();

/** root 必须严格位于某个已注册音乐库之下（库根本身不许动）；返回所属库 */
function libraryOwning(root, libraries) {
  const target = path.resolve(root).toLowerCase();
  for (const lib of libraries) {
    const base = path.resolve(lib.path).toLowerCase();
    if (target !== base && target.startsWith(base + path.sep)) return lib;
  }
  return null;
}

/**
 * 为一张音声发行找到**能唯一确定**的索引作品。
 * 依次试专辑标题、目录名；多个候选时先用社团消歧。
 * @returns {{ok:true, work:object, how:string}|{ok:false, ambiguous?:boolean, works?:object[], reason:string}}
 */
function resolveWork({ title, folder, circle }) {
  const want = String(circle ?? '').trim().toLowerCase();
  let ambiguity = null;
  for (const probe of [title, folder]) {
    const text = String(probe ?? '').trim();
    if (!text) continue;
    const found = dlsite.findWorksByTitle(text);
    if (!found.matches.length) continue;
    if (found.matches.length === 1) {
      return { ok: true, work: found.matches[0], how: found.how === 'exact' ? '按标题精确命中' : '按标题宽松命中' };
    }
    const picked = want
      ? found.matches.filter((w) => String(w.circle ?? '').trim().toLowerCase() === want)
      : [];
    if (picked.length === 1) {
      return { ok: true, work: picked[0], how: found.how === 'exact' ? '按标题+社团命中' : '按宽松标题+社团命中' };
    }
    // 同名多作品、社团也定不了 → 全部端出来让人挑（这本身就是「几个几乎接近的」）
    ambiguity = { works: found.matches, reason: '同名作品不止一个：由你按社团辨认' };
  }
  return ambiguity
    ? { ok: false, ambiguous: true, works: ambiguity.works, reason: ambiguity.reason }
    : { ok: false, reason: '索引里查不到同名作品' };
}

/**
 * 只读预览：算出哪些目录能安全补号、哪些被跳过以及为什么。
 * @param {{libraryId?:number|null}} opts 给了 libraryId 就只看该库之下的发行
 */
export function planRefill({ libraryId = null } = {}) {
  const index = dlsite.indexInfo();
  if (!index.available) {
    return { index, checked: 0, items: [], review: [], skipped: [{ reason: '没有可用的 DLsite 索引文件' }] };
  }
  const wantedLib = libraryId ? store.getLibrary(libraryId) : null;
  const rows = store.listVoiceAlbumsMissingRj();
  const libraries = store.listLibraries();
  const items = [];
  const review = [];
  const skipped = [];
  const note = (album, reason, extra = {}) => skipped.push({
    album_id: album.id,
    folder: path.basename(String(album.release_root ?? '')) || String(album.title ?? album.id),
    reason,
    old_path: String(album.release_root ?? '') || null,
    ...extra,
  });
  let checked = 0;

  for (const album of rows) {
    const root = String(album.release_root ?? '').trim();
    // 选库模式：不在所选库里的发行**不进清单**（也不算跳过，免得刷屏）
    if (wantedLib && !(root && !root.includes('\u0001') && !root.includes('\u0000')
      && path.resolve(root).toLowerCase().startsWith(path.resolve(wantedLib.path).toLowerCase() + path.sep))) {
      continue;
    }
    checked += 1;

    if (!root || root.includes('\u0001') || root.includes('\u0000')) { note(album, '压缩包/虚拟路径，暂只支持目录'); continue; }
    let stat = null;
    try { stat = fs.statSync(root); } catch { /* 目录不存在，走下面分支 */ }
    if (!stat) { note(album, '目录已不存在'); continue; }
    if (!stat.isDirectory()) { note(album, '不是目录'); continue; }
    const folder = path.basename(root);
    if (RJ_IN_NAME.test(folder)) { note(album, '目录名里已经有 RJ 号'); continue; }
    const owner = libraryOwning(root, libraries);
    if (!owner) { note(album, '不在任何已注册音乐库之下（库根不动）'); continue; }

    const hit = resolveWork({ title: album.title, folder, circle: album.circle });
    if (!hit.ok) {
      // 没有能自动拍板的结果 → 交人工确认区：同名歧义给**全部**同名，查不到给**几个**近似候选
      const candidates = hit.ambiguous
        ? hit.works.map((w) => ({ rj: w.rj, circle: w.circle, title: w.title, score: 1 }))
        : nearCandidates({ title: album.title, folder });
      if (!candidates.length) { note(album, hit.reason); continue; }
      review.push({
        album_id: album.id,
        folder,
        title: String(album.title ?? '').trim() || null,
        library_id: owner.id,
        old_path: root,
        hint: hit.reason,
        candidates,
      });
      continue;
    }

    const newPath = `${root}【${hit.work.rj}】`;
    let clash = false;
    try { clash = fs.existsSync(newPath); } catch { clash = true; }
    if (clash) { note(album, `目标目录名已存在（${hit.work.rj}）`, { new_path: newPath }); continue; }
    if (newPath.length > MAX_NEW_PATH) { note(album, `重命名后路径过长（${newPath.length} 字符）`, { new_path: newPath }); continue; }

    items.push({
      album_id: album.id,
      folder,
      rj: hit.work.rj,
      how: hit.how,
      work_title: hit.work.title ?? null,
      work_circle: hit.work.circle ?? null,
      library_id: owner.id,
      old_path: root,
      new_path: newPath,
    });
  }
  return { index, checked, items, review, skipped };
}

/**
 * 近似候选（标题与目录名两路探测、按 RJ 合并取最高分），供**人工确认区**展示。
 * 只给候选；选谁（或都不选）由用户决定，apply 端还会对着新计算的候选再校验一次。
 */
function nearCandidates({ title, folder }) {
  const byRj = new Map();
  for (const probe of [title, folder]) {
    const text = String(probe ?? '').trim();
    if (!text) continue;
    for (const c of dlsite.searchNearWorks(text, { limit: 5 }).matches) {
      const cur = byRj.get(c.rj);
      if (!cur || c.score > cur.score) byRj.set(c.rj, c);
    }
  }
  return [...byRj.values()].sort((a, b) => b.score - a.score).slice(0, 5);
}

/* ---------------------------------------------------- 执行（后台任务，可看进度） */

/*
 * apply 不再一口气跑完再返回：建好任务与条目（全部 pending）后**立即返回 jobId**，
 * 后台逐条把条目推进 pending → running → done/failed（write_jobs.succeeded/failed 同步刷新），
 * 前端轮询 /api/jobs/:id 就能看到「等待中 / 正在修改 / 完成 / 失败」的实时进度。
 */

let applying = false;
let applyPromise = null;
let cancelRequested = false;

export function isApplying() { return applying; }

/** 请求停止当前补全：当前这条处理完就停，未开始的条目记为「已停止（未执行）」 */
export function cancelRefill() {
  if (!applying) return false;
  cancelRequested = true;
  return true;
}

/** 等当前补全任务跑完（测试与维护用） */
export function awaitRefillIdle() { return applyPromise ?? Promise.resolve(); }

/** 单条重建的超时保护：改名已完成但重建卡住时,不能让整条任务无限期挂着 */
const REBUILD_TIMEOUT_MS = 15000;

function withTimeout(promise, ms) {
  let timer = null;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`索引重建超时（${Math.round(ms / 1000)} 秒）`)), ms);
    }),
  ]).finally(() => { if (timer) clearTimeout(timer); });
}

/**
 * 执行重命名（破坏性，用户已确认）：登记写任务 → 后台逐条 改名 → 删旧记录 → 按新路径重扫入库。
 * `albumIds` 必须来自**同一批预览**；这里会重新 plan 一次再按 id 过滤，
 * 磁盘或索引在预览后变了的话，对不上的条目自动落空，绝不按陈旧预览硬改。
 * `choices`（{album_id: rj}）来自近似候选的人工点选：服务端拿**刚算出的候选**核对，
 * rj 不在候选里的条目直接落空——陈旧或被篡改的选择绝不会被用来改名。
 */
export async function applyRefill(albumIds, { libraryId = null, choices = {} } = {}) {
  if (isScanning()) throw new Error('扫描正在进行，请先结束扫描再执行回填');
  if (isWriting()) throw new Error('正在写回文件，请等写入结束后再执行回填');
  if (applying) throw new Error('已有一次补全正在执行，请等它结束');
  const wanted = new Set((albumIds ?? []).map(Number).filter(Number.isFinite));
  const fresh = planRefill({ libraryId });
  const plan = fresh.items.filter((it) => wanted.has(it.album_id));

  // 人工确认区：id 在 wanted 里且带合法选择才算数
  const chosenFailed = [];
  const picked = new Map();
  for (const rv of fresh.review) {
    if (!wanted.has(rv.album_id)) continue;
    const rj = dlsite.normalizeRj(choices?.[rv.album_id] ?? choices?.[String(rv.album_id)]);
    if (!rj) continue; // 没选 = 跳过，不算失败
    const cand = rv.candidates.find((c) => c.rj === rj);
    if (!cand) {
      chosenFailed.push({ album_id: rv.album_id, folder: rv.folder, rj, reason: '该 RJ 号不在最新候选里（索引或磁盘变了？请重新匹配）' });
      continue;
    }
    const newPath = `${rv.old_path}【${rj}】`;
    let clash = false;
    try { clash = fs.existsSync(newPath); } catch { clash = true; }
    if (clash) { chosenFailed.push({ album_id: rv.album_id, folder: rv.folder, rj, reason: '目标目录名已存在' }); continue; }
    if (newPath.length > MAX_NEW_PATH) { chosenFailed.push({ album_id: rv.album_id, folder: rv.folder, rj, reason: `重命名后路径过长（${newPath.length} 字符）` }); continue; }
    picked.set(rv.album_id, {
      album_id: rv.album_id,
      folder: rv.folder,
      rj,
      how: cand.score >= 1
        ? '同名多作品·人工按社团确认'
        : `近似候选·人工确认（${Math.round(cand.score * 100)}%）`,
      work_title: cand.title,
      work_circle: cand.circle,
      library_id: rv.library_id,
      old_path: rv.old_path,
      new_path: newPath,
    });
  }
  // 自动候选 + 人工确认候选合并（同一专辑两者只会有一种）；校验失败的也进进度表（直接标失败）
  const entries = [...plan, ...picked.values()].map((it) => ({ ...it, presetError: null }));
  for (const f of chosenFailed) {
    entries.push({
      album_id: f.album_id, folder: f.folder, rj: f.rj, how: '人工确认候选校验失败',
      work_title: null, work_circle: null, library_id: null,
      old_path: null, new_path: null, presetError: f.reason,
    });
  }
  if (!entries.length) return { jobId: null, queued: 0 };

  const jobInfo = db.prepare(`
    INSERT INTO write_jobs (type, status, payload_json, total, created_at)
    VALUES (?, 'running', ?, ?, ?)
  `).run(JOB_TYPE, JSON.stringify({ items: entries }), entries.length, now());
  const jobId = Number(jobInfo.lastInsertRowid);
  const insItem = db.prepare(`
    INSERT INTO write_job_items (job_id, track_id, path, status) VALUES (?, NULL, ?, 'pending')
  `);
  // 条目顺序 = payload.items 顺序；撤销时按同一顺序对照 payload.items 取 library_id
  const itemIds = entries.map((e) => Number(
    insItem.run(jobId, e.new_path ?? e.folder ?? String(e.album_id)).lastInsertRowid,
  ));

  applying = true;
  cancelRequested = false;
  applyPromise = processRefillJob(jobId, entries, itemIds)
    .catch((err) => {
      db.prepare("UPDATE write_jobs SET status = 'failed', finished_at = ?, error = ? WHERE id = ?")
        .run(now(), String(err.message ?? err), jobId);
    })
    .finally(() => {
      applying = false;
      applyPromise = null;
    });
  return { jobId, queued: entries.length };
}

/** 后台逐条推进任务；每一步都落库，前端轮询即可看到进度 */
async function processRefillJob(jobId, entries, itemIds) {
  const item = db.prepare('UPDATE write_job_items SET status = ?, error = ?, backup_file = ? WHERE id = ?');
  const counts = db.prepare('UPDATE write_jobs SET status = ?, succeeded = ?, skipped = ?, failed = ? WHERE id = ?');
  let ok = 0;
  let bad = 0;
  let skipped = 0;
  for (let i = 0; i < entries.length; i += 1) {
    const it = entries[i];
    if (cancelRequested) {
      skipped += 1;
      item.run('skipped', '已停止（未执行）', null, itemIds[i]);
      counts.run('running', ok, skipped, bad, jobId);
      continue;
    }
    if (it.presetError) {
      bad += 1;
      item.run('failed', it.presetError, null, itemIds[i]);
      counts.run('running', ok, skipped, bad, jobId);
      continue;
    }
    item.run('running', null, null, itemIds[i]);
    try {
      fs.renameSync(it.old_path, it.new_path);
    } catch (err) {
      const reason = (err.code === 'EPERM' || err.code === 'EBUSY')
        ? '目录被占用或没有权限（正在播放或资源管理器打开了它？）'
        : `${err.code ?? '错误'}：${err.message}`;
      bad += 1;
      item.run('failed', reason, null, itemIds[i]);
      counts.run('running', ok, skipped, bad, jobId);
      continue;
    }
    // 改名成功即刻算完成（磁盘上的名字已经变了），先落「还原点」与成功计数
    ok += 1;
    item.run('done', null, it.old_path, itemIds[i]);
    counts.run('running', ok, skipped, bad, jobId);
    // 重建索引是**改名之后**的事：带超时，卡住也只在本条留警告，绝不无限挂起整条任务
    try {
      store.deleteAlbumDeep(it.album_id);
      await withTimeout(
        rescanReleaseRoot({ releaseRoot: it.new_path, libraryId: it.library_id }),
        REBUILD_TIMEOUT_MS,
      );
    } catch (err) {
      item.run('done', `索引重建未完成：${err.message}（下次扫描会自动补上）`, it.old_path, itemIds[i]);
    }
  }
  db.prepare(`
    UPDATE write_jobs SET status = 'done', finished_at = ?, succeeded = ?, skipped = ?, failed = ?
    WHERE id = ?
  `).run(now(), ok, skipped, bad, jobId);
}

/**
 * 撤销一条补号写任务：反向改名 + 删新路径的记录 + 按原路径重建。
 * 只还原目录名；apply 时删掉的标签/收藏不会回来。
 * 「新路径已经不在了 / 原路径又被占了」一律如实失败，绝不覆盖用户后来的改动。
 */
export async function undoRefillJob(jobId) {
  if (isScanning()) throw new Error('扫描正在进行，请先结束扫描');
  if (isWriting()) throw new Error('正在写回文件，请等写入结束');
  if (applying) throw new Error('补全任务正在执行，请等它结束再撤销');
  const job = db.prepare('SELECT * FROM write_jobs WHERE id = ?').get(Number(jobId));
  if (!job || job.type !== JOB_TYPE) throw new Error('这不是「补RJ号」写任务');
  if (job.status === 'undone') throw new Error('该任务已撤销过');
  if (!['done', 'failed', 'interrupted'].includes(job.status)) {
    throw new Error(`当前状态（${job.status}）不可撤销`);
  }

  const payload = JSON.parse(job.payload_json ?? '{}');
  const planItems = Array.isArray(payload.items) ? payload.items : [];
  const rows = db.prepare('SELECT * FROM write_job_items WHERE job_id = ? ORDER BY id').all(job.id);
  const setItem = db.prepare('UPDATE write_job_items SET error = ? WHERE id = ?');

  let restored = 0;
  let failed = 0;
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    if (row.status !== 'done' || !row.backup_file) continue;
    const oldPath = row.backup_file;
    const newPath = row.path;
    let newIsDir = false;
    try { newIsDir = fs.statSync(newPath).isDirectory(); } catch { /* 已不存在 */ }
    if (!newIsDir) {
      failed += 1;
      setItem.run('撤销落空：新目录不存在或已再被改名', row.id);
      continue;
    }
    if (fs.existsSync(oldPath)) {
      failed += 1;
      setItem.run('撤销落空：原路径已有同名目录，不覆盖', row.id);
      continue;
    }
    try {
      fs.renameSync(newPath, oldPath);
    } catch (err) {
      failed += 1;
      setItem.run(`撤销失败：${err.code ?? err.message}`, row.id);
      continue;
    }
    restored += 1;
    try {
      const rebuilt = store.findVoiceAlbum(newPath);
      if (rebuilt?.id) store.deleteAlbumDeep(rebuilt.id);
      const libraryId = planItems[i]?.library_id ?? null;
      if (libraryId) await rescanReleaseRoot({ releaseRoot: oldPath, libraryId });
    } catch { /* 名字已还原；索引交给下次扫描 */ }
  }

  if (!restored) {
    // 一个都没还原成（多半是被再改名/移动/原路径被占）：任务保持原状态，
    // 落空原因已逐条写进 items.error，用户清障后还能再点撤销
    throw new Error('没有可还原的目录（可能已被再次改名、移动，或原路径被占用），详情见写任务条目');
  }

  const undoInfo = db.prepare(`
    INSERT INTO write_jobs (type, status, payload_json, total, succeeded, failed, created_at, finished_at)
    VALUES ('undo', 'done', ?, ?, ?, ?, ?, ?)
  `).run(JSON.stringify({ undoOf: job.id }), rows.length, restored, failed, now(), now());
  db.prepare("UPDATE write_jobs SET status = 'undone' WHERE id = ?").run(job.id);
  return { undoJobId: Number(undoInfo.lastInsertRowid), restored, failed, unit: '个目录' };
}
