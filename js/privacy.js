/* 개인정보처리방침 — 언어 전환 (?lang= → 앱 화면 언어 → 브라우저 언어) */
(function () {
  const ORDER = ['ko', 'vi', 'en', 'zh', 'ja'];
  function pick() {
    const q = new URLSearchParams(location.search).get('lang');
    if (ORDER.includes(q)) return q;
    try { const s = JSON.parse(localStorage.getItem('lingo5_v1') || '{}').settings; if (s && ORDER.includes(s.ui)) return s.ui; } catch (e) {}
    const n = (navigator.language || 'ko').slice(0, 2).toLowerCase();
    return ORDER.includes(n) ? n : 'en';
  }
  function show(l) {
    document.querySelectorAll('article[data-l]').forEach(a => { a.hidden = a.dataset.l !== l; });
    document.querySelectorAll('#langs button').forEach(b => b.classList.toggle('on', b.dataset.l === l));
    document.documentElement.lang = l;
    const h = document.querySelector(`article[data-l="${l}"] h1`);
    if (h) document.title = (l === 'ko' ? '입말' : 'Ipmal') + ' — ' + h.textContent;
    try { history.replaceState(null, '', '?lang=' + l); } catch (e) {}
  }
  document.querySelectorAll('#langs button').forEach(b => b.onclick = () => show(b.dataset.l));
  show(pick());
})();
