/** 通用小工具：时间、体积、地址格式化 */

export function formatSize(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function pad(n) {
  return String(n).padStart(2, '0');
}

/** 列表里用的短时间：今天显示 HH:mm，昨天显示"昨天"，今年显示 MM-DD，更早显示 YYYY-MM-DD */
export function formatListDate(input) {
  const d = input ? new Date(input) : null;
  if (!d || Number.isNaN(d.getTime())) return '';
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const diffDays = Math.floor((startOfToday - new Date(d.getFullYear(), d.getMonth(), d.getDate())) / 86400000);

  if (diffDays <= 0) return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (diffDays === 1) return `昨天 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (d.getFullYear() === now.getFullYear()) return `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 阅读窗格用的完整时间 */
export function formatFullDate(input) {
  const d = input ? new Date(input) : null;
  if (!d || Number.isNaN(d.getTime())) return '';
  const week = ['日', '一', '二', '三', '四', '五', '六'][d.getDay()];
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 星期${week} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** [{name, address}] -> "张三 <a@b.com>；李四 <c@d.com>" */
export function formatAddresses(list, max = 4) {
  const arr = Array.isArray(list) ? list : [];
  if (!arr.length) return '(无)';
  const shown = arr.slice(0, max).map((a) => (a.name ? `${a.name} <${a.address}>` : a.address));
  if (arr.length > max) shown.push(`等 ${arr.length} 人`);
  return shown.join('；');
}

export function firstAddress(list) {
  const arr = Array.isArray(list) ? list : [];
  if (!arr.length) return { name: '', address: '' };
  return { name: arr[0].name || '', address: arr[0].address || '' };
}

/** 头像文字：优先取名字首字，否则取邮箱首字母 */
export function initialsOf(from) {
  const name = (from && from.name) || '';
  const addr = (from && from.address) || '';
  if (name) return name.trim().charAt(0).toUpperCase();
  return (addr.charAt(0) || '?').toUpperCase();
}

export function debounce(fn, wait = 300) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

/** 简单的中文昵称展示 */
export function prettyFrom(from) {
  const { name, address } = firstAddress([from].flat().filter(Boolean));
  return { label: name || address || '(未知发件人)', email: address };
}
