/**
 * 实验功能：给缺 RJ 号的音声目录在**目录名末尾**补【RJ号】。
 * 入口在「统计 → 数据安全」的按钮行（public/app.js 的 refillRjBtn）。
 *
 * 流程（两步，先只读预览、再写盘）：
 *   1. planRefill() —— 遍历库里「rj_code 为空」的音声发行，拿**专辑标题**与
 *      **目录名**去 DLsite 索引反查（dlsite.findWorksByTitle：精确→宽松）。
 *      唯一命中、或多命中里能用社团消歧到唯一的才进候选；
 *      查不到 / 无法唯一定 / 重名 / 过长，一律带原因进 skipped，**不猜**。
 *   2. applyRefill(ids) —— 按用户拍板的「破坏性」语义执行：
 *      目录 `原名` 重命名为 `原名【RJxxxxxxx】` → 旧专辑的入库记录**直接删除**
 *      （标签、收藏不迁移，这是本实验功能明示的代价）→ 用新路径走现成的
 *      rescanReleaseRoot 重新入库。新目录名里有 RJ，locateRelease 主链路照常识别，
 *      applyDlsiteMetadata 随即按索引补社团/声优/标签 —— 主流程代码零改动。
 *
 * 边界：只动**目录型**发行根（压缩包/虚拟路径跳过）；只动注册音乐库之下、
 * 不碰库根本身；单条失败如实报告，不影响其它条目。
 */
import fs from 'node:fs';
import path from 'node:path';

import * as store from './db.mjs';
import * as dlsite from './dlsite.mjs';
import { isScanning, rescanReleaseRoot } from './scanner.mjs';

const RJ_IN_NAME = /RJ\s*\d{6,8}/i;
/** Windows MAX_PATH=260，重命名会追加约 12 个字符，给长路径留出安全余量 */
const MAX_NEW_PATH = 250;

/** root 必须严格位于某个已注册音乐库之下（库根本身不许动） */
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
 * 依次试专辑标题、目录名；多个候选时再用社团消歧。
 * @returns {{ok:true, work:object, how:string}|{ok:false, reason:string}}
 */
function resolveWork({ title, folder, circle }) {
  const want = String(circle ?? '').trim().toLowerCase();
  let reason = '索引里查不到同名作品';
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
    reason = '索引里同名作品不止一个，社团也无法唯一定';
  }
  return { ok: false, reason };
}

/**
 * 只读预览：算出哪些目录能安全补号、哪些被跳过以及为什么。
 * 可以反复调，不写任何东西。
 */
export function planRefill() {
  const index = dlsite.indexInfo();
  if (!index.available) {
    return { index, checked: 0, items: [], skipped: [{ reason: '没有可用的 DLsite 索引文件' }] };
  }
  const rows = store.listVoiceAlbumsMissingRj();
  const libraries = store.listLibraries();
  const items = [];
  const skipped = [];
  const note = (album, reason) => skipped.push({
    album_id: album.id,
    folder: path.basename(String(album.release_root ?? '')) || String(album.title ?? album.id),
    reason,
  });

  for (const album of rows) {
    const root = String(album.release_root ?? '').trim();
    if (!root || root.includes('\u0001') || root.includes('\u0000')) { note(album, '压缩包/虚拟路径，暂只支持目录'); continue; }
    let stat = null;
    try { stat = fs.statSync(root); } catch { /* 目录不存在，走下面分支 */ }
    if (!stat) { note(album, '目录已不存在'); continue; }
    if (!stat.isDirectory()) { note(album, '不是目录'); continue; }
    const folder = path.basename(root);
    if (RJ_IN_NAME.test(folder)) { note(album, '目录名里已经有 RJ 号'); continue; }
    if (!libraryOwning(root, libraries)) { note(album, '不在任何已注册音乐库之下（库根不动）'); continue; }

    const hit = resolveWork({ title: album.title, folder, circle: album.circle });
    if (!hit.ok) { note(album, hit.reason); continue; }

    const newPath = `${root}【${hit.work.rj}】`;
    let clash = false;
    try { clash = fs.existsSync(newPath); } catch { clash = true; }
    if (clash) { note(album, `目标目录名已存在（${hit.work.rj}）`); continue; }
    if (newPath.length > MAX_NEW_PATH) { note(album, `重命名后路径过长（${newPath.length} 字符）`); continue; }

    items.push({
      album_id: album.id,
      folder,
      rj: hit.work.rj,
      how: hit.how,
      work_title: hit.work.title ?? null,
      work_circle: hit.work.circle ?? null,
      old_path: root,
      new_path: newPath,
    });
  }
  return { index, checked: rows.length, items, skipped };
}

/**
 * 执行重命名（破坏性，用户已确认）：改名 → 删旧记录 → 按新路径重扫入库。
 * `albumIds` 必须来自**同一批预览**；这里会重新 plan 一次再按 id 过滤，
 * 磁盘或索引在预览后变了的话，对不上的条目自动落空，绝不按陈旧预览硬改。
 */
export async function applyRefill(albumIds) {
  if (isScanning()) throw new Error('扫描正在进行，请先结束扫描再执行回填');
  const wanted = new Set((albumIds ?? []).map(Number).filter(Number.isFinite));
  const plan = planRefill().items.filter((it) => wanted.has(it.album_id));
  const renamed = [];
  const failed = [];

  for (const it of plan) {
    try {
      fs.renameSync(it.old_path, it.new_path);
    } catch (err) {
      const reason = (err.code === 'EPERM' || err.code === 'EBUSY')
        ? '目录被占用或没有权限（正在播放或资源管理器打开了它？）'
        : `${err.code ?? '错误'}：${err.message}`;
      failed.push({ ...it, reason });
      continue;
    }
    // 改名已成功，后面两步属于「重建」而不是「回退点」：失败就如实记下，
    // 用户在下次整库扫描时仍能自愈（主链路的清理与补齐都是幂等的）。
    try {
      const library = libraryOwning(it.new_path, store.listLibraries());
      store.deleteAlbumDeep(it.album_id);
      if (library) await rescanReleaseRoot({ releaseRoot: it.new_path, libraryId: library.id });
      renamed.push({ ...it, rescan: library ? 'ok' : 'skipped-no-library' });
    } catch (err) {
      renamed.push({ ...it, rescan: `failed: ${err.message}` });
    }
  }
  return { renamed: renamed.length, failed: failed.length, details: { renamed, failed } };
}
