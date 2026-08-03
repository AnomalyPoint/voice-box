// Seeded CRT faces for the console panel.
//
// Each agent gets one of 28 archetypes, picked by hashing its profile id, and
// glows in the agent's own color. One shared engine animates every mounted
// face: an idle face breathes, blinks, and its irises follow the cursor; a
// speaking face runs its archetype's talking animation; a paused face freezes
// mid-frame; a standby (offline) face dims and closes its eyes.
//
// The face mode is read from the mount's `data-face-mode` attribute
// ("speaking" | "idle" | "paused" | "standby"), so render.js just stamps a
// mode and never talks to this module beyond mount().
//
// No user text ever enters these SVG strings -- they are static templates, so
// building them with innerHTML is safe under the panel's CSP.

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

function hashStr(s) {
  let h = 2166136261;
  for (const c of s) {
    h ^= c.codePointAt(0);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// --- shared svg builders ----------------------------------------------------

const head = (rx = 14) =>
  `<rect class="fx-head" x="30" y="14" width="60" height="52" rx="${rx}"/>`;
const sock = (cx, cy, r = 7) => `<circle class="fx-socket" cx="${cx}" cy="${cy}" r="${r}"/>`;
const dot = (cx, cy, r = 3) => `<circle class="fx-fill fx-glow" cx="${cx}" cy="${cy}" r="${r}"/>`;
const eyes = (y = 36, l = 46, r = 74, sr = 7, ir = 3) =>
  `<g class="fx-eyes">${sock(l, y, sr)}${sock(r, y, sr)}<g class="fx-iris">${dot(l, y, ir)}${dot(r, y, ir)}</g></g>`;

// --- the 28 archetypes ------------------------------------------------------
// build() returns inner SVG for a 120x90 viewBox; tick(root, ctx) animates it.
// ctx: { t: seconds, talk: 0..1 (0 unless speaking), state, newBeat }

const FACES = [
  { name: "classic",
    build: () => head(14) + eyes() + `<ellipse class="fx-stroke mo" cx="60" cy="55" rx="7" ry="1.5"/>`,
    tick: (g, c) => { g.querySelector(".mo").setAttribute("ry", (1 + c.talk * 4.5).toFixed(1)); } },

  { name: "scope",
    build: () => head(10) + eyes(34, 48, 72, 5, 2.5) + `<path class="fx-stroke fx-glow mo" d="M42 56 H78"/>`,
    tick: (g, c) => {
      let d = "M42 56";
      for (let i = 1; i <= 12; i++) {
        const a = c.talk * 6 * Math.sin(c.t * 22 + i * 1.3);
        d += ` L${42 + i * 3} ${(56 + a).toFixed(1)}`;
      }
      g.querySelector(".mo").setAttribute("d", d);
    } },

  { name: "bars",
    build: () => head(12) + eyes(34) +
      `<g class="mo">${[0, 1, 2, 3, 4].map((i) => `<rect class="fx-fill fx-glow b${i}" x="${48 + i * 6}" y="55" width="3.6" height="2" rx="1"/>`).join("")}</g>`,
    tick: (g, c) => {
      for (let i = 0; i < 5; i++) {
        const h = 1.5 + c.talk * (2 + Math.random() * 9);
        const el = g.querySelector(".b" + i);
        el.setAttribute("height", h.toFixed(1));
        el.setAttribute("y", (57 - h).toFixed(1));
      }
    } },

  { name: "matrix",
    build: () => head(8) + eyes(33, 47, 73, 6, 2.6) +
      `<g class="mo">${[0, 1, 2].map((r) => [0, 1, 2, 3, 4].map((cl) => `<rect class="fx-fill c${r}${cl}" x="${49 + cl * 5}" y="${50 + r * 4}" width="3.4" height="2.6" rx=".6" opacity="${r === 1 ? ".9" : ".15"}"/>`).join("")).join("")}</g>`,
    tick: (g, c) => {
      if (!c.newBeat) return;
      for (let r = 0; r < 3; r++) for (let cl = 0; cl < 5; cl++) {
        g.querySelector(".c" + r + cl).setAttribute(
          "opacity",
          c.talk > 0 ? (Math.random() < c.talk * 0.8 ? ".9" : ".12") : r === 1 ? ".9" : ".12",
        );
      }
    } },

  { name: "chomp",
    build: () =>
      `<g class="up"><rect class="fx-head" x="30" y="12" width="60" height="34" rx="12"/><g class="fx-eyes">${sock(46, 30, 6)}${sock(74, 30, 6)}<g class="fx-iris">${dot(46, 30, 2.8)}${dot(74, 30, 2.8)}</g></g></g>` +
      `<g class="jaw"><rect class="fx-head" x="36" y="50" width="48" height="18" rx="8"/><path class="fx-stroke fx-dim" d="M44 59 H76"/></g>`,
    tick: (g, c) => {
      const o = c.talk * 7 * Math.abs(Math.sin(c.t * 14));
      g.querySelector(".jaw").setAttribute("transform", `translate(0 ${o.toFixed(1)})`);
    } },

  { name: "kit",
    build: () =>
      `<path class="fx-stroke fx-ear" d="M34 26 L40 8 L52 20 Z"/><path class="fx-stroke fx-ear" d="M86 26 L80 8 L68 20 Z"/>` +
      `<rect class="fx-head" x="30" y="16" width="60" height="50" rx="20"/>` + eyes(38, 46, 74, 6, 2.6) +
      `<path class="fx-stroke mo" d="M52 56 Q56 60 60 56 Q64 60 68 56"/>`,
    tick: (g, c) => {
      const s = 1 + c.talk * 1.6 * Math.abs(Math.sin(c.t * 16));
      g.querySelector(".mo").setAttribute("transform", `translate(0 ${(56 * (1 - s)).toFixed(1)}) scale(1 ${s.toFixed(2)})`);
    } },

  { name: "cyclops",
    build: () => head(16) +
      `<g class="fx-eyes">${sock(60, 36, 13)}<g class="fx-iris"><circle class="fx-fill fx-glow big" cx="60" cy="36" r="5"/></g></g><path class="fx-stroke mo" d="M52 58 H68"/>`,
    tick: (g, c) => {
      g.querySelector(".big").setAttribute("r", (4 + c.talk * 3 * Math.abs(Math.sin(c.t * 12))).toFixed(1));
      const w = 8 + c.talk * 4 * Math.sin(c.t * 20);
      g.querySelector(".mo").setAttribute("d", `M${60 - w / 2} 58 H${60 + w / 2}`);
    } },

  { name: "visor",
    build: () => head(10) +
      `<rect class="fx-socket" x="40" y="32" width="40" height="8" rx="4"/><rect class="fx-fill fx-glow sweep" x="42" y="33.5" width="8" height="5" rx="2.5"/>` +
      `<g class="mo">${[0, 1, 2].map((i) => `<rect class="fx-fill m${i}" x="${52 + i * 6}" y="55" width="3.5" height="2.5" rx="1" opacity=".2"/>`).join("")}</g>`,
    tick: (g, c) => {
      g.querySelector(".sweep").setAttribute("x", (42 + ((Math.sin(c.t * 3) + 1) / 2) * 30).toFixed(1));
      if (c.newBeat) for (let i = 0; i < 3; i++) {
        g.querySelector(".m" + i).setAttribute("opacity", c.talk > 0 && Math.random() < 0.7 ? ".95" : ".2");
      }
    } },

  { name: "kao",
    build: () => `<text class="fx-text kao" x="60" y="52" font-size="20" text-anchor="middle">(•_•)</text>`,
    tick: (g, c) => {
      const el = g.querySelector(".kao");
      if (c.state === "standby") { el.textContent = "(-_-)"; return; }
      if (c.newBeat) {
        el.textContent = c.talk > 0
          ? ["(•o•)", "(•▽•)", "(•ᴗ•)", "(•o•)"][Math.floor(Math.random() * 4)]
          : Math.random() < 0.06 ? "(-_-)" : "(•_•)";
      }
    } },

  { name: "term",
    build: () => `<text class="fx-text term" x="60" y="50" font-size="15" text-anchor="middle">[ o_o ]</text>`,
    tick: (g, c) => {
      const el = g.querySelector(".term");
      if (c.state === "standby") { el.textContent = "[ -_- ]"; return; }
      if (c.newBeat) {
        el.textContent = c.talk > 0
          ? ["[ o▂o ]", "[ o▄o ]", "[ o▆o ]", "[ o▄o ]"][Math.floor(Math.random() * 4)]
          : "[ o_o ]";
      }
    } },

  { name: "pixel",
    build: () => {
      const px = (x, y, cl = "") => `<rect class="fx-fill ${cl}" x="${x}" y="${y}" width="5" height="5"/>`;
      let s = `<rect class="fx-head" x="28" y="12" width="64" height="56" rx="2"/><g class="fx-eyes">`;
      s += px(44, 30) + px(49, 30) + px(44, 35) + px(49, 35) + px(66, 30) + px(71, 30) + px(66, 35) + px(71, 35);
      s += `</g><g class="mo">`;
      for (let i = 0; i < 6; i++) s += px(45 + i * 5, 52, "p" + i);
      return s + "</g>";
    },
    tick: (g, c) => {
      if (!c.newBeat) return;
      for (let i = 0; i < 6; i++) {
        const el = g.querySelector(".p" + i);
        el.setAttribute("y", c.talk > 0 && Math.random() < 0.5 ? "49" : "52");
        el.setAttribute("height", c.talk > 0 && Math.random() < 0.5 ? "8" : "5");
      }
    } },

  { name: "fox",
    build: () =>
      `<path class="fx-stroke fx-ear" d="M32 30 L34 8 L50 18 Z"/><path class="fx-stroke fx-ear" d="M88 30 L86 8 L70 18 Z"/>` +
      `<rect class="fx-head" x="30" y="18" width="60" height="48" rx="24"/>` +
      `<g class="fx-eyes"><ellipse class="fx-socket" cx="46" cy="38" rx="8" ry="5" transform="rotate(-8 46 38)"/><ellipse class="fx-socket" cx="74" cy="38" rx="8" ry="5" transform="rotate(8 74 38)"/><g class="fx-iris">${dot(46, 38, 2.6)}${dot(74, 38, 2.6)}</g></g>` +
      `<path class="fx-fill" d="M57 50 L63 50 L60 54 Z"/><path class="fx-stroke mo" d="M54 58 Q57 61 60 58 Q63 61 66 58"/>`,
    tick: (g, c) => {
      const s = 1 + c.talk * 1.4 * Math.abs(Math.sin(c.t * 15));
      g.querySelector(".mo").setAttribute("transform", `translate(0 ${(58 * (1 - s)).toFixed(1)}) scale(1 ${s.toFixed(2)})`);
    } },

  { name: "orb",
    build: () => `<g class="all"><circle class="fx-head" cx="60" cy="44" r="28"/>` + eyes(38, 50, 70, 5.5, 2.6) +
      `<path class="fx-stroke mo" d="M50 54 Q60 62 70 54"/></g>`,
    tick: (g, c) => {
      g.querySelector(".all").setAttribute("transform", `translate(0 ${(c.talk * 3 * Math.sin(c.t * 18)).toFixed(1)})`);
      const o = 1 + c.talk * 2 * Math.abs(Math.sin(c.t * 18));
      g.querySelector(".mo").setAttribute("d", `M50 54 Q60 ${(58 + o * 4).toFixed(1)} 70 54`);
    } },

  { name: "glitch",
    build: () => `<g class="gA" opacity="0">${head(14)}</g><g class="gB" opacity="0">${head(14)}</g>` +
      head(14) + eyes() + `<ellipse class="fx-stroke mo" cx="60" cy="55" rx="7" ry="1.5"/>`,
    tick: (g, c) => {
      g.querySelector(".mo").setAttribute("ry", (1 + c.talk * 4).toFixed(1));
      if (!c.newBeat) return;
      const a = g.querySelector(".gA"), b = g.querySelector(".gB");
      if (c.talk > 0 && Math.random() < 0.6) {
        a.setAttribute("opacity", ".3");
        a.setAttribute("transform", `translate(${(Math.random() * 4 - 2).toFixed(1)} 0)`);
        b.setAttribute("opacity", ".2");
        b.setAttribute("transform", `translate(${(Math.random() * 4 - 2).toFixed(1)} ${(Math.random() * 2 - 1).toFixed(1)})`);
      } else {
        a.setAttribute("opacity", "0");
        b.setAttribute("opacity", "0");
      }
    } },

  { name: "radar",
    build: () => head(12) +
      `<g class="fx-eyes">${sock(46, 37, 9)}${sock(74, 37, 9)}<path class="fx-stroke s1" d="M46 37 L46 29"/><path class="fx-stroke s2" d="M74 37 L74 29"/>${dot(46, 37, 1.6)}${dot(74, 37, 1.6)}</g><path class="fx-stroke mo" d="M54 58 H66"/>`,
    tick: (g, c) => {
      const a = (c.t * 160) % 360;
      g.querySelector(".s1").setAttribute("transform", `rotate(${a.toFixed(0)} 46 37)`);
      g.querySelector(".s2").setAttribute("transform", `rotate(${a.toFixed(0)} 74 37)`);
      const w = 6 + c.talk * 6 * Math.abs(Math.sin(c.t * 16));
      g.querySelector(".mo").setAttribute("d", `M${60 - w} 58 H${60 + w}`);
    } },

  { name: "wag",
    build: () => `<g class="ant"><path class="fx-stroke" d="M60 14 L60 4"/><circle class="fx-fill fx-glow" cx="60" cy="3" r="3"/></g>` +
      head(14) + eyes(36) + `<ellipse class="fx-stroke mo" cx="60" cy="54" rx="6" ry="1.5"/>`,
    tick: (g, c) => {
      const w = Math.sin(c.t * 9) * (c.talk > 0 ? 22 : 4);
      g.querySelector(".ant").setAttribute("transform", `rotate(${w.toFixed(1)} 60 14)`);
      g.querySelector(".mo").setAttribute("ry", (1 + c.talk * 4).toFixed(1));
    } },

  { name: "type",
    build: () => head(10) + eyes(34) +
      `<rect class="fx-fill mo" x="46" y="53" width="4" height="4"/><rect class="fx-fill cur" x="52" y="53" width="2.5" height="4"/>`,
    tick: (g, c) => {
      const w = 4 + c.talk * 20;
      g.querySelector(".mo").setAttribute("width", w.toFixed(1));
      const cur = g.querySelector(".cur");
      cur.setAttribute("x", (47 + w).toFixed(1));
      cur.setAttribute("opacity", Math.sin(c.t * 8) > 0 ? "1" : "0.1");
    } },

  { name: "brow",
    build: () => head(14) +
      `<g class="brows"><rect class="fx-fill" x="40" y="26" width="13" height="2.4" rx="1.2"/><rect class="fx-fill" x="67" y="26" width="13" height="2.4" rx="1.2"/></g>` +
      eyes(38) + `<ellipse class="fx-stroke mo" cx="60" cy="57" rx="7" ry="1.5"/>`,
    tick: (g, c) => {
      const o = c.talk * 4 * Math.abs(Math.sin(c.t * 13));
      g.querySelector(".brows").setAttribute("transform", `translate(0 ${(-o).toFixed(1)})`);
      g.querySelector(".mo").setAttribute("ry", (1 + c.talk * 4.5).toFixed(1));
    } },

  { name: "owl",
    build: () => `<rect class="fx-head" x="30" y="14" width="60" height="54" rx="26"/>` +
      `<g class="fx-eyes">${sock(48, 38, 11)}${sock(72, 38, 11)}<g class="fx-iris">${dot(48, 38, 4)}${dot(72, 38, 4)}</g></g><path class="fx-fill mo" d="M57 56 L63 56 L60 61 Z"/>`,
    tick: (g, c) => {
      const s = 1 + c.talk * 1.2 * Math.abs(Math.sin(c.t * 17));
      g.querySelector(".mo").setAttribute("transform", `translate(0 ${(56 * (1 - s)).toFixed(1)}) scale(1 ${s.toFixed(2)})`);
    } },

  { name: "seg",
    build: () => {
      const seg = (x, y, cl) => `<rect class="fx-fill ${cl}" x="${x}" y="${y}" width="10" height="2.6" rx=".8"/>`;
      let s = head(6) + `<g class="fx-eyes">`;
      ["s0", "s1", "s2"].forEach((cl, i) => { s += seg(41, 30 + i * 5, cl) + seg(69, 30 + i * 5, cl.replace("s", "z")); });
      return s + `</g><rect class="fx-fill mo" x="50" y="55" width="20" height="3" rx="1"/>`;
    },
    tick: (g, c) => {
      if (c.newBeat) {
        for (const cl of ["s0", "s1", "s2", "z0", "z1", "z2"]) {
          g.querySelector("." + cl).setAttribute(
            "opacity",
            c.talk > 0 ? (Math.random() < 0.75 ? "1" : ".2") : cl.endsWith("1") ? "1" : ".25",
          );
        }
      }
      const w = 12 + c.talk * 14 * Math.abs(Math.sin(c.t * 14));
      const m = g.querySelector(".mo");
      m.setAttribute("width", w.toFixed(1));
      m.setAttribute("x", (60 - w / 2).toFixed(1));
    } },

  { name: "swirl",
    build: () => head(16) +
      `<g class="fx-eyes"><circle class="fx-stroke w1" cx="46" cy="37" r="7" stroke-dasharray="6 5"/><circle class="fx-stroke w2" cx="74" cy="37" r="7" stroke-dasharray="6 5"/><g class="fx-iris">${dot(46, 37, 2)}${dot(74, 37, 2)}</g></g><path class="fx-stroke mo" d="M53 57 H67"/>`,
    tick: (g, c) => {
      const a = (c.t * (60 + c.talk * 240)) % 360;
      g.querySelector(".w1").setAttribute("transform", `rotate(${a.toFixed(0)} 46 37)`);
      g.querySelector(".w2").setAttribute("transform", `rotate(${(-a).toFixed(0)} 74 37)`);
    } },

  { name: "wink",
    build: () => head(14) +
      `<g class="fx-eyes"><g class="eL">${sock(46, 36)}<g class="fx-iris">${dot(46, 36)}</g></g><g class="eR">${sock(74, 36)}<g class="fx-iris">${dot(74, 36)}</g></g></g><ellipse class="fx-stroke mo" cx="60" cy="56" rx="7" ry="1.5"/>`,
    tick: (g, c) => {
      g.querySelector(".mo").setAttribute("ry", (1 + c.talk * 4).toFixed(1));
      const ph = Math.floor(c.t / 1.8) % 4;
      g.querySelector(".eL").setAttribute("transform", ph === 1 ? "translate(0 32.4) scale(1 0.1)" : "");
      g.querySelector(".eR").setAttribute("transform", ph === 3 ? "translate(0 32.4) scale(1 0.1)" : "");
    } },

  { name: "sleepy",
    build: () => head(14) +
      `<g class="fx-eyes">${sock(46, 37)}${sock(74, 37)}<g class="fx-iris">${dot(46, 38, 2.6)}${dot(74, 38, 2.6)}</g><rect class="lidL fx-lid" x="38" y="29" width="16" height="6"/><rect class="lidR fx-lid" x="66" y="29" width="16" height="6"/></g><ellipse class="fx-stroke mo" cx="60" cy="56" rx="5" ry="1.2"/>`,
    tick: (g, c) => {
      if (g._v === undefined) g._v = 0;
      g._v += (c.talk - g._v) * 0.12;
      const l = 6 + (1 - g._v) * 3;
      g.querySelector(".lidL").setAttribute("height", l.toFixed(1));
      g.querySelector(".lidR").setAttribute("height", l.toFixed(1));
      g.querySelector(".mo").setAttribute("ry", (1 + g._v * 6).toFixed(1));
    } },

  { name: "needle",
    build: () => head(12) + eyes(33, 48, 72, 5, 2.4) +
      `<path class="fx-stroke fx-dim" d="M46 60 A16 16 0 0 1 74 60"/><path class="fx-stroke fx-glow ndl" d="M60 60 L60 48"/><circle class="fx-fill" cx="60" cy="60" r="1.8"/>`,
    tick: (g, c) => {
      if (g._n === undefined) g._n = -38;
      const target = c.talk > 0 ? Math.sin(c.t * 10) * 38 * c.talk : -38;
      g._n += (target - g._n) * 0.2;
      g.querySelector(".ndl").setAttribute("transform", `rotate(${g._n.toFixed(1)} 60 60)`);
    } },

  { name: "pulse",
    build: () =>
      `<g><circle class="fx-stroke fx-dim r0" cx="60" cy="44" r="26"/><circle class="fx-stroke r1" cx="60" cy="44" r="18" opacity=".5"/><circle class="fx-stroke r2" cx="60" cy="44" r="10" opacity=".8"/></g>` +
      `<g class="fx-eyes"><g class="fx-iris">${dot(53, 42, 2.6)}${dot(67, 42, 2.6)}</g></g><path class="fx-stroke mo" d="M55 52 H65"/>`,
    tick: (g, c) => {
      [0, 1, 2].forEach((i) => {
        const r = [26, 18, 10][i] + c.talk * 4 * Math.sin(c.t * 9 + i * 1.1);
        g.querySelector(".r" + i).setAttribute("r", Math.max(4, r).toFixed(1));
      });
      const w = 5 + c.talk * 5 * Math.abs(Math.sin(c.t * 16));
      g.querySelector(".mo").setAttribute("d", `M${60 - w} 52 H${60 + w}`);
    } },

  { name: "sprout",
    build: () => `<g class="stem"><path class="fx-stroke" d="M60 14 Q58 8 60 3"/><ellipse class="fx-fill fx-glow bulb" cx="61" cy="3" rx="3.4" ry="2.4"/></g>` +
      `<rect class="fx-head" x="30" y="14" width="60" height="50" rx="18"/>` +
      `<g class="fx-eyes"><path class="fx-stroke" d="M41 38 Q46 33 51 38"/><path class="fx-stroke" d="M69 38 Q74 33 79 38"/></g><ellipse class="fx-stroke mo" cx="60" cy="54" rx="6" ry="1.5"/>`,
    tick: (g, c) => {
      g.querySelector(".bulb").setAttribute("ry", (2.4 * (1 + c.talk * 0.5 * Math.sin(c.t * 14))).toFixed(2));
      g.querySelector(".mo").setAttribute("ry", (1 + c.talk * 4.5).toFixed(1));
      g.querySelector(".stem").setAttribute("transform", `translate(0 ${(c.talk * 2 * Math.sin(c.t * 14)).toFixed(1)})`);
    } },

  { name: "diode",
    build: () => head(10) +
      `<g class="fx-eyes"><polygon class="fx-fill fx-glow dL" points="46,30 52,37 46,44 40,37"/><polygon class="fx-fill fx-glow dR" points="74,30 80,37 74,44 68,37"/></g><path class="fx-stroke mo" d="M50 56 L54 53 L58 59 L62 53 L66 59 L70 56"/>`,
    tick: (g, c) => {
      if (c.newBeat) {
        const o = c.talk > 0 ? 0.5 + Math.random() * 0.5 : 0.85;
        g.querySelector(".dL").setAttribute("opacity", o.toFixed(2));
        g.querySelector(".dR").setAttribute("opacity", o.toFixed(2));
      }
      const sc = 0.4 + c.talk * Math.abs(Math.sin(c.t * 18)) * 1.4;
      g.querySelector(".mo").setAttribute("transform", `translate(0 ${(56 * (1 - sc)).toFixed(1)}) scale(1 ${sc.toFixed(2)})`);
    } },

  { name: "echo",
    build: () => head(14) + eyes(35) +
      `<ellipse class="fx-stroke mo" cx="60" cy="56" rx="6" ry="1.5"/><circle class="fx-stroke e1" cx="60" cy="56" r="8" opacity="0"/><circle class="fx-stroke e2" cx="60" cy="56" r="14" opacity="0"/>`,
    tick: (g, c) => {
      g.querySelector(".mo").setAttribute("ry", (1 + c.talk * 4).toFixed(1));
      const p = c.t % 1;
      g.querySelector(".e1").setAttribute("r", (8 + p * 10).toFixed(1));
      g.querySelector(".e1").setAttribute("opacity", (c.talk * (1 - p) * 0.7).toFixed(2));
      const p2 = (c.t + 0.5) % 1;
      g.querySelector(".e2").setAttribute("r", (8 + p2 * 14).toFixed(1));
      g.querySelector(".e2").setAttribute("opacity", (c.talk * (1 - p2) * 0.45).toFixed(2));
    } },
];

export function faceNameFor(seedKey) {
  return FACES[hashStr(seedKey) % FACES.length].name;
}

// --- mounting & engine ------------------------------------------------------

/** container element -> { svg, face } */
const mounted = new Map();

/**
 * Put a seeded face inside `container` (idempotent per seed). The container's
 * column carries `--agent` (the tint color) and the mount carries
 * `data-face-mode`.
 */
export function mountFace(container, seedKey) {
  // Prune faces whose columns were removed -- without this, forgotten agents'
  // detached containers would be animated (and retained) forever.
  for (const el of mounted.keys()) {
    if (!el.isConnected && el !== container) mounted.delete(el);
  }

  const existing = mounted.get(container);
  if (existing && existing.seedKey === seedKey) return;
  const face = FACES[hashStr(seedKey) % FACES.length];
  container.innerHTML = `<svg class="fx" viewBox="0 0 120 90" aria-hidden="true">${face.build()}</svg>`;
  const entry = { seedKey, face, svg: container.querySelector("svg") };
  mounted.set(container, entry);

  // Reduced motion: no engine runs, so give the face one resting-pose tick
  // here instead of leaving the raw template geometry.
  if (reduced) {
    try {
      entry.face.tick(entry.svg, { t: 1, talk: 0, state: "idle", newBeat: true });
    } catch {
      /* ignore */
    }
  }
}

const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;

let mouseX = innerWidth / 2;
let mouseY = 160;
document.addEventListener("mousemove", (event) => {
  mouseX = event.clientX;
  mouseY = event.clientY;
});

let talk = 0;
let lastBeat = 0;
let anySpeaking = false;

function frame(now) {
  const t = now / 1000;
  let newBeat = false;
  if (t - lastBeat > 0.11) {
    lastBeat = t;
    newBeat = true;
    talk = anySpeaking ? 0.3 + Math.random() * 0.7 : 0;
  }

  anySpeaking = false;
  for (const [container, entry] of mounted) {
    if (!container.isConnected) {
      mounted.delete(container);
      continue;
    }
    const mode = container.dataset.faceMode ?? "idle";
    if (mode === "speaking") anySpeaking = true;
    if (mode === "paused") continue; // frozen mid-frame, like the audio

    const ctx = { t, talk: mode === "speaking" ? talk : 0, state: mode, newBeat };
    try {
      entry.face.tick(entry.svg, ctx);
    } catch {
      /* a broken face must never take down the panel */
    }

    // Eye contact: irises drift toward the cursor.
    const iris = entry.svg.querySelector(".fx-iris");
    if (iris && mode !== "standby") {
      const rect = container.getBoundingClientRect();
      if (rect.width > 0) {
        const dx = mouseX - (rect.left + rect.width / 2);
        const dy = mouseY - (rect.top + rect.height / 2);
        const dist = Math.hypot(dx, dy) || 1;
        const reach = clamp(dist / 240, 0, 1) * 2.6;
        iris.setAttribute(
          "transform",
          `translate(${((dx / dist) * reach).toFixed(1)} ${((dy / dist) * reach).toFixed(1)})`,
        );
      }
    }
  }
  requestAnimationFrame(frame);
}

if (!reduced) {
  requestAnimationFrame(frame);
  // Blinks: rare, random, skipped while paused or asleep.
  setInterval(() => {
    for (const [container, entry] of mounted) {
      const mode = container.dataset.faceMode ?? "idle";
      if (mode === "paused" || mode === "standby") continue;
      if (Math.random() < 0.05) {
        entry.svg.classList.add("blink");
        setTimeout(() => entry.svg.classList.remove("blink"), 150);
      }
    }
  }, 380);
}
