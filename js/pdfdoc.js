/* 입말 — 문서(PDF) 번역
 * - PDF 안에 글자 정보가 있으면 그대로 사용(사진 인식보다 정확: 성조 부호·작은 글씨 오류 없음)
 * - 글자 정보가 없는 스캔 PDF는 쪽 그림을 사진 번역(OCR)으로 처리
 * - 엔진: pdf.js 3.11 (vendor/pdfjs, 처음 문서를 열 때만 내려받음)
 */
const PDFDOC = (() => {
  const BASE = 'vendor/pdfjs/';
  const MAX_PAGES = 30;
  let loading = null;

  function load() {
    if (window.pdfjsLib) return Promise.resolve();
    if (loading) return loading;
    loading = new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = BASE + 'pdf.min.js';
      s.onload = () => { window.pdfjsLib.GlobalWorkerOptions.workerSrc = BASE + 'pdf.worker.min.js'; res(); };
      s.onerror = () => { loading = null; rej(new Error('PDF engine load failed')); };
      document.head.appendChild(s);
    });
    return loading;
  }

  async function open(file) {
    await load();
    const data = new Uint8Array(await file.arrayBuffer());
    const doc = await window.pdfjsLib.getDocument({
      data, cMapUrl: BASE + 'cmaps/', cMapPacked: true, standardFontDataUrl: BASE + 'standard_fonts/', isEvalSupported: false
    }).promise;
    return { doc, pages: Math.min(doc.numPages, MAX_PAGES), total: doc.numPages };
  }

  /* 쪽 그림(긴 변 약 2200px) + 글자 조각(그림 좌표) */
  async function page(doc, n) {
    const p = await doc.getPage(n);
    const v1 = p.getViewport({ scale: 1 });
    const scale = Math.min(4, 2200 / Math.max(v1.width, v1.height));
    const vp = p.getViewport({ scale });
    const cv = document.createElement('canvas'); cv.width = Math.round(vp.width); cv.height = Math.round(vp.height);
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cv.width, cv.height);
    // intent 'print': 화면 그리기 타이밍(requestAnimationFrame)에 기대지 않고 바로 그림 → 앱이 잠시 뒤로 가도 멈추지 않음
    await p.render({ canvasContext: ctx, viewport: vp, intent: 'print' }).promise;
    const tc = await p.getTextContent();
    const items = [];
    tc.items.forEach(it => {
      if (!it.str || !it.str.trim()) return;
      const m = window.pdfjsLib.Util.transform(vp.transform, it.transform);
      if (Math.abs(m[1]) > Math.abs(m[0]) * 0.3) return;            // 세로·기울어진 글자는 제외
      const h = Math.hypot(m[2], m[3]); if (h < 3) return;
      const w = it.width * scale || it.str.length * h * 0.5;
      items.push({ x0: m[4], x1: m[4] + w, base: m[5], h, str: it.str });
    });
    return { canvas: cv, segs: merge(cells(items), cv) };
  }

  /* 같은 줄에 붙어 있는 조각 → 한 칸(셀) 글자 */
  function cells(items) {
    items.sort((a, b) => (Math.abs(a.base - b.base) < Math.min(a.h, b.h) * 0.3 ? 0 : a.base - b.base) || a.x0 - b.x0);
    const out = [];
    let cur = null;
    items.forEach(it => {
      if (cur && Math.abs(it.base - cur.base) < Math.min(it.h, cur.h) * 0.3 && it.x0 - cur.x1 < cur.h * 0.6 && it.x0 >= cur.x1 - cur.h * 0.3) {
        cur.str += (it.x0 - cur.x1 > cur.h * 0.12 && !/\s$/.test(cur.str) && !/^\s/.test(it.str) ? ' ' : '') + it.str;
        cur.x1 = Math.max(cur.x1, it.x1); cur.h = Math.max(cur.h, it.h);
      } else { if (cur) out.push(cur); cur = Object.assign({}, it); }
    });
    if (cur) out.push(cur);
    return out.map(c => {
      const src = c.str.replace(/\s+/g, ' ').trim();
      return { x0: Math.floor(c.x0), x1: Math.ceil(c.x1), y0: Math.floor(c.base - c.h * 0.88), y1: Math.ceil(c.base + c.h * 0.22),
        src, conf: 99, keep: !/\p{L}/u.test(src), h: c.h, tight: true };
    }).filter(s => s.src);
  }

  /* 한 칸 안에서 줄바꿈된 글(예: "Pizza hải sản / (Size S)", 문단)을 하나로 합쳐 번역
   * 표의 칸 경계선(가로줄)이 사이에 있으면 다른 칸이므로 합치지 않음 */
  /* 아랫줄이 윗줄에 이어지는 글인가: 소문자·괄호로 시작, 윗줄이 쉼표·연결어로 끝남, 한·중·일 문장
   * (표에서 다음 항목은 대문자로 시작하므로 따로 번역) */
  const CJKCH = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
  function continues(a, b) {
    if (CJKCH.test(a.slice(-1)) && CJKCH.test(b[0])) return !/[。．.!?！？]$/.test(a);
    if (/^[\p{Ll}(（\[]/u.test(b)) return true;
    if ((a.match(/[(（]/g) || []).length > (a.match(/[)）]/g) || []).length) return true;   // 괄호가 아직 안 닫힘
    return /([,，、;:&\-–]|\b(và|với|của|cho|and|with|of|the|for|to|in))$/iu.test(a.trim());
  }
  function merge(segs, cv) {
    const W = cv.width, H = cv.height, px = cv.getContext('2d').getImageData(0, 0, W, H).data;
    const ruled = (a, b) => {   // a 아래와 b 위 사이에 가로줄이 있나
      const xa = Math.max(0, Math.min(a.x0, b.x0)), xb = Math.min(W - 1, Math.max(a.x1, b.x1));
      for (let y = Math.max(0, a.y1 - 2); y <= Math.min(H - 1, b.y0 + 2); y++) {
        let dark = 0, n = 0;
        for (let x = xa; x <= xb; x += 2) { const i = (y * W + x) * 4; n++; if (px[i] + px[i + 1] + px[i + 2] < 560) dark++; }
        if (n && dark / n > 0.6) return true;
      }
      return false;
    };
    const list = segs.slice().sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0), used = new Set(), out = [];
    list.forEach(a => {
      if (used.has(a)) return;
      used.add(a);
      let cur = a;
      while (!cur.keep && (cur.lines || 1) < 8) {
        const h = a.h;
        const nx = list.find(b => !used.has(b) && !b.keep && Math.abs(b.h - h) < h * 0.25 && b.y0 >= cur.y1 - h * 0.3 && b.y0 - cur.y1 < h * 0.6 &&
          (Math.abs(b.x0 - cur.x0) < h * 1.2 || Math.abs((b.x0 + b.x1) - (cur.x0 + cur.x1)) / 2 < h * 1.2) && b.x0 < cur.x1 && b.x1 > cur.x0 &&
          continues(cur.src, b.src) && !ruled(cur, b));
        if (!nx) break;
        used.add(nx);
        cur = { x0: Math.min(cur.x0, nx.x0), y0: cur.y0, x1: Math.max(cur.x1, nx.x1), y1: nx.y1, h,
          src: (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]$/u.test(cur.src) ? cur.src : cur.src + ' ') + nx.src,
          conf: 99, keep: false, tight: true, lines: (cur.lines || 1) + 1 };
      }
      out.push(cur);
    });
    return out;
  }

  /* 번역된 쪽 그림들 → PDF 파일(쪽마다 JPEG 그림 한 장) */
  async function toPdf(urls) {
    const enc = new TextEncoder(), parts = [], offs = [];
    let len = 0;
    const put = x => { const b = typeof x === 'string' ? enc.encode(x) : x; parts.push(b); len += b.length; };
    const obj = (n, body) => { offs[n] = len; put(`${n} 0 obj\n`); body(); put('\nendobj\n'); };
    const imgs = [];
    for (const u of urls) {
      const im = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = u; });
      const c = document.createElement('canvas'); c.width = im.naturalWidth; c.height = im.naturalHeight;
      c.getContext('2d').drawImage(im, 0, 0);
      const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.92));
      imgs.push({ w: c.width, h: c.height, data: new Uint8Array(await blob.arrayBuffer()) });
    }
    const N = imgs.length, A4W = 595.28;
    put('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');
    obj(1, () => put('<< /Type /Catalog /Pages 2 0 R >>'));
    obj(2, () => put(`<< /Type /Pages /Count ${N} /Kids [${imgs.map((_, i) => `${3 + i * 3} 0 R`).join(' ')}] >>`));
    imgs.forEach((im, i) => {
      const p = 3 + i * 3, pw = A4W, ph = Math.round(A4W * im.h / im.w * 100) / 100;
      const cs = `q ${pw} 0 0 ${ph} 0 0 cm /Im0 Do Q`;
      obj(p, () => put(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pw} ${ph}] /Resources << /XObject << /Im0 ${p + 2} 0 R >> >> /Contents ${p + 1} 0 R >>`));
      obj(p + 1, () => put(`<< /Length ${cs.length} >>\nstream\n${cs}\nendstream`));
      obj(p + 2, () => { put(`<< /Type /XObject /Subtype /Image /Width ${im.w} /Height ${im.h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${im.data.length} >>\nstream\n`); put(im.data); put('\nendstream'); });
    });
    const xref = len, total = 3 + N * 3;
    put(`xref\n0 ${total}\n0000000000 65535 f \n`);
    for (let i = 1; i < total; i++) put(String(offs[i]).padStart(10, '0') + ' 00000 n \n');
    put(`trailer\n<< /Size ${total} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`);
    return new Blob(parts, { type: 'application/pdf' });
  }

  return { open, page, toPdf, MAX_PAGES };
})();
