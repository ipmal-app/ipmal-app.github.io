/* 사진 번역 — 폰 안에서 글자 위치까지 인식(Tesseract.js, 오픈소스)하고
 * 사진 위 같은 자리에 번역문을 덮어 그림 (구글 렌즈 방식)
 * - 엔진·언어 파일은 사이트 안(vendor/tesseract)에 있어 외부 CDN 불필요, 한 번 받으면 브라우저에 저장
 * - 사진은 서버로 보내지 않음 (읽어낸 글자만 번역을 위해 전송) */
const OCR = (() => {
  const BASE = new URL('vendor/tesseract/', location.href).href;
  const MAP = { ko: 'kor', vi: 'vie', en: 'eng', zh: 'chi_sim', ja: 'jpn' };
  let worker = null, wkey = '', loading = null;

  function loadLib() {
    if (window.Tesseract) return Promise.resolve();
    if (loading) return loading;
    loading = new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = BASE + 'tesseract.min.js';
      s.onload = res;
      s.onerror = () => { loading = null; rej(new Error('OCR engine load failed')); };
      document.head.appendChild(s);
    });
    return loading;
  }

  let progFn = null;   // 현재 진행률 표시 함수(1차 0~60%, 2차 60~100%)
  async function getWorker(langs, onProg) {
    progFn = onProg;
    await loadLib();
    const key = langs.join('+');
    if (worker && wkey === key) return worker;
    if (worker) { try { await worker.terminate(); } catch (e) {} worker = null; }
    worker = await Tesseract.createWorker(langs, 1, {
      workerPath: BASE + 'worker.min.js', corePath: BASE + 'core', langPath: BASE + 'lang', gzip: true,
      logger: m => { if (progFn && m && typeof m.progress === 'number') progFn(m.status || '', m.progress); }
    });
    wkey = key;
    return worker;
  }

  /* 사진 언어 → 엔진 언어 (숫자·영문이 섞인 메뉴가 많아 영어를 함께 읽음) */
  function langsFor(sl, fallback) {
    const l = sl === 'auto' ? fallback : sl;
    const out = [MAP[l] || 'eng'];
    if (out[0] !== 'eng') out.push('eng');
    return out;
  }

  const CJK = /[぀-ヿ㐀-鿿가-힯]/;
  /* 한·중·일 글자 사이에 엔진이 넣은 빈칸 제거 */
  function tidy(s) {
    s = String(s || '').replace(/\s+/g, ' ').trim();
    return s.replace(/([぀-ヿ㐀-鿿]) (?=[぀-ヿ㐀-鿿])/g, '$1');
  }

  /* 한 줄 안에서 단어 사이가 크게 벌어진 곳(메뉴 이름 …… 가격)은 따로 나눔 */
  function segmentsOf(data) {
    const segs = [];
    (data.lines || []).forEach(line => {
      const words = (line.words || []).filter(w => w.text && w.text.trim());
      if (!words.length) return;
      const lh = Math.max(8, line.bbox.y1 - line.bbox.y0);
      let cur = null;
      words.forEach(w => {
        if (cur && w.bbox.x0 - cur.x1 > lh * 1.4) { segs.push(cur); cur = null; }
        if (!cur) cur = { x0: w.bbox.x0, y0: w.bbox.y0, x1: w.bbox.x1, y1: w.bbox.y1, words: [], conf: [] };
        cur.words.push(w.text); cur.conf.push(w.confidence);
        cur.x0 = Math.min(cur.x0, w.bbox.x0); cur.y0 = Math.min(cur.y0, w.bbox.y0);
        cur.x1 = Math.max(cur.x1, w.bbox.x1); cur.y1 = Math.max(cur.y1, w.bbox.y1);
      });
      if (cur) segs.push(cur);
    });
    return segs.map(s => {
      const text = tidy(s.words.join(' '));
      const conf = s.conf.reduce((a, b) => a + b, 0) / s.conf.length;
      const letters = /\p{L}/u.test(text);
      return { x0: s.x0, y0: s.y0, x1: s.x1, y1: s.y1, src: text, conf, keep: !letters };   // keep: 숫자·기호만 → 번역 안 하고 원본 유지
    }).filter(s => s.src && (s.keep || (s.conf >= 45 && s.src.replace(/[^\p{L}]/gu, '').length >= (CJK.test(s.src) ? 1 : 2))));
  }

  async function pass(w, image, psm) {
    await w.setParameters({ tessedit_pageseg_mode: psm });
    const { data } = await w.recognize(image, {}, { blocks: true, text: true });
    if (!data.lines && data.blocks) {   // 엔진 버전에 따라 줄 정보가 blocks 안에만 있을 때
      data.lines = [];
      data.blocks.forEach(b => (b.paragraphs || []).forEach(p => (p.lines || []).forEach(l => data.lines.push(l))));
    }
    return segmentsOf(data);
  }
  const overlap = (a, b) => {
    const w = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0), h = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
    if (w <= 0 || h <= 0) return 0;
    return (w * h) / Math.min((a.x1 - a.x0) * (a.y1 - a.y0), (b.x1 - b.x0) * (b.y1 - b.y0));
  };
  /* 1차: 자동 배치(제목·문단에 강함) → 2차: 흩어진 글자 모드(테두리 상자·표 안 글자) 중 1차에 없던 것만 추가 */
  async function recognize(image, sl, fallback, onProg) {
    const w = await getWorker(langsFor(sl, fallback), onProg);
    const ph = (a, b) => { progFn = onProg ? (st, p) => onProg(st, /recogniz/i.test(st) ? a + (b - a) * p : p) : null; };
    ph(0, 0.6);
    const segs = await pass(w, image, '3');
    ph(0.6, 1);
    try {
      (await pass(w, image, '11')).forEach(s => { if (!segs.some(o => overlap(o, s) > 0.3)) segs.push(s); });
    } catch (e) { /* 2차 실패 시 1차 결과만 사용 */ }
    const cy = s => (s.y0 + s.y1) / 2, sameRow = (a, b) => Math.abs(cy(a) - cy(b)) < Math.min(a.y1 - a.y0, b.y1 - b.y0) * 0.5;
    return segs.sort((a, b) => sameRow(a, b) ? a.x0 - b.x0 : cy(a) - cy(b));
  }

  /* ---------- 사진 위에 번역문 그리기 ---------- */
  function avgColor(px, w, h, x0, y0, x1, y1) {
    let r = 0, g = 0, b = 0, n = 0;
    const add = (x, y) => { if (x < 0 || y < 0 || x >= w || y >= h) return; const i = (y * w + x) * 4; r += px[i]; g += px[i + 1]; b += px[i + 2]; n++; };
    const step = Math.max(1, Math.round((x1 - x0) / 40));
    for (let x = x0; x <= x1; x += step) { add(x, y0); add(x, y1); }
    for (let y = y0; y <= y1; y += Math.max(1, Math.round((y1 - y0) / 8))) { add(x0, y); add(x1, y); }
    return n ? [r / n, g / n, b / n] : [255, 255, 255];
  }
  /* 원문 글자색: 상자 안에서 배경과 가장 다른 픽셀들의 평균 (빨간 가격·흰 제목 등 원래 색 유지) */
  function inkColor(px, w, s, bg) {
    const pts = [], sx = Math.max(1, Math.round((s.x1 - s.x0) / 60)), sy = Math.max(1, Math.round((s.y1 - s.y0) / 14));
    for (let y = s.y0; y < s.y1; y += sy) for (let x = s.x0; x < s.x1; x += sx) {
      const i = (y * w + x) * 4, d = Math.abs(px[i] - bg[0]) + Math.abs(px[i + 1] - bg[1]) + Math.abs(px[i + 2] - bg[2]);
      pts.push([d, px[i], px[i + 1], px[i + 2]]);
    }
    if (pts.length < 10) return null;
    pts.sort((a, b) => b[0] - a[0]);
    const top = pts.slice(0, Math.max(3, pts.length >> 4));
    if (top[top.length - 1][0] < 90) return null;   // 대비가 약하면 기본(검정/흰색)
    const m = k => Math.round(top.reduce((a, p) => a + p[k], 0) / top.length);
    return `rgb(${m(1)},${m(2)},${m(3)})`;
  }
  function fit(ctx, text, w, h, family, maxSize) {
    for (let size = Math.floor(Math.min(h * 0.82, maxSize || 1e9)); size >= 9; size--) {   // 한 줄로 맞추기
      ctx.font = `600 ${size}px ${family}`;
      if (ctx.measureText(text).width <= w * 1.02) return { size, lines: [text] };
      if (size < h * 0.55) break;
    }
    const words = text.split(/(\s+)/), cjk = CJK.test(text);   // 두 줄로 나누기
    const units = cjk && words.length < 3 ? [...text] : words;
    for (let size = Math.floor(h * 0.44); size >= 8; size--) {
      ctx.font = `600 ${size}px ${family}`;
      const lines = []; let cur = '';
      units.forEach(u => { const tryS = cur + u; if (ctx.measureText(tryS.trim()).width > w && cur.trim()) { lines.push(cur.trim()); cur = u; } else cur = tryS; });
      if (cur.trim()) lines.push(cur.trim());
      if (lines.length <= 2 && lines.every(l => ctx.measureText(l).width <= w * 1.02)) return { size, lines };
    }
    ctx.font = `600 8px ${family}`;
    return { size: 8, lines: [text] };
  }
  /* img: 원본(Image), segs: [{x0..y1, src, dst, keep}] → 번역이 덮인 canvas */
  function paint(img, segs) {
    const W = img.naturalWidth, H = img.naturalHeight;
    const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
    const ctx = cv.getContext('2d');
    ctx.drawImage(img, 0, 0, W, H);
    const px = ctx.getImageData(0, 0, W, H).data;
    const family = getComputedStyle(document.body).fontFamily || 'sans-serif';
    // 줄 높이 중앙값: 대문자·윗점이 없는 줄(예: "Phở bò tái")이 작게 잡혀 번역 글자가 작아지는 것 보정
    const hs = segs.map(s => s.y1 - s.y0).sort((a, b) => a - b), medH = hs[hs.length >> 1] || 0;
    segs.forEach(s => {
      if (s.keep || !s.dst) return;
      let sy0 = s.y0, sy1 = s.y1;
      if (sy1 - sy0 < medH * 0.9 && sy1 - sy0 > medH * 0.6) { const d = (medH - (sy1 - sy0)) / 2; sy0 -= d; sy1 += d; }
      const h = sy1 - sy0, pad = Math.round(h * 0.18);
      const x0 = Math.max(0, s.x0 - pad), y0 = Math.max(0, Math.round(sy0 - pad)), y1 = Math.min(H - 1, Math.round(sy1 + pad));
      let x1 = Math.min(W - 1, s.x1 + pad);
      // 번역문이 원문보다 길면 같은 줄 오른쪽 빈 공간(다음 글자 전까지)으로 넓힘
      ctx.font = `600 ${Math.floor(h * 0.9)}px ${family}`;
      const need = x0 + pad * 2 + ctx.measureText(s.dst).width;
      if (need > x1) {
        let room = W - 1 - pad;
        segs.forEach(o => { if (o !== s && o.x0 >= s.x1 && o.y0 < s.y1 && o.y1 > s.y0) room = Math.min(room, o.x0 - pad * 2); });
        x1 = Math.round(Math.max(x1, Math.min(need, room)));
      }
      const [r, g, b] = avgColor(px, W, H, x0, y0, x1, y1);
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      ctx.fillStyle = `rgba(${r | 0},${g | 0},${b | 0},1)`;
      const rr = Math.min(8, h * 0.25);
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(x0, y0, x1 - x0, y1 - y0, rr); else ctx.rect(x0, y0, x1 - x0, y1 - y0);
      ctx.fill();
      const bw = x1 - x0 - pad, bh = y1 - y0;
      const f = fit(ctx, s.dst, bw, bh, family, h * 0.88);   // 원문 글자보다 커지지 않게
      ctx.fillStyle = inkColor(px, W, s, [r, g, b]) || (lum > 140 ? '#14181F' : '#FFFFFF');
      ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
      ctx.font = `600 ${f.size}px ${family}`;
      const lineH = f.size * 1.08, top = y0 + bh / 2 - (lineH * (f.lines.length - 1)) / 2;
      f.lines.forEach((l, i) => ctx.fillText(l, x0 + pad / 2, top + i * lineH));
    });
    return cv;
  }

  return { recognize, paint, available: () => !!window.Tesseract };
})();
