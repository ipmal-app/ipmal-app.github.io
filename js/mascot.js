/* 마스코트 '입말이' — 앱 아이콘과 같은 얼굴 (민트 동그라미 + 아이콘의 입술 + 소리 파동 2줄)
 * 상태: idle(기본) · happy(기쁨) · oops(아쉬움) · think(생각) · party(축하)
 */
const Mascot = (() => {
  let uid = 0;
  const INK = '#3E4656';
  const CX = 54, CY = 66, R = 40;

  function eyes(state) {
    const ey = CY - 5, ex = 13;
    if (state === 'happy' || state === 'party') {
      return `<path d="M${CX - ex - 5},${ey + 1} Q${CX - ex},${ey - 6} ${CX - ex + 5},${ey + 1}" fill="none" stroke="${INK}" stroke-width="3" stroke-linecap="round"/>
              <path d="M${CX + ex - 5},${ey + 1} Q${CX + ex},${ey - 6} ${CX + ex + 5},${ey + 1}" fill="none" stroke="${INK}" stroke-width="3" stroke-linecap="round"/>`;
    }
    const lx = state === 'think' ? 2 : 0, ly = state === 'think' ? -2.5 : 0;
    return `<g class="m-eyes">
      <circle cx="${CX - ex + lx}" cy="${ey + ly}" r="5" fill="${INK}"/><circle cx="${CX + ex + lx}" cy="${ey + ly}" r="5" fill="${INK}"/>
      <circle cx="${CX - ex + lx + 1.7}" cy="${ey + ly - 1.8}" r="1.7" fill="#fff"/><circle cx="${CX + ex + lx + 1.7}" cy="${ey + ly - 1.8}" r="1.7" fill="#fff"/>
    </g>`;
  }

  /* 입 = 앱 아이콘의 입술 (아이콘 좌표 그대로 축소해서 사용 → 아이콘과 같은 얼굴) */
  const LIP_UP = '#F5A9B4', LIP_LO = '#E5838F', LIP_IN = '#9E4F62', LIP_LINE = '#C9707F';
  function lips(inner, s, dx) {
    const k = s || 0.24, my = CY + 8;
    return `<g transform="translate(${(CX - 242 * k + (dx || 0)).toFixed(2)},${(my - 300 * k).toFixed(2)}) scale(${k})">${inner}</g>`;
  }
  // 웃으며 벌린 입 (아이콘과 동일)
  const OPEN = `<path d="M188 306 C206 300 226 298 242 299 C258 298 278 300 296 306 C286 340 266 360 242 360 C218 360 198 340 188 306 Z" fill="${LIP_IN}"/>
    <path d="M198 307 C214 304 230 303 242 303 C254 303 270 304 286 307 L283 317 C268 314 254 313 242 313 C230 313 216 314 201 317 Z" fill="#FFFFFF"/>
    <ellipse cx="242" cy="344" rx="26" ry="11" fill="#F4A1AE"/>
    <path d="M184 306 C200 286 222 280 232 288 L242 294 L252 288 C262 280 284 286 300 306 C280 300 262 298 242 299 C222 298 204 300 184 306 Z" fill="${LIP_UP}"/>`;
  // 다문 입 (미소)
  const CLOSED = `<path d="M184 306 C204 312 222 314 242 314 C262 314 280 312 300 306 C290 336 268 348 242 348 C216 348 194 336 184 306 Z" fill="${LIP_LO}"/>
    <path d="M184 306 C200 286 222 280 232 288 L242 294 L252 288 C262 280 284 286 300 306 C280 312 262 314 242 314 C222 314 204 312 184 306 Z" fill="${LIP_UP}"/>
    <path d="M190 308 C214 316 270 316 294 308" fill="none" stroke="${LIP_LINE}" stroke-width="5" stroke-linecap="round"/>
    <ellipse cx="256" cy="336" rx="16" ry="4" fill="#FFFFFF" opacity=".55"/>`;
  // '오' 모양 (아쉬움)
  const OH = `<ellipse cx="242" cy="320" rx="30" ry="34" fill="${LIP_UP}"/><ellipse cx="242" cy="322" rx="15" ry="19" fill="${LIP_IN}"/>
    <ellipse cx="232" cy="296" rx="8" ry="3" fill="#FFFFFF" opacity=".6"/>`;

  function mouth(state) {
    if (state === 'happy' || state === 'party') return lips(OPEN, 0.24);
    if (state === 'oops') return lips(OH, 0.2);
    if (state === 'think') return lips(CLOSED, 0.17, 4);
    return lips(CLOSED, 0.22);
  }

  function svg(state, size) {
    const id = 'mi' + (++uid), w = size || 64;
    return `<svg class="mascot-svg" viewBox="0 0 120 112" width="${w}" height="${(w * 112 / 120).toFixed(0)}" aria-hidden="true">
      <defs><radialGradient id="${id}" cx=".38" cy=".3" r=".8"><stop offset="0" stop-color="#F6FCF8"/><stop offset=".7" stop-color="#D2EEDC"/><stop offset="1" stop-color="#BFE4CC"/></radialGradient></defs>
      <g class="m-wave" fill="none" stroke-linecap="round" stroke-width="4.4">
        <path d="M80,22 A15,15 0 0 1 87,35" stroke="#8FB0D8"/>
        <path d="M85,12 A26,26 0 0 1 97,34" stroke="#AF9CDA"/>
      </g>
      <g class="m-body">
        <circle cx="${CX}" cy="${CY}" r="${R}" fill="url(#${id})" stroke="#8CCBA2" stroke-width="3.4"/>
        <ellipse cx="${CX - 17}" cy="${CY - 24}" rx="10" ry="5" fill="#fff" opacity=".65" transform="rotate(-25 ${CX - 17} ${CY - 24})"/>
        <ellipse cx="${CX - 22}" cy="${CY + 9}" rx="6" ry="3.6" fill="#F7B8C2" opacity=".85"/>
        <ellipse cx="${CX + 22}" cy="${CY + 9}" rx="6" ry="3.6" fill="#F7B8C2" opacity=".85"/>
        ${eyes(state)}
        ${mouth(state)}
      </g>
      ${state === 'oops' ? `<path d="M${CX + 30},${CY - 30} c-4,7 -4,11 0,13 c4,-2 4,-6 0,-13z" fill="#BCD4EC" stroke="#9DB8D6"/>` : ''}
      ${state === 'think' ? '<g class="m-dots"><circle cx="102" cy="74" r="2.6" fill="#B9A9DC"/><circle cx="110" cy="66" r="3.4" fill="#B9A9DC"/></g>' : ''}
      ${state === 'party' ? '<g class="m-spark"><path d="M10,22 l2,6 6,2 -6,2 -2,6 -2,-6 -6,-2 6,-2z" fill="#FFE7A8"/><path d="M106,70 l1.6,4.6 4.6,1.6 -4.6,1.6 -1.6,4.6 -1.6,-4.6 -4.6,-1.6 4.6,-1.6z" fill="#CBBDEB"/><path d="M18,96 l1.3,3.7 3.7,1.3 -3.7,1.3 -1.3,3.7 -1.3,-3.7 -3.7,-1.3 3.7,-1.3z" fill="#BCD4EC"/></g>' : ''}
    </svg>`;
  }

  function html(state, msg, size) {
    return `<div class="mascot m-${state}">${svg(state, size)}${msg ? `<div class="mbubble">${msg}</div>` : ''}</div>`;
  }
  const pick = arr => arr[Math.floor(Math.random() * arr.length)];
  return { svg, html, pick };
})();
