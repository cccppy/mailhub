/**
 * 邮件正文净化。
 *
 * 双重防护：
 * 1. 白名单化：删掉可执行标签，抹掉所有 on* 事件和 javascript: 协议；
 * 2. 渲染层：正文一律塞进 <iframe sandbox>（不给 allow-scripts），
 *    即使有漏网的脚本也执行不了。
 */

const DROP_TAGS = [
  'script',
  'noscript',
  'iframe',
  'frame',
  'frameset',
  'object',
  'embed',
  'applet',
  'link',
  'meta',
  'base',
  'form',
  'input',
  'button',
  'select',
  'textarea',
  'audio',
  'video',
];

const URL_ATTRS = ['href', 'src', 'srcset', 'xlink:href', 'action', 'formaction', 'background', 'poster', 'data'];
const BAD_SCHEME = /^(?:javascript|vbscript|data:text\/(?:html|xml))/i;

// 顶替被拦截远程图片的占位图。
//
// 之前用的是 1x1 透明 GIF，结果是「被拦了」和「图没加载」在界面上长得一模一样 ——
// 一张 1 像素的透明图铺在正文里，用户只看到一片空白，根本不知道有图片被挡掉了。
// 现在换成带尺寸的占位图：没写尺寸的图会按 240x56 显示，一眼能看出这里本该有张图。
const BLOCKED_PLACEHOLDER =
  'data:image/svg+xml;charset=utf-8,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="56">' +
      '<rect x="0.5" y="0.5" width="239" height="55" fill="#f6f8fa" stroke="#d0d7de" stroke-dasharray="5 4"/>' +
      '<text x="120" y="28" font-family="Segoe UI,Microsoft YaHei,sans-serif" font-size="12" fill="#8b949e" text-anchor="middle" dominant-baseline="middle">图片已拦截</text>' +
      '</svg>',
  );

/** 去掉控制字符与空白后再判断协议，可拦住 "java\nscript:" 这类绕过写法 */
function normalizedSchemeValue(value) {
  return String(value || '').replace(/[\u0000-\u0020\u00a0]/g, '');
}

export function sanitizeHtml(dirty) {
  const doc = new DOMParser().parseFromString(String(dirty || ''), 'text/html');
  doc.querySelectorAll(DROP_TAGS.join(',')).forEach((el) => el.remove());

  doc.querySelectorAll('*').forEach((el) => {
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      if (name.startsWith('on')) {
        el.removeAttribute(attr.name);
        continue;
      }
      if (name === 'srcdoc') {
        el.removeAttribute(attr.name);
        continue;
      }
      if (URL_ATTRS.includes(name) && BAD_SCHEME.test(normalizedSchemeValue(attr.value))) {
        el.removeAttribute(attr.name);
        continue;
      }
      if (name === 'srcset') {
        // srcset 里可能夹带 javascript:，整条丢弃最省心
        if (/javascript|vbscript|data:text/i.test(attr.value)) el.removeAttribute(attr.name);
        continue;
      }
      if (name === 'style' && /expression\s*\(|javascript:/i.test(attr.value)) {
        el.removeAttribute(attr.name);
      }
    }
  });

  return doc.body ? doc.body.innerHTML : '';
}

/**
 * 把 cid: 内嵌图换成真正的图片地址。
 *
 * 转发邮件、带截图的邮件、几乎所有营销邮件里的图，正文里写的是 `src="cid:xxx"`，
 * 它指向邮件里的某个 MIME part，不是网址 —— 浏览器不认识 cid: 协议，一律不加载。
 * 所以要先按 Content-ID 找到对应附件，取回内容做成 data: URL 再塞回去。
 *
 * cid 图是邮件自己带的，不涉及「发件人追踪」，所以不受远程图片开关影响。
 */
function resolveCidImages(root, cidMap) {
  if (!cidMap || !cidMap.size) return 0;
  let n = 0;
  root.querySelectorAll('img').forEach((img) => {
    const src = (img.getAttribute('src') || '').trim();
    const m = /^cid:(.+)$/i.exec(src);
    if (!m) return;
    const raw = m[1].replace(/^<|>$/g, '');
    let key = raw;
    try {
      key = decodeURIComponent(raw);
    } catch {
      /* 保持原样 */
    }
    // Content-ID 在邮件里带尖括号，HTML 里有时带有时不带，两种都试
    const dataUrl = cidMap.get(key) || cidMap.get(`<${key}>`) || cidMap.get(raw);
    if (dataUrl) {
      img.setAttribute('src', dataUrl);
      img.removeAttribute('data-src');
      n += 1;
    }
  });
  return n;
}

/** 协议相对地址（//host/x.png）和绝对地址都算远程图 */
const isRemoteUrl = (v) => /^(?:https?:)?\/\//i.test(String(v || '').trim());

/**
 * 正文里有几张「需要联网才能取到」的图。
 *
 * 只用来决定「显示远程图片」按钮要不要出现，所以按同一套判定口径算一遍就行：
 * cid: 内嵌图不算（它跟着邮件来，自动显示），data: 也不算。
 */
export function countRemoteImages(html) {
  if (!html || !String(html).trim()) return 0;
  const doc = new DOMParser().parseFromString(sanitizeHtml(html), 'text/html');
  let n = 0;
  doc.querySelectorAll('img').forEach((img) => {
    const src =
      img.getAttribute('src') ||
      img.getAttribute('data-src') ||
      img.getAttribute('data-original') ||
      img.getAttribute('data-lazy-src') ||
      '';
    if (isRemoteUrl(src) || isRemoteUrl(img.getAttribute('srcset'))) n += 1;
  });
  return n;
}

/** 把远程图片换成占位，用户点"显示图片"后才真正加载。返回被拦的张数 */
function blockRemoteImages(root) {
  let count = 0;
  root.querySelectorAll('img').forEach((img) => {
    // 有些邮件用 data-src / data-original 做懒加载，也要一并看
    const src =
      img.getAttribute('src') ||
      img.getAttribute('data-src') ||
      img.getAttribute('data-original') ||
      img.getAttribute('data-lazy-src') ||
      '';
    const srcset = img.getAttribute('srcset') || '';
    if (!isRemoteUrl(src) && !isRemoteUrl(srcset)) return;

    if (src) img.setAttribute('data-blocked-src', src);
    img.setAttribute('src', BLOCKED_PLACEHOLDER);
    img.removeAttribute('srcset');
    img.removeAttribute('data-src');
    img.removeAttribute('data-original');
    img.removeAttribute('data-lazy-src');
    img.classList.add('mh-blocked');
    count += 1;
  });
  return count;
}

/** 拦截时在正文顶上插一条说明，否则用户只会看到一堆灰条，不知道为什么 */
function insertBlockedNotice(root, count) {
  const bar = root.ownerDocument.createElement('div');
  bar.className = 'mh-notice';
  bar.textContent = `为保护隐私，已拦截 ${count} 张远程图片（加载它们等于告诉发件人你已读过）。要看图，点正文上方的「显示远程图片」——点一次以后都放行，也可以去设置页改成「全部直接显示」。`;
  root.insertBefore(bar, root.firstChild);
}

const FRAME_CSS = `
  :root { color-scheme: light; }
  html, body { margin: 0; padding: 0; }
  body {
    font: 14px/1.7 -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
    color: #1f2328; background: #ffffff; padding: 18px 20px 28px;
    word-break: break-word; overflow-wrap: anywhere;
  }
  img { max-width: 100%; height: auto; }
  table { max-width: 100%; }
  a { color: #2563eb; }
  blockquote {
    border-left: 3px solid #d8dee4; margin: 10px 0;
    padding: 2px 0 2px 12px; color: #57606a;
  }
  pre { white-space: pre-wrap; font-family: inherit; margin: 0; }
  .mh-blocked { background: #f6f8fa; outline: 1px dashed #c9d1d9; min-height: 28px; }
  .mh-notice {
    background: #fff8e1; border: 1px solid #ffe08a; border-radius: 6px;
    color: #7a5b00; font-size: 12.5px; line-height: 1.6;
    padding: 8px 10px; margin: 0 0 14px;
  }
  .mh-plain { white-space: pre-wrap; font-family: inherit; }
`;

/**
 * 生成用于 iframe srcdoc 的完整文档。
 * @param {string} html 原始 HTML 正文
 * @param {{ text?: string, showImages?: boolean, cidMap?: Map<string,string> }} opts
 *   cidMap: Content-ID -> data: URL，用来把 `src="cid:xxx"` 的内嵌图显示出来
 *   showImages: 是否放行远程图。默认 true —— 调用方没表态时不该偷偷把图拦掉，
 *   拦图是个需要用户明确选择的动作，不是默认行为。
 */
export function buildEmailDocument(html, opts = {}) {
  const { text = '', showImages = true, cidMap = null } = opts;
  let bodyHtml;

  if (html && html.trim()) {
    const doc = new DOMParser().parseFromString(sanitizeHtml(html), 'text/html');
    const body = doc.body || doc.documentElement;
    // 顺序要紧：先把 cid 换成 data:（本地图，不受拦截开关影响），再拦远程图
    resolveCidImages(body, cidMap);
    if (!showImages) {
      const blocked = blockRemoteImages(body);
      if (blocked > 0) insertBlockedNotice(body, blocked);
    }
    bodyHtml = body ? body.innerHTML : '';
  } else {
    bodyHtml = `<pre class="mh-plain">${escapeHtml(text || '(这封邮件没有正文)')}</pre>`;
  }

  return [
    '<!doctype html><html><head><meta charset="utf-8">',
    '<base target="_blank" rel="noopener noreferrer">',
    `<style>${FRAME_CSS}</style>`,
    '</head><body>',
    bodyHtml,
    '</body></html>',
  ].join('');
}

export function escapeHtml(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
