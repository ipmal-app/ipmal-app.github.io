/* 사진 번역 — 폰 안에서 글자 위치까지 인식(Tesseract.js, 오픈소스)하고
 * 사진 위 같은 자리에 번역문을 덮어 그림 (구글 렌즈 방식)
 * - 엔진·언어 파일은 사이트 안(vendor/tesseract)에 있어 외부 CDN 불필요, 한 번 받으면 브라우저에 저장
 * - 사진은 서버로 보내지 않음 (읽어낸 글자만 번역을 위해 전송) */
const OCR = (() => {
  const BASE = new URL('vendor/tesseract/', location.href).href;
  const MAP = { ko: 'kor', vi: 'vie', en: 'eng', zh: 'chi_sim', ja: 'jpn' };
  let loading = null;

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

  /* 엔진 2개를 동시에 돌려(코어 4개 이상 기기) 1차·2차 인식을 병렬 처리 → 시간 절반 */
  let progFn = null;
  const pool = [];   // [{w, key}]
  async function getWorker(langs, onProg, idx = 0) {
    progFn = onProg;
    await loadLib();
    const key = langs.join('+');
    if (pool[idx] && pool[idx].key === key) return pool[idx].w;
    if (pool[idx]) { try { await pool[idx].w.terminate(); } catch (e) {} pool[idx] = null; }
    const w = await Tesseract.createWorker(langs, 1, {
      workerPath: BASE + 'worker.min.js', corePath: BASE + 'core', langPath: BASE + 'lang', gzip: true,
      logger: m => { if (idx === 0 && progFn && m && typeof m.progress === 'number') progFn(m.status || '', m.progress); }
    });
    pool[idx] = { w, key };
    return w;
  }
  const PARALLEL = (navigator.hardwareConcurrency || 2) >= 4;

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

  /* 단어 → 번역 단위(조각)로 묶기
   * - 점선·밑줄(…… / ____)은 버리고 그 자리에서 나눔 (메뉴 이름 …… 가격)
   * - 가격·숫자는 항상 따로 떼어 원본 유지 (번역 안 함)
   * - ★·* 같은 기호, 사진 속 무늬를 글자로 잘못 읽은 낮은 신뢰도 조각은 버림
   * - 단어 사이가 크게 벌어지거나 높이가 다른 줄이면 나눔 (두 단 메뉴가 한 줄로 붙는 것 방지) */
  const LEADER = /^([.\u2026_\-\u2013\u2014~·:,'"“”‘’`|]{2,}|[.\u2026_~·|])$/;   // 점선·밑줄(…… ___), 한 글자 "-"는 글자 사이 줄표라 유지
  const NUM = /^[“"'(]?(\d{1,3}([.,]\d{3})+|\d{4,})[đ₫dkK]?[.,)]?$/;   // 가격 모양(45.000, 200,000, 45000)만
  function cleanWord(t) {
    t = String(t || '').trim();
    const m = t.match(/^(.*?\p{L}[\p{L}\p{M})]*)[.\u2026_\-\u2014]{2,}.*$/u);   // "DỨA....." → "DỨA" + 끊김
    if (m) return { text: m[1], cut: true };
    return { text: t.replace(/^[*★☆%“"'‘’`]+/u, ''), cut: false };
  }
  function segmentsOf(data, loose) {   // loose: 빠진 줄 다시 읽기(사진 위 글자라 신뢰도가 낮게 나옴) → 기준 완화
    const segs = [];
    (data.lines || []).forEach(line => {
      const words = (line.words || []).filter(w => w.text && w.text.trim());
      if (!words.length) return;
      const hs = words.map(w => w.bbox.y1 - w.bbox.y0).sort((a, b) => a - b);
      const lh = Math.max(8, hs[hs.length >> 1]);
      let cur = null;
      const flush = () => { if (cur) segs.push(cur); cur = null; };
      words.forEach(w => {
        const { text, cut } = cleanWord(w.text);
        if (!text || LEADER.test(text)) { flush(); return; }                 // 점선 = 나누는 자리
        const num = NUM.test(text);
        if (!num && !/[\p{L}\d&]/u.test(text)) { if (cur) cur.x1 = Math.max(cur.x1, w.bbox.x1); return; }   // 기호만(★ – 등): 글자로는 빼고 간격 계산엔 포함
        if (w.confidence < (loose ? 30 : 40) && !num) { flush(); return; }  // 무늬를 글자로 잘못 읽음
        const cyw = (w.bbox.y0 + w.bbox.y1) / 2;
        if (cur && (num || cur.num || w.bbox.x0 - cur.x1 > lh * 1.0 || Math.abs(cyw - (cur.y0 + cur.y1) / 2) > lh * 0.6)) flush();
        if (!cur) cur = { x0: w.bbox.x0, y0: w.bbox.y0, x1: w.bbox.x1, y1: w.bbox.y1, words: [], conf: [], num };
        cur.words.push(text); cur.conf.push(w.confidence);
        cur.x0 = Math.min(cur.x0, w.bbox.x0); cur.y0 = Math.min(cur.y0, w.bbox.y0);
        cur.x1 = Math.max(cur.x1, w.bbox.x1); cur.y1 = Math.max(cur.y1, w.bbox.y1);
        if (cut) flush();
      });
      flush();
    });
    return segs.map(s => {
      // 맨 앞 별표(★)를 글자로 잘못 읽은 한 글자(X, x, 4 …) 제거
      if (!s.num && s.words.length >= 2 && /^[XxKk%*¥®©4]\W*$/u.test(s.words[0]) && !CJK.test(s.words.join(''))) { s.words.shift(); s.conf.shift(); }
      const text = tidy(s.words.join(' '));
      const conf = s.conf.reduce((a, b) => a + b, 0) / s.conf.length;
      const nL = text.replace(/[^\p{L}]/gu, '').length;
      return { x0: s.x0, y0: s.y0, x1: s.x1, y1: s.y1, src: text, conf, keep: s.num || !nL };   // keep: 숫자·기호 → 번역 안 하고 원본 유지
    }).filter(s => {
      if (!s.src) return false;
      if (s.keep) return s.conf >= 50 && /\d{2}/.test(s.src);               // 가격처럼 보이는 숫자만 (덮지 않으므로 표시용)
      const nL = s.src.replace(/[^\p{L}]/gu, '').length, cjk = CJK.test(s.src);
      if (cjk) return s.conf >= 45;
      return nL >= 2 && (s.conf >= (nL <= 3 ? 70 : loose ? 35 : 50));      // 짧은 조각일수록 엄격하게
    });
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
  /* 1차: 자동 배치(제목·문단에 강함) + 2차: 흩어진 글자 모드(테두리 상자·표 안 글자) → 1차에 없던 것만 추가 */
  async function recognize(image, sl, fallback, onProg, psms) {
    psms = psms || ['3', '11'];
    const langs = langsFor(sl, fallback);
    let results;
    if (PARALLEL && psms.length > 1) {
      const ws = await Promise.all(psms.map((_, i) => getWorker(langs, onProg, i)));
      progFn = onProg ? (st, p) => onProg(st, p) : null;
      results = await Promise.all(psms.map((m, i) => pass(ws[i], image, m).catch(e => { if (!i) throw e; return []; })));
    } else {
      const w = await getWorker(langs, onProg, 0);
      results = [];
      for (let i = 0; i < psms.length; i++) {
        const a = i / psms.length, b = (i + 1) / psms.length;
        progFn = onProg ? (st, p) => onProg(st, /recogniz/i.test(st) ? a + (b - a) * p : p) : null;
        try { results.push(await pass(w, image, psms[i])); } catch (e) { if (!i) throw e; }
      }
    }
    let segs = [];
    results.forEach(r => r.forEach(s => { if (!segs.some(o => overlap(o, s) > 0.3)) segs.push(s); }));
    const lang = sl === 'auto' ? fallback : sl;
    segs = segs.filter(s => plausible(s, lang));
    try {
      if (onProg) onProg('refining', 1);
      segs = await refine(pool.filter(Boolean).map(p => p.w), image, segs, lang);
    } catch (e) { /* 보완 실패 시 앞 결과 사용 */ }
    const out = joinLines(segs);
    const cy = s => (s.y0 + s.y1) / 2, sameRow = (a, b) => Math.abs(cy(a) - cy(b)) < Math.min(a.y1 - a.y0, b.y1 - b.y0) * 0.5;
    return out.sort((a, b) => sameRow(a, b) ? a.x0 - b.x0 : cy(a) - cy(b));
  }

  /* 3차(보완): 한 줄의 일부만 읽힌 조각(예: "NGO" 뒤 "CHIÊN"을 못 읽음)은 그 줄 글자 영역을 잘라 크게 확대해 한 줄 모드로 다시 읽음
   * - 줄 위쪽 65%만 보고 글자 이어짐을 판단(바닥의 점선·밑줄은 글자로 치지 않음)
   * - 다른 조각(가격 등)을 만나면 멈춤, 최대 30개 */
  async function refine(ws, image, segs, lang) {
    const img = await new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = rej; im.src = image; });
    const W = img.naturalWidth, H = img.naturalHeight;
    const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
    const cx = cv.getContext('2d'); cx.drawImage(img, 0, 0);
    const px = cx.getImageData(0, 0, W, H).data;
    const cand = [];
    segs.forEach(s => {
      if (s.keep) return;
      const h = s.y1 - s.y0; if (h < 6) return;
      const bg = avgColor(px, W, H, s.x0 - 3, s.y0 - 3, s.x1 + 3, s.y1 + 3);
      const yA = s.y0, yB = Math.round(s.y0 + h * 0.65), ys = Math.max(1, Math.round(h / 12));
      const ink = x => { for (let y = yA; y <= yB; y += ys) { const i = (y * W + x) * 4; if (Math.abs(px[i] - bg[0]) + Math.abs(px[i + 1] - bg[1]) + Math.abs(px[i + 2] - bg[2]) > 150) return true; } return false; };
      const blocked = x => segs.some(o => o !== s && o.keep && o.y0 < s.y1 && o.y1 > s.y0 && x >= o.x0 - 2 && x <= o.x1 + 2);   // 가격(숫자)에서 멈춤
      const scan = (from, dir) => { let edge = from, gap = 0; for (let x = from + dir; x >= 0 && x < W && !blocked(x); x += dir) { if (ink(x)) { edge = x; gap = 0; } else if (++gap > h * 0.9) break; } return edge; };
      const r = scan(s.x1, 1), l = scan(s.x0, -1);
      const ext = (s.x0 - l) + (r - s.x1);
      if (ext > h * 0.9) cand.push({ s, l, r, ext });
    });
    // 통째로 빠진 줄 찾기: 가격은 읽혔는데 같은 줄 왼쪽(메뉴 이름 자리)에 글자가 없으면 그 자리를 따로 다시 읽음
    //  (사진·무늬 위에 쓰인 메뉴 이름을 1·2차에서 놓치는 경우 — 예: 피자 사진 위 "KHOAI TÂY CHIÊN")
    const nL = o => o.src.replace(/[^\p{L}]/gu, '').length;
    const names = segs.filter(o => !o.keep && (nL(o) >= 6 || o.src.trim().split(/\s+/).length >= 2));
    segs.filter(o => o.keep && /^\d{1,3}([.,]\d{3})+[đ₫d]?$/.test(o.src.trim())).forEach(P => {
      const h = P.y1 - P.y0, cy = (P.y0 + P.y1) / 2;
      const near = names.filter(n => Math.abs((n.y0 + n.y1) / 2 - cy) < h * 12 && n.x1 < P.x0 && P.x0 - n.x0 < W * 0.62).map(n => n.x0).sort((a, b) => a - b);
      if (near.length < 2) return;
      const colL = near[near.length >> 1], mid = colL + (P.x0 - colL) * 0.5;
      const row = segs.filter(o => o !== P && Math.abs((o.y0 + o.y1) / 2 - cy) < h * 0.7 && o.x1 <= P.x0 + 2);
      if (row.some(o => !o.keep && o.x0 < mid && nL(o) >= 3)) return;               // 이미 이름이 있음
      const unit = row.filter(o => !o.keep && o.x0 >= mid).sort((a, b) => a.x0 - b.x0)[0];   // 단위(ĐĨA 등) 앞까지
      const l = Math.max(0, Math.round(colL - h * 0.8)), r = Math.round((unit ? unit.x0 : P.x0) - h * 0.4);
      if (r - l < h * 3) return;
      cand.push({ s: { x0: l, x1: r, y0: P.y0, y1: P.y1, src: '', conf: 43, ghost: true }, l, r, ext: 1e9 });
    });
    cand.sort((a, b) => b.ext - a.ext);
    const todo = cand.slice(0, 40);
    if (!todo.length) return segs;
    await Promise.all(ws.map(w => w.setParameters({ tessedit_pageseg_mode: '7' })));
    let k = 0;
    const rep = new Map();
    const run = async w => {
      while (k < todo.length) {
        const c = todo[k++], s = c.s, h = s.y1 - s.y0, pad = Math.round(h * 0.35), padY = Math.round(h * (s.ghost ? 0.45 : 0.2));   // 빠진 줄: 성조 부호까지 들어오게 위아래 여유
        const X0 = Math.max(0, c.l - pad), Y0 = Math.max(0, s.y0 - padY), X1 = Math.min(W, c.r + pad), Y1 = Math.min(H, s.y1 + padY);
        const z = Math.max(1, Math.min(3, 44 / h));   // 글자 높이 약 44px로 확대 → 성조 부호 인식 향상
        const cc = document.createElement('canvas'); cc.width = Math.round((X1 - X0) * z); cc.height = Math.round((Y1 - Y0) * z);
        const g = cc.getContext('2d'); g.imageSmoothingQuality = 'high'; g.drawImage(cv, X0, Y0, X1 - X0, Y1 - Y0, 0, 0, cc.width, cc.height);
        try {
          const { data } = await w.recognize(cc, {}, { blocks: true, text: true });
          if (!data.lines && data.blocks) { data.lines = []; data.blocks.forEach(b => (b.paragraphs || []).forEach(p => (p.lines || []).forEach(l => data.lines.push(l)))); }
          const ns = segmentsOf(data, s.ghost).map(n => Object.assign(n, { x0: Math.round(X0 + n.x0 / z), x1: Math.round(X0 + n.x1 / z), y0: Math.round(Y0 + n.y0 / z), y1: Math.round(Y0 + n.y1 / z) }))
            .filter(n => (n.keep || plausible(n, lang)) && Math.abs((n.y0 + n.y1) / 2 - (s.y0 + s.y1) / 2) < h * (s.ghost ? 0.7 : 0.45) && (n.y1 - n.y0) < h * (s.ghost ? 2.3 : 1.5))   // 같은 줄만(빠진 줄은 가격 숫자 높이 기준이라 여유)
            .map(n => s.ghost ? n : Object.assign(n, { y0: Math.max(n.y0, s.y0 - Math.round(h * 0.1)), y1: Math.min(n.y1, s.y1 + Math.round(h * 0.1)) }));   // 높이는 원래 줄에 맞춤
          const letters = a => a.filter(n => !n.keep).reduce((t, n) => t + n.src.replace(/[^\p{L}]/gu, '').length, 0);
          const good = ns.filter(n => !n.keep), mc = good.length ? good.reduce((t, n) => t + n.conf, 0) / good.length : 0;
          if (letters(ns) > letters([s]) && mc >= Math.min(80, s.conf - 8)) rep.set(s, good);   // 무늬를 글자로 읽어 길어진 경우는 버림
        } catch (e) { /* 실패 시 원래 조각 유지 */ }
      }
    };
    await Promise.all(ws.map(run));
    const out = [];
    segs.forEach(s => { if (rep.has(s)) rep.get(s).forEach(n => { if (!out.some(o => o !== s && overlap(o, n) > 0.5)) out.push(n); }); else out.push(s); });
    todo.forEach(c => { if (c.s.ghost && rep.has(c.s)) rep.get(c.s).forEach(n => { if (!out.some(o => overlap(o, n) > 0.3)) out.push(n); }); });
    // 새로 넓힌 조각과 겹치는 다른 조각(같은 줄 조각난 부분) 정리
    return out.filter((s, i) => !out.some((o, j) => j !== i && !s.keep && !o.keep && overlap(o, s) > 0.6 && (o.x1 - o.x0) > (s.x1 - s.x0)));
  }

  /* 베트남어 음절 모양 검사: 사진 속 무늬를 글자로 잘못 읽은 조각(NVI, AE, Xv 등) 걸러냄 */
  const VI_ON = '(NGH|NG|NH|CH|GH|GI|KH|PH|QU|TH|TR|[BCDGHKLMNPRSTVX])?';
  const VI_NUC = '(UYE|UYA|UOI|UOU|UOU|IEU|YEU|OAI|OAY|OEO|UAY|UYU|AI|AO|AU|AY|EO|EU|IA|IE|IU|OA|OE|OI|OO|UA|UE|UI|UO|UU|UY|YE|A|E|I|O|U|Y)';
  const VI_RE = new RegExp('^' + VI_ON + VI_NUC + '(NG|NH|CH|[CMNPT])?$');
  const plain = w => w.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[ĐđƠơƯư]/g, c => ({ Đ: 'D', đ: 'D', Ơ: 'O', ơ: 'O', Ư: 'U', ư: 'U' })[c]).toUpperCase();
  function plausible(s, lang) {
    if (s.keep || lang !== 'vi') return true;
    const ws = s.src.split(/\s+/).map(w => w.replace(/[^\p{L}]/gu, '')).filter(Boolean);
    if (!ws.length) return false;
    const ok = ws.filter(w => {
      const p = plain(w);
      if (VI_RE.test(p)) return true;
      return /^[A-Za-z]{4,}$/.test(w) && /[AEIOUY]/i.test(w);   // 외래어(PIZZA, COCA, HOTEL 등)
    }).length;
    return ok / ws.length > 0.5;
  }

  /* 두 줄로 나뉜 한 항목(예: "BÁNH MỲ KẸP PATE VÀ / THỊT NƯỚNG")을 하나로 합쳐 번역 — 바로 아래, 왼쪽 정렬, 같은 글자 크기 */
  function joinLines(segs) {
    const list = segs.slice().sort((a, b) => a.y0 - b.y0);
    const used = new Set(), out = [];
    list.forEach(a => {
      if (used.has(a)) return;
      let cur = a;
      for (;;) {
        if (cur.keep) break;
        const h = cur.y1 - cur.y0;
        const nx = list.find(b => !used.has(b) && b !== cur && b !== a && !b.keep &&
          (bh => { const m = Math.min(bh, h / (cur.lines || 1)); return b.y0 > cur.y0 + h * 0.5 && b.y0 - cur.y1 < m * 0.4 &&
            Math.abs(b.x0 - cur.x0) < m * 0.8 && Math.abs(bh - h / (cur.lines || 1)) < m * 0.3; })(b.y1 - b.y0) && !CJK.test(b.src + cur.src));
        if (!nx) break;
        used.add(nx);
        cur = { x0: Math.min(cur.x0, nx.x0), y0: cur.y0, x1: Math.max(cur.x1, nx.x1), y1: nx.y1, src: cur.src + ' ' + nx.src,
          conf: (cur.conf + nx.conf) / 2, keep: false, lines: (cur.lines || 1) + 1 };
      }
      used.add(a); out.push(cur);
    });
    return out;
  }

  /* ---------- 사진 위에 번역문 그리기 ---------- */
  function avgColor(px, w, h, x0, y0, x1, y1) {   // 상자 테두리 색의 중앙값(로고·무늬가 섞여도 배경색 유지)
    const R = [], G = [], B = [];
    const add = (x, y) => { x = Math.round(x); y = Math.round(y); if (x < 0 || y < 0 || x >= w || y >= h) return; const i = (y * w + x) * 4; R.push(px[i]); G.push(px[i + 1]); B.push(px[i + 2]); };
    const step = Math.max(1, Math.round((x1 - x0) / 40));
    for (let x = x0; x <= x1; x += step) { add(x, y0); add(x, y1); }
    for (let y = y0; y <= y1; y += Math.max(1, Math.round((y1 - y0) / 8))) { add(x0, y); add(x1, y); }
    if (!R.length) return [255, 255, 255];
    const med = a => a.sort((p, q) => p - q)[a.length >> 1];
    return [med(R), med(G), med(B)];
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
  /* 글자색이 배경과 대비가 약하면(사진 흐림·압축으로 색이 묽어짐) 같은 색 계열로 진하게/밝게 보정 → 대비 4.5:1 이상 */
  function readable(ink, bg) {
    if (!ink) return null;
    const m = ink.match(/\d+/g).map(Number);
    const L = c => { const v = c.map(x => { x /= 255; return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); }); return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2]; };
    const ratio = (a, b) => { const la = L(a), lb = L(b); return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05); };
    const dark = L(bg) > 0.18;   // 밝은 배경 → 글자를 더 진하게, 어두운 배경 → 더 밝게
    let c = m.slice(0, 3);
    for (let i = 0; i < 12 && ratio(c, bg) < 4.5; i++) c = c.map(x => dark ? Math.round(x * 0.8) : Math.round(x + (255 - x) * 0.25));
    return `rgb(${c[0]},${c[1]},${c[2]})`;
  }
  function fit(ctx, text, w, h, family, maxSize) {
    for (let size = Math.floor(Math.min(h * 0.82, maxSize || 1e9)); size >= 9; size--) {   // 한 줄로 맞추기
      ctx.font = `700 ${size}px ${family}`;
      if (ctx.measureText(text).width <= w * 1.02) return { size, lines: [text] };
      if (size < h * 0.55) break;
    }
    const words = text.split(/(\s+)/), cjk = CJK.test(text);   // 두 줄로 나누기
    const units = cjk && words.length < 3 ? [...text] : words;
    for (let size = Math.floor(h * 0.44); size >= 8; size--) {
      ctx.font = `700 ${size}px ${family}`;
      const lines = []; let cur = '';
      units.forEach(u => { const tryS = cur + u; if (ctx.measureText(tryS.trim()).width > w && cur.trim()) { lines.push(cur.trim()); cur = u; } else cur = tryS; });
      if (cur.trim()) lines.push(cur.trim());
      if (lines.length <= 2 && lines.every(l => ctx.measureText(l).width <= w * 1.02)) return { size, lines };
    }
    ctx.font = `700 8px ${family}`;
    return { size: 8, lines: [text] };
  }
  /* img: 원본 사진(Image, 원래 해상도), segs: 글자 인식한 사진(긴 변 2400px) 기준 좌표, ocrW: 그 사진의 가로 크기
     → 번역이 덮인 canvas. 선명도를 위해 원래 사진 해상도(긴 변 최대 2560px)로 다시 그림 */
  const MAX_SIDE = 2560;
  function paint(img, segs0, ocrW) {
    const nw = img.naturalWidth, nh = img.naturalHeight;
    const z = Math.min(1, MAX_SIDE / Math.max(nw, nh));
    const W = Math.round(nw * z), H = Math.round(nh * z), k = W / (ocrW || nw);
    const segs = segs0.map(s => Object.assign({}, s, { x0: Math.round(s.x0 * k), y0: Math.round(s.y0 * k), x1: Math.min(W - 1, Math.round(s.x1 * k)), y1: Math.min(H - 1, Math.round(s.y1 * k)) }));
    const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
    const ctx = cv.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, W, H);
    if ('textRendering' in ctx) ctx.textRendering = 'geometricPrecision';
    const px = ctx.getImageData(0, 0, W, H).data;
    const family = getComputedStyle(document.body).fontFamily || 'sans-serif';
    // 줄 높이 중앙값: 대문자·윗점이 없는 줄(예: "Phở bò tái")이 작게 잡혀 번역 글자가 작아지는 것 보정
    const hs = segs.filter(s => !s.lines && !s.keep).map(s => s.y1 - s.y0).sort((a, b) => a - b), medH = hs[hs.length >> 1] || 0;
    const bodyH = hs.filter(x => x >= medH * 0.55 && x <= medH * 1.45), refH = bodyH[Math.floor(bodyH.length * 0.75)] || medH;   // 본문 글자 크기 기준(성조 부호까지 포함한 높이)
    segs.forEach(s => {
      if (s.keep || !s.dst) return;
      let sy0 = s.y0, sy1 = s.y1;
      if (!s.lines && sy1 - sy0 < medH * 0.95 && sy1 - sy0 > medH * 0.55) { const d = (medH - (sy1 - sy0)) / 2; sy0 -= d; sy1 += d; }
      const h = sy1 - sy0, pad = Math.round(h * 0.18);
      const x0 = Math.max(0, s.x0 - pad), y0 = Math.max(0, Math.round(sy0 - pad)), y1 = Math.min(H - 1, Math.round(sy1 + pad));
      let x1 = Math.min(W - 1, s.x1 + pad);
      // 번역문이 원문보다 길면 같은 줄 오른쪽 빈 공간(다음 글자 전까지)으로 넓힘
      ctx.font = `700 ${Math.floor(h * 0.9)}px ${family}`;
      const need = x0 + pad * 2 + ctx.measureText(s.dst).width;
      if (need > x1) {
        let room = W - 1 - pad;
        segs.forEach(o => { if (o !== s && o.x0 >= s.x1 - 2 && o.y0 < s.y1 + h * 0.3 && o.y1 > s.y0 - h * 0.3) room = Math.min(room, o.x0 - pad * 2); });   // 같은 줄(위아래 조금 어긋나도)의 다음 글자 앞까지
        // 오른쪽 실제 픽셀 확인(줄 위쪽 65%만 → 바닥 점선·밑줄 무시)
        //  - 바로 붙어 이어진 글자(같은 항목의 못 읽은 나머지)는 끝까지 덮어 깔끔하게
        //  - 떨어져 있는 글자(인식 못 한 가격 등)를 만나면 그 앞에서 멈춤
        const bg = avgColor(px, W, H, x0, y0, x1, y1), hh = sy1 - sy0;
        const yA = Math.round(sy0), yB = Math.round(sy0 + hh * 0.65), ys = Math.max(1, Math.round(hh / 12));
        const ink = x => { for (let y = yA; y <= yB; y += ys) { const i = (y * W + x) * 4; if (Math.abs(px[i] - bg[0]) + Math.abs(px[i + 1] - bg[1]) + Math.abs(px[i + 2] - bg[2]) > 150) return true; } return false; };
        let last = s.x1, runEnd = s.x1;
        for (let x = s.x1 + 1; x < room; x++) {
          if (!ink(x)) continue;
          if (x - last > hh * 0.8) { room = Math.min(room, x - pad * 2); break; }
          last = x; runEnd = x;
        }
        const want = need > s.x1 && runEnd > s.x1 + 2 && runEnd - need < hh * 3 ? Math.max(need, runEnd + pad) : need;   // 사진·무늬까지 길게 덮지 않음
        x1 = Math.round(Math.max(x1, Math.min(want, room)));
      }
      const [r, g, b] = avgColor(px, W, H, x0, y0, x1, y1);
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      ctx.fillStyle = `rgba(${r | 0},${g | 0},${b | 0},1)`;
      const rr = Math.min(8 * k, h * 0.25);
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(x0, y0, x1 - x0, y1 - y0, rr); else ctx.rect(x0, y0, x1 - x0, y1 - y0);
      ctx.fill();
      const bw = x1 - x0 - pad, bh = y1 - y0;
      // 글자 크기 상한: 줄 높이와 원문 글자 폭(상자가 위아래로 크게 잡힌 경우 보정) 중 작은 값
      const nCh = Math.max(1, (s.src || '').replace(/\s/g, '').length), em = (s.x1 - s.x0) * (s.lines || 1) / nCh * (CJK.test(s.src || '') ? 1.05 : 1.6);
      let hl = h / (s.lines || 1);
      if (medH && hl > medH * 1.45 && em < hl * 0.8) hl = Math.max(medH, em);   // 위아래로 크게 잡힌 상자 보정(제목처럼 실제로 큰 글자는 유지)
      else if (medH && hl >= medH * 0.55 && hl <= medH * 1.45) hl = refH;          // 본문 크기 글자는 같은 크기로 통일(성조 부호 유무로 상자 높이가 달라짐)
      const f = fit(ctx, s.dst, bw, bh, family, hl * 0.92);   // 원문 글자보다 커지지 않게
      ctx.fillStyle = readable(inkColor(px, W, s, [r, g, b]), [r, g, b]) || (lum > 140 ? '#14181F' : '#FFFFFF');
      ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
      ctx.font = `700 ${f.size}px ${family}`;
      const lineH = f.size * 1.08, top = y0 + bh / 2 - (lineH * (f.lines.length - 1)) / 2;
      f.lines.forEach((l, i) => ctx.fillText(l, Math.round(x0 + pad / 2), Math.round(top + i * lineH)));
    });
    return cv;
  }

  return { recognize, paint, available: () => !!window.Tesseract };
})();
