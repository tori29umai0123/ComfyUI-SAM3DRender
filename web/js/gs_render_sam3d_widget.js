/**
 * GaussianSplattingRenderSAM3D — node widget.
 *
 * Mirrors gs_render_widget.js but:
 *  - opens /gs_render/editor_sam3d (no ply_path query)
 *  - listens for `gs-render-sam3d-confirmed` postMessage
 *  - has no ply_path widget to read on open
 */

import { app } from "../../../scripts/app.js";

const TARGET_NODE        = "GaussianSplattingRenderSAM3D";
const CONFIRM_MSG        = "gs-render-sam3d-confirmed";
const CANCEL_MSG         = "gs-render-sam3d-cancelled";
const HIDDEN_IMG         = "render_image";
const HIDDEN_VIEW_STATE  = "view_state";
const STATUS_NAME        = "status";
const EDITOR_PATH        = "/gs_render/editor_sam3d";
const MODAL_ID           = "gs-render-sam3d-editor-modal";

// Per-node cache of the most recently generated PLY, keyed by node id.
// Lives on the parent (ComfyUI) window so it survives modal close/open
// even though the iframe itself is torn down each time. Lost on page
// reload — that's the intended scope ("session cache").
//
// Value shape: { ascii: ArrayBuffer, binary: ArrayBuffer, suggestedName: string }
//   - ascii  : original SAM3D point cloud, used by 「ply保存」
//   - binary : 17-float 3DGS layout, used by the WebGL worker
if (!window.gsSam3dPlyCache) {
    window.gsSam3dPlyCache = new Map();
}

function _ensureHidden(node, name) {
    let w = node.widgets?.find((x) => x.name === name);
    if (!w) {
        w = node.addWidget("text", name, "", () => {}, {
            multiline: false,
            serialize: true,
        });
    }
    w.serialize = true;
    w.computeSize = () => [0, -4];
    w.draw = () => {};
    w.type = "hidden";
    return w;
}

function attachWidgets(node) {
    if (node.__gsRenderSam3dAttached) return;
    node.__gsRenderSam3dAttached = true;

    const hiddenImg       = _ensureHidden(node, HIDDEN_IMG);
    const hiddenViewState = _ensureHidden(node, HIDDEN_VIEW_STATE);

    const statusWidget = node.addWidget(
        "text",
        STATUS_NAME,
        hiddenImg.value ? "confirmed (image set)" : "(未確定 / unset)",
        () => {},
        { serialize: false },
    );
    statusWidget.disabled = true;

    node.addWidget("button", "Open Gaussian Splatting Render（SAM3D）", null, () => {
        openEditor(node);
    });

    const refresh = () => {
        statusWidget.value = hiddenImg.value
            ? `confirmed (${hiddenImg.value.length} chars)`
            : "(未確定 / unset)";
        node.setDirtyCanvas?.(true, true);
    };
    refresh();
    node.__gsRenderSam3dRefresh         = refresh;
    node.__gsRenderSam3dImgHidden       = hiddenImg;
    node.__gsRenderSam3dViewStateHidden = hiddenViewState;

    const origConfig = node.onConfigure;
    node.onConfigure = function (info) {
        const r = origConfig?.apply(this, arguments);
        refresh();
        return r;
    };

    if (node.size?.[0] < 320) node.size[0] = 340;
}

function ensureModalStyles() {
    if (document.getElementById("gs-render-sam3d-modal-styles")) return;
    const style = document.createElement("style");
    style.id = "gs-render-sam3d-modal-styles";
    style.textContent = `
.gs-render-sam3d-modal-backdrop {
    position: fixed; inset: 0; background: rgba(0,0,0,0.6);
    z-index: 99999; display: flex; align-items: center; justify-content: center;
}
.gs-render-sam3d-modal-frame {
    position: relative; width: 96vw; height: 94vh;
    background: #1e1e1e; border: 1px solid #444; border-radius: 8px;
    box-shadow: 0 10px 40px rgba(0,0,0,0.7); overflow: hidden;
}
.gs-render-sam3d-modal-frame > iframe {
    width: 100%; height: 100%; border: 0; display: block; background: #000;
}
.gs-render-sam3d-modal-close {
    position: absolute; top: 6px; right: 8px; z-index: 2;
    width: 28px; height: 28px; line-height: 28px;
    border: none; border-radius: 4px;
    background: rgba(0,0,0,0.45); color: #ddd;
    font-size: 18px; font-weight: 700; cursor: pointer;
}
.gs-render-sam3d-modal-close:hover { background: rgba(255,80,80,0.7); color: white; }
`;
    document.head.appendChild(style);
}

function closeModal() {
    const modal = document.getElementById(MODAL_ID);
    if (modal) modal.remove();
}

function openEditor(node) {
    ensureModalStyles();
    closeModal();

    const savedViewState = node.__gsRenderSam3dViewStateHidden?.value || "";
    const url =
        `${EDITOR_PATH}?node_id=${encodeURIComponent(node.id)}` +
        (savedViewState ? `&view_state=${encodeURIComponent(savedViewState)}` : "") +
        `&_t=${Date.now()}`;

    const backdrop = document.createElement("div");
    backdrop.className = "gs-render-sam3d-modal-backdrop";
    backdrop.id = MODAL_ID;
    backdrop.innerHTML = `
        <div class="gs-render-sam3d-modal-frame">
            <button class="gs-render-sam3d-modal-close" title="Close (Esc)">×</button>
            <iframe src="${url}" allow="clipboard-write"></iframe>
        </div>
    `;
    backdrop.querySelector(".gs-render-sam3d-modal-close").addEventListener("click", closeModal);
    backdrop.addEventListener("keydown", (ev) => {
        if (ev.key === "Escape") closeModal();
    });
    document.body.appendChild(backdrop);
    backdrop.tabIndex = -1;
    backdrop.focus();
}

window.addEventListener("message", (evt) => {
    if (!evt.data) return;
    if (evt.origin !== window.location.origin) return;
    if (evt.data.type === CANCEL_MSG) {
        closeModal();
        return;
    }
    if (evt.data.type !== CONFIRM_MSG) return;
    const { node_id, render_image, view_state } = evt.data;
    const target = app.graph?.getNodeById?.(Number(node_id));
    if (target && target.comfyClass === TARGET_NODE && target.__gsRenderSam3dImgHidden) {
        target.__gsRenderSam3dImgHidden.value =
            typeof render_image === "string" ? render_image : "";
        if (target.__gsRenderSam3dViewStateHidden) {
            target.__gsRenderSam3dViewStateHidden.value =
                typeof view_state === "string" ? view_state : "";
        }
        target.__gsRenderSam3dRefresh?.();
    }
    closeModal();
});

app.registerExtension({
    name: "GaussianSplattingRenderSAM3D.Widget",
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== TARGET_NODE) return;
        const orig = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const r = orig?.apply(this, arguments);
            attachWidgets(this);
            return r;
        };
    },
});
