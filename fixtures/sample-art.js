// Flat product tiles for the sample list. Real trips use Instacart photos.
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const SAMPLE = require("./sample-cart.json");

function pngBuffer(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  function chunk(type, data) {
    const head = Buffer.alloc(4);
    head.writeUInt32BE(data.length, 0);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(body) >>> 0, 0);
    return Buffer.concat([head, body, crc]);
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function canvas(size, bg) {
  const px = Buffer.alloc(size * size * 4);
  for (let i = 0; i < px.length; i += 4) {
    px[i] = bg[0]; px[i + 1] = bg[1]; px[i + 2] = bg[2]; px[i + 3] = 255;
  }
  function blend(x, y, color, alpha) {
    if (alpha <= 0) return;
    const ix = Math.round(x);
    const iy = Math.round(y);
    if (ix < 0 || iy < 0 || ix >= size || iy >= size) return;
    const i = (iy * size + ix) * 4;
    const a = Math.max(0, Math.min(1, alpha));
    px[i] = Math.round(color[0] * a + px[i] * (1 - a));
    px[i + 1] = Math.round(color[1] * a + px[i + 1] * (1 - a));
    px[i + 2] = Math.round(color[2] * a + px[i + 2] * (1 - a));
  }
  function fill(test, color, x0, y0, x1, y1) {
    const left = Math.max(0, Math.floor(x0));
    const top = Math.max(0, Math.floor(y0));
    const right = Math.min(size - 1, Math.ceil(x1));
    const bottom = Math.min(size - 1, Math.ceil(y1));
    for (let y = top; y <= bottom; y++) {
      for (let x = left; x <= right; x++) {
        let hit = 0;
        for (let sy = 0; sy < 2; sy++) {
          for (let sx = 0; sx < 2; sx++) {
            if (test(x + (sx + 0.5) / 2, y + (sy + 0.5) / 2)) hit++;
          }
        }
        if (hit) blend(x, y, color, hit / 4);
      }
    }
  }
  return {
    px: px,
    circle(cx, cy, r, color) {
      fill(function (x, y) { return Math.hypot(x - cx, y - cy) <= r; }, color, cx - r, cy - r, cx + r, cy + r);
    },
    ellipse(cx, cy, rx, ry, rot, color) {
      const cos = Math.cos(rot || 0);
      const sin = Math.sin(rot || 0);
      const reach = Math.max(rx, ry) + 1;
      fill(function (x, y) {
        const dx = x - cx;
        const dy = y - cy;
        const lx = dx * cos + dy * sin;
        const ly = -dx * sin + dy * cos;
        return (lx * lx) / (rx * rx) + (ly * ly) / (ry * ry) <= 1;
      }, color, cx - reach, cy - reach, cx + reach, cy + reach);
    },
    round(x, y, w, h, r, color) {
      fill(function (px, py) {
        if (px < x || py < y || px > x + w || py > y + h) return false;
        const left = px < x + r;
        const right = px > x + w - r;
        const top = py < y + r;
        const bottom = py > y + h - r;
        if ((left || right) && (top || bottom)) {
          const ccx = left ? x + r : x + w - r;
          const ccy = top ? y + r : y + h - r;
          return Math.hypot(px - ccx, py - ccy) <= r;
        }
        return true;
      }, color, x, y, x + w, y + h);
    },
    arc(cx, cy, r0, r1, a0, a1, color) {
      const reach = r1 + 1;
      fill(function (x, y) {
        const dx = x - cx;
        const dy = y - cy;
        const d = Math.hypot(dx, dy);
        if (d < r0 || d > r1) return false;
        let a = Math.atan2(dy, dx);
        if (a < 0) a += Math.PI * 2;
        let start = a0;
        let end = a1;
        if (end < start) end += Math.PI * 2;
        if (a < start) a += Math.PI * 2;
        return a >= start && a <= end;
      }, color, cx - reach, cy - reach, cx + reach, cy + reach);
    },
  };
}

function draw(art) {
  const S = 160;
  const scenes = {
    banana: function (c) {
      c.arc(92, 96, 36, 54, 2.4, 4.7, [246, 196, 69]);
      c.circle(118, 42, 7, [109, 76, 30]);
      c.circle(52, 128, 6, [109, 76, 30]);
    },
    lettuce: function (c) {
      c.ellipse(80, 88, 52, 40, 0, [62, 143, 74]);
      c.ellipse(80, 82, 34, 26, 0, [126, 196, 104]);
      c.ellipse(80, 78, 14, 18, 0, [232, 248, 214]);
    },
    berry: function (c) {
      c.ellipse(80, 92, 36, 42, 0, [226, 61, 74]);
      c.ellipse(80, 58, 16, 10, 0, [46, 125, 70]);
      [[58, 84], [80, 96], [102, 82], [70, 112], [96, 114]].forEach(function (p) {
        c.circle(p[0], p[1], 3, [255, 214, 90]);
      });
    },
    bread: function (c) {
      c.round(38, 58, 84, 58, 26, [230, 176, 112]);
      c.round(48, 70, 64, 18, 9, [244, 214, 168]);
      c.round(58, 78, 6, 28, 3, [196, 132, 72]);
      c.round(78, 78, 6, 28, 3, [196, 132, 72]);
      c.round(98, 78, 6, 28, 3, [196, 132, 72]);
    },
    bagel: function (c) {
      c.circle(80, 82, 42, [217, 161, 90]);
      c.circle(80, 82, 16, [246, 230, 207]);
      [[62, 58], [96, 64], [108, 96], [54, 100]].forEach(function (p) { c.circle(p[0], p[1], 3, [90, 62, 36]); });
    },
    turkey: function (c) {
      c.round(46, 48, 70, 22, 10, [231, 160, 160]);
      c.round(40, 74, 80, 22, 10, [214, 120, 120]);
      c.round(48, 100, 66, 20, 10, [196, 96, 96]);
    },
    cheddar: function (c) {
      c.round(42, 50, 78, 68, 12, [240, 162, 2]);
      c.circle(70, 78, 8, [255, 214, 102]);
      c.circle(98, 96, 6, [255, 214, 102]);
      c.circle(78, 104, 5, [255, 214, 102]);
    },
    chicken: function (c) {
      c.ellipse(96, 96, 36, 24, 0.6, [232, 184, 154]);
      c.circle(58, 62, 16, [244, 232, 214]);
      c.circle(58, 62, 7, [210, 180, 150]);
    },
    beef: function (c) {
      c.circle(80, 84, 46, [196, 69, 54]);
      c.circle(80, 84, 18, [244, 220, 196]);
      c.circle(62, 70, 6, [232, 160, 140]);
    },
    can: function (c) {
      c.round(54, 36, 52, 92, 16, [200, 62, 62]);
      c.ellipse(80, 40, 26, 10, 0, [232, 120, 112]);
      c.round(62, 70, 36, 16, 4, [255, 244, 230]);
    },
    pasta: function (c) {
      c.round(46, 40, 68, 86, 10, [242, 209, 107]);
      c.arc(80, 78, 10, 18, 0.4, 2.4, [214, 164, 54]);
      c.arc(80, 86, 16, 24, 3.4, 5.4, [214, 164, 54]);
    },
    pb: function (c) {
      c.round(52, 46, 56, 74, 12, [168, 107, 60]);
      c.round(60, 36, 40, 18, 8, [214, 168, 112]);
      c.round(66, 78, 28, 18, 6, [242, 220, 180]);
    },
    cereal: function (c) {
      c.round(48, 32, 64, 100, 8, [224, 122, 61]);
      c.circle(80, 86, 22, [255, 214, 140]);
      c.circle(72, 80, 6, [224, 122, 61]);
      c.circle(90, 92, 5, [224, 122, 61]);
    },
    oil: function (c) {
      c.round(68, 34, 24, 18, 6, [90, 120, 48]);
      c.round(58, 50, 44, 72, 16, [107, 143, 60]);
      c.ellipse(80, 86, 10, 16, 0, [214, 232, 150]);
    },
    chips: function (c) {
      c.round(50, 30, 60, 104, 18, [217, 79, 79]);
      c.round(62, 48, 36, 22, 8, [255, 214, 120]);
      c.circle(80, 96, 10, [255, 236, 180]);
    },
    towels: function (c) {
      c.ellipse(80, 58, 36, 14, 0, [123, 163, 201]);
      c.round(44, 58, 72, 58, 8, [168, 204, 230]);
      c.ellipse(80, 116, 36, 14, 0, [123, 163, 201]);
      c.round(70, 70, 8, 36, 4, [255, 255, 255]);
    },
    milk: function (c) {
      c.round(50, 36, 60, 90, 8, [247, 247, 247]);
      c.round(50, 78, 60, 28, 4, [47, 128, 196]);
      c.round(62, 28, 36, 16, 4, [220, 232, 242]);
    },
    yogurt: function (c) {
      c.round(50, 58, 60, 62, 16, [244, 241, 250]);
      c.ellipse(80, 62, 30, 12, 0, [149, 117, 205]);
      c.round(62, 86, 36, 10, 4, [149, 117, 205]);
    },
    butter: function (c) {
      c.round(36, 62, 88, 42, 8, [246, 213, 107]);
      c.round(36, 62, 28, 42, 8, [232, 168, 60]);
      c.round(48, 74, 52, 8, 3, [255, 244, 200]);
    },
    pizza: function (c) {
      c.circle(80, 86, 48, [226, 106, 61]);
      c.circle(80, 86, 34, [244, 208, 120]);
      c.circle(68, 78, 7, [196, 48, 42]);
      c.circle(92, 96, 6, [196, 48, 42]);
      c.circle(78, 104, 5, [90, 140, 60]);
    },
    icecream: function (c) {
      c.circle(80, 62, 28, [243, 193, 212]);
      c.circle(62, 74, 16, [255, 228, 236]);
      c.round(68, 84, 24, 46, 4, [214, 154, 90]);
    },
    cola: function (c) {
      c.round(58, 28, 44, 104, 12, [198, 40, 40]);
      c.round(58, 58, 44, 22, 4, [255, 255, 255]);
      c.ellipse(80, 30, 22, 8, 0, [160, 28, 28]);
    },
    water: function (c) {
      c.round(62, 26, 36, 108, 14, [79, 195, 247]);
      c.round(70, 18, 20, 16, 6, [144, 214, 255]);
      c.round(70, 70, 20, 28, 6, [255, 255, 255]);
    },
    candles: function (c) {
      [48, 68, 88, 108].forEach(function (x, i) {
        c.round(x, 58, 12, 62, 4, i % 2 ? [244, 143, 177] : [255, 255, 255]);
        c.ellipse(x + 6, 52, 4, 8, 0, [255, 196, 80]);
      });
    },
    bouquet: function (c) {
      c.round(74, 78, 12, 48, 4, [90, 140, 70]);
      c.circle(58, 70, 16, [226, 96, 122]);
      c.circle(102, 68, 16, [244, 176, 74]);
      c.circle(80, 52, 18, [186, 104, 200]);
      c.circle(80, 74, 8, [255, 220, 120]);
    },
  };
  const backgrounds = {
    banana: [255, 244, 204], lettuce: [229, 246, 232], berry: [253, 232, 234], bread: [248, 235, 215],
    bagel: [246, 230, 207], turkey: [251, 236, 236], cheddar: [255, 241, 214], chicken: [251, 232, 220],
    beef: [248, 228, 224], can: [248, 232, 230], pasta: [251, 243, 216], pb: [243, 230, 214],
    cereal: [253, 233, 216], oil: [234, 243, 216], chips: [253, 232, 228], towels: [231, 241, 248],
    milk: [231, 242, 250], yogurt: [237, 231, 246], butter: [255, 246, 216], pizza: [253, 232, 220],
    icecream: [253, 238, 243], cola: [248, 230, 230], water: [227, 246, 253], candles: [253, 231, 240],
    bouquet: [243, 232, 245],
  };
  const c = canvas(S, backgrounds[art] || [240, 240, 240]);
  (scenes[art] || scenes.candles)(c);
  return pngBuffer(S, S, c.px);
}

function writeSampleImages(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const items = SAMPLE.map(function (item) {
    const file = item.art + ".png";
    fs.writeFileSync(path.join(dir, file), draw(item.art));
    return Object.assign({}, item, { image: "/assets/sample/" + file });
  });
  return items;
}

module.exports = { SAMPLE, writeSampleImages, draw };
