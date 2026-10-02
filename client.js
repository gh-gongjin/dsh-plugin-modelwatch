// ============================================================
// dsh-plugin-modelwatch — Browser Client Half（浏览器半边）
// ============================================================
// 1) sidebar.panellist 注册图标按钮  2) main keyed slot 注册整页 UI。
// 数据通路：SSE 主（首帧 snapshot，检查完 update 帧 = 全量快照）、手动检查兜底。
// **不用 EventSource**（继承 sysops 口径：断线要能重连补帧）。
//
// 一份真相：本文件不定义任何枚举/判定口径 —— eventKindLabels / intervals /
// topNRange / sourceNote 全部来自宿主 index-inject 载荷；载荷没到就如实显示"配置未就位"。
// 零浮层：错误与状态一律就地落卡（.mw-notice）。
// 诚实降级：榜单源是非官方源，卡片标题旁常驻小字（宿主给的文案，不自己编）。

window.__ModuleLoader__.load({
  id: 'dsh-plugin-modelwatch',
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;

    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useRef } = React;

    const GLOBAL_KEY = '__MODELWATCH__';
    const cfg = () => globalThis[GLOBAL_KEY] || {};
    const PANEL_ID = cfg().panelId || 'modelwatch';
    const PANEL_ORDER = () => Number(cfg().panelOrder) || 14;
    const API_BASE = () => cfg().api || '/modelwatch/api';

    // ------------------------------------------------------------
    // 1) 样式：宿主 token 优先，原型值兜底（与 prototype/index.html 同构，mw- 前缀）
    // ------------------------------------------------------------
    const STYLE_ID = 'dsh-plugin-modelwatch:style';
    // 版式：状态压成整宽一条 → 主从两栏（周榜主 / 变化记录从，align-items:start 不做等高拉伸）
    // → 近 7 天新上整宽（5 列需要宽度）→ 设置。
    //
    // ⛔ 这里**不许**用 container-type + @container。曾这么写过一次，真机直接炸成"每张卡一条竖线"：
    //   container-type:inline-size 会施加 inline 轴 size containment，元素宽度**不再由内容撑开**；
    //   宿主主区是 flex、.mw-root 又是 flex:0 1 auto（宽度按内容算）⇒ 算出来 0 宽，
    //   里面所有 flex/grid 子项一起塌。兄弟插件（stock / sysops）一律只用 @media，别自作聪明。
    // ⛔ 根容器**必须自己带 box-sizing:border-box**（不能指望 `.mw-root *`，它盖不到根自己）。
    //   宿主 web 前端的 CSS 里**没有任何通配 box-sizing**（2026-10-02 核过 app.asar 里
    //   index-*.css / vendor-*.css 两份产物，0 条）；根一旦是 content-box，`width:100%` 只是内容宽，
    //   再加左右各 20px padding，**外框就比面板宽 40px** ⇒ 页头主按钮、卡头右端计数、榜单右侧列
    //   全被顶到可视区外（真机炸过一次，用户截图「旁边显示不出来了」）。
    //   兄弟插件（stock `.sa-root` / sysops `.so-root`）都把 box-sizing 写在根规则里 —— 照抄。
    // 断点/@media 与 stock 对齐；token 名也对齐 dsw-alias-*（用错名字 = 宿主主题永远不生效）。
    // ⚠️ 改这段样式前先看 docs/design-spec.md §7；CSS 模板串里注释与选择器都不许出现反引号。
    const CSS = `
.mw-root{--mw-fg:var(--dsw-alias-label-primary,#1a1a1a);--mw-muted:var(--dsw-alias-label-secondary,#6b6b70);
  --mw-faint:var(--dsw-alias-label-tertiary,#a0a0a6);
  --mw-card:var(--dsw-alias-bg-base,#ffffff);--mw-soft:var(--dsw-alias-bg-layer-2,#fafafb);
  --mw-hover:var(--dsw-alias-bg-layer-3,#f0f0f1);
  --mw-line:var(--dsw-alias-border-l1,#ebebed);--mw-line2:var(--dsw-alias-border-l2,#e0e0e3);
  --mw-ok:#1f883d;--mw-err:#c0392b;--mw-warn:#9a6700;--mw-info:var(--dsw-alias-state-business-primary,#3d6fe0);
  box-sizing:border-box;color:var(--mw-fg);background:transparent;padding:16px 20px 28px;
  width:100%;max-width:1320px;margin:0 auto;max-height:100vh;overflow-y:auto;
  display:flex;flex-direction:column;gap:12px;font-size:13px;line-height:1.5}
.mw-root *{box-sizing:border-box}
.mw-num{font-variant-numeric:tabular-nums;font-feature-settings:"tnum" 1}
.mw-r{text-align:right}
.mw-sub{color:var(--mw-muted);font-size:12px}
.mw-head{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;min-width:0}
.mw-head-l{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;min-width:0}
.mw-head-r{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.mw-title{font-size:16px;font-weight:600;letter-spacing:.2px;white-space:nowrap}
.mw-head .mw-sub{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mw-card{background:var(--mw-card);border:1px solid var(--mw-line);border-radius:12px;overflow:hidden;min-width:0}
.mw-card-h{display:flex;align-items:center;gap:8px;padding:9px 14px;background:var(--mw-soft);border-bottom:1px solid var(--mw-line)}
.mw-card-t{font-weight:600;font-size:13px;white-space:nowrap}
.mw-card-n{margin-left:auto;color:var(--mw-muted);font-size:11px;font-variant-numeric:tabular-nums;white-space:nowrap}
.mw-card-b{padding:12px 14px;display:flex;flex-direction:column;gap:10px;min-width:0}
.mw-note{margin:0;padding:8px 14px 10px;border-top:1px solid var(--mw-line);color:var(--mw-faint);font-size:11px}
.mw-cols{display:grid;grid-template-columns:minmax(0,1.6fr) minmax(0,1fr);gap:12px;align-items:start}
@media (max-width:1080px){.mw-cols{grid-template-columns:minmax(0,1fr)}}
.mw-status{display:flex;align-items:center;gap:18px;padding:11px 14px;flex-wrap:wrap}
.mw-srcs{display:flex;align-items:center;gap:20px;flex-wrap:wrap;min-width:0}
.mw-src{display:inline-flex;align-items:baseline;gap:7px;min-width:0}
.mw-src b{font-weight:500}
.mw-src .mw-sub{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:360px}
.mw-status-r{margin-left:auto;display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.mw-dot{width:7px;height:7px;border-radius:50%;flex:0 0 7px;background:var(--mw-faint);align-self:center}
.mw-dot-ok{background:var(--mw-ok)}
.mw-dot-err{background:var(--mw-err)}
.mw-notice{padding:7px 10px;border-radius:8px;border:1px solid var(--mw-line);border-left:3px solid var(--mw-warn);
  background:var(--mw-soft);color:var(--mw-muted);font-size:12px;line-height:1.5}
.mw-notice-err{border-left-color:var(--mw-err)}
.mw-scroll{max-height:420px;overflow-y:auto;overflow-x:hidden}
.mw-tbl{width:100%;border-collapse:separate;border-spacing:0;table-layout:fixed;font-size:12px}
.mw-tbl th{position:sticky;top:0;z-index:1;background:var(--mw-card);text-align:left;font-weight:500;
  color:var(--mw-muted);font-size:11px;padding:7px 8px;border-bottom:1px solid var(--mw-line);white-space:nowrap}
.mw-tbl th:first-child,.mw-tbl td:first-child{padding-left:14px}
.mw-tbl th:last-child,.mw-tbl td:last-child{padding-right:14px}
.mw-tbl td{padding:6px 8px;border-bottom:1px solid var(--mw-line);vertical-align:middle;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mw-tbl tbody tr:last-child td{border-bottom:none}
.mw-tbl tbody tr:hover td{background:var(--mw-hover)}
.mw-rank{color:var(--mw-faint)}
.mw-name{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mw-slug{display:block;color:var(--mw-faint);font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mw-up{color:var(--mw-ok)}
.mw-down{color:var(--mw-err)}
.mw-flat{color:var(--mw-faint)}
.mw-empty{margin:0;padding:10px 14px;color:var(--mw-muted);font-size:12px}
.mw-tl{list-style:none;margin:0;padding:2px 14px;display:flex;flex-direction:column}
.mw-tl li{display:flex;align-items:flex-start;gap:9px;padding:7px 0;border-bottom:1px solid var(--mw-line);min-width:0}
.mw-tl li:last-child{border-bottom:none}
.mw-tl li:before{content:'';flex:0 0 6px;width:6px;height:6px;border-radius:50%;background:var(--mw-faint);align-self:center;margin-right:-2px}
.mw-tl li[data-kind="new_model"]:before,.mw-tl li[data-kind="top_enter"]:before{background:var(--mw-info)}
.mw-tl li[data-kind="source_error"]:before,.mw-tl li[data-kind="removed_model"]:before{background:var(--mw-err)}
.mw-tl li[data-kind="source_recover"]:before{background:var(--mw-ok)}
.mw-tl li[data-kind="top_move"]:before{background:var(--mw-warn)}
.mw-chip{flex:0 0 auto;min-width:74px;text-align:center;padding:1px 8px;border-radius:999px;
  border:1px solid var(--mw-line2);background:var(--mw-soft);color:var(--mw-muted);font-size:11px}
.mw-tl-body{min-width:0;flex:1 1 auto;overflow-wrap:anywhere;line-height:1.45}
.mw-tl-body .mw-sub{margin-left:6px}
.mw-ago{flex:0 0 auto;color:var(--mw-faint);font-size:11px;white-space:nowrap;align-self:flex-start;padding-top:1px}
.mw-setrow{display:flex;flex-direction:row;align-items:center;gap:10px;flex-wrap:wrap}
.mw-setlabel{flex:0 0 auto;min-width:62px;color:var(--mw-muted);font-size:12px}
.mw-seg{display:inline-flex;padding:2px;gap:2px;background:var(--mw-soft);border:1px solid var(--mw-line);border-radius:8px}
.mw-seg button{border:none;background:transparent;color:var(--mw-muted);font-family:inherit;font-size:12px;
  padding:3px 10px;border-radius:6px;cursor:pointer}
.mw-seg button.on{background:var(--mw-fg);color:var(--mw-card);font-weight:500}
.mw-btn{font-family:inherit;font-size:12px;border-radius:8px;cursor:pointer;border:1px solid var(--mw-line2);
  background:var(--mw-card);color:var(--mw-fg);padding:4px 12px}
.mw-btn:hover:not(:disabled){background:var(--mw-hover)}
.mw-btn:disabled{opacity:.5;cursor:default}
.mw-btn-main{background:var(--mw-fg);border-color:var(--mw-fg);color:var(--mw-card);font-weight:500;padding:5px 14px}
.mw-btn.mw-btn-main:hover:not(:disabled){background:var(--mw-fg);opacity:.86}
.mw-step{width:28px;padding:4px 0;text-align:center;font-size:14px;line-height:1}
.mw-count{min-width:34px;text-align:center;font-weight:600}
.mw-saved{color:var(--mw-ok);font-size:12px}
.mw-disclaimer{margin:2px 0 0;color:var(--mw-faint);font-size:11px;line-height:1.6}
/* ---------- 页头状态 pill ---------- */
.mw-pill{display:inline-flex;align-items:center;gap:6px;padding:3px 10px;border-radius:999px;
  border:1px solid var(--mw-line);background:var(--mw-soft);font-size:12px;color:var(--mw-muted);white-space:nowrap}
/* ---------- 页签 ---------- */
.mw-tabs{display:flex;gap:2px;border-bottom:1px solid var(--mw-line);overflow-x:auto;margin-top:2px}
.mw-tab{position:relative;display:inline-flex;align-items:center;gap:6px;border:none;background:transparent;
  font-family:inherit;font-size:13px;color:var(--mw-muted);padding:8px 12px;cursor:pointer;
  border-radius:8px 8px 0 0;white-space:nowrap}
.mw-tab:hover{color:var(--mw-fg);background:var(--mw-soft)}
.mw-tab.on{color:var(--mw-fg);font-weight:600}
.mw-tab.on:after{content:'';position:absolute;left:10px;right:10px;bottom:-1px;height:2px;
  background:var(--mw-fg);border-radius:2px}
.mw-tab-n{font-size:11px;color:var(--mw-faint);font-variant-numeric:tabular-nums}
.mw-tab.on .mw-tab-n{color:var(--mw-muted)}
.mw-panel{display:flex;flex-direction:column;gap:12px;min-width:0}
/* ---------- 序数徽标（前三名金/银/铜） ---------- */
.mw-rank{display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;border-radius:8px;
  font-size:11px;font-weight:700;font-variant-numeric:tabular-nums;flex:0 0 auto}
.mw-rank-1{background:#e8b530;color:#3d2c00}
.mw-rank-2{background:#c3c9d2;color:#2f353c}
.mw-rank-3{background:#cf9a63;color:#3a2410}
.mw-rank-n{background:var(--mw-soft);color:var(--mw-faint);border:1px solid var(--mw-line)}
/* ---------- 前三名领奖台 ---------- */
.mw-podium{display:grid;grid-template-columns:repeat(auto-fit,minmax(196px,1fr));gap:10px}
.mw-pod{display:flex;flex-direction:column;gap:6px;padding:12px 14px;border:1px solid var(--mw-line);
  border-radius:12px;background:var(--mw-card);min-width:0}
.mw-pod-1{border-color:#ecd9a8;background:linear-gradient(180deg,#fffdf4,#fff)}
.mw-pod-2{border-color:#dbdfe5;background:linear-gradient(180deg,#fcfcfd,#fff)}
.mw-pod-3{border-color:#e7cfb6;background:linear-gradient(180deg,#fffaf5,#fff)}
.mw-pod-h{display:flex;align-items:center;gap:8px}
.mw-pod-r{font-size:11px;color:var(--mw-faint);font-variant-numeric:tabular-nums}
.mw-pod-slug{font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mw-pod-n{font-size:20px;font-weight:600;letter-spacing:-.3px;font-variant-numeric:tabular-nums;line-height:1.2}
.mw-pod-sub{display:flex;align-items:baseline;gap:6px;font-size:11px;color:var(--mw-faint)}
/* 榜首行与占比条 */
.mw-tr-medal td{background:#fffdf7}
.mw-bar-cell{width:92px}
.mw-bar{height:6px;border-radius:3px;background:var(--mw-soft);overflow:hidden}
.mw-bar i{display:block;height:100%;border-radius:3px;background:var(--mw-muted);opacity:.45}
.mw-bar-1 i{background:#e8b530;opacity:1}
.mw-bar-2 i{background:#b4bcc7;opacity:1}
.mw-bar-3 i{background:#cf9a63;opacity:1}
/* ---------- 源状态明细 ---------- */
.mw-srcrow{display:flex;align-items:baseline;gap:9px;min-width:0}
/* ---------- 卡内小结（总览用） ---------- */
.mw-mini{display:flex;align-items:baseline;gap:8px;padding:7px 0;border-bottom:1px solid var(--mw-line);min-width:0}
.mw-mini:last-child{border-bottom:none}
.mw-mini-t{flex:0 0 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mw-mini-s{color:var(--mw-faint);font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mw-mini-n{margin-left:auto;flex:0 0 auto;color:var(--mw-faint);font-size:11px;font-variant-numeric:tabular-nums}
.mw-link{border:none;background:transparent;color:var(--mw-info);font-family:inherit;font-size:12px;
  cursor:pointer;padding:0;margin-left:auto;white-space:nowrap}
.mw-link:hover{text-decoration:underline}
/* 卡头里「计数 + 链接」要贴在一起收在右侧：两个 margin-left:auto 会把空白对半分，计数飘到中间 */
.mw-card-h .mw-card-n+.mw-link{margin-left:2px}`;

    function injectStyle() {
      if (document.getElementById(STYLE_ID)) return () => {};
      const el = document.createElement('style');
      el.id = STYLE_ID;
      el.textContent = CSS;
      document.head.appendChild(el);
      return () => el.remove();
    }

    // ------------------------------------------------------------
    // 2) 纯函数helpers（测试从这里取，界面与测试吃同一份）
    // ------------------------------------------------------------
    /** 相对时间：刚刚 / N 分钟前 / N 小时前 / N 天前；无值说"从未"。 */
    function fmtAge(ms, nowMs) {
      if (!Number.isFinite(ms) || ms <= 0) return '从未';
      const s = Math.max(0, ((nowMs ?? Date.now()) - ms) / 1000);
      if (s < 60) return '刚刚';
      if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
      if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
      return `${Math.floor(s / 86400)} 天前`;
    }
    /** token 计数走 1000 进制（是计数不是容量；容量口径 1024 属 sysops，本插件无容量）。 */
    function fmtTokens(n) {
      const v = Number(n);
      if (!Number.isFinite(v)) return '—';
      if (v >= 1e12) return `${trimSig(v / 1e12)}T`;
      if (v >= 1e9) return `${trimSig(v / 1e9)}B`;
      if (v >= 1e6) return `${trimSig(v / 1e6)}M`;
      if (v >= 1e3) return `${trimSig(v / 1e3)}K`;
      return String(Math.round(v));
    }
    function trimSig(x) {
      if (x >= 100) return String(Math.round(x));
      if (x >= 10) return x.toFixed(1);
      return x.toFixed(2);
    }
    /** 价格：美元/1M tokens，最多 4 位有效；缺值说"—"而不是 $0（免费与未知是两回事）。 */
    function fmtPrice(v) {
      const n = Number(v);
      if (!Number.isFinite(n)) return '—';
      if (n === 0) return '$0';
      if (n >= 100) return `$${n.toFixed(0)}`;
      if (n >= 1) return `$${n.toFixed(2)}`;
      return `$${Number(n.toPrecision(3)).toString()}`;
    }
    function fmtCtx(n) {
      const v = Number(n);
      if (!Number.isFinite(v) || v <= 0) return '—';
      if (v >= 1e6) return `${trimSig(v / 1e6)}M`;
      if (v >= 1e3) return `${Math.round(v / 1e3)}K`;
      return String(v);
    }
    function fmtDate(sec) {
      const v = Number(sec);
      if (!Number.isFinite(v) || v <= 0) return '—';
      const d = new Date(v * 1000);
      const p = (x) => String(x).padStart(2, '0');
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
    }
    /** 名次变化：只在宿主给了 delta 时说话；没给就是"新见"，不冒充持平。 */
    function deltaCell(d) {
      if (Number.isFinite(d) && d > 0) return { text: `▲${d}`, cls: 'mw-up' };
      if (Number.isFinite(d) && d < 0) return { text: `▼${-d}`, cls: 'mw-down' };
      if (d === 0) return { text: '—', cls: 'mw-flat' };
      return { text: '新见', cls: 'mw-flat' };
    }
    function kindLabel(kind) {
      const map = cfg().eventKindLabels || {};
      return map[kind] || kind;
    }
    /** 合并 = 整体替换快照。update 帧就是 GET snapshot 的同形载荷，凭空补字段一律禁止（S17 教训）。 */
    function mergeFrame(prev, frame) {
      if (frame && typeof frame === 'object' && frame.kind === 'event') return prev;
      return frame && typeof frame === 'object' ? frame : prev;
    }

    async function api(path, opts = {}) {
      const res = await fetch(`${API_BASE()}${path}`, opts);
      const body = await res.json().catch(() => null);
      if (!res.ok || !body || body.ok !== true) {
        const msg = body?.error?.message || `HTTP ${res.status}`;
        throw Object.assign(new Error(msg), { code: body?.error?.code });
      }
      return body.data;
    }

    async function consumeSse(res, onEvent) {
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        buf += dec.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const raw = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          let ev = 'message';
          const dataLines = [];
          for (const line of raw.split('\n')) {
            if (line.startsWith(':')) continue;
            if (line.startsWith('event:')) ev = line.slice(6).trim();
            else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
          }
          if (!dataLines.length) continue;
          try { onEvent(ev, JSON.parse(dataLines.join('\n'))); } catch { /* 坏帧丢弃：下一帧会是全量快照 */ }
        }
      }
    }

    function useStream(setSnap, setConn) {
      const stopRef = useRef(false);
      useEffect(() => {
        stopRef.current = false;
        let retry = null;
        (async function loop() {
          while (!stopRef.current) {
            try {
              const res = await fetch(`${API_BASE()}/stream`);
              if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
              setConn({ ok: true, note: '' });
              await consumeSse(res, (ev, data) => {
                if (ev === 'snapshot' || ev === 'update') setSnap((prev) => mergeFrame(prev, data));
              });
              if (!stopRef.current) setConn({ ok: false, note: '推流断开，正在重连' });
            } catch (e) {
              if (!stopRef.current) setConn({ ok: false, note: `推流不可用：${e?.message ?? e}（点「立即检查」后需刷新页面）` });
            }
            if (stopRef.current) break;
            await new Promise((r) => { retry = setTimeout(r, 5000); });
          }
        })();
        return () => { stopRef.current = true; if (retry) clearTimeout(retry); };
      }, []);
    }

    // ------------------------------------------------------------
    // 3) 四卡 + 设置条
    // ------------------------------------------------------------
    /** 页签表：只放界面结构，判定口径仍然全部来自宿主载荷。 */
    const TABS = [
      { id: 'overview', label: '总览' },
      { id: 'top', label: '热门周榜' },
      { id: 'new', label: '新上模型' },
      { id: 'events', label: '变化记录' },
      { id: 'settings', label: '设置' },
    ];

    /** 页头：标题 + 数据源摘要 + 唯一的主操作（总览里不再放按钮 —— 一个功能只留一个入口）。 */
    function Header({ snap, conn, checking, lastErr, onCheck }) {
      const src = snap?.sources || {};
      const NAMES = { models: '清单源', rankings: '榜单源' };
      const bad = Object.keys(NAMES).filter((k) => src[k] && !src[k].ok);
      const absent = Object.keys(NAMES).filter((k) => !src[k]);
      let dot = 'mw-dot';
      let text = '等待首帧';
      if (snap) {
        if (bad.length) { dot = 'mw-dot mw-dot-err'; text = `${bad.map((k) => NAMES[k]).join('、')}故障`; }
        else if (absent.length) { dot = 'mw-dot mw-dot-warn'; text = '部分源未就位'; }
        else { dot = 'mw-dot mw-dot-ok'; text = '数据源全部在位'; }
      }
      const tip = [
        bad.map((k) => `${NAMES[k]}：${src[k].error || '原因未给出'}`).join('；'),
        lastErr ? `检查失败：${lastErr}` : '',
        conn && !conn.ok && conn.note ? conn.note : '',
      ].filter(Boolean).join('；');
      return h('header', { className: 'mw-head' },
        h('div', { className: 'mw-head-l' },
          h('span', { className: 'mw-title' }, cfg().label || '模型监控'),
          h('span', { className: 'mw-sub' }, 'OpenRouter 新上模型与热门周榜 · 全程只读 GET')),
        h('div', { className: 'mw-head-r' },
          h('span', { className: 'mw-pill', title: tip || undefined }, h('i', { className: dot }), text),
          snap ? h('span', { className: 'mw-sub mw-num' }, `检查于 ${fmtAge(snap.at, Date.now())} · 模型总数 ${snap.models?.count ?? '—'}`) : null,
          h('button', { className: 'mw-btn mw-btn-main', disabled: checking || !snap, onClick: onCheck },
            checking ? '检查中…' : '立即检查')));
    }

    /** 数据源状态明细（总览页顶部）。主操作只在页头，这里不重复放按钮。 */
    function StatusCard({ snap, conn, lastErr }) {
      const src = snap?.sources || {};
      const row = (label, s) => (s
        ? h('div', { key: label, className: 'mw-srcrow' },
            h('i', { className: `mw-dot ${s.ok ? 'mw-dot-ok' : 'mw-dot-err'}` }),
            h('b', null, label),
            h('span', {
              className: `mw-sub${s.ok ? ' mw-num' : ''}`,
              title: s.ok ? '' : (s.error || ''),
            }, s.ok ? `在位 · 上次成功 ${fmtAge(s.checkedAt, snap.at)}` : `故障 · ${s.error || '原因未给出'}`))
        : null);
      const notices = [
        snap && snap.storage && !snap.storage.available
          ? h('div', { key: 'storage', className: 'mw-notice mw-notice-err' }, '存储不可用：监控照跑，但本轮变化无法留痕，偏好改动不落库') : null,
        conn && !conn.ok && conn.note ? h('div', { key: 'conn', className: 'mw-notice' }, conn.note) : null,
        lastErr ? h('div', { key: 'lastErr', className: 'mw-notice mw-notice-err' }, `检查失败：${lastErr}`) : null,
      ].filter(Boolean);
      return h('section', { className: 'mw-card' },
        h('div', { className: 'mw-card-h' },
          h('span', { className: 'mw-card-t' }, '数据源状态'),
          h('span', { className: 'mw-card-n mw-num' },
            snap ? `检查于 ${fmtAge(snap.at, Date.now())} · 模型总数 ${snap.models?.count ?? '—'}` : '等待首帧')),
        h('div', { className: 'mw-card-b' },
          row('官方清单 API', src.models),
          row('热门周榜（非官方源）', src.rankings),
          notices.length ? notices : null));
    }

    /** 序数徽标：1/2/3 金/银/铜，其余中性。 */
    function RankBadge({ rank }) {
      const n = Number(rank);
      const medal = Number.isFinite(n) && n >= 1 && n <= 3;
      return h('span', {
        className: medal ? `mw-rank mw-rank-${n}` : 'mw-rank mw-rank-n',
        title: medal ? `第 ${n} 名` : '',
      }, String(rank));
    }

    /** 卡内小结（总览页底部两块）：只放前几条，其余靠「全部 →」切页签。 */
    function MiniList({ title, total, onGo, empty, children }) {
      const items = (Array.isArray(children) ? children : [children]).filter(Boolean);
      return h('section', { className: 'mw-card' },
        h('div', { className: 'mw-card-h' },
          h('span', { className: 'mw-card-t' }, title),
          h('span', { className: 'mw-card-n mw-num' }, `${total} 条`),
          h('button', { className: 'mw-link', onClick: onGo }, '全部 →')),
        items.length ? h('div', { className: 'mw-card-b' }, items) : h('p', { className: 'mw-empty' }, empty));
    }

    /** 本周前三：三张并排卡，金/银/铜徽标 + 大号 token 数。 */
    function Podium({ snap, onGo }) {
      const rows = (snap?.top?.rows || []).slice(0, 3);
      return h('section', { className: 'mw-card' },
        h('div', { className: 'mw-card-h' },
          h('span', { className: 'mw-card-t' }, '本周前三'),
          h('span', { className: 'mw-card-n' }, '非官方源'),
          h('button', { className: 'mw-link', onClick: () => onGo('top') }, '完整榜单 →')),
        rows.length
          ? h('div', { className: 'mw-card-b' }, h('div', { className: 'mw-podium' }, rows.map((r, i) => {
              const dd = deltaCell(r.delta);
              return h('div', { key: r.slug, className: `mw-pod mw-pod-${i + 1}` },
                h('div', { className: 'mw-pod-h' },
                  h(RankBadge, { rank: i + 1 }),
                  h('span', { className: 'mw-pod-r' }, `榜内第 ${r.rank} 名`)),
                h('div', { className: 'mw-pod-slug', title: r.slug }, r.slug),
                h('div', { className: 'mw-pod-n' }, fmtTokens(r.tokens)),
                h('div', { className: 'mw-pod-sub' },
                  h('span', null, '较上轮'),
                  h('span', { className: dd.cls }, dd.text)));
            })))
          : h('p', { className: 'mw-empty' }, '还没有成功解析过周榜数据'));
    }

    function TabBar({ tab, onTab, snap }) {
      const counts = {
        top: (snap?.top?.rows || []).length,
        new: (snap?.models?.newThisWeek || []).length,
        events: (snap?.events || []).length,
      };
      return h('nav', { className: 'mw-tabs' }, TABS.map((t) =>
        h('button', {
          key: t.id,
          className: `mw-tab${tab === t.id ? ' on' : ''}`,
          onClick: () => onTab(t.id),
        }, t.label, counts[t.id] ? h('span', { className: 'mw-tab-n mw-num' }, String(counts[t.id])) : null)));
    }

    /** 总览：源状态 → 本周前三 → 新上 / 变化各取前几条。 */
    function OverviewTab({ snap, conn, lastErr, onGo }) {
      const showDays = cfg().showDays || 7;
      const allNew = snap?.models?.newThisWeek || [];
      const allEv = snap?.events || [];
      return h('div', { className: 'mw-panel' },
        h(StatusCard, { snap, conn, lastErr }),
        h(Podium, { snap, onGo }),
        h('div', { className: 'mw-cols' },
          h(MiniList, { title: `近 ${showDays} 天新上`, total: allNew.length, onGo: () => onGo('new'), empty: `近 ${showDays} 天没有新上模型` },
            allNew.slice(0, 3).map((r) => h('div', { key: r.id, className: 'mw-mini' },
              h('span', { className: 'mw-mini-t', title: r.id }, r.name),
              h('span', { className: 'mw-mini-s' }, fmtDate(r.created)),
              h('span', { className: 'mw-mini-n' }, `${fmtCtx(r.contextLength)} · ${fmtPrice(r.priceInM)}`)))),
          h(MiniList, { title: '最近变化', total: allEv.length, onGo: () => onGo('events'), empty: '还没有记录' },
            allEv.slice(0, 4).map((e) => h('div', { key: e.id, className: 'mw-mini' },
              h('span', { className: 'mw-mini-t' }, kindLabel(e.kind)),
              h('span', { className: 'mw-mini-s' }, e.slug || e.detail || ''),
              h('span', { className: 'mw-mini-n mw-num' }, fmtAge(e.at, snap?.at)))))));
    }

    function NewModelsCard({ snap, showDays }) {
      const rows = snap?.models?.newThisWeek ?? [];
      return h('section', { className: 'mw-card' },
        h('div', { className: 'mw-card-h' },
          h('span', { className: 'mw-card-t' }, `近 ${showDays} 天新上`),
          h('span', { className: 'mw-card-n mw-num' }, `${rows.length} 个`)),
        snap?.models?.firstRun
          ? h('div', { className: 'mw-card-b' }, h('div', { className: 'mw-notice' }, '首轮建档：上架/下架对比从下一轮开始')) : null,
        rows.length
          ? h('table', { className: 'mw-tbl' },
              h('colgroup', null,
                h('col', null), h('col', { style: { width: 112 } }), h('col', { style: { width: 92 } }),
                h('col', { style: { width: 104 } }), h('col', { style: { width: 104 } })),
              h('thead', null, h('tr', null,
                h('th', null, '模型'), h('th', { className: 'mw-r' }, '上架'), h('th', { className: 'mw-r' }, '上下文'),
                h('th', { className: 'mw-r' }, '输入 $/1M'), h('th', { className: 'mw-r' }, '输出 $/1M'))),
              h('tbody', null, rows.map((r) => h('tr', { key: r.id },
                h('td', null,
                  h('span', { className: 'mw-name', title: r.id }, r.name),
                  h('span', { className: 'mw-slug' }, r.id)),
                h('td', { className: 'mw-r mw-num' }, fmtDate(r.created)),
                h('td', { className: 'mw-r mw-num' }, fmtCtx(r.contextLength)),
                h('td', { className: 'mw-r mw-num' }, fmtPrice(r.priceInM)),
                h('td', { className: 'mw-r mw-num' }, fmtPrice(r.priceOutM))))))
          : h('p', { className: 'mw-empty' }, `近 ${showDays} 天没有新上模型`),
        h('p', { className: 'mw-note' }, '口径：官方清单 API 的 created 时间戳，含 :batch 等变体行'));
    }

    function TopCard({ snap }) {
      const rows = snap?.top?.rows ?? [];
      const rk = snap?.sources?.rankings;
      const stale = rk && !rk.ok && rows.length > 0;
      // 量级条按榜首归一：一眼看出第 1 名和第 15 名差多少（纯文本列看不出来）
      const maxTok = rows.reduce((m, r) => Math.max(m, Number(r.tokens) || 0), 0) || 1;
      return h('section', { className: 'mw-card' },
        h('div', { className: 'mw-card-h' },
          h('span', { className: 'mw-card-t' }, '热门周榜'),
          h('span', { className: 'mw-card-n mw-num' }, `${rows.length} 条`)),
        stale
          ? h('div', { className: 'mw-card-b' },
              h('div', { className: 'mw-notice mw-notice-err' }, `本轮榜单源故障：${rk.error || '原因未给出'}；下面显示的是上次成功数据`))
          : null,
        rows.length
          ? h('table', { className: 'mw-tbl' },
              h('colgroup', null,
                h('col', { style: { width: 46 } }), h('col', null),
                h('col', { style: { width: 84 } }), h('col', { style: { width: 92 } }), h('col', { style: { width: 76 } })),
              h('thead', null, h('tr', null,
                h('th', null, '#'), h('th', null, '模型'), h('th', { className: 'mw-r' }, '周 token'),
                h('th', null, '量级'), h('th', { className: 'mw-r' }, '较上轮'))),
              h('tbody', null, rows.map((r) => {
                const dd = deltaCell(r.delta);
                const medal = Number(r.rank) >= 1 && Number(r.rank) <= 3;
                const pct = Math.max(4, Math.round(((Number(r.tokens) || 0) / maxTok) * 100));
                return h('tr', { key: r.slug, className: medal ? 'mw-tr-medal' : '' },
                  h('td', { className: 'mw-r' }, h(RankBadge, { rank: r.rank })),
                  h('td', { className: 'mw-name', title: r.slug }, r.slug),
                  h('td', { className: 'mw-r mw-num' }, fmtTokens(r.tokens)),
                  h('td', null, h('div', { className: `mw-bar mw-bar-${medal ? r.rank : 'n'}` },
                    h('i', { style: { width: `${pct}%` } }))),
                  h('td', { className: `mw-r mw-num ${dd.cls}` }, dd.text));
              })))
          : h('p', { className: 'mw-empty' }, '还没有成功解析过周榜数据'),
        h('p', { className: 'mw-note' },
          `${snap?.top?.note || '来源文案未就位'} · 名次差按上一轮周榜计算，「新见」= 上轮不在榜或首轮无对比`));
    }

    function EventsCard({ snap }) {
      const evs = snap?.events ?? [];
      return h('section', { className: 'mw-card' },
        h('div', { className: 'mw-card-h' },
          h('span', { className: 'mw-card-t' }, '变化记录'),
          h('span', { className: 'mw-card-n mw-num' }, `${evs.length} 条`)),
        evs.length
          ? h('div', { className: 'mw-scroll' }, h('ul', { className: 'mw-tl' }, evs.map((e) =>
              h('li', { key: e.id, 'data-kind': e.kind },
                h('span', { className: 'mw-chip' }, kindLabel(e.kind)),
                h('span', { className: 'mw-tl-body' },
                  e.slug || e.detail || '',
                  e.slug && e.detail ? h('span', { className: 'mw-sub' }, e.detail) : null),
                h('span', { className: 'mw-ago mw-num' }, fmtAge(e.at, snap?.at))))))
          : h('p', { className: 'mw-empty' }, snap && snap.storage && !snap.storage.available
              ? '存储不可用，变化不会留痕'
              : '还没有记录：第一轮检查只建档，之后每次变化都会落在这里'));
    }

    /** 设置页：可改的三项 + 只读的运行环境（能力表来自宿主快照，不自己编）。 */
    function SettingsBar({ snap, saving, savedNote, onInterval, onSave }) {
      const intervals = cfg().intervals || [];
      const labels = cfg().intervalLabels || {};
      const cur = snap?.prefs?.intervalMin;
      const range = cfg().topNRange || { min: 5, max: 20 };
      const topN = snap?.prefs?.topN ?? range.min;
      const evRange = cfg().keepEventsRange || { min: 50, max: 2000, step: 100 };
      const keep = snap?.prefs?.keepEvents ?? evRange.min;
      const caps = snap?.capabilityRows || [];
      if (!intervals.length) {
        return h('section', { className: 'mw-card' },
          h('div', { className: 'mw-card-b' },
            h('div', { className: 'mw-notice' }, '配置未就位：宿主载荷还没到，刷新页面试试')));
      }
      const bump = (key, v, min, max, dx) => onSave({ [key]: Math.min(max, Math.max(min, v + dx)) });
      const stepper = (key, v, min, max, dx, unit) => [
        h('button', { key: 'm', className: 'mw-btn mw-step', disabled: v <= min, onClick: () => bump(key, v, min, max, -dx) }, '−'),
        h('span', { key: 'v', className: 'mw-num mw-count' }, String(v)),
        h('button', { key: 'p', className: 'mw-btn mw-step', disabled: v >= max, onClick: () => bump(key, v, min, max, dx) }, '+'),
        h('span', { key: 'u', className: 'mw-sub mw-num' }, unit),
      ];
      return h('div', { className: 'mw-panel' },
        h('section', { className: 'mw-card' },
          h('div', { className: 'mw-card-h' },
            h('span', { className: 'mw-card-t' }, '监测频率与容量'),
            h('span', { className: 'mw-card-n' }, '改动即生效'),
            saving ? h('span', { className: 'mw-card-n mw-num' }, '保存中…') : null,
            savedNote ? h('span', { className: 'mw-saved mw-num' }, savedNote) : null),
          h('div', { className: 'mw-card-b' },
            h('div', { className: 'mw-setrow' },
              h('span', { className: 'mw-setlabel' }, '检查间隔'),
              h('span', { className: 'mw-seg' }, intervals.map((v) =>
                h('button', { key: v, className: v === cur ? 'on' : '', onClick: () => onInterval(v) }, labels[v] || `${v} 分`)))),
            h('div', { className: 'mw-setrow' },
              h('span', { className: 'mw-setlabel' }, '榜单条数'),
              stepper('topN', topN, range.min, range.max, 1, `条（${range.min}–${range.max}）`)),
            h('div', { className: 'mw-setrow' },
              h('span', { className: 'mw-setlabel' }, '事件保留'),
              stepper('keepEvents', keep, evRange.min, evRange.max, evRange.step || 100,
                `条（超出裁老，${evRange.min}–${evRange.max}）`)))),
        h('section', { className: 'mw-card' },
          h('div', { className: 'mw-card-h' },
            h('span', { className: 'mw-card-t' }, '运行环境'),
            h('span', { className: 'mw-card-n' }, '宿主能力 · 只读')),
          caps.length
            ? h('div', { className: 'mw-card-b' }, caps.map((r) => h('div', { key: r.key, className: 'mw-srcrow' },
                h('i', { className: `mw-dot ${r.ok ? 'mw-dot-ok' : 'mw-dot-err'}` }),
                h('b', null, r.label),
                h('span', { className: 'mw-sub', title: r.ok ? '' : (r.detail || r.fallback || '') },
                  r.ok ? '在位' : (r.detail || r.fallback || '不可用')))))
            : h('p', { className: 'mw-empty' }, '当前快照没有带回能力表')));
    }

    function ModelwatchPanelIcon() {
      return h('svg', { width: 20, height: 20, viewBox: '0 0 20 20', fill: 'none' },
        h('circle', { cx: 10, cy: 10, r: 7.5, stroke: 'currentColor', strokeWidth: 1.5 }),
        h('path', { d: 'M6 11.5l2.5-3 2 2L14 7', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round' }));
    }

    function ModelwatchPage() {
      const [snap, setSnap] = useState(null);
      const [conn, setConn] = useState({ ok: false, note: '' });
      const [checking, setChecking] = useState(false);
      const [lastErr, setLastErr] = useState('');
      const [saving, setSaving] = useState(false);
      const [savedNote, setSavedNote] = useState('');
      const [tab, setTab] = useState('overview');
      useStream(setSnap, setConn);

      async function doCheck() {
        setChecking(true); setLastErr('');
        try {
          const r = await api('/check', { method: 'POST' });
          if (!conn.ok) setSnap(await api('/snapshot'));
          const n = Object.values(r.produced || {}).reduce((a, b) => a + b, 0);
          setSavedNote(`本轮 ${new Date(r.at).toLocaleTimeString()} 完成，记录 ${n} 项变化`);
        } catch (e) {
          setLastErr(e?.message ?? String(e));
        } finally {
          setChecking(false);
        }
      }
      async function savePrefs(patch) {
        setSaving(true); setSavedNote('');
        try {
          setSnap((p) => mergeFrame(p, { ...(p || {}), prefs: { ...(p?.prefs || {}), ...patch } }));
          const saved = await api('/prefs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) });
          setSnap((p) => (p ? { ...p, prefs: saved } : p));
          setSavedNote('已保存');
        } catch (e) {
          setSavedNote(`保存失败：${e?.message ?? e}`);
        } finally {
          setSaving(false);
        }
      }

      const showDays = cfg().showDays || 7;
      let panel;
      if (tab === 'top') panel = h(TopCard, { snap });
      else if (tab === 'new') panel = h(NewModelsCard, { snap, showDays });
      else if (tab === 'events') panel = h(EventsCard, { snap });
      else if (tab === 'settings') panel = h(SettingsBar, { snap, saving, savedNote, onInterval: (v) => savePrefs({ intervalMin: v }), onSave: (p) => savePrefs(p) });
      else panel = h(OverviewTab, { snap, conn, lastErr, onGo: setTab });

      return h('div', { className: 'mw-root' },
        h(Header, { snap, conn, checking, lastErr, onCheck: doCheck }),
        h(TabBar, { tab, onTab: setTab, snap }),
        h('div', { className: 'mw-panel' }, panel),
        h('p', { className: 'mw-disclaimer' },
          '本插件不发起任何对话、不代理请求、不推送外部通知；唯一出网动作是每轮检查对 openrouter.ai 的两次只读 GET。'));
    }

    // ------------------------------------------------------------
    // 4) apply：入口注册
    // ------------------------------------------------------------
    function apply(ctx) {
      if (!cfg().routePrefix) return; // 没路由前缀 = 没 webServer：一个入口都不注册
      ctx.effect(() => injectStyle(), 'modelwatch:style');
      ctx.slots.inject('sidebar.panellist', () =>
        ctx.slots.register(
          { name: 'sidebar.panellist', id: PANEL_ID, order: PANEL_ORDER(), label: () => cfg().label || '模型监控' },
          ModelwatchPanelIcon,
        ));
      ctx.slots.inject('main', () =>
        ctx.slots.register({ name: 'main', key: PANEL_ID }, ModelwatchPage));
    }

    exports.apply = apply;
    exports.inject = ['slots'];
    exports.PANEL_ID = PANEL_ID;
    exports.__test = { cfg, API_BASE, fmtAge, fmtTokens, fmtPrice, fmtCtx, fmtDate, deltaCell, kindLabel, mergeFrame, api, consumeSse, TABS, components: { Header, TabBar, OverviewTab, StatusCard, Podium, RankBadge, MiniList, NewModelsCard, TopCard, EventsCard, SettingsBar, ModelwatchPage } };
    // 宿主 ModuleLoader 吃的是 factory 的**返回值**当模块导出（sysops 同形）：
    // 返回 module 会让外层拿不到 apply ⇒ 真机 web-boot 直接 "invalid plugin, received object"。
    return module.exports;
  },
});
