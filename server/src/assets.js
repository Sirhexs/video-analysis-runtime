import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from './config.js';
import { RuntimeError } from './errors.js';
import { readJsonFile, writeJsonAtomic } from './json-store.js';

const assetsDir = path.join(config.dataDir, 'assets');

function safeFilename(value) {
  const name = path.basename(String(value || 'media.bin'));
  return name.replace(/[^\p{L}\p{N}._-]+/gu, '_').slice(0, 180) || 'media.bin';
}

function pathsFor(id, filename = 'media.bin') {
  const dir = path.join(assetsDir, id);
  return {
    dir,
    metadata: path.join(dir, 'asset.json'),
    file: path.join(dir, safeFilename(filename)),
  };
}

async function persistAsset(asset) {
  await writeJsonAtomic(pathsFor(asset.id).metadata, asset);
  return asset;
}

export async function initializeAssets() {
  await fsp.mkdir(assetsDir, { recursive: true });
}

export async function createAssetFromStream(stream, options = {}) {
  const id = randomUUID();
  const filename = safeFilename(options.filename);
  const target = pathsFor(id, filename);
  await fsp.mkdir(target.dir, { recursive: true });
  let size = 0;
  const output = fs.createWriteStream(target.file, { flags: 'wx' });
  try {
    for await (const chunk of stream) {
      size += chunk.length;
      if (size > config.maxAssetBytes) {
        throw new RuntimeError('asset_too_large', '媒体文件超过大小限制', 413, {
          maxBytes: config.maxAssetBytes,
        });
      }
      if (!output.write(chunk)) {
        await new Promise((resolve) => output.once('drain', resolve));
      }
    }
    await new Promise((resolve, reject) => {
      output.end(resolve);
      output.once('error', reject);
    });
  } catch (error) {
    output.destroy();
    await fsp.rm(target.dir, { recursive: true, force: true });
    throw error;
  }
  const now = Date.now();
  return persistAsset({
    id,
    filename,
    path: target.file,
    contentType: options.contentType || 'application/octet-stream',
    source: options.source || 'upload',
    size,
    createdAt: now,
    updatedAt: now,
    expiresAt: now + config.assetRetentionMs,
    metadata: options.metadata || {},
  });
}

export async function createAssetFromFile(sourcePath, options = {}) {
  const filename = safeFilename(options.filename || path.basename(sourcePath));
  const input = fs.createReadStream(sourcePath);
  return createAssetFromStream(input, { ...options, filename });
}

export async function importAssetUrl(urlValue, options = {}) {
  let url;
  try {
    url = new URL(urlValue);
  } catch {
    throw new RuntimeError('invalid_media_url', '媒体 URL 无效');
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new RuntimeError('invalid_media_url', '媒体 URL 仅支持 HTTP(S)');
  }
  const response = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(config.assetImportTimeoutMs),
  });
  if (!response.ok || !response.body) {
    throw new RuntimeError(
      'media_download_failed',
      `媒体下载失败 HTTP ${response.status}`,
      502,
    );
  }
  const contentLength = Number(response.headers.get('content-length') || 0);
  if (contentLength > config.maxAssetBytes) {
    throw new RuntimeError('asset_too_large', '媒体文件超过大小限制', 413);
  }
  const filename =
    options.filename || path.basename(new URL(response.url).pathname) || 'media.bin';
  return createAssetFromStream(response.body, {
    filename,
    contentType: response.headers.get('content-type') || 'application/octet-stream',
    source: 'url',
    metadata: { requestedUrl: String(url), resolvedUrl: response.url },
  });
}

export async function getAsset(id) {
  const asset = await readJsonFile(pathsFor(id).metadata, null);
  if (!asset) return null;
  try {
    await fsp.access(asset.path);
  } catch {
    return null;
  }
  return asset;
}

export async function deleteAsset(id) {
  const asset = await getAsset(id);
  if (!asset) return false;
  await fsp.rm(pathsFor(id).dir, { recursive: true, force: true });
  return true;
}

export async function cleanupExpiredAssets(now = Date.now()) {
  const entries = await fsp.readdir(assetsDir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const asset = await readJsonFile(pathsFor(entry.name).metadata, null);
    if (!asset || Number(asset.expiresAt) <= now) {
      await fsp.rm(path.join(assetsDir, entry.name), { recursive: true, force: true });
    }
  }
}

export function publicAsset(asset) {
  if (!asset) return null;
  const { path: ignored, ...publicValue } = asset;
  void ignored;
  return publicValue;
}
