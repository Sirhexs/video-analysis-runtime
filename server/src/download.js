import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';

/**
 * 用 polydl 下载抖音视频。
 * 正确用法（官方 README）：
 *   const detail = await handler.fetchOneVideo(urlOrId)
 *   await downloader.createDownloadTasks(detail.toAwemeData(), path)
 */
export async function downloadDouyinVideo({
  externalId,
  url,
  cookie,
  workDir,
}) {
  const ck = cookie || config.douyinCookie;
  if (!ck) {
    throw new Error(
      '缺少抖音 Cookie：请在扩展设置同步 Cookie 或设置环境变量 DOUYIN_COOKIE',
    );
  }

  await fs.mkdir(workDir, { recursive: true });

  let polydl;
  try {
    polydl = await import('polydl');
  } catch {
    throw new Error(
      '未安装 polydl。请在 server 目录执行: npm i polydl',
    );
  }

  const DouyinHandler =
    polydl.DouyinHandler || polydl.default?.DouyinHandler;
  const DouyinDownloader =
    polydl.DouyinDownloader || polydl.default?.DouyinDownloader;
  const setConfig = polydl.setConfig || polydl.default?.setConfig;

  if (!DouyinHandler || !DouyinDownloader) {
    throw new Error(
      'polydl 导出不包含 DouyinHandler/DouyinDownloader，请升级 polydl',
    );
  }

  if (typeof setConfig === 'function') {
    try {
      setConfig({ encryption: 'ab' });
    } catch {
      /* ignore */
    }
  }

  const awemeId =
    externalId && /^\d{6,}$/.test(externalId)
      ? externalId
      : extractAwemeId(url);

  if (!awemeId) {
    throw new Error('无法解析 aweme_id，请提供 /video/{id} 链接');
  }

  const target =
    url && /douyin\.com|v\.douyin\.com/i.test(String(url))
      ? String(url)
      : `https://www.douyin.com/video/${awemeId}`;

  const handler = new DouyinHandler({ cookie: ck });

  let postDetail;
  try {
    postDetail = await handler.fetchOneVideo(target);
  } catch (e1) {
    // 次级：仅 id 再试
    try {
      postDetail = await handler.fetchOneVideo(awemeId);
    } catch (e2) {
      // 再次：分享页（部分环境无 cookie 也能拿到）
      if (typeof handler.fetchOneVideoFromSharePage === 'function') {
        postDetail = await handler.fetchOneVideoFromSharePage(awemeId);
      }
      if (!postDetail) {
        throw new Error(
          `fetchOneVideo 失败: ${
            e2 instanceof Error ? e2.message : String(e2)
          }`,
        );
      }
    }
  }

  if (!postDetail) {
    throw new Error('fetchOneVideo 返回空');
  }

  // 关键：Filter → AwemeData（旧代码漏了这一步，导致空目录）
  const awemeData = toAwemeData(postDetail);
  if (!awemeData) {
    throw new Error(
      '无法将作品详情转为 AwemeData（缺少 toAwemeData）。请检查 polydl 版本',
    );
  }

  // 图集：明确提示（第一期不强求视频轨）
  const awemeType =
    awemeData.aweme_type ??
    awemeData.awemeType ??
    awemeData.type ??
    null;
  if (awemeType === 68 || awemeType === '68') {
    throw new Error(
      `作品 ${awemeId} 是图集（aweme_type=68），当前流水线需要视频文件`,
    );
  }

  // 只需视频：音轨用 ffmpeg 从 mp4 抽，不必另下 _music.mp3（省带宽、避免抢超时）
  // 默认 polydl timeout=30s 对大视频偏短，提高到 3 分钟并加重试
  const dlOpts = {
    cookie: ck,
    downloadPath: workDir,
    naming: '{aweme_id}',
    folderize: true,
    cover: false,
    music: false,
    desc: false,
    timeout: Number(process.env.DOWNLOAD_TIMEOUT_MS || 180_000),
    retries: Number(process.env.DOWNLOAD_RETRIES || 3),
    maxConcurrency: 1,
  };

  const runDownload = async (data, label) => {
    const downloader = new DouyinDownloader(dlOpts);
    console.log(`[download] start ${label} timeout=${dlOpts.timeout}ms`);
    if (typeof downloader.createDownloadTasks === 'function') {
      await downloader.createDownloadTasks(data, workDir);
    } else if (typeof downloader.handleDownload === 'function') {
      await downloader.handleDownload(data, workDir);
    } else if (typeof downloader.downloadVideo === 'function') {
      await downloader.downloadVideo(data, workDir);
    } else {
      throw new Error('polydl downloader 无可用下载方法');
    }
  };

  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await runDownload(awemeData, `attempt-${attempt}`);
      lastErr = null;
      break;
    } catch (e) {
      lastErr = e;
      console.warn(
        `[download] attempt ${attempt} failed:`,
        e instanceof Error ? e.message : e,
      );
      await sleep(1000 * attempt);
    }
  }

  // 仍失败：分享页数据再试一轮
  if (lastErr && typeof handler.fetchOneVideoFromSharePage === 'function') {
    try {
      const share = await handler.fetchOneVideoFromSharePage(awemeId);
      const shareData = toAwemeData(share);
      if (shareData) {
        await runDownload(shareData, 'share-page');
        lastErr = null;
      }
    } catch (e) {
      lastErr = e;
      console.warn('[download] share-page retry failed', e);
    }
  }

  await sleep(400);

  let videoPath = await findVideoFile(workDir);
  if (!videoPath) {
    await sleep(1000);
    videoPath = await findVideoFile(workDir);
  }

  // 若只有音频：仍可走 ASR（口播），jobs 层可接；这里优先视频
  if (!videoPath) {
    const listing = await listDirRecursive(workDir, 3);
    const audioOnly = await findAudioFile(workDir);
    if (audioOnly) {
      // 把「仅音频」作为可返回结果，供 jobs 走 ASR-only
      console.warn('[download] video missing, audio only:', audioOnly);
      return {
        videoPath: null,
        audioPath: audioOnly,
        awemeId,
        workDir,
        awemeData,
        audioOnly: true,
      };
    }
    const msg = lastErr instanceof Error ? lastErr.message : String(lastErr || '');
    throw new Error(
      `下载完成但未找到视频文件：${workDir}\n目录内容: ${listing || '(空)'}\n最后错误: ${msg}\n请检查 Cookie、网络或增大 DOWNLOAD_TIMEOUT_MS`,
    );
  }

  return { videoPath, awemeId, workDir, awemeData };
}

function toAwemeData(postDetail) {
  if (!postDetail) return null;
  if (typeof postDetail.toAwemeData === 'function') {
    try {
      return postDetail.toAwemeData();
    } catch (e) {
      console.warn('[download] toAwemeData failed', e);
    }
  }
  // 已经是纯数据对象
  if (postDetail.aweme_id || postDetail.awemeId || postDetail.video) {
    return postDetail;
  }
  // 部分 filter 挂在 ._data
  if (postDetail._data && typeof postDetail._data === 'object') {
    return postDetail._data;
  }
  return null;
}

function extractAwemeId(url) {
  if (!url) return null;
  const m =
    String(url).match(/\/video\/(\d{6,})/) ||
    String(url).match(/modal_id=(\d{6,})/);
  return m?.[1] ?? null;
}

async function findVideoFile(dir) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      const nested = await findVideoFile(full);
      if (nested) return nested;
    } else if (/\.(mp4|mov|webm|mkv|m4v|flv)$/i.test(e.name)) {
      try {
        const st = await fs.stat(full);
        if (st.size > 1024) return full;
      } catch {
        /* ignore */
      }
    }
  }
  return null;
}

async function findAudioFile(dir) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      const nested = await findAudioFile(full);
      if (nested) return nested;
    } else if (/\.(mp3|m4a|aac|wav|ogg)$/i.test(e.name)) {
      return full;
    }
  }
  return null;
}

async function listDirRecursive(dir, depth = 2, prefix = '') {
  if (depth < 0) return '';
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return '(无法读取)';
  }
  const lines = [];
  for (const e of entries.slice(0, 40)) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      lines.push(`${prefix}${e.name}/`);
      const sub = await listDirRecursive(full, depth - 1, `${prefix}  `);
      if (sub) lines.push(sub);
    } else {
      let size = '?';
      try {
        size = String((await fs.stat(full)).size);
      } catch {
        /* ignore */
      }
      lines.push(`${prefix}${e.name} (${size}B)`);
    }
  }
  return lines.join('\n');
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
