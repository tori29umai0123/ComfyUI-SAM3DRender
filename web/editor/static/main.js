/* ComfyUI-SAM3DRender — viewer page bootstrap.
 *
 * Re-uses the WebGL2 splat shaders and worker-based PLY → splat
 * conversion + depth sort pattern from antimatter15/splat (E:/splat),
 * with three additions:
 *
 *   1. Intuitive controls: left-drag in-place rotate (axis-locked,
 *      yaw around world-up + pitch around camera-right), right-drag
 *      pan, wheel zoom, WASD/QE keys for fly, R to reset camera.
 *   2. Selection-rect overlay matching the SAM3DBody Confirm flow
 *      ("撮影範囲指定" toggle → drag red rect → reset / 範囲指定を終了 →
 *      Confirm & Close).
 *   3. Captures the (optionally cropped) canvas as a PNG dataURL and
 *      posts it back to the parent ComfyUI window via postMessage.
 *
 * The shader code and worker logic are taken largely verbatim from
 * E:/splat/main.js (MIT — Kevin Kwok / antimatter15) since they are
 * non-trivial and well-tuned; control bindings, selection UI, capture,
 * and the PLY-loading source were rewritten for this project.
 */

(() => {
"use strict";

// ---------------------------------------------------------------------
// Math helpers (from splat/main.js — left intact)
// ---------------------------------------------------------------------
function getProjectionMatrix(fx, fy, width, height) {
    const znear = 0.2, zfar = 200;
    return [
        [(2 * fx) / width, 0, 0, 0],
        [0, -(2 * fy) / height, 0, 0],
        [0, 0, zfar / (zfar - znear), 1],
        [0, 0, -(zfar * znear) / (zfar - znear), 0],
    ].flat();
}

function multiply4(a, b) {
    return [
        b[0]*a[0]+b[1]*a[4]+b[2]*a[8]+b[3]*a[12],
        b[0]*a[1]+b[1]*a[5]+b[2]*a[9]+b[3]*a[13],
        b[0]*a[2]+b[1]*a[6]+b[2]*a[10]+b[3]*a[14],
        b[0]*a[3]+b[1]*a[7]+b[2]*a[11]+b[3]*a[15],
        b[4]*a[0]+b[5]*a[4]+b[6]*a[8]+b[7]*a[12],
        b[4]*a[1]+b[5]*a[5]+b[6]*a[9]+b[7]*a[13],
        b[4]*a[2]+b[5]*a[6]+b[6]*a[10]+b[7]*a[14],
        b[4]*a[3]+b[5]*a[7]+b[6]*a[11]+b[7]*a[15],
        b[8]*a[0]+b[9]*a[4]+b[10]*a[8]+b[11]*a[12],
        b[8]*a[1]+b[9]*a[5]+b[10]*a[9]+b[11]*a[13],
        b[8]*a[2]+b[9]*a[6]+b[10]*a[10]+b[11]*a[14],
        b[8]*a[3]+b[9]*a[7]+b[10]*a[11]+b[11]*a[15],
        b[12]*a[0]+b[13]*a[4]+b[14]*a[8]+b[15]*a[12],
        b[12]*a[1]+b[13]*a[5]+b[14]*a[9]+b[15]*a[13],
        b[12]*a[2]+b[13]*a[6]+b[14]*a[10]+b[15]*a[14],
        b[12]*a[3]+b[13]*a[7]+b[14]*a[11]+b[15]*a[15],
    ];
}

function invert4(a) {
    let b00 = a[0]*a[5] - a[1]*a[4];
    let b01 = a[0]*a[6] - a[2]*a[4];
    let b02 = a[0]*a[7] - a[3]*a[4];
    let b03 = a[1]*a[6] - a[2]*a[5];
    let b04 = a[1]*a[7] - a[3]*a[5];
    let b05 = a[2]*a[7] - a[3]*a[6];
    let b06 = a[8]*a[13] - a[9]*a[12];
    let b07 = a[8]*a[14] - a[10]*a[12];
    let b08 = a[8]*a[15] - a[11]*a[12];
    let b09 = a[9]*a[14] - a[10]*a[13];
    let b10 = a[9]*a[15] - a[11]*a[13];
    let b11 = a[10]*a[15] - a[11]*a[14];
    let det = b00*b11 - b01*b10 + b02*b09 + b03*b08 - b04*b07 + b05*b06;
    if (!det) return null;
    return [
        (a[5]*b11 - a[6]*b10 + a[7]*b09)/det,
        (a[2]*b10 - a[1]*b11 - a[3]*b09)/det,
        (a[13]*b05 - a[14]*b04 + a[15]*b03)/det,
        (a[10]*b04 - a[9]*b05 - a[11]*b03)/det,
        (a[6]*b08 - a[4]*b11 - a[7]*b07)/det,
        (a[0]*b11 - a[2]*b08 + a[3]*b07)/det,
        (a[14]*b02 - a[12]*b05 - a[15]*b01)/det,
        (a[8]*b05 - a[10]*b02 + a[11]*b01)/det,
        (a[4]*b10 - a[5]*b08 + a[7]*b06)/det,
        (a[1]*b08 - a[0]*b10 - a[3]*b06)/det,
        (a[12]*b04 - a[13]*b02 + a[15]*b00)/det,
        (a[9]*b02 - a[8]*b04 - a[11]*b00)/det,
        (a[5]*b07 - a[4]*b09 - a[6]*b06)/det,
        (a[0]*b09 - a[1]*b07 + a[2]*b06)/det,
        (a[13]*b01 - a[12]*b03 - a[14]*b00)/det,
        (a[8]*b03 - a[9]*b01 + a[10]*b00)/det,
    ];
}

function rotate4(a, rad, x, y, z) {
    let len = Math.hypot(x, y, z);
    x /= len; y /= len; z /= len;
    let s = Math.sin(rad), c = Math.cos(rad), t = 1 - c;
    let b00 = x*x*t + c,    b01 = y*x*t + z*s,  b02 = z*x*t - y*s;
    let b10 = x*y*t - z*s,  b11 = y*y*t + c,    b12 = z*y*t + x*s;
    let b20 = x*z*t + y*s,  b21 = y*z*t - x*s,  b22 = z*z*t + c;
    return [
        a[0]*b00 + a[4]*b01 + a[8]*b02,
        a[1]*b00 + a[5]*b01 + a[9]*b02,
        a[2]*b00 + a[6]*b01 + a[10]*b02,
        a[3]*b00 + a[7]*b01 + a[11]*b02,
        a[0]*b10 + a[4]*b11 + a[8]*b12,
        a[1]*b10 + a[5]*b11 + a[9]*b12,
        a[2]*b10 + a[6]*b11 + a[10]*b12,
        a[3]*b10 + a[7]*b11 + a[11]*b12,
        a[0]*b20 + a[4]*b21 + a[8]*b22,
        a[1]*b20 + a[5]*b21 + a[9]*b22,
        a[2]*b20 + a[6]*b21 + a[10]*b22,
        a[3]*b20 + a[7]*b21 + a[11]*b22,
        ...a.slice(12, 16),
    ];
}

function translate4(a, x, y, z) {
    return [
        ...a.slice(0, 12),
        a[0]*x + a[4]*y + a[8]*z + a[12],
        a[1]*x + a[5]*y + a[9]*z + a[13],
        a[2]*x + a[6]*y + a[10]*z + a[14],
        a[3]*x + a[7]*y + a[11]*z + a[15],
    ];
}

// Translate in WORLD frame — directly bumps the translation column.
// Used for "Space = jump" / "X = crouch" so vertical movement always
// runs along the chosen world-up axis instead of the camera's own up,
// even when the camera is pitched.
function translateWorld4(a, x, y, z) {
    return [
        ...a.slice(0, 12),
        a[12] + x,
        a[13] + y,
        a[14] + z,
        a[15],
    ];
}

// ---------------------------------------------------------------------
// Worker — sorts splats by depth and packs them into the GPU texture.
// Logic copied from antimatter15/splat (MIT). Only invocation glue
// (postMessage shape) is touched by us.
// ---------------------------------------------------------------------
function createWorker(self) {
    let buffer;
    // Pristine copy of the parsed splat buffer — kept around so the live
    // "Splat Size" slider in the viewer can re-derive scaled buffers from
    // the original each time without compounding rounding errors.
    let originalBuffer = null;
    let currentScaleMultiplier = 1.0;
    let vertexCount = 0;
    let viewProj;
    const rowLength = 3*4 + 3*4 + 4 + 4;
    let lastProj = [];
    let depthIndex = new Uint32Array();
    let lastVertexCount = 0;

    var _floatView = new Float32Array(1);
    var _int32View = new Int32Array(_floatView.buffer);

    function floatToHalf(float) {
        _floatView[0] = float;
        var f = _int32View[0];
        var sign = (f >> 31) & 0x0001;
        var exp = (f >> 23) & 0x00ff;
        var frac = f & 0x007fffff;
        var newExp;
        if (exp == 0) newExp = 0;
        else if (exp < 113) {
            newExp = 0;
            frac |= 0x00800000;
            frac = frac >> (113 - exp);
            if (frac & 0x01000000) { newExp = 1; frac = 0; }
        } else if (exp < 142) newExp = exp - 112;
        else { newExp = 31; frac = 0; }
        return (sign << 15) | (newExp << 10) | (frac >> 13);
    }

    function packHalf2x16(x, y) {
        return (floatToHalf(x) | (floatToHalf(y) << 16)) >>> 0;
    }

    function generateTexture() {
        if (!buffer) return;
        const f_buffer = new Float32Array(buffer);
        const u_buffer = new Uint8Array(buffer);
        var texwidth = 1024 * 2;
        var texheight = Math.ceil((2 * vertexCount) / texwidth);
        var texdata = new Uint32Array(texwidth * texheight * 4);
        var texdata_c = new Uint8Array(texdata.buffer);
        var texdata_f = new Float32Array(texdata.buffer);
        for (let i = 0; i < vertexCount; i++) {
            texdata_f[8*i + 0] = f_buffer[8*i + 0];
            texdata_f[8*i + 1] = f_buffer[8*i + 1];
            texdata_f[8*i + 2] = f_buffer[8*i + 2];
            texdata_c[4*(8*i + 7) + 0] = u_buffer[32*i + 24 + 0];
            texdata_c[4*(8*i + 7) + 1] = u_buffer[32*i + 24 + 1];
            texdata_c[4*(8*i + 7) + 2] = u_buffer[32*i + 24 + 2];
            texdata_c[4*(8*i + 7) + 3] = u_buffer[32*i + 24 + 3];
            let scale = [
                f_buffer[8*i + 3 + 0],
                f_buffer[8*i + 3 + 1],
                f_buffer[8*i + 3 + 2],
            ];
            let rot = [
                (u_buffer[32*i + 28 + 0] - 128) / 128,
                (u_buffer[32*i + 28 + 1] - 128) / 128,
                (u_buffer[32*i + 28 + 2] - 128) / 128,
                (u_buffer[32*i + 28 + 3] - 128) / 128,
            ];
            const M = [
                1.0 - 2.0 * (rot[2]*rot[2] + rot[3]*rot[3]),
                2.0 * (rot[1]*rot[2] + rot[0]*rot[3]),
                2.0 * (rot[1]*rot[3] - rot[0]*rot[2]),
                2.0 * (rot[1]*rot[2] - rot[0]*rot[3]),
                1.0 - 2.0 * (rot[1]*rot[1] + rot[3]*rot[3]),
                2.0 * (rot[2]*rot[3] + rot[0]*rot[1]),
                2.0 * (rot[1]*rot[3] + rot[0]*rot[2]),
                2.0 * (rot[2]*rot[3] - rot[0]*rot[1]),
                1.0 - 2.0 * (rot[1]*rot[1] + rot[2]*rot[2]),
            ].map((k, i) => k * scale[Math.floor(i / 3)]);
            const sigma = [
                M[0]*M[0] + M[3]*M[3] + M[6]*M[6],
                M[0]*M[1] + M[3]*M[4] + M[6]*M[7],
                M[0]*M[2] + M[3]*M[5] + M[6]*M[8],
                M[1]*M[1] + M[4]*M[4] + M[7]*M[7],
                M[1]*M[2] + M[4]*M[5] + M[7]*M[8],
                M[2]*M[2] + M[5]*M[5] + M[8]*M[8],
            ];
            texdata[8*i + 4] = packHalf2x16(4*sigma[0], 4*sigma[1]);
            texdata[8*i + 5] = packHalf2x16(4*sigma[2], 4*sigma[3]);
            texdata[8*i + 6] = packHalf2x16(4*sigma[4], 4*sigma[5]);
        }
        self.postMessage({ texdata, texwidth, texheight }, [texdata.buffer]);
    }

    function runSort(viewProj) {
        if (!buffer) return;
        const f_buffer = new Float32Array(buffer);
        if (lastVertexCount == vertexCount) {
            let dot = lastProj[2]*viewProj[2] + lastProj[6]*viewProj[6] + lastProj[10]*viewProj[10];
            if (Math.abs(dot - 1) < 0.01) return;
        } else {
            generateTexture();
            lastVertexCount = vertexCount;
        }
        let maxDepth = -Infinity;
        let minDepth = Infinity;
        let sizeList = new Int32Array(vertexCount);
        for (let i = 0; i < vertexCount; i++) {
            let depth = ((viewProj[2]*f_buffer[8*i+0] + viewProj[6]*f_buffer[8*i+1] + viewProj[10]*f_buffer[8*i+2]) * 4096) | 0;
            sizeList[i] = depth;
            if (depth > maxDepth) maxDepth = depth;
            if (depth < minDepth) minDepth = depth;
        }
        let depthInv = (256*256 - 1) / (maxDepth - minDepth);
        let counts0 = new Uint32Array(256*256);
        for (let i = 0; i < vertexCount; i++) {
            sizeList[i] = ((sizeList[i] - minDepth) * depthInv) | 0;
            counts0[sizeList[i]]++;
        }
        let starts0 = new Uint32Array(256*256);
        for (let i = 1; i < 256*256; i++) starts0[i] = starts0[i-1] + counts0[i-1];
        depthIndex = new Uint32Array(vertexCount);
        for (let i = 0; i < vertexCount; i++) depthIndex[starts0[sizeList[i]]++] = i;
        lastProj = viewProj;
        self.postMessage({ depthIndex, viewProj, vertexCount }, [depthIndex.buffer]);
    }

    function processPlyBuffer(inputBuffer) {
        const ubuf = new Uint8Array(inputBuffer);
        const header = new TextDecoder().decode(ubuf.slice(0, 1024 * 10));
        const header_end = "end_header\n";
        const header_end_index = header.indexOf(header_end);
        if (header_end_index < 0) throw new Error("Unable to read .ply file header");
        const vertexCount = parseInt(/element vertex (\d+)\n/.exec(header)[1]);
        let row_offset = 0, offsets = {}, types = {};
        const TYPE_MAP = {
            double: "getFloat64", int: "getInt32", uint: "getUint32",
            float: "getFloat32", short: "getInt16", ushort: "getUint16", uchar: "getUint8",
        };
        for (let prop of header.slice(0, header_end_index).split("\n").filter((k) => k.startsWith("property "))) {
            const [p, type, name] = prop.split(" ");
            const arrayType = TYPE_MAP[type] || "getInt8";
            types[name] = arrayType;
            offsets[name] = row_offset;
            row_offset += parseInt(arrayType.replace(/[^\d]/g, "")) / 8;
        }
        let dataView = new DataView(inputBuffer, header_end_index + header_end.length);
        let row = 0;
        const attrs = new Proxy({}, {
            get(target, prop) {
                if (!types[prop]) throw new Error(prop + " not found");
                return dataView[types[prop]](row * row_offset + offsets[prop], true);
            },
        });
        let sizeList = new Float32Array(vertexCount);
        let sizeIndex = new Uint32Array(vertexCount);
        for (row = 0; row < vertexCount; row++) {
            sizeIndex[row] = row;
            if (!types["scale_0"]) continue;
            const size = Math.exp(attrs.scale_0) * Math.exp(attrs.scale_1) * Math.exp(attrs.scale_2);
            const opacity = 1 / (1 + Math.exp(-attrs.opacity));
            sizeList[row] = size * opacity;
        }
        sizeIndex.sort((b, a) => sizeList[a] - sizeList[b]);
        const rowLength = 3*4 + 3*4 + 4 + 4;
        const buffer = new ArrayBuffer(rowLength * vertexCount);
        for (let j = 0; j < vertexCount; j++) {
            row = sizeIndex[j];
            const position = new Float32Array(buffer, j * rowLength, 3);
            const scales   = new Float32Array(buffer, j * rowLength + 4*3, 3);
            const rgba = new Uint8ClampedArray(buffer, j * rowLength + 4*3 + 4*3, 4);
            const rot  = new Uint8ClampedArray(buffer, j * rowLength + 4*3 + 4*3 + 4, 4);
            if (types["scale_0"]) {
                const qlen = Math.sqrt(attrs.rot_0**2 + attrs.rot_1**2 + attrs.rot_2**2 + attrs.rot_3**2);
                rot[0] = (attrs.rot_0 / qlen) * 128 + 128;
                rot[1] = (attrs.rot_1 / qlen) * 128 + 128;
                rot[2] = (attrs.rot_2 / qlen) * 128 + 128;
                rot[3] = (attrs.rot_3 / qlen) * 128 + 128;
                scales[0] = Math.exp(attrs.scale_0);
                scales[1] = Math.exp(attrs.scale_1);
                scales[2] = Math.exp(attrs.scale_2);
            } else {
                scales[0] = 0.01; scales[1] = 0.01; scales[2] = 0.01;
                rot[0] = 255; rot[1] = 0; rot[2] = 0; rot[3] = 0;
            }
            position[0] = attrs.x; position[1] = attrs.y; position[2] = attrs.z;
            if (types["f_dc_0"]) {
                const SH_C0 = 0.28209479177387814;
                rgba[0] = (0.5 + SH_C0 * attrs.f_dc_0) * 255;
                rgba[1] = (0.5 + SH_C0 * attrs.f_dc_1) * 255;
                rgba[2] = (0.5 + SH_C0 * attrs.f_dc_2) * 255;
            } else {
                rgba[0] = attrs.red; rgba[1] = attrs.green; rgba[2] = attrs.blue;
            }
            if (types["opacity"]) rgba[3] = (1 / (1 + Math.exp(-attrs.opacity))) * 255;
            else rgba[3] = 255;
        }
        return buffer;
    }

    let sortRunning;
    const throttledSort = () => {
        if (!sortRunning) {
            sortRunning = true;
            let lastView = viewProj;
            runSort(lastView);
            setTimeout(() => {
                sortRunning = false;
                if (lastView !== viewProj) throttledSort();
            }, 0);
        }
    };
    // Compute the centroid of every splat's position (offset 0..11 of each
    // 32-byte row) and post it to the main thread. The main-thread "Flip
    // 180°" button uses this as the orbit pivot so the camera ends up on
    // the diagonally opposite side of the actual data, not a hard-coded
    // distance forward of the current view. Coords are in PLY/buffer space
    // — the main thread runs them through the active SCENE_ROTATIONS to
    // bring them into viewMatrix-world before orbiting.
    function postCentroid() {
        if (!originalBuffer || !vertexCount) return;
        const f = new Float32Array(originalBuffer);
        let sx = 0, sy = 0, sz = 0;
        for (let i = 0; i < vertexCount; i++) {
            sx += f[8*i + 0];
            sy += f[8*i + 1];
            sz += f[8*i + 2];
        }
        postMessage({ centroid: [sx / vertexCount, sy / vertexCount, sz / vertexCount] });
    }

    // Build a working buffer from the pristine `originalBuffer` with each
    // splat's linear-space scale (offsets 12, 16, 20 within its 32-byte row,
    // post-exp() out of processPlyBuffer) multiplied by ``factor``. factor=1
    // skips the per-vertex loop and just shares the original.
    function applySplatScale(factor) {
        // Always remember the multiplier — even if no PLY is loaded yet —
        // so a scaleMultiplier message that arrives BEFORE the first ply
        // (e.g. when restoring view_state on modal reopen) still sticks.
        // The PLY handler later calls applySplatScale(currentScaleMultiplier)
        // and picks it up.
        currentScaleMultiplier = factor;
        if (!originalBuffer) return;
        if (factor === 1.0) {
            buffer = originalBuffer;
        } else {
            buffer = originalBuffer.slice(0);
            const f_buffer = new Float32Array(buffer);
            const N = vertexCount;
            for (let i = 0; i < N; i++) {
                f_buffer[8*i + 3] *= factor;
                f_buffer[8*i + 4] *= factor;
                f_buffer[8*i + 5] *= factor;
            }
        }
        generateTexture();
    }

    self.onmessage = (e) => {
        if (e.data.ply) {
            vertexCount = 0;
            runSort(viewProj);
            const parsed = processPlyBuffer(e.data.ply);
            originalBuffer = parsed;
            vertexCount = Math.floor(parsed.byteLength / rowLength);
            // Reapply the slider's current value so a re-parse of the same
            // PLY (e.g. after a view_state restore) preserves the user's
            // size choice instead of snapping back to ×1.
            applySplatScale(currentScaleMultiplier);
            postCentroid();
            postMessage({ buffer: buffer });
        } else if (e.data.scaleMultiplier !== undefined) {
            applySplatScale(Number(e.data.scaleMultiplier) || 1.0);
        } else if (e.data.buffer) {
            // .splat path: 32-byte rows already laid out for us.
            originalBuffer = e.data.buffer;
            vertexCount = e.data.vertexCount;
            applySplatScale(currentScaleMultiplier);
            postCentroid();
        } else if (e.data.vertexCount) {
            vertexCount = e.data.vertexCount;
        } else if (e.data.view) {
            viewProj = e.data.view;
            throttledSort();
        }
    };
}

// ---------------------------------------------------------------------
// Shaders (verbatim from antimatter15/splat)
// ---------------------------------------------------------------------
const vertexShaderSource = `
#version 300 es
precision highp float;
precision highp int;

uniform highp usampler2D u_texture;
uniform mat4 projection, view;
uniform vec2 focal;
uniform vec2 viewport;
// Distance below which splats are discarded — used to peel off foreground
// walls / pillars that block the camera's view of the subject. This
// projection convention (see getProjectionMatrix in main.js: w = +z) puts
// visible points at positive camera-space z, so the camera looks down +Z
// and a splat at distance d has cam.z = +d. We cull when cam.z < nearClip.
// nearClip == 0 disables culling entirely.
uniform float nearClip;

in vec2 position;
in int index;

out vec4 vColor;
out vec2 vPosition;

void main () {
    uvec4 cen = texelFetch(u_texture, ivec2((uint(index) & 0x3ffu) << 1, uint(index) >> 10), 0);
    vec4 cam = view * vec4(uintBitsToFloat(cen.xyz), 1);
    if (nearClip > 0.0 && cam.z < nearClip) {
        gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
        return;
    }
    vec4 pos2d = projection * cam;

    float clip = 1.2 * pos2d.w;
    if (pos2d.z < -clip || pos2d.x < -clip || pos2d.x > clip || pos2d.y < -clip || pos2d.y > clip) {
        gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
        return;
    }

    uvec4 cov = texelFetch(u_texture, ivec2(((uint(index) & 0x3ffu) << 1) | 1u, uint(index) >> 10), 0);
    vec2 u1 = unpackHalf2x16(cov.x), u2 = unpackHalf2x16(cov.y), u3 = unpackHalf2x16(cov.z);
    mat3 Vrk = mat3(u1.x, u1.y, u2.x, u1.y, u2.y, u3.x, u2.x, u3.x, u3.y);

    mat3 J = mat3(
        focal.x / cam.z, 0., -(focal.x * cam.x) / (cam.z * cam.z),
        0., -focal.y / cam.z, (focal.y * cam.y) / (cam.z * cam.z),
        0., 0., 0.
    );

    mat3 T = transpose(mat3(view)) * J;
    mat3 cov2d = transpose(T) * Vrk * T;

    float mid = (cov2d[0][0] + cov2d[1][1]) / 2.0;
    float radius = length(vec2((cov2d[0][0] - cov2d[1][1]) / 2.0, cov2d[0][1]));
    float lambda1 = mid + radius, lambda2 = mid - radius;

    if(lambda2 < 0.0) return;
    vec2 diagonalVector = normalize(vec2(cov2d[0][1], lambda1 - cov2d[0][0]));
    vec2 majorAxis = min(sqrt(2.0 * lambda1), 1024.0) * diagonalVector;
    vec2 minorAxis = min(sqrt(2.0 * lambda2), 1024.0) * vec2(diagonalVector.y, -diagonalVector.x);

    vColor = clamp(pos2d.z/pos2d.w+1.0, 0.0, 1.0) * vec4((cov.w) & 0xffu, (cov.w >> 8) & 0xffu, (cov.w >> 16) & 0xffu, (cov.w >> 24) & 0xffu) / 255.0;
    vPosition = position;

    vec2 vCenter = vec2(pos2d) / pos2d.w;
    gl_Position = vec4(
        vCenter
        + position.x * majorAxis / viewport
        + position.y * minorAxis / viewport, 0.0, 1.0);
}
`.trim();

const fragmentShaderSource = `
#version 300 es
precision highp float;

in vec4 vColor;
in vec2 vPosition;

out vec4 fragColor;

void main () {
    float A = -dot(vPosition, vPosition);
    if (A < -4.0) discard;
    float B = exp(A) * vColor.a;
    fragColor = vec4(B * vColor.rgb, B);
}
`.trim();

// Hoisted to module scope so the splat-size slider wiring (also at module
// scope) can postMessage scale changes to it after main() has assigned it.
let worker = null;

// Centroid of the loaded splat cloud, in PLY/buffer (pre-scene-rotation)
// space. Posted by the worker once per PLY parse; consumed by the "Flip
// 180°" button as the orbit pivot so the camera ends up on the actual
// diagonally opposite side of the data instead of a fixed distance in
// front of the current view.
let dataCentroid = null;

// ---------------------------------------------------------------------
// Camera state — independent of any auto-loaded camera presets so the
// initial framing is purely a function of the .ply being loaded.
// ---------------------------------------------------------------------
const DEFAULT_VIEW = [
    0.47,  0.04,  0.88, 0,
   -0.11,  0.99,  0.02, 0,
   -0.88, -0.11,  0.47, 0,
    0.07,  0.03,  6.55, 1,
];
const IDENTITY_VIEW = [
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    0, 0, 0, 1,
];
// Default vertical FoV in degrees. ~50° is a comfortable mid-tele/normal
// framing — close to a 50 mm lens on full-frame. Focal length is now
// derived per-frame from the viewport height so the slider edits FoV
// directly: fy = H / (2 * tan(fov/2)), fx = fy (square pixels).
const DEFAULT_FOV_DEG = 50;

let viewMatrix = DEFAULT_VIEW.slice();

// ---------------------------------------------------------------------
// Selection-rectangle state (in CSS pixel coordinates)
// ---------------------------------------------------------------------
const sel = {
    active: false,         // selection mode toggled on?
    rect: null,            // {x, y, w, h} in CSS px, or null
    dragStart: null,       // {x, y} during drag
    dragging: false,
};

const cropRectEl = document.getElementById("crop-rect");
const cropOverlayEl = document.getElementById("crop-overlay");
const maskTop    = document.getElementById("crop-mask-top");
const maskBottom = document.getElementById("crop-mask-bottom");
const maskLeft   = document.getElementById("crop-mask-left");
const maskRight  = document.getElementById("crop-mask-right");
const selectToggleBtn = document.getElementById("select-toggle-btn");
const selectResetBtn  = document.getElementById("select-reset-btn");
const statusText      = document.getElementById("status-text");
const confirmBtn      = document.getElementById("confirm-and-close-btn");
const progressEl      = document.getElementById("progress");
const messageEl       = document.getElementById("message");


// Camera-panel DOM refs.
const camAxisSelect = document.getElementById("cam-axis-select");
const camRotXRange  = document.getElementById("cam-rot-x");
const camRotYRange  = document.getElementById("cam-rot-y");
const camRotZRange  = document.getElementById("cam-rot-z");
const camRotXNum    = document.getElementById("cam-rot-x-num");
const camRotYNum    = document.getElementById("cam-rot-y-num");
const camRotZNum    = document.getElementById("cam-rot-z-num");
const camPosXRange  = document.getElementById("cam-pos-x");
const camPosYRange  = document.getElementById("cam-pos-y");
const camPosZRange  = document.getElementById("cam-pos-z");
const camPosXNum    = document.getElementById("cam-pos-x-num");
const camPosYNum    = document.getElementById("cam-pos-y-num");
const camPosZNum    = document.getElementById("cam-pos-z-num");
const camResetBtn   = document.getElementById("cam-reset-btn");
const camFlipBtn    = document.getElementById("cam-flip-btn");

// Live "Splat Size" controls — multiplies every gaussian's linear-space
// scale on the GPU side before texture upload. Used to dial in how chunky
// the splats look without refetching the .ply.
const splatScaleRange    = document.getElementById("splat-scale");
const splatScaleNum      = document.getElementById("splat-scale-num");
const splatScaleResetBtn = document.getElementById("splat-scale-reset-btn");

// "Near Clip" controls — discards splats whose camera-space distance is
// below the slider value. Lets the user peel off foreground walls /
// pillars / hands etc. that obscure the subject. 0 disables culling.
// Wired to the GL uniform inside main() once the program is linked.
const nearClipRange    = document.getElementById("near-clip");
const nearClipNum      = document.getElementById("near-clip-num");
const nearClipResetBtn = document.getElementById("near-clip-reset-btn");

// Field-of-view slider — vertical FoV in degrees. Wired to the
// projection matrix + u_focal shader uniform via resize() so changes
// take effect on the next frame. Persisted in view_state so reopening
// the modal restores the user's FoV instead of snapping back to default.
const fovRange    = document.getElementById("cam-fov");
const fovNum      = document.getElementById("cam-fov-num");
const fovResetBtn = document.getElementById("cam-fov-reset-btn");

function _readFovDeg() {
    const v = parseFloat(fovNum?.value);
    if (!Number.isFinite(v) || v <= 0) return DEFAULT_FOV_DEG;
    // Clamp away from 0 / 180 to keep tan() finite.
    return Math.min(170, Math.max(5, v));
}

function _focalFromFov(viewportHeightPx) {
    const fov = _readFovDeg();
    const fy = viewportHeightPx / (2 * Math.tan((fov * Math.PI / 180) * 0.5));
    return { fx: fy, fy };
}

// World-up axis used by orbit-drag. The dropdown selects which world axis
// horizontal mouse-drag rotates around. PLYs from depth-based pipelines
// (SAM3D, etc.) are in OpenCV camera coords where +Y points down, so the
// user typically picks -Y up for those.
const AXIS_VECTORS = {
    "y-up":  [0,  1,  0],
    "-y-up": [0, -1,  0],
    "z-up":  [0,  0,  1],
    "-z-up": [0,  0, -1],
};
let camAxisUpVec = AXIS_VECTORS["y-up"];

// Visual scene rotation, applied to the view matrix at GPU upload time.
// Rotates the data so that the user-selected "up" axis ends up pointing
// toward the screen's +Y. Identity for "y-up" (the renderer's native
// convention); a quarter or half turn around X otherwise.
//
// Column-major mat4 — same layout as everywhere else in this file.
const SCENE_ROTATIONS = {
    "y-up":  [
        1, 0, 0, 0,
        0, 1, 0, 0,
        0, 0, 1, 0,
        0, 0, 0, 1,
    ],
    // 180° around X: (x, y, z) → (x, -y, -z).
    "-y-up": [
        1,  0,  0, 0,
        0, -1,  0, 0,
        0,  0, -1, 0,
        0,  0,  0, 1,
    ],
    // -90° around X: (x, y, z) → (x, z, -y).
    "z-up": [
        1,  0,  0, 0,
        0,  0, -1, 0,
        0,  1,  0, 0,
        0,  0,  0, 1,
    ],
    // +90° around X: (x, y, z) → (x, -z, y).
    "-z-up": [
        1,  0,  0, 0,
        0,  0,  1, 0,
        0, -1,  0, 0,
        0,  0,  0, 1,
    ],
};
function getSceneRotationMat4() {
    return SCENE_ROTATIONS[camAxisSelect.value] || SCENE_ROTATIONS["y-up"];
}

// ---------------------------------------------------------------------
// Camera-state ↔ slider bidirectional sync.
//
// viewMatrix (column-major 4x4, world→camera) is the source of truth for
// rendering. The camera panel sliders display it as Euler XYZ rotation +
// world-space position, and writes to a slider rebuild viewMatrix.
//
// We only push viewMatrix → sliders when the user is NOT actively dragging
// a slider (otherwise typing into a number input would flicker as the
// previous frame's value snaps back). camSlidersBusy is set on the slider
// pointerdown/focus events and cleared on pointerup/blur.
// ---------------------------------------------------------------------

let camSlidersBusy = false;

function decomposeViewMatrix(view) {
    // inv is the camera-to-world transform; its translation column is the
    // camera position in world coords, and the upper-left 3x3 is the
    // rotation that maps camera-space basis vectors to world-space ones.
    const inv = invert4(view);
    if (!inv) return { pos: [0, 0, 0], rot: [0, 0, 0] };
    const pos = [inv[12], inv[13], inv[14]];

    // R[i][j] in maths notation lives at inv[j*4 + i] (column-major).
    const r00 = inv[0],  r01 = inv[4],  r02 = inv[8];
    const r10 = inv[1],  r11 = inv[5],  r12 = inv[9];
    const r20 = inv[2],  r21 = inv[6],  r22 = inv[10];

    // Extract Euler XYZ (extrinsic) — the inverse of R = Rz(rz) Ry(ry) Rx(rx).
    const sy = Math.hypot(r00, r10);
    let rx, ry, rz;
    if (sy > 1e-6) {
        rx = Math.atan2(r21, r22);
        ry = Math.atan2(-r20, sy);
        rz = Math.atan2(r10, r00);
    } else {
        // Near gimbal lock — pick a consistent fallback.
        rx = Math.atan2(-r12, r11);
        ry = Math.atan2(-r20, sy);
        rz = 0;
    }
    return { pos, rot: [rx, ry, rz] };
}

function composeViewMatrix(pos, rot) {
    const [rx, ry, rz] = rot;
    const cx = Math.cos(rx), sx = Math.sin(rx);
    const cy = Math.cos(ry), sy = Math.sin(ry);
    const cz = Math.cos(rz), sz = Math.sin(rz);
    // R = Rz(rz) * Ry(ry) * Rx(rx) — same convention as decomposeViewMatrix.
    const m00 = cy * cz;
    const m01 = sx * sy * cz - cx * sz;
    const m02 = cx * sy * cz + sx * sz;
    const m10 = cy * sz;
    const m11 = sx * sy * sz + cx * cz;
    const m12 = cx * sy * sz - sx * cz;
    const m20 = -sy;
    const m21 = sx * cy;
    const m22 = cx * cy;

    // Build inv (camera-to-world) as column-major float16, then invert.
    const inv = [
        m00, m10, m20, 0,
        m01, m11, m21, 0,
        m02, m12, m22, 0,
        pos[0], pos[1], pos[2], 1,
    ];
    return invert4(inv);
}

function setSliderPair(rangeEl, numEl, value) {
    // Round to the slider's step-precision so the displayed text doesn't
    // turn into "12.99999998" after FP round-trips.
    const step = parseFloat(rangeEl.step) || 1;
    const decimals = step >= 1 ? 0 : Math.max(0, -Math.floor(Math.log10(step)));
    const formatted = value.toFixed(decimals);
    if (rangeEl.value !== formatted) rangeEl.value = formatted;
    if (numEl.value !== formatted)   numEl.value = formatted;
}

function syncSlidersFromView() {
    if (camSlidersBusy) return;
    const { pos, rot } = decomposeViewMatrix(viewMatrix);
    const rad2deg = 180 / Math.PI;
    setSliderPair(camRotXRange, camRotXNum, rot[0] * rad2deg);
    setSliderPair(camRotYRange, camRotYNum, rot[1] * rad2deg);
    setSliderPair(camRotZRange, camRotZNum, rot[2] * rad2deg);
    setSliderPair(camPosXRange, camPosXNum, pos[0]);
    setSliderPair(camPosYRange, camPosYNum, pos[1]);
    setSliderPair(camPosZRange, camPosZNum, pos[2]);
}

function applySlidersToView() {
    const deg2rad = Math.PI / 180;
    const rx = parseFloat(camRotXRange.value) * deg2rad;
    const ry = parseFloat(camRotYRange.value) * deg2rad;
    const rz = parseFloat(camRotZRange.value) * deg2rad;
    const px = parseFloat(camPosXRange.value);
    const py = parseFloat(camPosYRange.value);
    const pz = parseFloat(camPosZRange.value);
    if ([rx, ry, rz, px, py, pz].some((v) => Number.isNaN(v))) return;
    const m = composeViewMatrix([px, py, pz], [rx, ry, rz]);
    if (m) viewMatrix = m;
}

function wireSliderPair(rangeEl, numEl) {
    // Mark "user is editing" while pointer is down on the range or focus is
    // in the number input, so the per-frame sync from viewMatrix doesn't
    // overwrite what they're typing.
    rangeEl.addEventListener("pointerdown", () => { camSlidersBusy = true; });
    rangeEl.addEventListener("pointerup",   () => { camSlidersBusy = false; });
    numEl.addEventListener("focus", () => { camSlidersBusy = true; });
    numEl.addEventListener("blur",  () => { camSlidersBusy = false; });
    rangeEl.addEventListener("input", () => {
        numEl.value = rangeEl.value;
        applySlidersToView();
    });
    numEl.addEventListener("input", () => {
        // Don't clamp numEl to the slider's range — let the user type
        // arbitrary positions / rotations. The slider just shows the
        // clamped representation while the number input holds the truth.
        const v = parseFloat(numEl.value);
        if (!Number.isNaN(v)) {
            rangeEl.value = String(v);
            applySlidersToView();
        }
    });
}

// Wire pairs eagerly — these handlers don't depend on the WebGL setup.
[
    [camRotXRange, camRotXNum],
    [camRotYRange, camRotYNum],
    [camRotZRange, camRotZNum],
    [camPosXRange, camPosXNum],
    [camPosYRange, camPosYNum],
    [camPosZRange, camPosZNum],
].forEach(([r, n]) => wireSliderPair(r, n));

// Splat-size slider — multiplies every gaussian's linear-space scale on
// the worker side, then triggers a texture re-upload. Bidirectional sync
// between range and number input (mirroring camera-panel sliders), with
// a Reset button to snap back to ×1.0.
function sendSplatScaleToWorker(value) {
    const factor = Number(value);
    if (!Number.isFinite(factor) || factor <= 0) return;
    if (!worker) return;
    worker.postMessage({ scaleMultiplier: factor });
}
// Live-mirror the slider into the number input (and vice versa) during
// drag/typing, but defer the actual worker dispatch — and therefore the
// re-upload of the splat texture — until the input is *committed*
// (mouseup on the slider; Enter / blur / arrow on the number input).
// Re-uploading the splat buffer per pixel of drag is expensive on big
// scenes and the visual flicker is distracting; users get the final
// result on release instead.
splatScaleRange.addEventListener("input", () => {
    splatScaleNum.value = splatScaleRange.value;
});
splatScaleRange.addEventListener("change", () => {
    sendSplatScaleToWorker(splatScaleRange.value);
});
splatScaleNum.addEventListener("input", () => {
    const v = parseFloat(splatScaleNum.value);
    if (!Number.isNaN(v) && v > 0) {
        splatScaleRange.value = String(v);
    }
});
splatScaleNum.addEventListener("change", () => {
    const v = parseFloat(splatScaleNum.value);
    if (!Number.isNaN(v) && v > 0) {
        sendSplatScaleToWorker(v);
    }
});
splatScaleResetBtn.addEventListener("click", () => {
    splatScaleRange.value = "1";
    splatScaleNum.value   = "1";
    sendSplatScaleToWorker(1);
});

// Axis-dropdown — switches which world axis horizontal drag orbits around.
camAxisSelect.addEventListener("change", () => {
    camAxisUpVec = AXIS_VECTORS[camAxisSelect.value] || AXIS_VECTORS["y-up"];
});
// Reset always lands on identity so the camera-panel readouts (rotation +
// position) all show 0. The initial framing uses DEFAULT_VIEW; only the
// explicit reset action (button / R key) snaps to identity.
function getResetView() {
    return IDENTITY_VIEW.slice();
}

// Restore saved camera state from the URL (set by the widget before opening
// the modal). Persists across Confirm-and-reopen and across PLY changes —
// so the user lands back at the last framing they had instead of the
// default DEFAULT_VIEW pose every time.
if (window.GS_VIEW_STATE) {
    try {
        const saved = JSON.parse(window.GS_VIEW_STATE);
        if (Array.isArray(saved.viewMatrix) && saved.viewMatrix.length === 16) {
            const v = saved.viewMatrix.map((x) => +x);
            if (v.every((x) => Number.isFinite(x))) {
                viewMatrix = v;
            }
        }
        if (saved.axis && AXIS_VECTORS[saved.axis]) {
            camAxisSelect.value = saved.axis;
            camAxisUpVec = AXIS_VECTORS[saved.axis];
        }
        // Splat-size and near-clip: write the slider DOM values now so
        // they're visible to the user immediately. The actual GPU/worker
        // hookup happens later — main() reads splatScaleNum on worker
        // creation and nearClipNum on uniform init.
        if (saved.splat_scale != null) {
            const v = +saved.splat_scale;
            if (Number.isFinite(v) && v > 0) {
                splatScaleRange.value = String(v);
                splatScaleNum.value   = String(v);
            }
        }
        if (saved.near_clip != null) {
            const v = +saved.near_clip;
            if (Number.isFinite(v) && v >= 0) {
                nearClipRange.value = String(v);
                nearClipNum.value   = String(v);
            }
        }
        if (saved.fov_deg != null && fovRange && fovNum) {
            const v = +saved.fov_deg;
            if (Number.isFinite(v) && v > 0) {
                fovRange.value = String(Math.min(120, Math.max(15, v)));
                fovNum.value   = String(v);
            }
        }
    } catch (exc) {
        console.warn("[GSRender] couldn't restore view_state:", exc);
    }
}

// Reset button — same effect as the R key.
camResetBtn.addEventListener("click", () => {
    viewMatrix = getResetView();
    syncSlidersFromView();
});

// "Flip 180°" button — orbit the camera 180° around the data centroid
// (computed once per PLY load by the worker), about the screen-up axis.
// Falls back to a "5m forward of the camera" heuristic until the centroid
// arrives, so the button still does *something* during the parse window.
function flipCameraAroundPivot() {
    const inv = invert4(viewMatrix);
    if (!inv) return;

    let pivot;
    if (dataCentroid) {
        // dataCentroid is in PLY/buffer space; viewMatrix lives in
        // scene-rotated space (effectiveView = viewMatrix · sceneRot).
        // Push the centroid through the active scene rotation so the
        // pivot lands at the right point in viewMatrix's world.
        const M = getSceneRotationMat4();
        const px = dataCentroid[0], py = dataCentroid[1], pz = dataCentroid[2];
        pivot = [
            M[0]*px + M[4]*py + M[8] *pz,
            M[1]*px + M[5]*py + M[9] *pz,
            M[2]*px + M[6]*py + M[10]*pz,
        ];
    } else {
        // Centroid hasn't been posted yet (race against PLY parse). Fall
        // back to a fixed-distance forward pivot so the button isn't dead.
        const camForward = [-inv[8], -inv[9], -inv[10]];
        const PIVOT_DIST = 5.0;
        pivot = [
            inv[12] + PIVOT_DIST * camForward[0],
            inv[13] + PIVOT_DIST * camForward[1],
            inv[14] + PIVOT_DIST * camForward[2],
        ];
    }

    // viewMatrix operates on scene-ROTATED coordinates, so the screen-up
    // axis in its world is always +Y regardless of preset. Hard-code
    // R = R(180°, +Y) = diag(-1, 1, -1) — using camAxisUpVec here would
    // be wrong for -y-up / z-up since those vectors live in PRE-rotated
    // space.
    const r00 = -1, r01 = 0, r02 =  0;
    const r10 =  0, r11 = 1, r12 =  0;
    const r20 =  0, r21 = 0, r22 = -1;

    // Build the orbit transform M = T(pivot) · R · T(-pivot) and apply
    // M·inv. Translation column collapses to (pivot - R·pivot).
    const tx = pivot[0] - (r00*pivot[0] + r01*pivot[1] + r02*pivot[2]);
    const ty = pivot[1] - (r10*pivot[0] + r11*pivot[1] + r12*pivot[2]);
    const tz = pivot[2] - (r20*pivot[0] + r21*pivot[1] + r22*pivot[2]);

    const newInv = new Array(16);
    for (let col = 0; col < 4; col++) {
        const a = inv[col*4 + 0], b = inv[col*4 + 1], c = inv[col*4 + 2], d = inv[col*4 + 3];
        newInv[col*4 + 0] = r00*a + r01*b + r02*c + tx*d;
        newInv[col*4 + 1] = r10*a + r11*b + r12*c + ty*d;
        newInv[col*4 + 2] = r20*a + r21*b + r22*c + tz*d;
        newInv[col*4 + 3] = d;
    }
    viewMatrix = invert4(newInv);
    syncSlidersFromView();
}
camFlipBtn.addEventListener("click", flipCameraAroundPivot);

function showError(msg) {
    messageEl.hidden = false;
    messageEl.textContent = String(msg);
}

function updateCropOverlay() {
    if (!sel.active) {
        cropOverlayEl.hidden = true;
        return;
    }
    if (!sel.rect) {
        // selection mode on, but no rect yet → no masking
        cropOverlayEl.hidden = true;
        return;
    }
    cropOverlayEl.hidden = false;
    const W = window.innerWidth, H = window.innerHeight;
    const { x, y, w, h } = sel.rect;
    cropRectEl.style.left   = x + "px";
    cropRectEl.style.top    = y + "px";
    cropRectEl.style.width  = w + "px";
    cropRectEl.style.height = h + "px";
    // Four masks around the rect to dim the rest.
    maskTop.style.left = "0"; maskTop.style.top = "0";
    maskTop.style.width = W + "px"; maskTop.style.height = y + "px";
    maskBottom.style.left = "0"; maskBottom.style.top = (y + h) + "px";
    maskBottom.style.width = W + "px"; maskBottom.style.height = (H - y - h) + "px";
    maskLeft.style.left = "0"; maskLeft.style.top = y + "px";
    maskLeft.style.width = x + "px"; maskLeft.style.height = h + "px";
    maskRight.style.left = (x + w) + "px"; maskRight.style.top = y + "px";
    maskRight.style.width = (W - x - w) + "px"; maskRight.style.height = h + "px";
}

function setSelectionMode(on) {
    sel.active = on;
    if (on) {
        selectToggleBtn.textContent = "範囲指定を終了";
        selectToggleBtn.classList.add("active");
        selectResetBtn.hidden = false;
        canvas.classList.add("selecting");
    } else {
        selectToggleBtn.textContent = "撮影範囲指定";
        selectToggleBtn.classList.remove("active");
        selectResetBtn.hidden = true;
        canvas.classList.remove("selecting");
    }
    updateCropOverlay();
}

selectToggleBtn.addEventListener("click", () => {
    setSelectionMode(!sel.active);
});
selectResetBtn.addEventListener("click", () => {
    sel.rect = null;
    updateCropOverlay();
});

// ---------------------------------------------------------------------
// Main bootstrap
// ---------------------------------------------------------------------
const canvas = document.getElementById("canvas");

async function main() {
    const plyPath = window.GS_PLY_PATH || "";
    // SAM3D variant boots without a PLY: the user picks an image first,
    // a PLY is generated server-side and *streamed back* in the response
    // body, then the SAM3D glue calls `window.gsLoadPlyFromBuffer(buf)`
    // (exposed below) to render the bytes directly — the server keeps
    // no copy on disk.
    const sam3dMode = !!window.GS_SAM3D_MODE;
    if (!plyPath && !sam3dMode) {
        showError("ply パスが指定されていません。 / no ply path was supplied.");
        return;
    }

    // Worker for sort + ply→splat conversion
    worker = new Worker(URL.createObjectURL(new Blob(
        ["(", createWorker.toString(), ")(self)"],
        { type: "application/javascript" },
    )));
    // If view_state restored a non-default splat-size, push it to the worker
    // up front so the first PLY parse applies it. applySplatScale stores
    // the multiplier even when no buffer is loaded yet, so this message can
    // safely arrive before the PLY itself.
    {
        const restoredScale = parseFloat(splatScaleNum.value);
        if (Number.isFinite(restoredScale) && restoredScale > 0 && restoredScale !== 1.0) {
            worker.postMessage({ scaleMultiplier: restoredScale });
        }
    }

    const gl = canvas.getContext("webgl2", {
        antialias: false,
        alpha: true,
        premultipliedAlpha: true,
        preserveDrawingBuffer: true,   // required for canvas capture
    });

    const vertexShader = gl.createShader(gl.VERTEX_SHADER);
    gl.shaderSource(vertexShader, vertexShaderSource);
    gl.compileShader(vertexShader);
    if (!gl.getShaderParameter(vertexShader, gl.COMPILE_STATUS))
        console.error(gl.getShaderInfoLog(vertexShader));

    const fragmentShader = gl.createShader(gl.FRAGMENT_SHADER);
    gl.shaderSource(fragmentShader, fragmentShaderSource);
    gl.compileShader(fragmentShader);
    if (!gl.getShaderParameter(fragmentShader, gl.COMPILE_STATUS))
        console.error(gl.getShaderInfoLog(fragmentShader));

    const program = gl.createProgram();
    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragmentShader);
    gl.linkProgram(program);
    gl.useProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS))
        console.error(gl.getProgramInfoLog(program));

    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(
        gl.ONE_MINUS_DST_ALPHA, gl.ONE,
        gl.ONE_MINUS_DST_ALPHA, gl.ONE,
    );
    gl.blendEquationSeparate(gl.FUNC_ADD, gl.FUNC_ADD);
    gl.clearColor(0, 0, 0, 0);

    const u_projection = gl.getUniformLocation(program, "projection");
    const u_viewport   = gl.getUniformLocation(program, "viewport");
    const u_focal      = gl.getUniformLocation(program, "focal");
    const u_view       = gl.getUniformLocation(program, "view");
    const u_nearClip   = gl.getUniformLocation(program, "nearClip");
    // Seed the uniform from the slider DOM value, which view_state restore
    // (above) may have already overwritten with the user's last setting.
    // 0 disables culling.
    {
        const restoredClip = parseFloat(nearClipNum.value);
        gl.uniform1f(u_nearClip,
            (Number.isFinite(restoredClip) && restoredClip >= 0) ? restoredClip : 0.0);
    }

    // Wire the "Near Clip" slider here (rather than at module scope) so we
    // have access to the GL context; the DOM elements were grabbed earlier.
    const sendNearClipToGl = (v) => {
        const f = Number(v);
        if (!Number.isFinite(f) || f < 0) return;
        gl.uniform1f(u_nearClip, f);
    };
    nearClipRange.addEventListener("input", () => {
        nearClipNum.value = nearClipRange.value;
        sendNearClipToGl(nearClipRange.value);
    });
    nearClipNum.addEventListener("input", () => {
        const v = parseFloat(nearClipNum.value);
        if (!Number.isNaN(v) && v >= 0) {
            nearClipRange.value = String(v);
            sendNearClipToGl(v);
        }
    });
    nearClipResetBtn.addEventListener("click", () => {
        nearClipRange.value = "0";
        nearClipNum.value   = "0";
        sendNearClipToGl(0);
    });

    const triangleVertices = new Float32Array([-2, -2, 2, -2, 2, 2, -2, 2]);
    const vertexBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, triangleVertices, gl.STATIC_DRAW);
    const a_position = gl.getAttribLocation(program, "position");
    gl.enableVertexAttribArray(a_position);
    gl.vertexAttribPointer(a_position, 2, gl.FLOAT, false, 0, 0);

    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    const u_textureLocation = gl.getUniformLocation(program, "u_texture");
    gl.uniform1i(u_textureLocation, 0);

    const indexBuffer = gl.createBuffer();
    const a_index = gl.getAttribLocation(program, "index");
    gl.enableVertexAttribArray(a_index);
    gl.bindBuffer(gl.ARRAY_BUFFER, indexBuffer);
    gl.vertexAttribIPointer(a_index, 1, gl.INT, false, 0, 0);
    gl.vertexAttribDivisor(a_index, 1);

    let projectionMatrix;
    let downsample = 1;

    const resize = () => {
        const focal = _focalFromFov(innerHeight);
        gl.uniform2fv(u_focal, new Float32Array([focal.fx, focal.fy]));
        projectionMatrix = getProjectionMatrix(
            focal.fx, focal.fy,
            innerWidth, innerHeight,
        );
        gl.uniform2fv(u_viewport, new Float32Array([innerWidth, innerHeight]));
        gl.canvas.width  = Math.round(innerWidth  / downsample);
        gl.canvas.height = Math.round(innerHeight / downsample);
        gl.viewport(0, 0, gl.canvas.width, gl.canvas.height);
        gl.uniformMatrix4fv(u_projection, false, projectionMatrix);
        updateCropOverlay();
    };
    window.addEventListener("resize", resize);
    resize();

    // Field-of-view slider — same defer-on-release pattern as Splat Size:
    // `input` only mirrors the slider <-> number-input pair so the user
    // sees the value tracking the cursor, but the projection matrix is
    // only recomputed on `change` (mouseup / Enter / blur). Reflowing
    // the projection per drag pixel is cheap, but the apparent zoom
    // skating during drag is distracting on busy scenes — committing on
    // release matches the splat-size UX.
    if (fovRange && fovNum) {
        const mirrorFromRange = () => { fovNum.value = fovRange.value; };
        const mirrorFromNum   = () => {
            const v = parseFloat(fovNum.value);
            if (Number.isFinite(v)) {
                fovRange.value = String(Math.min(120, Math.max(15, v)));
            }
        };
        fovRange.addEventListener("input",  mirrorFromRange);
        fovNum.addEventListener("input",    mirrorFromNum);
        fovRange.addEventListener("change", () => { resize(); });
        fovNum.addEventListener("change",   () => { resize(); });
        fovResetBtn?.addEventListener("click", () => {
            fovRange.value = String(DEFAULT_FOV_DEG);
            fovNum.value   = String(DEFAULT_FOV_DEG);
            resize();
        });
    }

    let vertexCount = 0;
    worker.onmessage = (e) => {
        if (e.data.centroid) {
            dataCentroid = e.data.centroid;
            return;
        }
        if (e.data.buffer) {
            statusText.textContent = "ready";
            progressEl.hidden = true;
        } else if (e.data.texdata) {
            const { texdata, texwidth, texheight } = e.data;
            gl.bindTexture(gl.TEXTURE_2D, texture);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
            gl.texImage2D(
                gl.TEXTURE_2D, 0, gl.RGBA32UI,
                texwidth, texheight, 0,
                gl.RGBA_INTEGER, gl.UNSIGNED_INT, texdata,
            );
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, texture);
        } else if (e.data.depthIndex) {
            const { depthIndex } = e.data;
            gl.bindBuffer(gl.ARRAY_BUFFER, indexBuffer);
            gl.bufferData(gl.ARRAY_BUFFER, depthIndex, gl.DYNAMIC_DRAW);
            vertexCount = e.data.vertexCount;
        }
    };

    // ---------------- Controls ----------------
    const activeKeys = new Set();

    // Game-style key set: while these are held the browser must NOT do
    // its default action (Space scrolls the page, arrow keys can scroll
    // sliders, etc.) — otherwise WASD-fly feels jumpy.
    const MOVEMENT_KEYS = new Set([
        "KeyW", "KeyA", "KeyS", "KeyD",
        "KeyQ", "KeyE", "KeyX", "Space",
        "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown",
        "ShiftLeft", "ShiftRight",
    ]);

    window.addEventListener("keydown", (e) => {
        // Avoid stealing typing focus from any potential text inputs.
        const tag = e.target?.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
        if (MOVEMENT_KEYS.has(e.code)) e.preventDefault();
        activeKeys.add(e.code);
        if (e.code === "KeyR") { viewMatrix = getResetView(); }
        if ((e.ctrlKey || e.metaKey) && e.code === "Enter") {
            e.preventDefault();
            confirmAndClose();
        }
    });
    window.addEventListener("keyup", (e) => activeKeys.delete(e.code));
    window.addEventListener("blur", () => activeKeys.clear());

    // Mouse / pointer interactions on canvas. We multiplex orbit / pan /
    // selection-drag through a single pointerdown handler.
    let drag = null;  // { mode: "orbit" | "pan" | "select", lastX, lastY, ... }

    canvas.addEventListener("pointerdown", (e) => {
        canvas.setPointerCapture(e.pointerId);

        if (sel.active) {
            // Start a new selection rectangle.
            drag = { mode: "select", originX: e.clientX, originY: e.clientY };
            sel.dragStart = { x: e.clientX, y: e.clientY };
            sel.rect = { x: e.clientX, y: e.clientY, w: 0, h: 0 };
            sel.dragging = true;
            updateCropOverlay();
            return;
        }

        // Mouse mapping:
        //   Left-click drag  → look (axis-locked yaw / pitch in place)
        //   Right-click drag → roll (tilt the camera around its forward
        //                      axis — like tilting a tripod-mounted
        //                      camera sideways without changing where
        //                      it's pointed)
        //   Middle-click drag → pan (translate, no rotation)
        let mode;
        if (e.button === 2) mode = "roll";
        else if (e.button === 1) mode = "pan";
        else mode = "look";
        drag = {
            mode,
            lastX: e.clientX,
            lastY: e.clientY,
            // Origin is used for "look" mode to lock rotation to a single
            // axis (horizontal=yaw OR vertical=pitch) once the cursor
            // travels past `axisLockThreshold` from where the drag began.
            // This keeps drags strictly horizontal/vertical even when
            // the user's gesture isn't perfectly axis-aligned.
            originX: e.clientX,
            originY: e.clientY,
            axisLock: null,  // null | "h" | "v" — assigned on first significant move
        };
        canvas.classList.add("dragging");
    });

    canvas.addEventListener("pointermove", (e) => {
        if (!drag) return;
        if (drag.mode === "select") {
            const x = Math.min(drag.originX, e.clientX);
            const y = Math.min(drag.originY, e.clientY);
            const w = Math.abs(e.clientX - drag.originX);
            const h = Math.abs(e.clientY - drag.originY);
            sel.rect = { x, y, w, h };
            updateCropOverlay();
            return;
        }
        const dx = e.clientX - drag.lastX;
        const dy = e.clientY - drag.lastY;
        drag.lastX = e.clientX;
        drag.lastY = e.clientY;
        if (drag.mode === "pan") {
            pan(dx, dy);
        } else if (drag.mode === "roll") {
            roll(dx);
        } else if (drag.mode === "look") {
            // Lock the drag to a single rotation axis as soon as the
            // cursor has moved past `axisLockThreshold` (in CSS px) from
            // its origin. Whichever component (|Δx| vs |Δy|) is larger
            // at that moment wins for the rest of the drag — so a slight
            // diagonal accidental motion never bleeds into the other axis.
            const axisLockThreshold = 6;
            if (drag.axisLock === null) {
                const totalDx = e.clientX - drag.originX;
                const totalDy = e.clientY - drag.originY;
                if (Math.hypot(totalDx, totalDy) >= axisLockThreshold) {
                    drag.axisLock = (Math.abs(totalDx) >= Math.abs(totalDy)) ? "h" : "v";
                }
            }
            if (drag.axisLock === "h")      lookAround(dx, 0);
            else if (drag.axisLock === "v") lookAround(0, dy);
            // else: still under threshold → no rotation yet, just buffering
        }
    });

    const endDrag = (e) => {
        if (!drag) return;
        if (drag.mode === "select") {
            sel.dragging = false;
            // Drop tiny accidental clicks.
            if (sel.rect && (sel.rect.w < 4 || sel.rect.h < 4)) {
                sel.rect = null;
                updateCropOverlay();
            }
        }
        drag = null;
        canvas.classList.remove("dragging");
        try { canvas.releasePointerCapture(e.pointerId); } catch (_e) {}
    };
    canvas.addEventListener("pointerup", endDrag);
    canvas.addEventListener("pointercancel", endDrag);

    canvas.addEventListener("contextmenu", (e) => e.preventDefault());

    canvas.addEventListener("wheel", (e) => {
        e.preventDefault();
        const lineHeight = 10;
        const scale = e.deltaMode == 1 ? lineHeight : e.deltaMode == 2 ? innerHeight : 1;
        // Dolly forward/back. Quartered from the antimatter15 original
        // (-10 → -2) so single-notch nudges feel finer when framing.
        let inv = invert4(viewMatrix);
        inv = translate4(inv, 0, 0, (-2 * (e.deltaY * scale)) / innerHeight);
        viewMatrix = invert4(inv);
    }, { passive: false });

    function pan(dx, dy) {
        // Pan in screen space — sensitivity halved (was 3 → 1.5).
        let inv = invert4(viewMatrix);
        inv = translate4(inv,
            (-1.5 * dx) / innerWidth,
            (-1.5 * dy) / innerHeight,
            0,
        );
        viewMatrix = invert4(inv);
    }

    function roll(dx) {
        // Roll the camera around its own forward (depth) axis — only
        // horizontal mouse delta contributes, so the gesture is "tilt
        // the camera left/right". Camera-local Z is the depth axis in
        // any mode, so this works regardless of the axis dropdown.
        let inv = invert4(viewMatrix);
        if (!inv) return;
        const sensitivity = 1.2;
        const angle = (sensitivity * dx) / innerWidth;
        inv = rotate4(inv, angle, 0, 0, 1);
        viewMatrix = invert4(inv);
    }

    function lookAround(dx, dy) {
        // Camera-relative mouse look. Both axes are CAMERA-LOCAL
        // constants — yaw around (0,1,0) (the camera's own up, which
        // is screen-up at identity for ANY mode because the per-mode
        // SCENE_ROTATIONS is applied elsewhere at GPU upload), pitch
        // around (1,0,0) (the camera's own right). These rotate with
        // the camera body, so it feels like turning a camera held in
        // your hands. Sensitivity halved (was 2.5 → 1.2).
        //
        // Using world-up (`camAxisUpVec`) as the yaw axis here would
        // be wrong — for z-up / -z-up modes that vector lies along
        // the camera's depth axis, so dragging would roll the view
        // instead of yawing it.
        let inv = invert4(viewMatrix);
        if (!inv) return;
        const sensitivity = 1.2;
        const yaw   = (sensitivity * dx) / innerWidth;
        const pitch = (sensitivity * dy) / innerHeight;

        inv = rotate4(inv, yaw, 0, 1, 0);
        inv = rotate4(inv, -pitch, 1, 0, 0);
        viewMatrix = invert4(inv);
    }

    // ---------------- Render loop ----------------
    function frame() {
        let inv = invert4(viewMatrix);

        // Fly camera with finer base step (was 0.30 → 0.10) so each frame's
        // movement is small enough to dial in close framings. Shift still
        // sprints (3×) for crossing rooms quickly; Ctrl creeps even slower.
        // WASD = camera-local forward/strafe; Q/E/Space/X = world-up
        // vertical (so jumping stays vertical regardless of camera pitch).
        const sprint = activeKeys.has("ShiftLeft") || activeKeys.has("ShiftRight");
        const slow   = activeKeys.has("ControlLeft") || activeKeys.has("ControlRight");
        let speedMove = 0.10;
        if (sprint) speedMove *= 3.0;
        if (slow)   speedMove *= 0.30;
        // Arrow-key rotation also halved (0.025 → 0.012).
        const speedRot = 0.012;

        // Forward / strafe — camera-local.
        if (activeKeys.has("KeyW")) inv = translate4(inv, 0, 0,  speedMove);
        if (activeKeys.has("KeyS")) inv = translate4(inv, 0, 0, -speedMove);
        if (activeKeys.has("KeyA")) inv = translate4(inv, -speedMove, 0, 0);
        if (activeKeys.has("KeyD")) inv = translate4(inv,  speedMove, 0, 0);

        // Vertical — world-up. Q / Space go up, E / X go down. We translate
        // the world-frame up vector by ±speedMove and add it directly to
        // the position column.
        const upX = camAxisUpVec[0] * speedMove;
        const upY = camAxisUpVec[1] * speedMove;
        const upZ = camAxisUpVec[2] * speedMove;
        if (activeKeys.has("KeyQ") || activeKeys.has("Space"))
            inv = translateWorld4(inv,  upX,  upY,  upZ);
        if (activeKeys.has("KeyE") || activeKeys.has("KeyX"))
            inv = translateWorld4(inv, -upX, -upY, -upZ);

        // Arrow keys — finer rotation, useful when no mouse is connected.
        if (activeKeys.has("ArrowLeft"))  inv = rotate4(inv, -speedRot, 0, 1, 0);
        if (activeKeys.has("ArrowRight")) inv = rotate4(inv,  speedRot, 0, 1, 0);
        if (activeKeys.has("ArrowUp"))    inv = rotate4(inv, -speedRot, 1, 0, 0);
        if (activeKeys.has("ArrowDown"))  inv = rotate4(inv,  speedRot, 1, 0, 0);
        viewMatrix = invert4(inv);

        // Apply the user's "world up" choice as a fixed scene rotation
        // multiplied into the view at upload time. The user's viewMatrix
        // (and therefore the slider readouts) stay in the data's native
        // frame; only the rendered + sorted view is reoriented.
        const sceneRot = getSceneRotationMat4();
        const effectiveView = multiply4(viewMatrix, sceneRot);

        const viewProj = multiply4(projectionMatrix, effectiveView);
        worker.postMessage({ view: viewProj });

        if (vertexCount > 0) {
            gl.uniformMatrix4fv(u_view, false, effectiveView);
            gl.clear(gl.COLOR_BUFFER_BIT);
            gl.drawArraysInstanced(gl.TRIANGLE_FAN, 0, 4, vertexCount);
        } else {
            gl.clear(gl.COLOR_BUFFER_BIT);
        }
        // Push the latest camera state into the slider/number inputs so
        // dragging / WASD / R-key all keep the panel readout in sync.
        // No-op when the user is mid-edit (camSlidersBusy = true).
        syncSlidersFromView();

        requestAnimationFrame(frame);
    }
    frame();

    // ---------------- Confirm & Close ----------------
    function captureToDataURL() {
        // Force a fresh draw before grabbing the buffer (preserveDrawingBuffer
        // keeps the previous frame, but we want the moment-of-confirm view).
        // Use the same scene-rotation-applied effective view as frame().
        if (vertexCount > 0) {
            const effectiveView = multiply4(viewMatrix, getSceneRotationMat4());
            gl.uniformMatrix4fv(u_view, false, effectiveView);
            gl.clear(gl.COLOR_BUFFER_BIT);
            gl.drawArraysInstanced(gl.TRIANGLE_FAN, 0, 4, vertexCount);
        }

        const W = canvas.width, H = canvas.height;
        let sx = 0, sy = 0, sw = W, sh = H;

        if (sel.rect && sel.rect.w > 1 && sel.rect.h > 1) {
            // sel.rect is in CSS px; convert to canvas-buffer px.
            const ratioX = W / innerWidth;
            const ratioY = H / innerHeight;
            sx = Math.max(0, Math.round(sel.rect.x * ratioX));
            // WebGL canvases are sampled top-down by drawImage when you
            // pass a source canvas, so we keep coordinates as-is.
            sy = Math.max(0, Math.round(sel.rect.y * ratioY));
            sw = Math.min(W - sx, Math.round(sel.rect.w * ratioX));
            sh = Math.min(H - sy, Math.round(sel.rect.h * ratioY));
        }

        const out = document.createElement("canvas");
        out.width = sw;
        out.height = sh;
        const ctx = out.getContext("2d");
        // White background under the splats so the saved PNG isn't black.
        ctx.fillStyle = "white";
        ctx.fillRect(0, 0, sw, sh);
        ctx.drawImage(canvas, sx, sy, sw, sh, 0, 0, sw, sh);
        return out.toDataURL("image/png");
    }

    function resolveTargetWindow() {
        try { if (window.parent && window.parent !== window) return window.parent; } catch (_e) {}
        try { if (window.opener && !window.opener.closed) return window.opener; } catch (_e) {}
        return null;
    }

    function confirmAndClose() {
        if (vertexCount <= 0) {
            alert(
                "まだ描画準備が整っていません。読み込み完了後に再度お試しください。\n" +
                "Render is not ready yet — please wait for the .ply to finish loading."
            );
            return;
        }
        let dataUrl;
        try { dataUrl = captureToDataURL(); }
        catch (exc) { alert(String(exc?.message || exc)); return; }
        // Snapshot the current camera state so the next "Open" lands here.
        // 6 decimal places is enough precision for a viewing transform and
        // keeps the URL-encoded payload short enough that browsers and
        // proxies don't truncate it. Splat-size and near-clip are display
        // knobs the user typically dials in once per scene — also persist
        // them so a Confirm-and-reopen cycle doesn't reset them.
        const view_state = JSON.stringify({
            viewMatrix: viewMatrix.map((v) => Math.round(v * 1e6) / 1e6),
            axis: camAxisSelect.value,
            splat_scale: parseFloat(splatScaleNum.value) || 1.0,
            near_clip:   parseFloat(nearClipNum.value)   || 0.0,
            fov_deg:     _readFovDeg(),
        });

        const target = resolveTargetWindow();
        const msg = {
            // Default messageType lets vanilla viewer talk to its widget.
            // SAM3D variant overrides via window.GS_CONFIRM_TYPE so each
            // widget filters by its own message type.
            type: window.GS_CONFIRM_TYPE || "gs-render-confirmed",
            node_id: window.GS_NODE_ID,
            render_image: dataUrl,
            // Camera framing snapshot — restored on next open via URL.
            view_state,
        };
        if (!target) {
            try { navigator.clipboard.writeText(dataUrl); } catch (_e) {}
            alert(
                "ComfyUI ノードから開かれていないため結果を返却できません。\n" +
                "PNG dataURL をクリップボードにコピーしました。"
            );
            return;
        }
        target.postMessage(msg, window.location.origin);
    }
    confirmBtn.addEventListener("click", confirmAndClose);

    // ---------------- Load PLY ----------------
    function loadPlyBuffer(buf) {
        const u = new Uint8Array(buf);
        const isPly = u[0] === 112 && u[1] === 108 && u[2] === 121 && u[3] === 10;
        if (isPly) {
            worker.postMessage({ ply: buf }, [buf]);
        } else {
            // Treat as already-converted .splat (binary 32-byte rows)
            const rowLen = 3*4 + 3*4 + 4 + 4;
            worker.postMessage({
                buffer: buf,
                vertexCount: Math.floor(u.length / rowLen),
            }, [buf]);
            statusText.textContent = "ready";
            progressEl.hidden = true;
        }
        progressEl.style.width = "100%";
    }

    // ---------------- Public load API (SAM3D mode) ----------------
    // Vanilla viewer fetches a server-side path. The SAM3D viewer holds
    // the .ply bytes in browser memory (returned in the response body of
    // /gs_render/sam3d_generate) and feeds them in here directly — the
    // server keeps no copy.
    window.gsLoadPlyFromBuffer = function (buf) {
        if (!buf || !buf.byteLength) return;
        // worker.postMessage transfers ownership of the ArrayBuffer, so
        // the caller (SAM3D glue) is responsible for pre-cloning if it
        // wants to retain a copy for the "ply保存" button.
        statusText.textContent = "parsing .ply…";
        progressEl.hidden = false;
        progressEl.style.width = "60%";
        loadPlyBuffer(buf);
    };

    window.gsLoadPlyFromUrl = async function (serverPlyPath) {
        if (!serverPlyPath) return;
        statusText.textContent = "fetching .ply…";
        progressEl.hidden = false;
        progressEl.style.width = "10%";
        try {
            const url = `/gs_render/ply?path=${encodeURIComponent(serverPlyPath)}`;
            const resp = await fetch(url);
            if (!resp.ok) {
                const t = await resp.text().catch(() => "");
                throw new Error(`failed to fetch .ply (${resp.status}): ${t}`);
            }
            const buf = await resp.arrayBuffer();
            progressEl.style.width = "60%";
            statusText.textContent = "parsing .ply…";
            loadPlyBuffer(buf);
            window.GS_PLY_PATH = serverPlyPath;
        } catch (exc) {
            console.error(exc);
            showError(exc.message || String(exc));
            statusText.textContent = "error";
        }
    };

    // Vanilla mode: fetch the PLY referenced by the URL on boot.
    if (plyPath) {
        await window.gsLoadPlyFromUrl(plyPath);
    } else {
        // SAM3D mode without a PLY yet — keep the UI quiet.
        statusText.textContent = "画像を読み込んでください / load an image";
        progressEl.hidden = true;
    }
}

main().catch((err) => {
    console.error(err);
    showError(err);
});
})();
