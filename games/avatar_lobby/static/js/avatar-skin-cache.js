/**
 * 皮套贴图本地缓存：内存 Map + Cache Storage（按带 contentHash 的 URL）。
 * 供 AvatarEntity.loadAppearance / 大厅预加载复用，不参与联机同步。
 */
(() => {
  const CACHE_NAME = 'avatar-skins-v1';
  /** @type {Map<string, HTMLImageElement | Promise<HTMLImageElement>>} */
  const memory = new Map();
  let loggedPersistentHit = false;

  /** 由 appearance 拼贴图 URL（与 AvatarEntity 一致）。 */
  function textureUrl(appearance) {
    if (!appearance?.skinId) return null;
    const v = appearance.contentHash || '';
    return `/avatar-lobby/skins/${appearance.skinId}/texture?v=${encodeURIComponent(v)}`;
  }

  /** 由 skins API 条目拼贴图 URL。 */
  function textureUrlFromSkin(skin) {
    if (!skin?.id) return null;
    const v = skin.content_hash || skin.created_at || '';
    return `/avatar-lobby/skins/${skin.id}/texture?v=${encodeURIComponent(v)}`;
  }

  async function openCache() {
    if (!('caches' in window)) return null;
    try {
      return await caches.open(CACHE_NAME);
    } catch {
      return null;
    }
  }

  function imageFromBlob(blob) {
    return new Promise((resolve, reject) => {
      const objectUrl = URL.createObjectURL(blob);
      const image = new Image();
      image.onload = () => {
        URL.revokeObjectURL(objectUrl);
        resolve(image);
      };
      image.onerror = () => {
        URL.revokeObjectURL(objectUrl);
        reject(new Error('skin image decode failed'));
      };
      image.src = objectUrl;
    });
  }

  async function storeResponse(cache, url, response) {
    if (!cache) return;
    try {
      await cache.put(url, response);
    } catch (error) {
      // 配额 / 隐私模式等：忽略，仍可用本次网络结果
      console.warn('[AvatarSkinCache] put failed', error?.name || error);
    }
  }

  async function fetchToImage(url, cache) {
    const response = await fetch(url, { credentials: 'same-origin' });
    if (!response.ok) {
      throw new Error(`skin fetch ${response.status}`);
    }
    await storeResponse(cache, url, response.clone());
    return imageFromBlob(await response.blob());
  }

  /**
   * 加载皮套贴图：内存 → Cache Storage → 网络。
   * @param {string} url
   * @returns {Promise<HTMLImageElement>}
   */
  function loadImage(url) {
    if (!url) {
      return Promise.reject(new Error('empty skin url'));
    }
    const existing = memory.get(url);
    if (existing) {
      return existing instanceof Promise ? existing : Promise.resolve(existing);
    }

    const pending = (async () => {
      const cache = await openCache();
      if (cache) {
        const hit = await cache.match(url);
        if (hit) {
          if (!loggedPersistentHit) {
            loggedPersistentHit = true;
            console.info('[AvatarSkinCache] persistent hit', url);
          }
          return imageFromBlob(await hit.blob());
        }
      }
      return fetchToImage(url, cache);
    })();

    memory.set(url, pending);
    return pending.then((image) => {
      memory.set(url, image);
      return image;
    }).catch((error) => {
      memory.delete(url);
      throw error;
    });
  }

  /** 后台预取一组 URL（失败不抛）。 */
  function preload(urls) {
    const list = [...new Set((urls || []).filter(Boolean))];
    return Promise.allSettled(list.map((url) => loadImage(url)));
  }

  /** 预取 appearance 对应贴图。 */
  function preloadAppearance(appearance) {
    const url = textureUrl(appearance);
    return url ? loadImage(url).catch(() => null) : Promise.resolve(null);
  }

  /** 预取 skins API 列表中的贴图。 */
  function preloadSkins(skins) {
    return preload((skins || []).map(textureUrlFromSkin));
  }

  window.AvatarSkinCache = {
    CACHE_NAME,
    textureUrl,
    textureUrlFromSkin,
    loadImage,
    preload,
    preloadAppearance,
    preloadSkins,
  };
})();
