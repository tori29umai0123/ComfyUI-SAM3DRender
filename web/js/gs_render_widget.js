/**
 * GaussianSplattingRender — node widget.
 *
 * Adds an "Open Gaussian Splatting Render" button to the
 * GaussianSplattingRender node, opens the WebGL viewer in an in-page
 * modal iframe, and listens for the `gs-render-confirmed` postMessage
 * to populate the hidden render_image widget with the captured PNG.
 *
 * Pattern mirrors ComfyUI-SAM3DBody_utills/character_editor_widget.js.
 */

import { app } from "../../../scripts/app.js";

const TARGET_NODE  = "GaussianSplattingRender";
const CONFIRM_MSG  = "gs-render-confirmed";
const CANCEL_MSG   = "gs-render-cancelled";
const HIDDEN_IMG        = "render_image";
const HIDDEN_VIEW_STATE = "view_state";
const STATUS_NAME       = "status";
const EDITOR_PATH       = "/gs_render/editor";
const MODAL_ID          = "gs-render-editor-modal";

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

function _findPlyWidget(node) {
    return node.widgets?.find((x) => x.name === "ply_path");
}

function attachWidgets(node) {
    if (node.__gsRenderAttached) return;
    node.__gsRenderAttached = true;

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

    node.addWidget("button", "Open Gaussian Splatting Render", null, () => {
        openEditor(node);
    });

    const refresh = () => {
        statusWidget.value = hiddenImg.value
            ? `confirmed (${hiddenImg.value.length} chars)`
            : "(未確定 / unset)";
        node.setDirtyCanvas?.(true, true);
    };
    refresh();
    node.__gsRenderRefresh         = refresh;
    node.__gsRenderImgHidden       = hiddenImg;
    node.__gsRenderViewStateHidden = hiddenViewState;

    const origConfig = node.onConfigure;
    node.onConfigure = function (info) {
        const r = origConfig?.apply(this, arguments);
        refresh();
        return r;
    };

    if (node.size?.[0] < 280) node.size[0] = 300;
}

function ensureModalStyles() {
    if (document.getElementById("gs-render-modal-styles")) return;
    const style = document.createElement("style");
    style.id = "gs-render-modal-styles";
    style.textContent = `
.gs-render-modal-backdrop {
    position: fixed; inset: 0; background: rgba(0,0,0,0.6);
    z-index: 99999; display: flex; align-items: center; justify-content: center;
}
.gs-render-modal-frame {
    position: relative; width: 96vw; height: 94vh;
    background: #1e1e1e; border: 1px solid #444; border-radius: 8px;
    box-shadow: 0 10px 40px rgba(0,0,0,0.7); overflow: hidden;
}
.gs-render-modal-frame > iframe {
    width: 100%; height: 100%; border: 0; display: block; background: #000;
}
.gs-render-modal-close {
    position: absolute; top: 6px; right: 8px; z-index: 2;
    width: 28px; height: 28px; line-height: 28px;
    border: none; border-radius: 4px;
    background: rgba(0,0,0,0.45); color: #ddd;
    font-size: 18px; font-weight: 700; cursor: pointer;
}
.gs-render-modal-close:hover { background: rgba(255,80,80,0.7); color: white; }
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

    const plyW = _findPlyWidget(node);
    const plyPath = (plyW?.value || "").trim();
    if (!plyPath) {
        alert(
            "ply_path が空です。.ply ファイルの絶対パスを入力してから開いてください。\n" +
            "ply_path is empty. Enter the absolute path of a .ply file first."
        );
        return;
    }

    // Persist the camera state across reopens / ply changes by passing
    // the saved view_state through the URL. main.js parses it and seeds
    // viewMatrix + axis dropdown so the user lands at the same framing.
    const savedViewState = node.__gsRenderViewStateHidden?.value || "";
    const url =
        `${EDITOR_PATH}?node_id=${encodeURIComponent(node.id)}` +
        `&ply=${encodeURIComponent(plyPath)}` +
        (savedViewState ? `&view_state=${encodeURIComponent(savedViewState)}` : "") +
        `&_t=${Date.now()}`;

    const backdrop = document.createElement("div");
    backdrop.className = "gs-render-modal-backdrop";
    backdrop.id = MODAL_ID;
    backdrop.innerHTML = `
        <div class="gs-render-modal-frame">
            <button class="gs-render-modal-close" title="Close (Esc)">×</button>
            <iframe src="${url}" allow="clipboard-write"></iframe>
        </div>
    `;
    backdrop.querySelector(".gs-render-modal-close").addEventListener("click", closeModal);
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
    if (target && target.comfyClass === TARGET_NODE && target.__gsRenderImgHidden) {
        target.__gsRenderImgHidden.value =
            typeof render_image === "string" ? render_image : "";
        if (target.__gsRenderViewStateHidden) {
            target.__gsRenderViewStateHidden.value =
                typeof view_state === "string" ? view_state : "";
        }
        target.__gsRenderRefresh?.();
    }
    closeModal();
});

app.registerExtension({
    name: "GaussianSplattingRender.Widget",
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
