/**
 * 头像渲染：优先 fastly.jsdelivr.net 快速地址，加载失败回退
 * raw.githubusercontent.com，最终统一回退文字「学」。
 * 图片 URL 命中缓存时立即显示，保证顶栏 / 个人信息 / 个人资料三处同步。
 */
import { requireConfig, fileUrl, rawUrl } from './github.js';

const FALLBACK_TEXT = '学';
const imgCache = {};

export function renderAvatar(holderId, imgId, user, fallbackLetter) {
  const holder = document.getElementById(holderId);
  const img = document.getElementById(imgId);
  if (!holder || !img) return;
  let letter = holder.querySelector('.avatar-letter');
  if (!letter) {
    letter = document.createElement('span');
    letter.className = 'avatar-letter';
    holder.appendChild(letter);
  }

  const showLetter = () => {
    img.classList.add('hidden');
    letter.classList.remove('hidden');
    letter.textContent = FALLBACK_TEXT;
  };

  const path = user && user.avatar;
  if (path) {
    let candidates = [];
    try {
      const cfg = requireConfig();
      candidates = [fileUrl(cfg, path), rawUrl(cfg, path)];
    } catch (e) {
      candidates = [];
    }
    if (candidates.length) {
      if (imgCache[candidates[0]]) {
        img.src = candidates[0];
        img.classList.remove('hidden');
        letter.classList.add('hidden');
        return;
      }
      let i = 0;
      const tryLoad = () => {
        img.onload = () => {
          imgCache[candidates[0]] = true;
          img.classList.remove('hidden');
          letter.classList.add('hidden');
        };
        img.onerror = () => {
          i += 1;
          if (i < candidates.length) {
            img.src = candidates[i];
          } else {
            showLetter();
          }
        };
        img.src = candidates[i];
      };
      tryLoad();
      return;
    }
  }
  showLetter();
}
