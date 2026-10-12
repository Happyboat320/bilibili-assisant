/* WBI 是 B 站公开接口的参数签名；密钥从 nav 接口读取，不绕过权限校验。 */
(function (root) {
  "use strict";
  function md5(value) {
    const bytes = new TextEncoder().encode(value);
    const size = Math.ceil((bytes.length + 9) / 64) * 64;
    const data = new Uint8Array(size);
    data.set(bytes); data[bytes.length] = 128;
    const view = new DataView(data.buffer);
    view.setUint32(size - 8, bytes.length * 8, true);
    view.setUint32(size - 4, Math.floor(bytes.length / 536870912), true);
    const shifts = [7,12,17,22,5,9,14,20,4,11,16,23,6,10,15,21];
    let state = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476];
    for (let offset = 0; offset < size; offset += 64) {
      let [a,b,c,d] = state;
      for (let i = 0; i < 64; i++) {
        let f, g;
        if (i < 16) { f = (b & c) | (~b & d); g = i; }
        else if (i < 32) { f = (d & b) | (~d & c); g = (5 * i + 1) % 16; }
        else if (i < 48) { f = b ^ c ^ d; g = (3 * i + 5) % 16; }
        else { f = c ^ (b | ~d); g = (7 * i) % 16; }
        const n = (a + f + Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) + view.getUint32(offset + g * 4, true)) | 0;
        const shift = shifts[Math.floor(i / 16) * 4 + i % 4];
        const next = (b + ((n << shift) | (n >>> (32 - shift)))) | 0;
        a = d; d = c; c = b; b = next;
      }
      state = state.map((v, i) => (v + [a,b,c,d][i]) | 0);
    }
    return state.map(n => [0,8,16,24].map(s => ((n >>> s) & 255).toString(16).padStart(2, "0")).join("")).join("");
  }
  const permutation = [46,47,18,2,53,8,23,32,15,50,10,31,58,3,45,35,27,43,5,49,33,9,42,19,29,28,14,39,12,38,41,13,37,48,7,16,24,55,40,61,26,17,0,1,60,51,30,4,22,25,54,21,56,59,6,63,57,62,11,36,20,34,44,52];
  function sign(params, imgKey, subKey, time = Math.floor(Date.now() / 1000)) {
    const original = imgKey + subKey;
    const key = permutation.map(i => original[i]).join("").slice(0, 32);
    const values = { ...params, wts: time };
    const query = Object.keys(values).sort().map(k => `${encodeURIComponent(k)}=${encodeURIComponent(String(values[k]).replace(/[!'()*]/g, ""))}`).join("&");
    return query + "&w_rid=" + md5(query + key);
  }
  root.BiliWbi = { md5, sign };
  if (typeof module !== "undefined") module.exports = root.BiliWbi;
})(globalThis);
