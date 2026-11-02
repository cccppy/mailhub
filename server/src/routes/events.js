import { Router } from 'express';
import { subscribe } from '../mail/idle.js';

const router = Router();

/**
 * GET /api/events —— 新邮件实时推送（Server-Sent Events）
 *
 * 为什么是 SSE 而不是 WebSocket：这个服务本来就是纯 HTTP + 一条本地连接，
 * SSE 不需要额外依赖、不需要握手协议、断了浏览器会自动重连，够用了。
 *
 * 令牌照旧走 Authorization 头（前端用 fetch 读流，不是 EventSource，
 * 所以能带自定义头）——不放在 URL 里，免得被写进 diag.log。
 */
router.get('/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    // 万一将来前面挡了 nginx 之类，别让它攒着
    'X-Accel-Buffering': 'no',
  });
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  subscribe(res);
});

export default router;
